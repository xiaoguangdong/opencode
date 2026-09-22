// 引入事件总线事件定义
import { BusEvent } from "@/bus/bus-event"
// 引入事件总线服务
import { Bus } from "@/bus"
// 引入 Session 模块
import * as Session from "./session"
// 引入会话 ID / 消息 ID / Part ID schema
import { SessionID, MessageID, PartID } from "./schema"
// 引入 Provider 命名空间
import { Provider } from "../provider"
// 引入消息类型
import { MessageV2 } from "./message-v2"
import z from "zod"
// 引入 token 估算与日志工具
import { Token } from "../util"
import { Log } from "../util"
// 引入 Session 处理器(执行 LLM 调用)
import { SessionProcessor } from "./processor"
// 引入 Agent 服务
import { Agent } from "@/agent/agent"
// 引入插件服务
import { Plugin } from "@/plugin"
// 引入配置服务
import { Config } from "@/config"
// 引入 NotFoundError
import { NotFoundError } from "@/storage"
// 引入模型 ID / Provider ID schema
import { ModelID, ProviderID } from "@/provider/schema"
// 引入 Effect 核心类型
import { Effect, Layer, Context } from "effect"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
// 引入溢出检测工具
import { isOverflow as overflow, usable } from "./overflow"
// 引入运行时构建工具(把 Effect 服务包装为 Promise)
import { makeRuntime } from "@/effect/run-service"
// 引入 fn 工具(把 zod 输入包装为可调用函数)
import { fn } from "@/util/fn"

// 创建本模块 logger
const log = Log.create({ service: "session.compaction" })

/**
 * 会话压缩相关事件
 */
