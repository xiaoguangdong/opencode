// 引入事件总线服务
import { Bus } from "@/bus"
// 引入事件总线事件定义工具
import { BusEvent } from "@/bus/bus-event"
// 引入配置中的权限信息类型
import { ConfigPermission } from "@/config/permission"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
// 引入项目 ID schema
import { ProjectID } from "@/project/schema"
// 引入消息 ID / 会话 ID schema
import { MessageID, SessionID } from "@/session/schema"
// 引入权限持久化表
import { PermissionTable } from "@/session/session.sql"
// 引入数据库工具
import { Database, eq } from "@/storage"
// 引入 Schema <-> zod 桥接
import { zod } from "@/util/effect-zod"
// 引入日志与 Trace
import { Log, Trace } from "@/util"
// 引入给 Schema 附加静态属性的工具
import { withStatics } from "@/util/schema"
// 引入通配符匹配工具
import { Wildcard } from "@/util"
// 引入 Effect 核心类型
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
// 引入规则评估函数
import { evaluate as evalRule } from "./evaluate"
// 引入 PermissionID schema
import { PermissionID } from "./schema"

// 创建本模块 logger 与 Trace
const log = Log.create({ service: "permission" })
const trace = Trace.create("permission", "packages/opencode/src/permission/index.ts")

/**
 * 权限动作:allow / deny / ask
 */
export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

/**
 * 一条权限规则:
 * - permission: 权限名(例如 read / edit / bash)
 * - pattern:    匹配模式(可为通配符)
 * - action:     allow / deny / ask
 */
export class Rule extends Schema.Class<Rule>("PermissionRule")({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}) {
  static readonly zod = zod(this)
}

// 规则集:Rule 的数组
export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

/**
 * 一次权限请求
 * - id / sessionID:     请求 ID 与会话 ID
 * - permission:         权限名
 * - patterns:           待检查的模式列表
 * - metadata:           附加元数据
 * - always:             "always" 允许后要固化的模式列表
 * - tool:               关联的工具调用信息(可选)
 */
export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

// 用户回复:一次允许 / 始终允许 / 拒绝
export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

// 回复结构公共字段(回复类型 + 可选反馈消息)
const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

// 回复请求体 schema
export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

/**
 * 已批准的规则(持久化到项目级)
 */
export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

/**
 * 权限相关总线事件
 * - Asked:   请求权限
 * - Replied: 用户回复
 */
export const Event = {
  Asked: BusEvent.define("permission.asked", Request.zod),
  Replied: BusEvent.define(
    "permission.replied",
    zod(
      Schema.Struct({
        sessionID: SessionID,
        requestID: PermissionID,
        reply: Reply,
      }),
    ),
  ),
}

// 用户直接拒绝
export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

// 用户带反馈拒绝
export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

// 规则命中 deny
export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

// 权限错误的联合类型
export type Error = DeniedError | RejectedError | CorrectedError

/**
 * 请求权限的输入(规则集 + 请求体,id 可省略)
 */
export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

/**
 * 回复权限请求的输入
 */
export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

/**
 * Permission 服务接口
 * - ask:   发起一次权限检查,必要时等待用户审批
 * - reply: 用户对某次请求的回复
 * - list:  列出当前挂起的请求
 */
export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

// 挂起请求的条目:请求信息 + 等待中的 Deferred
interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

// 按 Instance 隔离的状态
interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

/**
 * 评估权限规则(对外导出,便于测试/复用)
 * 会记录日志和 Trace。
 */
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  log.info("evaluate", { permission, pattern, ruleset: rulesets.flat() })
  const result = evalRule(permission, pattern, ...rulesets)
  trace.info("Permission 规则评估完成", {
    permission,
    pattern,
    ruleset: rulesets.flat(),
    result,
  })
  return result
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

