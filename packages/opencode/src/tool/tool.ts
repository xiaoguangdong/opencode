import z from "zod"
// 引入 Effect 核心
import { Effect } from "effect"
// 引入消息类型
import type { MessageV2 } from "../session/message-v2"
// 引入权限类型
import type { Permission } from "../permission"
// 引入会话 ID / 消息 ID 类型
import type { SessionID, MessageID } from "../session/schema"
// 引入截断模块
import * as Truncate from "./truncate"
// 引入 Agent 服务
import { Agent } from "@/agent/agent"

// 工具元数据的通用形状:任意键值对
interface Metadata {
  [key: string]: any
}

// TODO: 移除这个 hack
// 动态描述函数:根据 agent 生成工具描述文本
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * 工具执行上下文
 * - sessionID / messageID: 当前会话和消息 ID
 * - agent:                 当前 agent 名称
 * - abort:                 中止信号
 * - callID:                本次工具调用 ID(可选)
 * - extra:                 额外透传数据(可选)
 * - messages:              当前会话历史消息
 * - metadata(input):       更新工具调用进度(title / metadata)
 * - ask(input):            向用户发起权限请求
 */
export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

/**
 * 工具执行结果
 * - title:       展示给用户的标题
 * - metadata:    元数据
 * - output:      文本输出
 * - attachments: 附件列表(可选,已去掉存储相关的 ID 字段)
 */
export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

/**
 * 工具定义(完整版,包含 id)
 * - id:                     工具名
 * - description:            描述(可以是静态字符串)
 * - parameters:             参数 zod schema
 * - execute:                执行函数,接收参数和上下文,返回结果
 * - formatValidationError:  自定义参数校验错误格式化(可选)
 */
export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: z.ZodError): string
}

// 去掉 id 的工具定义(用于 init 阶段,id 在注册时统一注入)
export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
  Def<Parameters, M>,
  "id"
>

/**
 * 工具信息:注册入口对象
 * - id:   工具唯一标识
 * - init: 延迟初始化的 Effect,产生 DefWithoutID
 */
export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

// init 的类型:直接给出 DefWithoutID,或返回 DefWithoutID 的 Effect 工厂
type Init<Parameters extends z.ZodType, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

// 从 Info/Effect 中提取参数类型
export type InferParameters<T> =
  T extends Info<infer P, any> ? z.infer<P> : T extends Effect.Effect<Info<infer P, any>, any, any> ? z.infer<P> : never
// 从 Info/Effect 中提取元数据类型
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

// 从 Info/Effect 中提取完整 Def 类型
export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

/**
 * 包装工具的 init,附加:
 *  - 参数解析与校验(失败时给出友好错误)
 *  - 输出自动截断
 *  - OpenTelemetry span 标注
 */
function wrap<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      // 若 init 是函数,则调用之;否则直接浅拷贝
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const execute = toolInfo.execute
      // 替换原 execute:先校验参数,再执行,最后按需截断输出
      toolInfo.execute = (args, ctx) => {
        // OpenTelemetry span 属性
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // 参数校验:失败时抛 Error
          yield* Effect.try({
            try: () => toolInfo.parameters.parse(args),
            catch: (error) => {
              // 若工具自定义了 formatValidationError,则使用之
              if (error instanceof z.ZodError && toolInfo.formatValidationError) {
                return new Error(toolInfo.formatValidationError(error), { cause: error })
              }
              return new Error(
                `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
                { cause: error },
              )
            },
          })
          // 执行实际逻辑
          const result = yield* execute(args, ctx)
          // 若已标记 truncated,则不再重复截断
          if (result.metadata.truncated !== undefined) {
            return result
          }
          // 根据 agent 配置截断输出
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(
          // 出错时直接 die(视为不可恢复)
          Effect.orDie,
          // 打上 span
          Effect.withSpan("Tool.execute", { attributes: attrs }),
        )
      }
      return toolInfo
    })
}

/**
 * 定义一个工具:
 *  - 传入 id 和 init Effect
 *  - 内部 resolve 出 DefWithoutID,并从环境中获取 Truncate / Agent 服务
 *  - 返回带 id 的 Info,该 Info 挂载在 Effect 上,并附带 id 静态字段
 */
export function define<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      // 解析 init
      const resolved = yield* init
      // 取出截断和 agent 服务
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

/**
 * 初始化工具 Info,得到可执行 Def(补齐 id)
 */
export function init<P extends z.ZodType, M extends Metadata>(info: Info<P, M>): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}
