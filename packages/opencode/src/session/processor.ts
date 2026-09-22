/**
 * SessionProcessor — LLM 流式事件处理器
 *
 * 这个模块是连接 LLM 流式输出和会话存储的桥梁。它接收 LLM 的流式事件（StreamTextResult），
 * 将每个事件转换为会话消息的 Part 并写入存储，同时管理工具调用的生命周期。
 *
 * 核心职责：
 *  1. 消费 LLM 事件流（text-delta / reasoning-delta / tool-call / finish-step 等）
 *  2. 将事件实时写入会话存储（支持增量写入，如 text-delta 追加到同一 TextPart）
 *  3. 管理工具调用生命周期：pending -> running -> completed/error
 *  4. 快照管理：在 LLM 推理前后捕获文件系统快照，生成 diff patch
 *  5. Token 统计与成本追踪
 *  6. 上下文溢出检测 -> 触发压缩
 *  7. Doom Loop 检测：防止模型重复调用相同工具（相同参数超过阈值）
 *  8. 错误处理与重试：通过 SessionRetry 策略自动重试可恢复错误
 *  9. 中断清理：用户取消时，安全关闭未完成的工具调用和文本 Part
 *
 * 对话循环中 prompt.ts 的 runLoop() 每轮调用 process()，根据返回的 Result 决定是否继续循环。
 */
import { Cause, Deferred, Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { FlowLog, Log } from "@/util"
import { isRecord } from "@/util/record"

/** Doom Loop 检测阈值：连续 3 次相同工具 + 相同参数则触发权限确认 */
const DOOM_LOOP_THRESHOLD = 3
const log = Log.create({ service: "session.processor" })

/** 处理器返回值：compact=需要压缩 | stop=停止循环 | continue=继续循环 */
export type Result = "compact" | "stop" | "continue"

/** 处理器处理的流式事件类型（来自 LLM） */
export type Event = LLM.Event

/**
 * 处理器句柄 — 对外暴露的接口
 * - message: 当前正在处理的 assistant 消息
 * - updateToolCall: 更新工具调用 Part 状态
 * - completeToolCall: 标记工具调用完成
 * - process: 启动 LLM 流式处理，返回 Result
 */
export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

/** 处理器创建输入 */
type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

/** 追踪中的工具调用状态（含 Deferred 用于等待完成） */
type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

/**
 * 处理器内部上下文 — 在一次 process() 调用期间共享的可变状态
 * - toolcalls: 当前追踪的工具调用映射
 * - shouldBreak: 权限拒绝时是否应该停止循环
 * - snapshot: 当前步骤的文件系统快照
 * - blocked: 是否因权限拒绝而阻塞
 * - needsCompaction: 是否需要触发上下文压缩
 * - currentText: 当前正在接收的文本 Part
 * - reasoningMap: 当前正在接收的推理 Part 映射（按 reasoning ID 索引）
 */
interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
}

type StreamEvent = Event

/** Effect Context Service 标签，用于依赖注入 */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      /** 错误解析器：将未知错误转为 MessageV2 错误格式，感知 abort 状态 */
      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      /** 结束工具调用：解除 Deferred，让等待的 cleanup 继续 */
      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      /** 读取工具调用：从存储中获取 Part 并返回 { call, part } */
      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      /** 更新工具调用 Part 状态（running 时的 metadata 更新等） */
      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      /** 标记工具调用完成：写入 output/metadata/attachments，并 settle Deferred */
      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        FlowLog.write("工具结果写入会话", {
          sessionID: ctx.sessionID,
          messageID: ctx.assistantMessage.id,
          callID: toolCallID,
          tool: match.part.tool,
          output,
        })
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      /** 标记工具调用失败：写入错误信息，处理权限拒绝（设置 blocked） */
      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        FlowLog.write("工具执行失败", {
          sessionID: ctx.sessionID,
          messageID: ctx.assistantMessage.id,
          callID: toolCallID,
          tool: match.part.tool,
          error: errorMessage(error),
        })
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      /**
       * 核心事件处理器 — 将 LLM 流式事件逐一转换为会话 Part
       *
       * 事件处理顺序与 LLM 输出一致：
       *  1. start: 设置状态为 busy
       *  2. reasoning-start/delta/end: 推理过程（如 CoT 思考链）
       *  3. text-start/delta/end: 文本输出（模型回复）
       *  4. tool-input-start/delta/end: 工具输入组织中（pending 状态）
       *  5. tool-call: 工具调用就绪（running 状态）+ Doom Loop 检测
       *  6. tool-result: 工具执行完成（completed 状态）
       *  7. tool-error: 工具执行失败（error 状态）
       *  8. start-step: 步骤开始（捕获快照）
       *  9. finish-step: 步骤完成（写入 token/cost/patch）
       * 10. finish: 整个流结束
       * 11. error: 流式错误 -> 抛出异常
       */
      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            FlowLog.write("LLM processor 收到 start", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
            })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            FlowLog.write("模型开始组织工具输入", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              callID: value.id,
              tool: value.toolName,
              providerExecuted: value.providerExecuted,
            })
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            // 模型已完成工具参数组织，进入 running 状态
            // 同时进行 Doom Loop 检测：如果最近 3 次都是相同工具+相同参数，触发权限确认
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))
            FlowLog.write("模型发起工具调用", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              callID: value.toolCallId,
              tool: value.toolName,
              input: value.input,
              providerMetadata: value.providerMetadata,
            })

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            yield* completeToolCall(value.toolCallId, value.output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            // 步骤完成：计算 token/cost，写入 step-finish Part，生成文件 diff patch
            // 同时异步触发 summary 生成，检查上下文是否溢出
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            FlowLog.write("模型 step 完成", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              finishReason: value.finishReason,
              usage,
              providerMetadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: yield* snapshot.track(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            FlowLog.write("模型开始输出文本", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              providerMetadata: value.providerMetadata,
            })
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            // 文本输出完成：触发 plugin 文本后处理，更新 Part 时间戳
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            FlowLog.write("模型文本输出完成", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              text: ctx.currentText.text,
              providerMetadata: value.providerMetadata,
            })
            ctx.currentText = undefined
            return

          case "finish":
            FlowLog.write("模型流 finish", {
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              event: value,
            })
            return

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      /**
       * 清理函数 — 在 process 结束（正常/异常/中断）后执行
       *
       * 处理未完成的资源：
       *  1. 如有未关闭的快照，生成 diff patch
       *  2. 如有未结束的 currentText，写入完成状态
       *  3. 如有未结束的 reasoningMap 中的推理 Part，写入完成状态
       *  4. 等待所有进行中的工具调用完成（250ms 超时）
       *  5. 未完成的工具调用标记为 error（"Tool execution aborted"）
       *  6. 更新 assistant 消息的 completed 时间
       */
      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      /**
       * 异常停止处理 — 将错误转为 MessageV2 错误格式并发布
       *
       * 特殊处理：
       *  - ContextOverflowError: 设置 needsCompaction，让循环触发压缩
       *  - 其他错误: 写入 assistant 消息的 error 字段，发布 Bus 事件，设置 idle
       */
      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        FlowLog.write("LLM processor 异常停止", {
          sessionID: ctx.sessionID,
          assistantMessageID: ctx.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) =>
                  status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                  }),
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
