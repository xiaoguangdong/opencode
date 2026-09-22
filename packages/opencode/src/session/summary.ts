import z from "zod"
// 引入 Effect 核心类型
import { Effect, Layer, Context } from "effect"
// 引入事件总线服务
import { Bus } from "@/bus"
// 引入快照服务(用于 diff)
import { Snapshot } from "@/snapshot"
// 引入存储服务(用于持久化 session diff)
import { Storage } from "@/storage"
// 引入 Session 模块
import * as Session from "./session"
// 引入消息类型
import { MessageV2 } from "./message-v2"
// 引入会话 ID / 消息 ID schema
import { SessionID, MessageID } from "./schema"

/**
 * 还原 git 的引号包裹路径(如 "a\u00e9b.txt")为原始字符串。
 * git 在输出中包含非 ASCII 或特殊字符的路径时,会用双引号包裹,并把不可打印字符转义为八进制或 \n/\t 等形式。
 */
function unquoteGitPath(input: string) {
  // 非引号包裹则原样返回
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  // 去掉两端的双引号
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    // 普通字符直接压入字节
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    // 结尾孤立的反斜杠,原样压入
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    // 八进制转义(1~3 位)
    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    // 常见单字符转义
    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  // 按 UTF-8 解码字节序列
  return Buffer.from(bytes).toString()
}

/**
 * SessionSummary 服务接口
 * - summarize:  根据会话内的 step-start/step-finish 快照计算整体 diff,并写回会话摘要
 * - diff:       读取会话已存储的 diff(会做一次 git 路径还原)
 * - computeDiff: 根据消息列表计算 diff
 */
export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

/**
 * SessionSummary 的 Layer 实现
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    /**
     * 根据消息列表计算整体 diff:
     * - from 取第一个带 snapshot 的 step-start
     * - to   取最后一个带 snapshot 的 step-finish
     * 两者都存在时,调用 snapshot.diffFull 计算差异
     */
    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        // 只取第一个 from
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        // to 持续覆盖,最终为最后一个
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    /**
     * 计算并写回会话摘要:
     *  1. 计算整个会话的 diff,写入 session.summary(additions/deletions/files)
     *  2. 持久化 diff 到 storage(["session_diff", sessionID])
     *  3. 广播 Session.Event.Diff 事件
     *  4. 若指定了 messageID,则单独计算该消息(及对应 assistant 消息)的 diff 并写回其 summary
     */
    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      // 读取该会话的所有消息
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      if (!all.length) return

      // 计算全量 diff
      const diffs = yield* computeDiff({ messages: all })
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      // 持久化到 storage,失败忽略
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      // 广播 diff 事件
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })

      // 计算指定消息的局部 diff(该 user 消息 + 其下所有 assistant 消息)
      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const msgDiffs = yield* computeDiff({ messages })
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
    })

    /**
     * 读取该会话已存储的 diff:
     *  - 对每项 file 做一次 git 路径还原
     *  - 若发生变更,则把还原后的结果写回 storage
     */
    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      // 有变化才写回
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    // 返回 Service 实例
    return Service.of({ summarize, diff, computeDiff })
  }),
)

// 默认 Layer:装配 Session / Snapshot / Storage / Bus 依赖
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

// diff 接口的输入 schema
export const DiffInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
})

// 以命名空间形式导出
export * as SessionSummary from "./summary"
