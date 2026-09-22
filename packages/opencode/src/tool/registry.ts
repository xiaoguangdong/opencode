// 引入各内置工具
import { PlanExitTool } from "./plan"
import { Session } from "../session"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
// 引入工具基础模块(Def / init 等)
import * as Tool from "./tool"
import { Config } from "../config"
// 引入插件系统的工具定义类型
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "../provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/shared/util/glob"
import path from "path"
import { pathToFileURL } from "url"
// Effect 核心类型
import { Effect, Layer, Context } from "effect"
// HTTP / 子进程相关 Effect 服务
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"

// 创建本模块 logger
const log = Log.create({ service: "tool.registry" })

// 工具定义类型别名(便于后续引用)
type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

/**
 * 注册表状态:
 * - custom:  自定义工具(来自文件扫描 + 插件)
 * - builtin: 内置工具列表
 * - task:    task 工具引用(供外部直接使用)
 * - read:    read 工具引用(供外部直接使用)
 */
type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

/**
 * ToolRegistry 服务接口
 * - ids:   列出所有工具 id
 * - all:   返回全部工具定义
 * - named: 返回 task / read 工具的引用
 * - tools: 根据 provider / model / agent 过滤出可用工具
 */
export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

/**
 * ToolRegistry 的 Layer 实现,依赖较多子服务
 */
export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | Provider.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service

    // 逐个初始化内置工具的 Info
    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const bash = yield* BashTool
    const codesearch = yield* CodeSearchTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const agent = yield* Agent.Service

    // 按 Instance 隔离的状态
    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        /**
         * 把插件定义的工具包装为 Tool.Def:
         *  - 参数使用 zod 对象
         *  - 执行时构造插件上下文(注入 directory / worktree)
         *  - 执行完毕后按 agent 配置截断输出
         */
        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          return {
            id,
            parameters: z.object(def.args),
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                // 调用插件提供的 execute(Promise)
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const info = yield* agent.get(toolCtx.agent)
                // 按 agent 配置截断输出
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : output,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }),
          }
        }

        // 扫描配置目录下的 {tool,tools}/*.{js,ts} 作为自定义工具
        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          // 用文件名作为命名空间
          const namespace = path.basename(match, path.extname(match))
          // `match` 来自 Glob.scanSync(..., { absolute: true }),是绝对路径。
          // 用 file:// URL 导入,保证 Windows 下 Node 也能接受动态 import。
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        // 加载插件系统提供的工具
        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        // question 工具仅在特定客户端或开关开启时启用
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        // 并行初始化所有内置工具
        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          bash: Tool.init(bash),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          code: Tool.init(codesearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
        })

        return {
          custom,
          // 内置工具列表(部分受 Flag 控制)
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.bash,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.code,
            tool.skill,
            tool.patch,
            // LSP 工具需显式开启实验开关
            ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            // Plan 工具需显式开启实验开关且为 CLI 客户端
            ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    /**
     * 返回全部工具(内置 + 自定义)
     */
    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    /**
     * 返回所有工具的 id
     */
    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    /**
     * 生成 skill 工具的附加描述:
     *  - 列出当前 agent 可用的技能(verbose=false 的简版)
     *  - 无可用技能时返回占位文本
     */
    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    /**
     * 生成 task 工具的附加描述:
     *  - 过滤出非 primary 的 subagent
     *  - 排除权限上不允许 task 的 agent
     *  - 按名称排序后列出
     */
    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    /**
     * 根据 provider / model / agent 过滤出可用工具:
     *  - codesearch / websearch 仅对特定 provider 或开启 Exa 时可用
     *  - 某些 GPT 模型使用 apply_patch 替代 edit / write
     *  - 通过插件 hook("tool.definition") 允许修改 description / parameters
     *  - 为 task / skill 工具追加动态描述
     */
    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        // codesearch / websearch 只在 opencode provider 或 Exa 开启时可用
        if (tool.id === CodeSearchTool.id || tool.id === WebSearchTool.id) {
          return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
        }

        // 对 gpt 系列(排除 oss 和 gpt-4)使用 apply_patch,替代 edit / write
        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          // 记录耗时日志
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          // 允许插件修改工具定义
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          return {
            id: tool.id,
            description: [
              output.description,
              // task 工具追加动态 agent 列表
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              // skill 工具追加动态技能列表
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    /**
     * 返回 task / read 工具引用
     */
    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    // 返回 Service 实例
    return Service.of({ ids, all, named, tools })
  }),
)

/**
 * 默认 Layer:装配所有子服务依赖
 */
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
  ),
)