export const Event = {
  // 完成压缩事件
  Compacted: BusEvent.define(
    "session.compacted",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
}

// 触发 prune 的最小可释放 token 阈值
export const PRUNE_MINIMUM = 20_000
// prune 时保留的最近工具输出 token 数
export const PRUNE_PROTECT = 40_000
// 传给压缩模型时工具输出的最大字符数
const TOOL_OUTPUT_MAX_CHARS = 2_000
// prune 时受保护(不清理)的工具名
const PRUNE_PROTECTED_TOOLS = ["skill"]
// 默认保留的最近对话轮数
const DEFAULT_TAIL_TURNS = 2
// 保留最近内容的 token 下限
const MIN_PRESERVE_RECENT_TOKENS = 2_000
// 保留最近内容的 token 上限
const MAX_PRESERVE_RECENT_TOKENS = 8_000
// 摘要模板:固定 Markdown 结构,模型需严格按此输出
const SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:
---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

// 一轮对话(以 user 消息为起点,到下一个 user 消息前)
type Turn = {
  start: number
  end: number
  id: MessageID
}

// 需要保留的尾部起点
type Tail = {
  start: number
  id: MessageID
}

// 已完成的压缩记录(用户消息 index / 摘要助手消息 index / 摘要内容)
type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

/**
 * 提取一条消息中的所有文本内容作为摘要文本
 */
function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

/**
 * 找出所有"已完成"的压缩记录:
 *  - 对应 user 消息含 compaction part
 *  - 对应 assistant 消息是 summary 且正常 finish 且无 error
 */
function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

/**
 * 构造压缩提示词:
 * - 若已有 previousSummary,则要求模型"更新"摘要
 * - 否则要求模型"新建"摘要
 */
function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

/**
 * 计算"保留最近内容"的 token 预算:
 * - 优先使用用户配置
 * - 否则按模型可用上下文的 25% 计算,并夹在 [MIN, MAX] 区间内
 */
function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

/**
 * 把消息序列按"用户消息"划分为多轮(turn)
 * 注意:带 compaction part 的 user 消息被跳过,不计入轮次
 */
function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  // 每轮的 end 为下一轮的 start
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

/**
 * 尝试在单轮内找一个可以切入的点,使其尾部大小 <= budget。
 * 用于"保留最近预算不够保留整轮"时,在轮内切分。
 */
function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    // 从轮内第二个消息开始依次尝试
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

/**
 * SessionCompaction 服务接口
 */
export interface Interface {
  // 判断当前 token 是否溢出
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  // 清理旧的工具输出以释放上下文空间
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  // 执行一次压缩(产生 summary 消息)
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  // 创建一条 compaction 用户消息(作为压缩的锚点)
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

/**
 * SessionCompaction 的 Layer 实现
 */
export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service

    /**
     * 判断 token 是否溢出上下文
     */
    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    /**
     * 估算一组消息转换为 ModelMessage 后的 token 数
     */
    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    /**
     * 根据"保留最近预算"选择:
     *  - head:需要被压缩的头部消息
     *  - tail_start_id:压缩后保留的尾部起点消息 ID
     */
    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      // 计算最近若干轮的 token 大小
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      // 从最近一轮往前累加,直到超出预算
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        // 预算不足,尝试在轮内切分
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    /**
     * 从尾部往前扫描工具调用,累计到 PRUNE_PROTECT token 后,
     * 把更早的工具输出标记为 compacted(清空内容以释放上下文)
     */
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      // 从尾部往头部扫描
      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        // 至少跳过最近 2 轮
        if (turns < 2) continue
        // 遇到 summary 消息即停止扫描(压缩边界)
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          // 跳过受保护的工具
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          // 已 compacted 过,说明此处为压缩边界,停止
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          // 未超出保护阈值则继续累加
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      // 仅当可释放量超过 PRUNE_MINIMUM 时才真正执行
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    /**
     * 执行压缩主流程:
     *  1. 校验 parentID 对应的 user 消息(及其 compaction part)
     *  2. overflow 情况下尝试找到最近一条有实质内容的用户消息作为 replay
     *  3. 组装 prompt(previousSummary + SUMMARY_TEMPLATE + 插件 context)
     *  4. 调用 compaction agent 生成 summary 消息
     *  5. 根据结果决定是否继续自动执行 follow-up
     */
    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      // overflow 场景:找到最近一条有实质内容的用户消息,用于压缩后自动重放
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        // 若压缩后没有任何实质用户内容,则放弃 replay
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      // 使用 compaction agent(或回退到用户消息所用模型)
      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      // 若最后一条是触发压缩的 user 消息,则不参与摘要生成
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      // 此前已完成压缩的 user/assistant 消息不参与本次摘要
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // 插件可注入 context 或替换压缩 prompt
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      // 允许插件改写传给模型的消息
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      // 组装占位的 summary assistant 消息
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      // 创建处理器执行实际 LLM 调用
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      // 压缩过程中再次溢出 -> 记录错误并停止
      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      // 若 select 计算出的 tail_start_id 与旧值不同,更新 compaction part
      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      // 若需继续且为 auto 模式,则发起 follow-up
      if (result === "continue" && input.auto) {
        // 有 replay:重放之前的用户消息
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            // 媒体文件替换为占位文本
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        // 无 replay:通过插件询问是否自动继续,然后生成 continue 消息
        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // 内部标记,用于 provider 插件区分自动压缩 follow-up 与用户手动输入
              // 非稳定插件契约,可能随时变化
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      // 成功继续时广播 Compacted 事件
      if (result === "continue") yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return result
    })

    /**
     * 创建一条压缩锚点用户消息(携带 compaction part)
     */
    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    // 返回 Service 实例
    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

// 默认 Layer:装配所有依赖(Session / Processor / Agent / Plugin / Bus / Config / Provider)
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

// 构造运行时,便于以 Promise 方式调用
const { runPromise } = makeRuntime(Service, defaultLayer)

/**
 * Promise 版 isOverflow
 */
export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

/**
 * Promise 版 prune
 */
export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

/**
 * zod 输入版本 create(供外部按 schema 校验后调用)
 */
export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

// 以命名空间形式导出
export * as SessionCompaction from "./compaction"
