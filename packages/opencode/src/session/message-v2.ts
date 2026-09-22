// 引入事件总线事件定义
import { BusEvent } from "@/bus/bus-event"
// 引入会话相关的 ID schema
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
// 引入带名称的错误工具
import { NamedError } from "@opencode-ai/shared/util/error"
// 引入 AI SDK 中的错误类型和消息转换工具
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
// 引入 LSP 类型(用于 SymbolSource 里的 Range)
import { LSP } from "../lsp"
// 引入快照模块(用于 User.summary.diffs)
import { Snapshot } from "@/snapshot"
// 引入同步事件定义工具
import { SyncEvent } from "../sync"
// 引入数据库工具和查询操作符
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@/storage"
// 引入会话相关的表定义
import { MessageTable, PartTable, SessionTable } from "./session.sql"
// 引入 ProviderError(用于解析 API 错误)
import { ProviderError } from "@/provider"
// 引入立即执行函数工具
import { iife } from "@/util/iife"
// 引入错误消息提取工具
import { errorMessage } from "@/util/error"
// 引入媒体类型判定工具
import { isMedia } from "@/util/media"
// 引入 Bun 系统错误类型
import type { SystemError } from "bun"
// 引入 Provider 命名空间类型
import type { Provider } from "@/provider"
// 引入模型 ID / Provider ID schema
import { ModelID, ProviderID } from "@/provider/schema"
// 引入 Effect 生态核心类型
import { Effect, Schema, Types } from "effect"
// 引入 Schema 与 zod 桥接工具
import { zod, ZodOverride } from "@/util/effect-zod"
// 引入给 Schema 附加静态属性的工具
import { withStatics } from "@/util/schema"
// 引入命名 Schema 错误工具
import { namedSchemaError } from "@/util/named-schema-error"
// 引入 Effect 日志器
import { EffectLogger } from "@/effect"

/**
 * Bun fetch() 在流式响应中 gzip/br 解压失败时抛出的错误形状
 */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

// 当把工具结果里的媒体拆成单独 user 消息时使用的引导语
export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
// 重新导出 isMedia,方便使用方从本模块获取
export { isMedia }

// ===== 各类命名错误定义 =====

// 输出长度超限错误
export const OutputLengthError = namedSchemaError("MessageOutputLengthError", {})
// 消息被中止错误
export const AbortedError = namedSchemaError("MessageAbortedError", { message: Schema.String })
// 结构化输出错误(含重试次数)
export const StructuredOutputError = namedSchemaError("StructuredOutputError", {
  message: Schema.String,
  retries: Schema.Number,
})
// 鉴权错误
export const AuthError = namedSchemaError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})
// 通用 API 错误
export const APIError = namedSchemaError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = z.infer<typeof APIError.Schema>
// 上下文溢出错误
export const ContextOverflowError = namedSchemaError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

/**
 * 输出格式:纯文本
 */
export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {
  static readonly zod = zod(this)
}

/**
 * 输出格式:JSON Schema
 * - schema:     期望的 JSON Schema
 * - retryCount: 失败重试次数(默认 2)
 */
export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: Schema.Number.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {
  static readonly zod = zod(this)
}

// 输出格式联合类型(text | json_schema)
const _Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export const Format = Object.assign(_Format, { zod: zod(_Format) })
export type OutputFormat = Schema.Schema.Type<typeof _Format>

// 所有 Part 共享的基础字段
const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

/**
 * 快照 Part:记录某时刻的文件快照
 */
export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
})
  .annotate({ identifier: "SnapshotPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

/**
 * 补丁 Part:记录某次 patch(hash + 涉及的文件列表)
 */
export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
})
  .annotate({ identifier: "PatchPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

/**
 * 文本 Part
 * - text:      正文内容
 * - synthetic: 是否为系统合成的文本
 * - ignored:   是否忽略(不发送给模型)
 * - time:      起止时间
 * - metadata:  附加元数据
 */
export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: Schema.Number,
      end: Schema.optional(Schema.Number),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

/**
 * 推理 Part:模型的 reasoning 输出(如 Anthropic thinking)
 */
export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: Schema.Number,
    end: Schema.optional(Schema.Number),
  }),
})
  .annotate({ identifier: "ReasoningPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

// FilePart 来源(source)共享的文本定位字段
const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Number.check(Schema.isInt()),
    end: Schema.Number.check(Schema.isInt()),
  }).annotate({ identifier: "FilePartSourceText" }),
}

