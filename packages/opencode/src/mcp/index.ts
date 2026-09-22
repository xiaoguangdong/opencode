// 引入 AI SDK 的动态工具与 JSON Schema 类型
import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
// 引入 MCP SDK 客户端与各种传输方式
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
// 引入 MCP 未授权错误
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
// 引入 MCP 工具结果 schema 与工具列表变更通知 schema
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config"
import { ConfigMCP } from "../config/mcp"
import { Log } from "../util"
import { NamedError } from "@opencode-ai/shared/util/error"
import z from "zod/v4"
import { Installation } from "../installation"
import { InstallationVersion } from "../installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
// 引入 OAuth 相关模块
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
// Effect 核心类型
import { Effect, Exit, Layer, Option, Context, Stream } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"

// 创建本模块 logger
const log = Log.create({ service: "mcp" })
// 默认连接超时时间(30s)
const DEFAULT_TIMEOUT = 30_000

/**
 * MCP 资源(resource)的元信息
 */
export const Resource = z
  .object({
    name: z.string(),
    uri: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    client: z.string(),
  })
  .meta({ ref: "McpResource" })
export type Resource = z.infer<typeof Resource>

// 某个 MCP 服务器的工具列表变更事件
export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  z.object({
    server: z.string(),
  }),
)

// 打开浏览器失败事件(用于 TUI 提示)
export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  z.object({
    mcpName: z.string(),
    url: z.string(),
  }),
)

// MCP 连接/操作失败错误
export const Failed = NamedError.create(
  "MCPFailed",
  z.object({
    name: z.string(),
  }),
)

// MCP 客户端类型别名
type MCPClient = Client

/**
 * MCP 服务器状态(联合类型,按 status 判别)
 * - connected:                  已连接
 * - disabled:                   已禁用
 * - failed:                     连接失败(带 error)
 * - needs_auth:                 需要鉴权
 * - needs_client_registration:  需要预注册 client ID
 */
export const Status = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("connected"),
      })
      .meta({
        ref: "MCPStatusConnected",
      }),
    z
      .object({
        status: z.literal("disabled"),
      })
      .meta({
        ref: "MCPStatusDisabled",
      }),
    z
      .object({
        status: z.literal("failed"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusFailed",
      }),
    z
      .object({
        status: z.literal("needs_auth"),
      })
      .meta({
        ref: "MCPStatusNeedsAuth",
      }),
    z
      .object({
        status: z.literal("needs_client_registration"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusNeedsClientRegistration",
      }),
  ])
  .meta({
    ref: "MCPStatus",
  })
export type Status = z.infer<typeof Status>

// 存放支持 OAuth 的远端传输实例,用于后续 finishAuth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt 缓存类型
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

/**
 * 判断某个配置项是否为合法的 MCP 配置(对象且带 type 字段)
 */
function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

// 把字符串中的非法字符替换为下划线,用于生成安全的工具名
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * 把 MCP 工具定义转换为 AI SDK 的 Tool
 * - 强制 inputSchema 的 type 为 "object"
 * - additionalProperties 置 false
 * - execute 直接调用 MCP 客户端的 callTool
 */
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema

  // 先展开,再覆盖 type 确保始终为 "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          timeout,
        },
      )
    },
  })
}

/**
 * 获取某个 MCP 客户端的工具列表(带超时),失败返回 undefined
 */
