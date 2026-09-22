import z from "zod"
// 引入 Effect 核心类型
import { Effect, Exit, Layer, PubSub, Scope, Context, Stream } from "effect"
// 引入 EffectBridge(用于把 Effect 操作桥接到非 Effect 环境)
import { EffectBridge } from "@/effect"
import { Log, Trace } from "../util"
// 引入总线事件定义工具
import { BusEvent } from "./bus-event"
// 引入全局事件总线(用于把实例事件转发给 TUI 等外部消费者)
import { GlobalBus } from "./global"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
// 引入运行时构建工具(把 Effect 服务包装为 Promise / Sync)
import { makeRuntime } from "@/effect/run-service"

// 本模块 logger 与 Trace
const log = Log.create({ service: "bus" })
const trace = Trace.create("bus", "packages/opencode/src/bus/index.ts")

/**
 * 实例被销毁时广播的事件
 */
export const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  z.object({
    directory: z.string(),
  }),
)

/**
 * 事件负载的通用形状:type + properties
 */
type Payload<D extends BusEvent.Definition = BusEvent.Definition> = {
  type: D["type"]
  properties: z.infer<D["properties"]>
}

/**
 * 每个 Instance 的状态:
 * - wildcard: 通配订阅(所有事件)
 * - typed:    按事件类型分别维护的 PubSub
 */
type State = {
  wildcard: PubSub.PubSub<Payload>
  typed: Map<string, PubSub.PubSub<Payload>>
}

/**
 * Bus 服务接口
 * - publish:              发布事件
 * - subscribe:            订阅指定类型事件(Stream)
 * - subscribeAll:         订阅所有事件(Stream)
 * - subscribeCallback:    以回调方式订阅指定类型
 * - subscribeAllCallback: 以回调方式订阅所有
 */
export interface Interface {
  readonly publish: <D extends BusEvent.Definition>(
    def: D,
    properties: z.output<D["properties"]>,
  ) => Effect.Effect<void>
  readonly subscribe: <D extends BusEvent.Definition>(def: D) => Stream.Stream<Payload<D>>
  readonly subscribeAll: () => Stream.Stream<Payload>
  readonly subscribeCallback: <D extends BusEvent.Definition>(
    def: D,
    callback: (event: Payload<D>) => unknown,
  ) => Effect.Effect<() => void>
  readonly subscribeAllCallback: (callback: (event: any) => unknown) => Effect.Effect<() => void>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/Bus") {}

/**
 * Bus 服务的 Layer 实现
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 按 Instance 隔离的状态
    const state = yield* InstanceState.make<State>(
      Effect.fn("Bus.state")(function* (ctx) {
        // 通配 PubSub
        const wildcard = yield* PubSub.unbounded<Payload>()
        // 按类型分别维护的 PubSub
        const typed = new Map<string, PubSub.PubSub<Payload>>()

        // 销毁时:先广播 InstanceDisposed,再关闭所有 PubSub
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // 在关闭前发布 InstanceDisposed,让订阅者能收到
            yield* PubSub.publish(wildcard, {
              type: InstanceDisposed.type,
              properties: { directory: ctx.directory },
            })
            yield* PubSub.shutdown(wildcard)
            for (const ps of typed.values()) {
              yield* PubSub.shutdown(ps)
            }
          }),
        )

        return { wildcard, typed }
      }),
    )

    /**
     * 获取或创建指定事件类型的 PubSub
     */
    function getOrCreate<D extends BusEvent.Definition>(state: State, def: D) {
      return Effect.gen(function* () {
        let ps = state.typed.get(def.type)
        if (!ps) {
          ps = yield* PubSub.unbounded<Payload>()
          state.typed.set(def.type, ps)
        }
        return ps as unknown as PubSub.PubSub<Payload<D>>
      })
    }

