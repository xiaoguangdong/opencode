// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
// 引入 Runner(用于管理每个会话的运行循环)
import { Runner } from "@/effect"
// 引入 Effect 核心类型:Layer / Scope / Context
import { Effect, Layer, Scope, Context } from "effect"
// 引入 Session 模块(用于 BusyError)
import * as Session from "./session"
// 引入消息类型
import { MessageV2 } from "./message-v2"
// 引入会话 ID schema
import { SessionID } from "./schema"
// 引入会话状态服务
import { SessionStatus } from "./status"
// 引入 Trace 工具
import { Trace } from "@/util"

// 创建本模块的 Trace 实例
const trace = Trace.create("session.run-state", "packages/opencode/src/session/run-state.ts")

/**
 * SessionRunState 服务对外接口
 * - assertNotBusy: 断言会话当前不忙,否则抛 BusyError
 * - cancel:        取消当前会话正在运行的任务
 * - ensureRunning: 确保会话正在运行主循环(若已在运行则复用)
 * - startShell:    以 shell 模式启动任务(独立于主循环的另一种运行方式)
 */
export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

/**
 * SessionRunState 的 Layer 实现
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖:会话状态服务
    const status = yield* SessionStatus.Service

    // 按 Instance 隔离的状态:每个项目实例维护自己的 runner 映射
    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        // 当前状态的 Scope,用于管理 runner 生命周期
        const scope = yield* Scope.Scope
        // sessionID -> Runner 映射
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        // 状态销毁时,取消所有 runner 并清空
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    /**
     * 获取(或创建)指定会话的 Runner
     * - 若已存在,则复用并记录 trace
     * - 若不存在,则创建并注册到 runners
     */
    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) {
        trace.info("RunState 复用已有 session runner", {
          sessionID,
          busy: existing.busy,
        })
        return existing
      }
      trace.info("RunState 创建新的 session runner", { sessionID })
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        // 空闲时:从 runners 中移除,并把会话状态置为 idle
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          trace.info("RunState runner 进入 idle", { sessionID })
          yield* status.set(sessionID, { type: "idle" })
        }),
        // 忙碌时:把会话状态置为 busy
        onBusy: Effect.gen(function* () {
          trace.info("RunState runner 进入 busy", { sessionID })
          yield* status.set(sessionID, { type: "busy" })
        }),
        // 中断回调
        onInterrupt,
        // 已忙碌时抛 BusyError
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    /**
     * 断言会话不忙:若已有 runner 且处于 busy,则抛 BusyError
     */
    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      trace.info("RunState 检查会话是否忙碌", {
        sessionID,
        found: Boolean(existing),
        busy: existing?.busy,
      })
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    /**
     * 取消指定会话的当前运行
     * - 若不存在或未 busy,则直接把状态置为 idle
     * - 否则调用 runner.cancel
     */
    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      trace.info("RunState 收到取消请求", {
        sessionID,
        found: Boolean(existing),
        busy: existing?.busy,
      })
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    /**
     * 确保会话主循环运行(若已有 runner 则复用)
     */
    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      trace.info("RunState 确保会话运行主循环", { sessionID })
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    /**
     * 以 shell 模式启动任务
     */
    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      trace.info("RunState 启动 shell 模式任务", { sessionID })
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work)
    })

    // 返回 Service 实例
    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

// 默认 Layer:把 SessionStatus 的默认 Layer 装配进来
export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

// 以命名空间形式导出
export * as SessionRunState from "./run-state"