/**
 * 文件来源:普通文件路径
 */
export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
})
  .annotate({ identifier: "FileSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

/**
 * 文件来源:代码符号(带位置和种类)
 */
export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: LSP.Range,
  name: Schema.String,
  kind: Schema.Number.check(Schema.isInt()),
})
  .annotate({ identifier: "SymbolSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

/**
 * 文件来源:外部资源(如 MCP 资源)
 */
export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
})
  .annotate({ identifier: "ResourceSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

// 文件来源联合类型
const _FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})
export const FilePartSource = Object.assign(_FilePartSource, { zod: zod(_FilePartSource) })

/**
 * 文件 Part
 * - mime:     文件 MIME 类型
 * - filename: 文件名(可选)
 * - url:      文件 URL(可能是 data: URL)
 * - source:   文件来源(可选)
 */
export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

/**
 * Agent Part:指向某个 agent 的引用
 */
export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: Schema.Number.check(Schema.isInt()),
      end: Schema.Number.check(Schema.isInt()),
    }),
  ),
})
  .annotate({ identifier: "AgentPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

/**
 * 压缩 Part:标记上下文压缩位置
 * - auto:          是否自动触发
 * - overflow:      是否因上下文溢出触发
 * - tail_start_id: 压缩后保留的尾部消息起始 ID
 */
export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
})
  .annotate({ identifier: "CompactionPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

/**
 * 子任务 Part:由父 agent 派发给子 agent 的任务
 */
export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

/**
 * 重试 Part:记录一次 API 调用重试
 */
export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: Schema.Number,
  // APIError 仍基于 NamedError 的 Zod,通过 ZodOverride 桥接
  error: Schema.Any.annotate({ [ZodOverride]: APIError.Schema }),
  time: Schema.Struct({
    created: Schema.Number,
  }),
})
  .annotate({ identifier: "RetryPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

/**
 * Step 开始 Part:标记一次工具调用 step 的起点
 */
export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
})
  .annotate({ identifier: "StepStartPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

/**
 * Step 结束 Part:记录 step 的结束原因、cost、token 用量
 */
export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Number,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Number),
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({
      read: Schema.Number,
      write: Schema.Number,
    }),
  }),
})
  .annotate({ identifier: "StepFinishPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

/**
 * 工具状态:待执行
 */
export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
})
  .annotate({ identifier: "ToolStatePending" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

/**
 * 工具状态:运行中
 */
export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: Schema.Number,
  }),
})
  .annotate({ identifier: "ToolStateRunning" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

/**
 * 工具状态:已完成
 * - output:      字符串输出
 * - title:       展示用标题
 * - attachments: 附件列表(可能包含图片等)
 */
export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
    compacted: Schema.optional(Schema.Number),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
})
  .annotate({ identifier: "ToolStateCompleted" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

/**
 * 截断工具输出(用于压缩上下文时限制输出长度)
 */
function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

/**
 * 工具状态:出错
 */
export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
  }),
})
  .annotate({ identifier: "ToolStateError" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

// 工具状态联合类型(按 status 判别)
const _ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
// 强制声明 zod 类型,让 z.infer 与手写 TS 类型一致(可变的)
export const ToolState = Object.assign(_ToolState, {
  zod: zod(_ToolState) as unknown as z.ZodType<
    ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
  >,
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

/**
 * 工具 Part:一次工具调用的完整记录
 */
export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: _ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "ToolPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

// 所有 Message 共享的基础字段
const messageBase = {
  id: MessageID,
  sessionID: SessionID,
}

/**
 * 用户消息
 * - format:  输出格式(可选)
 * - summary: 会话摘要(标题、正文、diff)
 * - agent:   使用的 agent 名称
 * - model:   使用的模型
 * - system:  系统提示词(可选)
 * - tools:   工具开关映射(可选)
 */
export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Schema.Number,
  }),
  format: Schema.optional(_Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
  .annotate({ identifier: "UserMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

// Part 联合类型(按 type 判别)
const _Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export const Part = Object.assign(_Part, {
  zod: zod(_Part) as unknown as z.ZodType<
    | TextPart
    | SubtaskPart
    | ReasoningPart
    | FilePart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | SnapshotPart
    | PatchPart
    | AgentPart
    | RetryPart
    | CompactionPart
  >,
})
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

// 助手消息可能的错误联合类型(仍基于 NamedError 的 Zod)
const AssistantErrorZod = z.discriminatedUnion("name", [
  AuthError.Schema,
  NamedError.Unknown.Schema,
  OutputLengthError.Schema,
  AbortedError.Schema,
  StructuredOutputError.Schema,
  ContextOverflowError.Schema,
  APIError.Schema,
])
type AssistantError = z.infer<typeof AssistantErrorZod>

// ── Prompt 输入 schema ─────────────────────────────────────────────────────
//
// `SessionPrompt.PromptInput.parts` 的使用方传入的是"draft part",没有
// `messageID` / `sessionID` 这些持久化 part 才有的字段,并且可以省略 `id`
// 由服务端分配。这里定义一批"Input"版本的 Schema 用于这种形状,
// `SessionPrompt.PromptInput` 直接引用它们派生的 `.zod` 即可。

/**
 * 文本 Part 输入
 */
export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: Schema.Number,
      end: Schema.optional(Schema.Number),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

/**
 * 文件 Part 输入
 */
export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

/**
 * Agent Part 输入
 */
export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: Schema.Number.check(Schema.isInt()),
      end: Schema.Number.check(Schema.isInt()),
    }),
  ),
})
  .annotate({ identifier: "AgentPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

/**
 * 子任务 Part 输入
 */
export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

/**
 * 助手消息
 * - error:      出错信息(可选)
 * - parentID:   对应用户消息 ID
 * - modelID/providerID: 使用的模型
 * - mode:       (已废弃)
 * - agent:      使用的 agent 名称
 * - path:       工作目录 / 项目根目录
 * - summary:    是否为摘要消息
 * - cost:       本次消耗
 * - tokens:     token 用量
 * - structured: 结构化输出
 * - variant:    变体标识
 * - finish:     结束原因
 */
export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: Schema.Number,
    completed: Schema.optional(Schema.Number),
  }),
  error: Schema.optional(Schema.Any.annotate({ [ZodOverride]: AssistantErrorZod })),
  parentID: MessageID,
  modelID: ModelID,
  providerID: ProviderID,
  /**
   * @deprecated
   */
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Number,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Number),
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({
      read: Schema.Number,
      write: Schema.Number,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
})
  .annotate({ identifier: "AssistantMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

// Message 联合类型(user | assistant)
const _Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export const Info = Object.assign(_Info, {
  zod: zod(_Info) as unknown as z.ZodType<User | Assistant>,
})
export type Info = User | Assistant

/**
 * 消息相关的同步/总线事件定义
 */
export const Event = {
  // 消息被更新(创建/修改)
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info.zod,
    }),
  }),
  // 消息被删除
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
  }),
  // Part 被更新
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      part: Part.zod,
      time: z.number(),
    }),
  }),
  // Part 增量更新(流式)
  PartDelta: BusEvent.define(
    "message.part.delta",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
  ),
  // Part 被删除
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
  }),
}

