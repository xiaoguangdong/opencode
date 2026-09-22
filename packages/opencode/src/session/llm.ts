/**
 * LLM Service — AI 模型流式调用的核心模块
 *
 * 职责：
 *  1. 组装系统提示词（agent prompt / provider prompt + 用户自定义 prompt）
 *  2. 合并模型参数（model options + agent options + variant + provider options）
 *  3. 解析可用工具（根据权限规则过滤）
 *  4. 处理特殊 provider 兼容性（OpenAI OAuth、GitLab Workflow、LiteLLM 代理等）
 *  5. 调用 Vercel AI SDK 的 streamText 进行流式推理
 *  6. 将 AI SDK 的 AsyncIterable 转换为 Effect Stream
 *
 * 数据流：
 *   StreamInput → [组装 system prompt] → [合并 options] → [过滤 tools]
 *                → [plugin hooks] → [streamText] → Effect Stream<Event>
 */

import { Provider } from "@/provider"
import { FlowLog, Log } from "@/util"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import { Trace } from "@/util"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"

const log = Log.create({ service: "llm" })
const trace = Trace.create("llm", "packages/opencode/src/session/llm.ts")
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
/** streamText 的返回类型，用于推导 Event 类型 */
type Result = Awaited<ReturnType<typeof streamText>>

/**
 * 流式调用的输入参数
 *
 * @property user          - 用户消息（包含 text、images、tools 配置等）
 * @property sessionID     - 当前会话 ID
 * @property parentSessionID - 父会话 ID（子 agent 调用时存在）
 * @property model         - 目标模型信息（provider、limit、options 等）
 * @property agent         - 当前 agent 配置（prompt、tools、permission、options）
 * @property permission    - 权限规则集（覆盖 agent 默认权限）
 * @property system        - 额外的系统提示词片段
 * @property messages      - AI SDK 格式的消息历史
 * @property small         - 是否使用小模型（用于摘要等轻量任务）
 * @property tools         - 可用工具集（AI SDK Tool 格式）
 * @property retries       - API 调用重试次数
 * @property toolChoice    - 工具选择策略：auto（自动）/ required（必须调用）/ none（不调用）
 */
export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

/** 带 AbortSignal 的请求（用于取消流式调用） */
export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

/**
 * 流式事件类型 — 从 streamText 的 fullStream 推导得出。
 * 包含 text-delta / tool-call / tool-result / finish / error 等事件。
 */
export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

/**
 * LLM Service 接口
 * @method stream - 发起一次流式 LLM 调用，返回 Effect Stream<Event>
 */
export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}

/** Effect 依赖注入 Service 标识 */
export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

/**
 * LLM Service 的实现 Layer
 *
 * 依赖的 Service（通过 yield* 注入）：
 *  - Auth.Service       — 获取 provider 认证信息（API key / OAuth token）
 *  - Config.Service     — 读取全局配置（openTelemetry、compaction 等）
 *  - Provider.Service   — 获取 LanguageModel 实例和 provider 元信息
 *  - Plugin.Service     — 触发 chat.params / chat.headers / system.transform 等 hook
 *  - Permission.Service — 工具权限过滤
 */