/**
 * Permission 服务的 Layer 实现
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    // 按 Instance 隔离的状态
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        // 从数据库读取该项目已批准的规则集
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: row?.data ?? [],
        }

        // 销毁时把所有挂起请求置为拒绝,避免悬挂
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    /**
     * 发起权限检查:
     *  1. 对每个 pattern 求值,遇到 deny 立即抛 DeniedError
     *  2. 全部 allow 则直接返回
     *  3. 存在 ask 则创建挂起请求,广播 permission.asked 并等待用户回复
     */
    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false
      trace.info("Permission 收到权限检查请求", {
        permission: request.permission,
        sessionID: request.sessionID,
        patterns: request.patterns,
        metadata: request.metadata,
        tool: request.tool,
        ruleset,
        approved,
      })

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        // 命中 deny 立即拒绝
        if (rule.action === "deny") {
          trace.warn("Permission 根据规则直接拒绝", {
            permission: request.permission,
            pattern,
            rule,
          })
          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        // 命中 allow 继续检查下一个
        if (rule.action === "allow") continue
        needsAsk = true
      }

      // 无需询问则直接通过
      if (!needsAsk) {
        trace.info("Permission 根据规则直接允许", {
          permission: request.permission,
          patterns: request.patterns,
        })
        return
      }

      // 生成请求 ID,构造请求信息
      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })
      trace.info("Permission 需要用户审批，发布 permission.asked", {
        requestID: id,
        request: info,
      })

      // 创建 Deferred 并登记到 pending,广播事件后等待回复
      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    /**
     * 处理用户回复:
     *  - reject: 若带 message 则 CorrectedError,否则 RejectedError;
     *            同时拒绝同会话所有其它挂起请求
     *  - once:   仅本次允许
     *  - always: 将 always 里的 patterns 固化到 approved,并放行同会话中已满足规则的挂起请求
     */
    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      trace.info("Permission 收到用户审批回复", {
        requestID: input.requestID,
        reply: input.reply,
        message: input.message,
        found: Boolean(existing),
      })
      if (!existing) return

      pending.delete(input.requestID)
      trace.info("Permission 发布 permission.replied", {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      // 广播 replied 事件
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      // 拒绝分支
      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        // 拒绝同会话所有其它挂起请求
        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
        return
      }

      // 放行当前请求
      yield* Deferred.succeed(existing.deferred, undefined)
      // once 分支到此为止
      if (input.reply === "once") return

      // always:把 always 中的 patterns 固化到 approved
      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      // 尝试自动放行同会话中已被现有规则覆盖的挂起请求
      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    /**
     * 列出所有挂起请求
     */
    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

/**
 * 展开路径中的 ~ / $HOME 占位符
 */
function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

/**
 * 从用户配置构造规则集:
 *  - 把顶层 key 中的通配符(如 `*`、`mcp_*`)排到前面,具体规则排到后面。
 *    与 evaluate 中的 findLast 配合,得到"具体规则覆盖 `*` 兜底"的语义,
 *    不受用户 JSON 键顺序影响。
 *  - 单个 permission key 内部的子 pattern 顺序保持原样,只对顶层 key 排序。
 */
export function fromConfig(permission: ConfigPermission.Info) {
  const entries = Object.entries(permission).sort(([a], [b]) => {
    const aWild = a.includes("*")
    const bWild = b.includes("*")
    return aWild === bWild ? 0 : aWild ? -1 : 1
  })
  const ruleset: Ruleset = []
  for (const [key, value] of entries) {
    // 值为字符串时:action 为该字符串,pattern 取 "*"
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    // 值为对象时:展开为多条 (pattern -> action) 规则
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

/**
 * 合并多个规则集(简单拼接)
 */
export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

// 编辑类工具统一归入 "edit" 权限
const EDIT_TOOLS = ["edit", "write", "apply_patch"]

/**
 * 计算被禁用的工具集合:
 *  - 编辑类工具映射到 "edit" 权限
 *  - 使用 findLast 找最具体的匹配规则
 *  - 命中 pattern="*" 且 action="deny" 时视为禁用
 */
export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

// 默认 Layer:装配 Bus 依赖
export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

// 以命名空间形式导出
export * as Permission from "."