/**
 * 消息 + 其下所有 Part 的组合结构
 */
export const WithParts = Schema.Struct({
  info: _Info,
  parts: Schema.Array(_Part),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type WithParts = {
  info: Info
  parts: Part[]
}

// 分页游标(id + 创建时间)
const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Number,
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

/**
 * 游标编解码:base64url 编码的 JSON
 */
export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

// 数据库行 -> Info 的映射
const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

// 数据库行 -> Part 的映射
const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

// 构造"更早于游标"的 SQL 条件(time 更早,或同 time 但 id 更小)
const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

/**
 * 把 Message 行水合为 WithParts[](附带各自的 Part 列表)
 */
function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

/**
 * 取出 metadata 中除 providerExecuted 外的其它字段
 */
function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * 把 WithParts[] 转换为 AI SDK 的 ModelMessage[](Effect 版本)
 *
 * 主要职责:
 *  - 根据 user/assistant 角色组装 UIMessage
 *  - 处理文件附件(文本/MIME),对于不支持工具结果内媒体的 provider,
 *    把媒体抽取出来作为独立的 user 消息注入
 *  - 处理 tool part 的 completed / error / pending / running 状态,
 *    避免出现 dangling tool_use(某些 provider 要求 tool_use 必须配对 tool_result)
 */
export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // 追踪需要作为独立 user 消息注入的工具结果媒体(针对不支持工具结果内媒体的 provider)
  //
  // OpenAI 兼容 API 的工具结果只支持字符串内容,因此需要把媒体抽取出来,
  // 作为独立 user 消息注入。其它 SDK(anthropic, google, bedrock)原生支持
  // type: "content" 携带媒体部分。
  //
  // 仅当模型本身支持图像输入时才应用此 workaround,否则抽取图片没有意义。
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  // 把工具原始输出转为 AI SDK 的 toModelOutput 结果
  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          { type: "text", text: outputObject.text },
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    // ===== 用户消息 =====
    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)
      for (const part of msg.parts) {
        // 普通文本(且未被 ignore)直接透传
        if (part.type === "text" && !part.ignored)
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain 和目录类型的文件会转换为文本 part,忽略之
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            // 剥离媒体时,替换为占位文本
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        // 压缩 part 转为追问文本
        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        // 子任务 part 转为提示文本
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    // ===== 助手消息 =====
    if (msg.info.role === "assistant") {
      // 该助手消息使用的模型与当前请求模型是否不同
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      // 需要作为独立 user 消息注入的媒体(工具结果媒体)
      const media: Array<{ mime: string; url: string }> = []

      // 若消息有 error,且不是"被中止但有实质产出"的情况,直接跳过该消息
      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      for (const part of msg.parts) {
        // 文本
        if (part.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            // 模型切换时不透传 providerMetadata
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        // step 开始
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        // 工具 part
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            // 已被压缩过的旧输出用占位文本替换
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // 对于不支持工具结果内媒体的 provider,把媒体文件(图片、PDF)抽取为独立的 user 消息
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            // 如果 metadata 中标记了 interrupted,则把 output 当正常输出使用
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // 处理 pending / running 的工具调用,避免出现 dangling tool_use 块
          // Anthropic/Claude API 要求每个 tool_use 都必须有对应的 tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        // 推理
        if (part.type === "reasoning") {
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // 对于不支持工具结果内媒体的 provider,把待注入的媒体作为独立 user 消息推入
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
              })),
            ],
          })
        }
      }
    }
  }

  // 收集所有用到的工具,并为每个工具提供 toModelOutput 转换
  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      // 过滤掉只包含 step-start 的消息
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages 期望 ToolSet,但实际只用到 tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