const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service

    /**
     * run() — 执行一次 LLM 流式调用的核心函数
     *
     * 步骤：
     *  1. 并行获取 language model、config、provider info、auth info
     *  2. 组装系统提示词（agent prompt / provider prompt + 用户自定义）
     *  3. 触发 system.transform 插件 hook
     *  4. 合并模型参数（base options + model + agent + variant）
     *  5. 构建最终消息列表（system messages + user messages）
     *  6. 触发 chat.params / chat.headers 插件 hook
     *  7. 解析可用工具（权限过滤 + LiteLLM 兼容处理）
     *  8. GitLab Workflow 特殊处理（toolExecutor + approvalHandler）
     *  9. 组装请求头（opencode 自定义头 / session affinity 头）
     *  10. 调用 AI SDK streamText 并返回结果
     */
    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      // ── 1. 构建带标签的日志器 ──
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      // ── 2. 并行获取四项依赖 ──
      // language: Vercel AI SDK 的 LanguageModel 实例
      // cfg:      全局配置
      // item:     provider 元信息（options、id 等）
      // info:     认证信息（API key / OAuth token）
      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      // ── 3. 组装系统提示词 ──
      // 优先级：agent.prompt > SystemPrompt.provider(model) > 用户传入的 system 片段 > user.system
      // TODO: move this to a proper hook
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system: string[] = []
      system.push(
        [
          // use agent prompt otherwise provider prompt
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          // any custom prompt passed into this call
          ...input.system,
          // any custom prompt from last user message
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      // ── 4. 触发 system.transform 插件 hook ──
      // 插件可以修改 system 数组内容
      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // 如果插件只修改了 header 之后的部分，重新合并以保持 2-part 结构
      // （header 不变时可以利用 prompt cache）
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      // ── 5. 合并模型参数 ──
      // 优先级（从低到高）：base options < model.options < agent.options < variant
      // variant 来自用户在消息中指定的模型变体（如 thinking 模式）
      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options: Record<string, any> = pipe(
        base,
        mergeDeep(input.model.options),
        mergeDeep(input.agent.options),
        mergeDeep(variant),
      )
      // OpenAI OAuth 模式下，system prompt 需要通过 options.instructions 传递
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }
      trace.info("LLM 已完成系统提示词和模型参数初步组装", {
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        apiModelID: input.model.api.id,
        providerPackage: input.model.api.npm,
        agent: input.agent.name,
        mode: input.agent.mode,
        small: input.small ?? false,
        userMessageID: input.user.id,
        requestedVariant: input.user.model.variant,
        effectiveVariant: variant,
        providerOptions: item.options,
        modelOptions: input.model.options,
        agentOptions: input.agent.options,
        mergedOptions: options,
        system,
      })
      FlowLog.write("LLM 参数已组装", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        apiModelID: input.model.api.id,
        providerPackage: input.model.api.npm,
        agent: input.agent.name,
        small: input.small ?? false,
        userMessageID: input.user.id,
        requestedVariant: input.user.model.variant,
        providerOptions: item.options,
        modelOptions: input.model.options,
        agentOptions: input.agent.options,
        mergedOptions: options,
        systemCount: system.length,
      })

      // ── 6. 构建最终消息列表 ──
      // OpenAI OAuth 和 GitLab Workflow 模式下不注入 system messages（通过其他途径传递）
      // 其他 provider 将 system prompt 作为消息数组的前几条
      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const messages = isOpenaiOauth
        ? input.messages
        : isWorkflow
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]
      trace.info("LLM 最终消息列表已生成", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        isOpenaiOauth,
        isWorkflow,
        messageCount: messages.length,
        messages,
      })
      FlowLog.write("LLM 最终消息列表已生成", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        isOpenaiOauth,
        isWorkflow,
        messageCount: messages.length,
        messages,
      })

      // ── 7. 触发 chat.params 插件 hook ──
      // 插件可以修改 temperature、topP、topK、maxOutputTokens 和 options
      // 温度等采样参数：如果模型不支持 temperature 能力则不设置
      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      // ── 8. 触发 chat.headers 插件 hook ──
      // 插件可以添加自定义 HTTP 请求头
      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      // ── 9. 解析可用工具 ──
      // 根据权限规则过滤掉被禁用的工具，同时移除用户明确关闭的工具
      const tools = resolveTools(input)
      trace.info("LLM 工具和采样参数已准备", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        maxOutputTokens: params.maxOutputTokens,
        toolChoice: input.toolChoice,
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
        toolDefinitions: Object.fromEntries(
          Object.entries(tools).map(([name, item]) => [
            name,
            {
              description: item.description,
              inputSchema: item.inputSchema,
            },
          ]),
        ),
        headers,
        paramsOptions: params.options,
      })

      // ── 10. LiteLLM 代理兼容处理 ──
      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      // ── 11. GitLab Workflow 特殊处理 ──
      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        // toolExecutor: 将 GitLab Workflow 的工具调用桥接到 opencode 的工具系统
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        // 预批准工具列表：权限规则中 action 非 "ask" 的工具会被自动批准
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        // approvalHandler: 当 Workflow 服务端请求工具审批时，通过 opencode 权限系统向用户提问
        workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      // ── 12. 构建请求头 ──
      // OpenCode provider: 注入 project / session / request / client 头
      // 其他 provider: 注入 session affinity / parent session / User-Agent
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      // 如果启用了 OpenTelemetry，包装 tracer 以自动注入 session.id 属性
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined
      const providerOptions = ProviderTransform.providerOptions(input.model, params.options)
      const requestHeaders = {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : {
              "x-session-affinity": input.sessionID,
              ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
              "User-Agent": `opencode/${InstallationVersion}`,
            }),
        ...input.model.headers,
        ...headers,
      }
      trace.info("LLM 即将调用 AI SDK streamText", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        providerOptions,
        headers: requestHeaders,
        maxRetries: input.retries ?? 0,
        messageCount: messages.length,
      })
      FlowLog.write("即将调用 AI SDK streamText", {
        sessionID: input.sessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        providerOptions,
        headers: requestHeaders,
        maxRetries: input.retries ?? 0,
        messageCount: messages.length,
      })

      // 调用 Vercel AI SDK 的 streamText 进行流式推理
      //
      // streamText 来自 `ai` 包（Vercel AI SDK v6），是 AI SDK 提供的通用 LLM 流式调用入口。
      // 它封装了 HTTP SSE 请求解析、流式 chunk 解码、工具调用循环等复杂逻辑，
      // OpenCode 只需组装参数（system prompt、messages、tools、采样参数）并消费返回的事件流。
      //
      // 核心工作流程：
      //   1. streamText 调用 model.doStream()（LanguageModel 适配器）
      //   2. 适配器向 LLM Provider（OpenAI/Anthropic 等）发起 HTTP SSE 请求
      //   3. Provider 流式返回 chunks，适配器转换为事件流
      //   4. streamText 返回 StreamTextResult，其 fullStream 是 AsyncIterable
      //   5. 下游（本文件 stream() 方法）通过 Stream.fromAsyncIterable 转为 Effect Stream
      //
      // fullStream 产生的事件类型：
      //   - text-delta:    文本增量（模型生成的文本片段）
      //   - tool-call:     模型请求调用工具
      //   - tool-result:   工具执行完成
      //   - tool-error:    工具执行出错
      //   - finish-step:   一个推理步骤完成
      //   - finish:        整个流式调用完成
      //
      // 参考: https://sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text
      return streamText({
        // 流式错误回调：记录日志和追踪
        onError(error) {
          l.error("stream error", {
            error,
          })
          trace.error("LLM 流式请求发生错误", {
            sessionID: input.sessionID,
            providerID: input.model.providerID,
            modelID: input.model.id,
            error,
          })
          FlowLog.write("LLM 流式请求发生错误", {
            sessionID: input.sessionID,
            providerID: input.model.providerID,
            modelID: input.model.id,
            error,
          })
        },
        // 工具调用修复：当模型生成了无效的工具名时尝试修复
        // 1. 如果工具名大小写错误（如 "Read" → "read"），自动修正
        // 2. 如果无法修复，路由到 "invalid" 工具，返回错误信息给模型
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && tools[lower]) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: lower,
            })
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions,
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
        tools,
        toolChoice: input.toolChoice,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort,
        headers: requestHeaders,
        maxRetries: input.retries ?? 0,
        messages,
        // 使用 wrapLanguageModel 注入 middleware
        // transformParams: 在发送给 provider 之前对 prompt 做最后的转换
        // （例如 provider 特定的消息格式调整）
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                  trace.info("LLM 已完成 provider 消息转换", {
                    sessionID: input.sessionID,
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                    transformedPrompt: args.params.prompt,
                    transformOptions: options,
                  })
                  FlowLog.write("LLM provider 消息转换完成", {
                    sessionID: input.sessionID,
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                    transformedPrompt: args.params.prompt,
                    transformOptions: options,
                  })
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    /**
     * stream() — 对外暴露的流式调用接口
     *
     * 实现要点：
     *  - Stream.scoped: 确保 AbortController 在 Scope 关闭时自动 abort
     *  - Stream.unwrap: 从 Effect<Stream> 中解包出 Stream
     *  - Stream.fromAsyncIterable: 将 AI SDK 的 fullStream 转换为 Effect Stream
     *  - Stream.tap: 对每个事件做追踪日志
     *  - Stream.ensuring: 流结束时写日志
     */
    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            // 创建 AbortController，在 Scope 释放时自动 abort（取消正在进行的请求）
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e)))).pipe(
              // Stream.tap: 对每个流事件做追踪日志（不修改事件本身）
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (!trace.enabled()) return
                  if (event.type === "text-delta") {
                    trace.info("LLM 收到文本增量", { sessionID: input.sessionID, text: event.text })
                    FlowLog.write("LLM 文本增量", { sessionID: input.sessionID, text: event.text })
                    return
                  }
                  trace.info("LLM 收到流事件", { sessionID: input.sessionID, event })
                  if (
                    event.type === "tool-call" ||
                    event.type === "tool-result" ||
                    event.type === "tool-error" ||
                    event.type === "finish-step" ||
                    event.type === "finish"
                  ) {
                    FlowLog.write("LLM 流事件", { sessionID: input.sessionID, event })
                  }
                }),
              ),
              // Stream.ensuring: 流结束时（正常结束或被取消）写入日志
              Stream.ensuring(
                Effect.sync(() => {
                  trace.info("LLM 流读取结束", {
                    sessionID: input.sessionID,
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                  })
                  FlowLog.write("LLM 流读取结束", {
                    sessionID: input.sessionID,
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                  })
                }),
              ),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

// 导出 layer（已提供 Permission 依赖）
export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

// 导出 defaultLayer（提供全部依赖，供 AppLayer 使用）
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
  ),
)

/**
 * 解析可用工具 — 根据权限规则和用户配置过滤工具集
 *
 * 过滤规则：
 *  1. 权限禁用：Permission.disabled() 返回被 deny 的工具名集合
 *  2. 用户关闭：input.user.tools[name] === false 表示用户明确关闭了该工具
 *
 * @param input - 包含 tools、agent.permission、permission、user.tools 的输入
 * @returns 过滤后的工具字典
 */
function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

/**
 * 检查消息历史中是否包含工具调用或工具结果
 *
 * 用于判断是否需要为 LiteLLM 代理注入占位工具
 * （LiteLLM 在消息含工具调用但请求中没有 tools 参数时会报错）
 *
 * @param messages - AI SDK 格式的消息历史
 * @returns 是否包含 tool-call 或 tool-result
 */
// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
