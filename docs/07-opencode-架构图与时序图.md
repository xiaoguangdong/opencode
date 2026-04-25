# opencode 架构图与时序图

本文基于当前代码结构整理，核心代码主要在 `packages/opencode/src`，外围包括 `packages/app`、`packages/desktop-electron`、`packages/sdk/js`、`packages/console/*`。

## 总体架构

```mermaid
flowchart TB
  User[用户]

  subgraph Clients[客户端入口]
    CLI[CLI: packages/opencode/src/index.ts]
    TUI[TUI/Terminal UI]
    WebApp[Web App: packages/app]
    Desktop[Desktop Electron: packages/desktop-electron]
    SDK[JS SDK: packages/sdk/js]
    Slack[Slack/其他集成]
  end

  subgraph Core[opencode Core: packages/opencode]
    Server[Hono Server]
    Routes[Instance Routes\n/session /event /provider /file /mcp /pty]
    Instance[Project Instance\n目录/工作树/项目上下文]
    Runtime[Effect Runtime + Layers]
    Session[Session Service\n会话/消息/Parts]
    Prompt[SessionPrompt\n构造用户消息/系统提示/工具]
    Processor[SessionProcessor\n消费 LLM stream]
    LLM[LLM Service\nAI SDK streamText]
    Provider[Provider Service\n模型/鉴权/SDK适配]
    ToolRegistry[ToolRegistry]
    Tools[内置工具\nbash/read/write/edit/grep/glob/task/skill...]
    MCP[MCP Clients/Tools]
    Plugin[Plugin Hooks]
    Permission[Permission/Question]
    Bus[Bus + GlobalBus\n事件发布订阅]
    Storage[SQLite + Drizzle\nSession/Part/Project...]
    Project[Project/VCS/File/LSP/Snapshot]
  end

  subgraph External[外部系统]
    AIProviders[AI Providers\nOpenAI/Anthropic/GitHub Copilot/OpenRouter/...]
    FS[本地文件系统/Git]
    Shell[Shell/PTY/子进程]
    RemoteMCP[MCP Servers]
    Console[Console/Control Plane\npackages/console]
  end

  User --> CLI
  User --> WebApp
  User --> Desktop
  CLI --> SDK
  WebApp --> SDK
  Desktop --> WebApp
  Desktop --> Server
  SDK --> Server
  Slack --> SDK

  Server --> Routes
  Routes --> Instance
  Instance --> Runtime
  Runtime --> Session
  Routes --> Prompt
  Prompt --> Session
  Prompt --> Provider
  Prompt --> ToolRegistry
  Prompt --> Processor
  Prompt --> Plugin
  Prompt --> Permission
  Prompt --> MCP

  Processor --> LLM
  Processor --> Session
  Processor --> Bus
  Processor --> Project

  LLM --> Provider
  LLM --> Plugin
  LLM --> AIProviders
  LLM --> Tools

  ToolRegistry --> Tools
  ToolRegistry --> MCP
  ToolRegistry --> Plugin
  Tools --> FS
  Tools --> Shell
  MCP --> RemoteMCP

  Session --> Storage
  Project --> FS
  Project --> Storage
  Bus --> Routes
  Routes --> Bus
  Server --> Console
```

## 组件职责