function defs(key: string, client: MCPClient, timeout?: number) {
  return Effect.tryPromise({
    try: () => withTimeout(client.listTools(), timeout ?? DEFAULT_TIMEOUT),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

/**
 * 从某个 MCP 客户端拉取一类资源(prompts / resources):
 * - 结果以 `sanitized(clientName):sanitized(item.name)` 为 key 组织为对象
 * - 失败返回 undefined
 */
function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

// create 的返回结构
interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

// startAuth 的返回结构
interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

// 按 Instance 隔离的状态:每个项目实例维护自己的 MCP 状态
interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
}

/**
 * MCP 服务接口
 */
export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void>
  readonly disconnect: (name: string) => Effect.Effect<void>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (mcpName: string) => Effect.Effect<{ authorizationUrl: string; oauthState: string }>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

/**
 * MCP 服务的 Layer 实现
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

    // 三种传输方式的联合
    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * 使用指定 transport 创建并连接 client:
     * - 成功:调用方接管 client
     * - 失败:关闭 transport(资源安全)
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "opencode", version: InstallationVersion })
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    // 禁用状态的固定返回
    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    /**
     * 连接远端 MCP 服务器:
     *  - 依次尝试 StreamableHTTP 和 SSE 两种传输
     *  - 遇鉴权错误时标记 needs_auth / needs_client_registration 并广播 TUI 提示
     *  - 遇其它错误时记录 failed 状态,继续尝试下一个 transport
     */
    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      // 未显式禁用 OAuth 时构造 OAuth Provider
      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      // 待尝试的传输列表(按优先级)
      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            // 判断是否为鉴权错误(UnauthorizedError 或消息中包含 OAuth)
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              // 需要预注册 client ID 的情形
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                // 普通需要鉴权:暂存 transport 供 finishAuth 使用
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            // 非鉴权错误:记录 failed 状态,继续尝试下一个 transport
            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // 若为鉴权错误则停止尝试其它传输
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    /**
     * 连接本地 MCP 服务器(通过 stdio 启动子进程)
     */
    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          // 当命令为 opencode 自身时,设置 BUN_BE_BUN
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      // 转发 stderr 到日志
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    /**
     * 创建 MCP 客户端:
     *  - 根据 type 走 remote 或 local
     *  - 成功后拉取工具列表(defs)
     *  - 失败时把 client 关闭并返回错误状态
     */
    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    /**
     * 递归查找某个进程的所有后代进程 PID(通过 pgrep -P)
     * Windows 直接返回空数组
     */
    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    /**
     * 监听 MCP 客户端的"工具列表变更"通知:
     *  - 校验 client 和 status 仍有效
     *  - 重新拉取工具并更新状态,广播 ToolsChanged
     */
    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    // 按 Instance 隔离的状态
    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          status: {},
          clients: {},
          defs: {},
        }

        // 逐个初始化配置中的 MCP 服务器
        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        // 状态销毁时关闭所有客户端,并终止其派生的子进程
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    /**
     * 关闭某个客户端,并清理其工具缓存
     */
    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    /**
     * 存储/更新客户端及其工具定义,并挂上 tools 变更监听
     */
    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    /**
     * 返回配置中所有 MCP 服务器的状态(未在 state 中的按 disabled 处理)
     */
    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    /**
     * 返回所有已连接的客户端
     */
    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    /**
     * 创建并存储客户端(用于 add / connect 场景)
     */
    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    /**
     * 新增一个 MCP 服务器(运行时)
     */
    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    /**
     * 连接配置中已有的某个 MCP 服务器
     */
    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* getMcpConfig(name)
      if (!mcp) {
        log.error("MCP config not found or invalid", { name })
        return
      }
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    /**
     * 断开某个 MCP 服务器并标记为 disabled
     */
    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    /**
     * 收集所有已连接 MCP 服务器的工具,转换为 AI SDK Tool 并返回:
     * key 为 `sanitized(clientName)_sanitized(toolName)`
     */
    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            for (const mcpTool of listed) {
              result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
            }
          }),
        { concurrency: "unbounded" },
      )
      return result
    })

    /**
     * 从所有已连接的客户端并发收集某一类资源(prompts / resources)
     */
    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    /**
     * 收集所有 prompts
     */
    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    /**
     * 收集所有 resources
     */
    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    /**
     * 在指定客户端上执行一个 Promise 操作,失败返回 undefined
     */
    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    /**
     * 获取某个客户端的指定 prompt
     */
    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    /**
     * 读取某个客户端的指定 resource
     */
    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    /**
     * 从配置中读取指定名字的 MCP 配置项
     */
    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    /**
     * 开始一次 OAuth 授权流程:
     *  - 校验 MCP 配置为 remote 且未禁用 OAuth
     *  - 启动回调服务并生成 state
     *  - 创建 OAuth Provider 并尝试连接,捕获重定向 URL
     *  - 若首次连接即成功,直接返回 client
     */
    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) throw new Error(`MCP server ${mcpName} not found or disabled`)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)

      // OAuth 配置可选 - 未提供则使用自动发现
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // 启动回调服务器(使用自定义 redirectUri,如果配置了)
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(oauthConfig?.redirectUri))

      // 生成 32 字节随机 state
      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: oauthConfig?.redirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "opencode", version: InstallationVersion })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          // 遇到 Unauthorized 且捕获到重定向 URL,说明需要用户去授权
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    /**
     * 完整执行一次 OAuth 授权:
     *  - 调用 startAuth,若无 authorizationUrl 则说明已直接连通
     *  - 否则打开浏览器、等待回调、校验 state、finishAuth
     */
    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      // 无需浏览器跳转:已直接连通
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* getMcpConfig(mcpName)
        if (!mcpConfig) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "MCP config not found after auth" } as Status
        }

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      // 等待回调返回 code
      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      // 尝试打开浏览器(失败则广播 BrowserOpenFailed,让用户手动打开)
      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      // 校验 OAuth state 防止 CSRF
      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    /**
     * 完成 OAuth:用 authorizationCode 调用 transport.finishAuth,然后重新连接
     */
    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return { status: "failed", error: "MCP config not found after auth" } as Status

      return yield* createAndStore(mcpName, mcpConfig)
    })

    /**
     * 移除某个 MCP 服务器的 OAuth 凭据并取消未完成的回调等待
     */
    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    /**
     * 判断某 MCP 服务器是否支持 OAuth(remote 且未显式禁用)
     */
    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return false
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    /**
     * 判断某 MCP 服务器是否已保存 token
     */
    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    /**
     * 返回某 MCP 服务器的鉴权状态
     */
    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    // 返回 Service 实例
    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

// 鉴权状态类型
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

// 默认 Layer:装配 McpAuth / Bus / Config / CrossSpawnSpawner / AppFileSystem
export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

// 以命名空间形式导出
export * as MCP from "."
