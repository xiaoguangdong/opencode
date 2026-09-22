// 引入配置服务
import { Config } from "../config"
// 引入 zod 用于 schema 校验
import z from "zod"
// 引入 Provider 服务(LLM 提供商)
import { Provider } from "../provider"
// 引入 ModelID / ProviderID 的 zod schema
import { ModelID, ProviderID } from "../provider/schema"
// 引入 AI SDK 的对象生成 / 流式对象生成 / 消息类型
import { generateObject, streamObject, type ModelMessage } from "ai"
// 引入当前项目实例
import { Instance } from "../project/instance"
// 引入截断工具(里面定义了 GLOB 常量用于外部目录白名单)
import { Truncate } from "../tool"
// 引入鉴权服务
import { Auth } from "../auth"
// 引入 Provider 转换工具(用于拼装 providerOptions)
import { ProviderTransform } from "../provider"

// 引入各类 Prompt 模板(通过构建工具以字符串形式载入)
import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
// 引入权限模块
import { Permission } from "@/permission"
// remeda 工具函数:深合并、管道、排序、取 values
import { mergeDeep, pipe, sortBy, values } from "remeda"
// 引入全局路径
import { Global } from "@/global"
import path from "path"
// 引入插件系统
import { Plugin } from "@/plugin"
// 引入技能(Skill)系统
import { Skill } from "../skill"
// 引入 Effect 生态的核心类型
import { Effect, Context, Layer } from "effect"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
import * as Option from "effect/Option"
// 引入 OpenTelemetry tracer
import * as OtelTracer from "@effect/opentelemetry/Tracer"

/**
 * Agent 的元信息 schema
 * - name:            名称(唯一标识)
 * - description:     描述(展示给用户/其它 agent 用来判断何时调用)
 * - mode:            模式:primary(主 agent,可被用户直接选中) / subagent(子 agent,仅可被调用) / all(都行)
 * - native:          是否为内置 agent
 * - hidden:          是否隐藏(不显示在选择列表,比如 title/summary/compaction)
 * - topP/temperature:采样参数
 * - color:           UI 中显示的颜色
 * - permission:      权限规则集
 * - model:           指定使用的模型(可选,否则使用默认模型)
 * - variant:         变体标识
 * - prompt:          系统提示词
 * - options:         传给模型 provider 的其它自定义选项
 * - steps:           最多允许的工具调用步数
 */
export const Info = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]),
    native: z.boolean().optional(),
    hidden: z.boolean().optional(),
    topP: z.number().optional(),
    temperature: z.number().optional(),
    color: z.string().optional(),
    permission: Permission.Ruleset.zod,
    model: z
      .object({
        modelID: ModelID.zod,
        providerID: ProviderID.zod,
      })
      .optional(),
    variant: z.string().optional(),
    prompt: z.string().optional(),
    options: z.record(z.string(), z.any()),
    steps: z.number().int().positive().optional(),
  })
  .meta({
    ref: "Agent",
  })
export type Info = z.infer<typeof Info>

/**
 * Agent 服务对外暴露的接口
 */