| 组件 | 主要职责 | 关键路径 |
|---|---|---|
| CLI | 命令解析、运行 `run/serve/web/session` 等命令 | `packages/opencode/src/index.ts`, `src/cli/cmd/*` |
| Server | Hono HTTP/SSE/WebSocket 服务，统一暴露 API | `src/server/server.ts`, `src/server/routes/instance/*` |
| Instance | 每个目录/项目的运行上下文，管理 project/worktree 生命周期 | `src/project/instance.ts`, `src/project/bootstrap.ts` |
| Session | 会话、消息、消息 part 的持久化和事件 | `src/session/session.ts`, `src/session/session.sql.ts` |
| SessionPrompt | 一轮用户输入的主编排：创建消息、解析 agent/model、准备 tools、启动 processor | `src/session/prompt.ts` |
| SessionProcessor | 消费 AI SDK stream，更新 text/reasoning/tool/patch parts，处理重试/压缩/错误 | `src/session/processor.ts` |
| LLM | 组装 system/messages/tools/headers/providerOptions，调用 `ai.streamText` | `src/session/llm.ts` |
| Provider | 模型发现、鉴权、provider SDK 动态加载和模型适配 | `src/provider/provider.ts` |
| ToolRegistry/Tools | 内置工具、插件工具、MCP 工具注册与执行 | `src/tool/registry.ts`, `src/tool/*.ts` |
| Bus | 实例级 PubSub + GlobalBus，把事件推送给 SSE/TUI/UI | `src/bus/index.ts`, `src/server/routes/instance/event.ts` |
| Storage | SQLite/Drizzle，存储 session/project/message parts | `src/storage/*`, `src/**/*.sql.ts` |
| Web/Desktop | Solid UI 和 Electron 宿主，连接本地/远端 opencode server | `packages/app`, `packages/desktop-electron` |
| SDK | 生成/封装 HTTP client/server，供 CLI/Web/外部集成使用 | `packages/sdk/js/src/v2` |

## CLI Run 时序

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant CLI as CLI run 命令
  participant Bootstrap as Instance Bootstrap
  participant SDK as Opencode SDK Client
  participant Server as In-process Hono Server
  participant SessionAPI as /session routes
  participant EventAPI as /event SSE
  participant Bus as Bus

  U->>CLI: opencode run "message"
  CLI->>CLI: 解析参数、文件、stdin、权限规则
  alt --attach
    CLI->>SDK: createOpencodeClient(remote baseUrl)
  else local
    CLI->>Bootstrap: bootstrap(process.cwd())
    Bootstrap->>Bootstrap: 初始化 Config/Plugin/LSP/File/VCS/Snapshot
    CLI->>SDK: createOpencodeClient(fetch=Server.Default().app.fetch)
  end

  CLI->>SDK: session.create 或选择已有 session
  SDK->>Server: POST /session
  Server->>SessionAPI: 路由处理
  SessionAPI-->>SDK: sessionID

  CLI->>SDK: event.subscribe()
  SDK->>EventAPI: GET /event
  EventAPI->>Bus: subscribeAll()

  CLI->>SDK: session.prompt(sessionID, parts)
  SDK->>Server: POST /session/:id/message 或 prompt route
  Server->>SessionAPI: 进入 SessionPrompt

  Bus-->>EventAPI: message/session/tool/status 事件
  EventAPI-->>CLI: SSE events
  CLI->>CLI: 渲染文本、工具结果、错误、idle 后退出
```

## Server/Instance 请求时序

```mermaid
sequenceDiagram
  autonumber
  participant Client as SDK/Web/CLI
  participant Server as Hono Server
  participant Middleware as Auth/Logger/Cors/InstanceMiddleware
  participant Instance as Instance.provide
  participant Bootstrap as InstanceBootstrap
  participant Route as Instance Route Handler
  participant Effect as AppRuntime/Effect Services

  Client->>Server: HTTP request + directory/header/query
  Server->>Middleware: 全局中间件
  Middleware->>Middleware: 鉴权、日志、压缩、CORS
  Middleware->>Instance: provide(directory)
  alt instance 首次创建
    Instance->>Bootstrap: init()
    Bootstrap->>Effect: Config.get()
    Bootstrap->>Effect: Plugin.init()
    Bootstrap->>Effect: fork LSP/File/VCS/Snapshot/FileWatcher
  end
  Instance->>Route: 在项目上下文中执行 next()
  Route->>Effect: runRequest/jsonRequest
  Effect-->>Route: service result
  Route-->>Client: JSON/SSE/WebSocket response
