// 引入 Effect 核心类型
import { Context, Effect, Layer } from "effect"

// 引入当前项目实例
import { Instance } from "../project/instance"

// 引入各模型家族对应的系统提示词模板
import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
// 引入 Provider / Agent / Permission / Skill 类型与服务
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

/**
 * 根据模型 ID 选择合适的系统提示词模板。
 * 通过 api.id 中的关键字判断模型家族,返回对应的 prompt 数组。
 */
export function provider(model: Provider.Model) {
  // GPT-4 / o1 / o3 系列使用 BEAST 提示词
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  // 其它 gpt 系列:codex 用 CODEX,其余用 GPT
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  // Gemini 系列
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  // Claude 系列
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  // Trinity 系列(小写匹配)
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  // Kimi 系列(小写匹配)
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  // 兜底:默认提示词
  return [PROMPT_DEFAULT]
}

/**
 * SystemPrompt 服务接口
 * - environment: 根据模型返回描述当前运行环境的信息块
 * - skills:      根据 agent 权限返回该 agent 可用的技能说明(可能为 undefined)
 */
export interface Interface {
  readonly environment: (model: Provider.Model) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

/**
 * SystemPrompt 的 Layer 实现,依赖 Skill 服务
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入 Skill 服务
    const skill = yield* Skill.Service

    return Service.of({
      /**
       * 生成运行环境描述:
       * 包含模型 ID、工作目录、workspace 根目录、是否 git 仓库、平台、日期等信息,
       * 用 <env> 标签包裹。
       */
      environment(model) {
        const project = Instance.project
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      },

      /**
       * 返回技能说明文本:
       * - 若 agent 权限中禁用了 skill,则返回 undefined
       * - 否则列出可用技能(verbose 模式,信息更丰富,便于模型理解)
       */
      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        // 权限中禁用了 skill 则直接返回
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        // 获取该 agent 可用的技能列表
        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // 给模型看到的版本更详细,而工具描述里可以更简略,这样模型吸收效果更好
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

// 默认 Layer:装配 Skill 的默认 Layer
export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

// 以命名空间形式导出
export * as SystemPrompt from "./system"