/**
 * toModelMessages 的 Promise 包装版本(自动提供 EffectLogger)
 */
export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

/**
 * 按游标分页查询某个会话的消息
 * - before: base64url 编码的游标,表示"取此游标之前"的消息
 * - 返回 items(按时间正序)、more(是否还有更多)、cursor(下一页游标)
 */
export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  // 多查一条用于判断是否还有更多
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    // 无消息时校验会话是否存在
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  // 数据库里是倒序查询的,这里反转为时间正序
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
}

/**
 * 以生成器形式流式遍历会话的全部消息(从最早到最新)
 */
export function* stream(sessionID: SessionID) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before })
    if (next.items.length === 0) break
    // 反向 yield,保证从早到晚
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

/**
 * 查询某条消息的所有 Part(按 id 排序)
 */
export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

/**
 * 按会话 + 消息 ID 获取单条消息及其 parts
 */
export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
}

/**
 * 过滤出"当前有效"的消息序列(用于喂给模型的历史)
 *
 * 规则:
 *  - 若遇到被压缩的 user 消息(带 compaction part):
 *      * 若指定了 tail_start_id,则从该 id 起保留尾部
 *      * 否则直接截断
 *  - assistant 消息若为 summary 且正常 finish 且无 error,则将其 parentID 记为已完成
 *  - 最终反转结果(由内到外正向返回)
 */
export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  return result
}

/**
 * filterCompacted 的 Effect 版本
 */
export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(stream(sessionID))
})

/**
 * 把任意错误转换为助手消息的 error 结构
 * 覆盖:中止、输出长度、API Key、连接重置、解压失败、APICallError 等
 */
export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    // DOM AbortError -> AbortedError
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    // 已经是 OutputLengthError,直接返回
    case OutputLengthError.isInstance(e):
      return e
    // 缺少 API Key -> AuthError
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    // 连接被重置 -> 可重试的 APIError
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    // 响应解压失败(ZlibError):若已中止 -> AbortedError,否则 -> 可重试的 APIError
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    // AI SDK 的 APICallError -> 交给 ProviderError 解析
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      // 上下文溢出单独用 ContextOverflowError 表示
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    // 普通 Error -> Unknown
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    // 兜底:尝试用 ProviderError.parseStreamError 解析流错误
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

// 以命名空间形式导出
export * as MessageV2 from "./message-v2"