```

## Session Prompt + LLM 主链路

```mermaid
sequenceDiagram
  autonumber
  participant API as SessionRoutes
  participant Prompt as SessionPrompt
  participant Session as Session Service
  participant Agent as Agent Service
  participant Provider as Provider Service
  participant Registry as ToolRegistry/MCP
  participant Processor as SessionProcessor
  participant LLM as LLM Service
  participant AI as AI Provider
  participant Bus as Bus

  API->>Prompt: prompt({sessionID, parts, agent, model})
  Prompt->>Session: get session / cleanup revert
  Prompt->>Agent: resolve default or requested agent
  Prompt->>Provider: resolve model
  Prompt->>Session: create user message + user parts
  Prompt->>Session: create assistant message
  Prompt->>Processor: create({assistantMessage, sessionID, model})
  Prompt->>Registry: tools({model, providerID, agent})
  Registry-->>Prompt: builtin/custom/MCP tools
  Prompt->>Session: load history + convert to model messages
  Prompt->>Processor: process(streamInput)
  Processor->>LLM: stream(system, messages, tools, model)
  LLM->>Provider: getLanguage/getProvider/auth/config
  LLM->>AI: streamText(...)
  AI-->>LLM: fullStream events
  LLM-->>Processor: start/text/tool/finish events
  Processor->>Session: update message parts
  Processor->>Bus: publish status/errors/events
```

## 工具调用时序

```mermaid
sequenceDiagram
  autonumber
  participant AI as AI Provider stream
  participant Processor as SessionProcessor
  participant Prompt as Tool wrapper in SessionPrompt
  participant Permission as Permission Service
  participant Tool as Builtin/MCP/Plugin Tool
  participant Session as Session Service
  participant Plugin as Plugin Hooks
  participant Bus as Bus

  AI-->>Processor: tool-input-start
  Processor->>Session: create pending tool part
  AI-->>Processor: tool-call(name,input)
  Processor->>Session: mark tool running + input
  AI->>Prompt: execute tool(input)

  Prompt->>Permission: ask if needed
  alt rejected
    Permission-->>Prompt: reject
    Prompt-->>AI: tool error
    Processor->>Session: mark tool error
    Processor->>Bus: session.error/status
  else approved
    Prompt->>Plugin: tool.execute.before
    Prompt->>Tool: execute(args, ctx)
    Tool->>Tool: 读写文件/运行 bash/grep/glob/MCP/task...
    Tool-->>Prompt: {title, output, metadata, attachments}
    Prompt->>Plugin: tool.execute.after
    Prompt-->>AI: tool result
    AI-->>Processor: tool-result
    Processor->>Session: mark tool completed
    Processor->>Bus: message.part.updated
  end
```

## 事件流时序

```mermaid
sequenceDiagram
  autonumber
  participant UI as CLI/Web/TUI
  participant EventRoute as GET /event
  participant Bus as Instance Bus
  participant GlobalBus as GlobalBus
  participant Services as Session/Processor/Permission/etc

  UI->>EventRoute: subscribe SSE
  EventRoute-->>UI: server.connected
  EventRoute->>Bus: subscribeAll()
  loop heartbeat
    EventRoute-->>UI: server.heartbeat
  end

  Services->>Bus: publish(Event, properties)
  Bus->>Bus: publish typed + wildcard PubSub
  Bus->>GlobalBus: emit directory/project/workspace payload
  Bus-->>EventRoute: event payload
  EventRoute-->>UI: SSE data JSON

  Services->>Bus: publish InstanceDisposed
  Bus-->>EventRoute: server.instance.disposed
  EventRoute-->>UI: final event
  EventRoute->>EventRoute: unsubscribe + close