    /**
     * 发布事件:
     *  1. 向该类型的 PubSub 投递
     *  2. 向通配 PubSub 投递
     *  3. 转发到 GlobalBus(供 TUI / 外部进程消费)
     */
    function publish<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) {
      return Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const payload: Payload = { type: def.type, properties }
        log.info("publishing", { type: def.type })
        trace.info("Bus 发布事件到实例 PubSub", {
          type: def.type,
          properties,
          hasTypedSubscribers: s.typed.has(def.type),
        })

        const ps = s.typed.get(def.type)
        if (ps) yield* PubSub.publish(ps, payload)
        yield* PubSub.publish(s.wildcard, payload)

        // 转发到 GlobalBus,附带目录 / 项目 / workspace 信息
        const dir = yield* InstanceState.directory
        const context = yield* InstanceState.context
        const workspace = yield* InstanceState.workspaceID

        GlobalBus.emit("event", {
          directory: dir,
          project: context.project.id,
          workspace,
          payload,
        })
        trace.info("Bus 事件已转发到 GlobalBus，等待 TUI/事件流消费", {
          type: def.type,
          directory: dir,
          projectID: context.project.id,
          workspace,
        })
      })
    }

    /**
     * 以 Stream 形式订阅指定类型事件
     */
    function subscribe<D extends BusEvent.Definition>(def: D): Stream.Stream<Payload<D>> {
      log.info("subscribing", { type: def.type })
      trace.info("订阅指定类型 Bus 事件", { type: def.type })
      return Stream.unwrap(
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const ps = yield* getOrCreate(s, def)
          return Stream.fromPubSub(ps)
        }),
      ).pipe(Stream.ensuring(Effect.sync(() => log.info("unsubscribing", { type: def.type }))))
    }

    /**
     * 以 Stream 形式订阅所有事件
     */
    function subscribeAll(): Stream.Stream<Payload> {
      log.info("subscribing", { type: "*" })
      trace.info("订阅全部 Bus 事件", { type: "*" })
      return Stream.unwrap(
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          return Stream.fromPubSub(s.wildcard)
        }),
      ).pipe(Stream.ensuring(Effect.sync(() => log.info("unsubscribing", { type: "*" }))))
    }

    /**
     * 内部工具:向指定 PubSub 注册回调订阅
     * 返回一个注销函数(Effect)
     */
    function on<T>(pubsub: PubSub.PubSub<T>, type: string, callback: (event: T) => unknown) {
      return Effect.gen(function* () {
        log.info("subscribing", { type })
        trace.info("注册 Bus 回调订阅者", { type })
        // 用于在注销时从非 Effect 上下文触发 Scope.close
        const bridge = yield* EffectBridge.make()
        const scope = yield* Scope.make()
        const subscription = yield* Scope.provide(scope)(PubSub.subscribe(pubsub))

        // 在独立 Scope 中异步消费订阅流,每条消息调用 callback
        yield* Scope.provide(scope)(
          Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((msg) =>
              Effect.tryPromise({
                try: () => Promise.resolve().then(() => callback(msg)),
                catch: (cause) => {
                  log.error("subscriber failed", { type, cause })
                },
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          ),
        )

        // 返回注销函数
        return () => {
          log.info("unsubscribing", { type })
          trace.info("注销 Bus 回调订阅者", { type })
          bridge.fork(Scope.close(scope, Exit.void))
        }
      })
    }

    /**
     * 以回调方式订阅指定类型事件
     */
    const subscribeCallback = Effect.fn("Bus.subscribeCallback")(function* <D extends BusEvent.Definition>(
      def: D,
      callback: (event: Payload<D>) => unknown,
    ) {
      const s = yield* InstanceState.get(state)
      const ps = yield* getOrCreate(s, def)
      return yield* on(ps, def.type, callback)
    })

    /**
     * 以回调方式订阅所有事件
     */
    const subscribeAllCallback = Effect.fn("Bus.subscribeAllCallback")(function* (callback: (event: any) => unknown) {
      const s = yield* InstanceState.get(state)
      return yield* on(s.wildcard, "*", callback)
    })

    // 返回 Service 实例
    return Service.of({ publish, subscribe, subscribeAll, subscribeCallback, subscribeAllCallback })
  }),
)

// 默认 Layer 直接使用 layer
export const defaultLayer = layer

// 构造运行时
const { runPromise, runSync } = makeRuntime(Service, layer)

/**
 * Promise 版 publish
 */
// 此处使用 runSync 是安全的,因为订阅链路(InstanceState.get、PubSub.subscribe、
// Scope.make、Effect.forkScoped)均为同步;若后续某一步变为异步,这里会抛错。
export async function publish<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) {
  return runPromise((svc) => svc.publish(def, properties))
}

/**
 * 同步版 subscribeCallback,返回注销函数
 */
export function subscribe<D extends BusEvent.Definition>(
  def: D,
  callback: (event: { type: D["type"]; properties: z.infer<D["properties"]> }) => unknown,
) {
  return runSync((svc) => svc.subscribeCallback(def, callback))
}

/**
 * 同步版 subscribeAllCallback,返回注销函数
 */
export function subscribeAll(callback: (event: any) => unknown) {
  return runSync((svc) => svc.subscribeAllCallback(callback))
}

// 以命名空间形式导出
export * as Bus from "."