export interface Interface {
  // 按名称获取单个 agent 信息
  readonly get: (agent: string) => Effect.Effect<Info>
  // 列出所有 agent(已按可见性和默认排序)
  readonly list: () => Effect.Effect<Info[]>
  // 获取默认主 agent 名称
  readonly defaultAgent: () => Effect.Effect<string>
  // 根据描述生成一个新的 agent 配置(用于 /agent 之类的生成命令)
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

// 内部状态:Interface 去掉 generate(因为 generate 依赖运行时环境,无需实例缓存)
type State = Omit<Interface, "generate">

// 定义 Effect 的 Service Tag,类名为 "@opencode/Agent"
export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

/**
 * 构造 Agent 服务的 Layer。
 * 该 Layer 依赖 Config / Auth / Plugin / Skill / Provider 等子服务。
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依次从环境中取出依赖(Effect 的依赖注入)
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    // 按 Instance 隔离的状态:每个项目实例拥有自己的一套 agents 配置
    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (_ctx) {
        // 读取用户配置
        const cfg = yield* config.get()
        // 技能目录(用于把技能目录加入外部目录白名单)
        const skillDirs = yield* skill.dirs()
        // 白名单:截断工具 GLOB 目录 + 所有 skill 目录下的文件
        const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

        // 默认权限集(所有 agent 的基础权限,用户配置会在此之上覆盖)
        const defaults = Permission.fromConfig({
          "*": "allow",                                  // 默认全部允许
          doom_loop: "ask",                              // 检测到死循环时询问用户
          external_directory: {
            "*": "ask",                                  // 默认访问外部目录先问
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])), // 白名单直接允许
          },
          question: "deny",                              // 默认禁止对用户提问
          plan_enter: "deny",                            // 默认禁止进入 plan 模式
          plan_exit: "deny",                             // 默认禁止退出 plan 模式
          // 读取权限:允许所有文件,但 .env 类文件需要询问(参考 GitHub Node.gitignore)
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        // 用户自定义权限(来自 cfg.permission)
        const user = Permission.fromConfig(cfg.permission ?? {})

        // 内置 agent 定义表
        const agents: Record<string, Info> = {
          // ========== build:默认主 agent,可执行所有工具 ==========
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",     // build 允许向用户提问
                plan_enter: "allow",   // build 允许进入 plan 模式
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },

          // ========== plan:计划模式,禁止所有编辑工具 ==========
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",   // plan 模式下允许退出 plan
                external_directory: {
                  // 允许读写 plans 目录
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",        // 默认禁止一切编辑
                  // 但允许编辑 .opencode/plans/*.md
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  // 以及全局 data 目录下的 plans/*.md
                  [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },

          // ========== general:通用子 agent,用于并行执行多步任务 ==========
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny", // 子 agent 不允许写 todo
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },

          // ========== explore:代码库探索子 agent ==========
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",       // 默认禁止一切
                grep: "allow",     // 只开放只读类工具
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                codesearch: "allow",
                read: "allow",
                external_directory: {
                  "*": "ask",
                  ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                },
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },

          // ========== compaction:历史压缩 agent(隐藏) ==========
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny", // 压缩过程禁止任何工具
              }),
              user,
            ),
            options: {},
          },

          // ========== title:会话标题生成 agent(隐藏) ==========
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,   // 稍高的温度让标题更有创造力
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },

          // ========== summary:摘要生成 agent(隐藏) ==========
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        // 合并用户配置中的 agent(可覆盖内置 agent 或新增自定义 agent)
        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          // 若用户显式 disable,则从表中移除
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          // 若不存在,则新建一个用户 agent
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          // 逐字段覆盖(仅当用户配置了对应字段时才覆盖)
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          // 深合并 options
          item.options = mergeDeep(item.options, value.options ?? {})
          // 合并权限
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // 确保 Truncate.GLOB 被允许(除非用户显式拒绝)
        for (const name in agents) {
          const agent = agents[name]
          // 检查是否已显式声明了对 Truncate.GLOB 的 deny
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          // 未显式拒绝则追加 allow
          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        // 内部方法:按名称获取 agent
        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        // 内部方法:列出所有 agent,并按"是否默认 / 名称"排序
        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              // 默认 agent 排前
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              // 其余按名称升序
              [(x) => x.name, "asc"],
            ),
          )
        })

        // 内部方法:返回默认 agent 名称
        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          // 用户显式指定了 default_agent 时校验其合法性
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          // 未指定则自动选择第一个可见的非 subagent
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        // 返回实例状态
        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    // 构造 Service,对外暴露方法(把实例方法包装为 Effect)
    return Service.of({
      // 按名称获取 agent
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      // 列出所有 agent
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      // 获取默认 agent 名称
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),

      /**
       * 根据用户描述动态生成一个新的 agent 配置。
       * 流程:
       *  1. 解析模型(用户指定或默认)
       *  2. 组装 system prompt(可通过插件改写)
       *  3. 收集已存在的 agent 名称,避免生成冲突
       *  4. 调用 generateObject / streamObject 让 LLM 输出结构化配置
       *  5. 对于 OpenAI OAuth 特殊路径,使用 streamObject + providerOptions(instructions)
       */
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        // 若用户未指定模型,使用 provider 的默认模型
        const model = input.model ?? (yield* provider.defaultModel())
        // 解析模型引用
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        // 获取可用于 AI SDK 的语言模型对象
        const language = yield* provider.getLanguage(resolved)
        // 若开启 OpenTelemetry,则取用 tracer
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        // 初始 system 消息集合,允许插件后续追加
        const system = [PROMPT_GENERATE]
        // 触发插件钩子,允许插件修改 system 提示词
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        // 现有 agent 列表,用来避免重名
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: 这里的 provider 特化逻辑需要后续重构,避免耦合
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        // OpenAI OAuth 场景需要走 providerOptions 而不是 system message
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        // 组装 generateObject / streamObject 参数
        const params = {
          // OpenTelemetry 遥测配置
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3, // 生成 agent 配置时稍低温度,更稳定
          messages: [
            // 非 OpenAI OAuth 时,system 提示词以 system 消息传入
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              // 用户消息:描述 + 已存在标识符(禁止重名)
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          // 期望的输出结构
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        // OpenAI OAuth 特殊处理:使用 streamObject 并传入 instructions
        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            // 消费流,遇到错误直接抛出
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        // 默认路径:直接 generateObject
        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

// Agent 服务的默认 Layer:把各个子服务的默认 Layer 装配进来
export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

// 以命名空间形式导出,方便 `import { Agent } from "./agent"` 后使用 Agent.Info 等
export * as Agent from "./agent"