```

## Provider/模型解析时序

```mermaid
sequenceDiagram
  autonumber
  participant LLM as LLM Service
  participant Provider as Provider Service
  participant Config as Config
  participant Auth as Auth
  participant Env as Env
  participant Plugin as Plugin
  participant SDK as AI SDK Provider Package
  participant AI as External AI API

  LLM->>Provider: getLanguage(model)
  Provider->>Config: get provider config
  Provider->>Auth: get credentials/oauth/api key
  Provider->>Env: read provider env vars
  Provider->>Plugin: provider/model hooks if configured
  Provider->>SDK: dynamic import bundled/custom provider
  SDK-->>Provider: languageModel/chat/responses
  Provider-->>LLM: LanguageModelV3
  LLM->>AI: streamText(model, messages, tools, headers)
  AI-->>LLM: stream response
```

## Desktop 启动时序

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant Electron as Electron Main
  participant Migration as SQLite Migration
  participant Sidecar as Local opencode Server
  participant Window as Renderer Window
  participant App as Solid App
  participant SDK as SDK/API Client

  U->>Electron: 打开 OpenCode Desktop
  Electron->>Electron: 设置 app id、protocol、menu、single instance
  Electron->>Migration: 检查/执行 SQLite migration
  Migration-->>Electron: progress/done
  Electron->>Sidecar: spawnLocalServer(host, port, password)
  Sidecar-->>Electron: listener + health
  Electron->>Window: createMainWindow()
  Window->>App: 加载 UI
  App->>SDK: 使用 sidecar url + basic auth
  SDK->>Sidecar: 调用 /session /event /provider 等 API
```

## Web App 连接时序

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant App as Solid Web App
  participant ServerCtx as ServerProvider
  participant Health as Health Check
  participant SDK as SDK/API Client
  participant Server as opencode Server

  U->>App: 打开 Web UI
  App->>ServerCtx: 初始化 server list/active server
  ServerCtx->>Health: 每 10s 检查 server health
  Health->>Server: health/API request
  Server-->>Health: healthy/unhealthy
  App->>SDK: 使用 active server
  SDK->>Server: list projects/sessions/providers
  App->>Server: GET /event
  Server-->>App: SSE events
  U->>App: 发送 prompt
  App->>SDK: session.prompt()
  SDK->>Server: session API
  Server-->>App: events drive UI updates
```

## 数据流总结

```mermaid
flowchart LR
  Input[用户输入/文件/命令] --> Prompt[SessionPrompt]
  Prompt --> UserMsg[User Message + Parts]
  UserMsg --> DB[(SQLite)]
  Prompt --> Tools[Tool definitions]
  Prompt --> Processor[SessionProcessor]
  Processor --> LLM[LLM stream]
  LLM --> Provider[Provider adapter]
  Provider --> AI[外部模型]
  AI --> Events[Stream events]
  Events --> Processor
  Processor --> Parts[Text/Reasoning/Tool/Patch Parts]
  Parts --> DB
  Processor --> Bus[Bus events]
  Bus --> SSE["/event SSE"]
  SSE --> UI[CLI/Web/Desktop/TUI]
```

## 关键架构边界

| 边界 | 当前设计 |
|---|---|
| 客户端到核心 | 全部尽量通过 HTTP/SSE SDK 访问，即使 CLI 本地 run 也用 in-process fetch 调 Server |
| 项目隔离 | `Instance.provide(directory)` 建立目录级上下文，`InstanceState` 管理每个实例服务状态 |
| 业务编排 | `SessionPrompt` 是一轮对话的入口编排，`SessionProcessor` 专注消费流事件 |
| 模型适配 | `Provider` 屏蔽不同 AI SDK provider、鉴权、模型配置差异 |
| 工具系统 | `ToolRegistry` 聚合内置工具、插件工具、MCP 工具，执行时统一走 permission/plugin/truncation |
| UI 更新 | 所有重要状态更新落库并发布 Bus 事件，再通过 SSE 推给客户端 |
| 扩展点 | Plugin hooks、MCP、Agent/Skill、Provider config 都是主要扩展面 |
