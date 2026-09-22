import path from "path"
// 引入把文件路径转换为 file:// URL 的工具(用于 skill 的 base 目录)
import { pathToFileURL } from "url"
import z from "zod"
// 引入 Effect 核心
import { Effect } from "effect"
// 引入 Effect 的 Stream 模块
import * as Stream from "effect/Stream"
// 引入 Ripgrep 服务(用于列举 skill 目录下的文件)
import { Ripgrep } from "../file/ripgrep"
// 引入 Skill 服务
import { Skill } from "../skill"
// 引入工具定义模块
import * as Tool from "./tool"
// 引入工具描述文本模板
import DESCRIPTION from "./skill.txt"

// 工具入参 schema:仅一个 name 字段
const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
})

/**
 * skill 工具定义:
 *  - 输入:skill 名称
 *  - 行为:
 *      1. 从 Skill 服务查找该 skill
 *      2. 找不到时抛出错误并列出可用 skill
 *      3. 请求 skill 权限
 *      4. 用 ripgrep 采样该 skill 目录下的文件(最多 10 个,排除 SKILL.md)
 *      5. 返回包含 skill 内容与文件列表的结构化文本
 */
export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    // 依赖注入
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // 查找指定名字的 skill
          const info = yield* skill.get(params.name)
          if (!info) {
            // 未找到时列出所有可用 skill 名称,便于模型纠正
            const all = yield* skill.all()
            const available = all.map((item) => item.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          // 请求 skill 权限
          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          // skill 所在目录与作为 base 的 file:// URL
          const dir = path.dirname(info.location)
          const base = pathToFileURL(dir).href
          // 采样文件数量上限
          const limit = 10
          // 用 ripgrep 列出目录下文件(排除 SKILL.md),截取前 limit 个并包装为 <file> 标签
          const files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
            Stream.filter((file) => !file.includes("SKILL.md")),
            Stream.map((file) => path.resolve(dir, file)),
            Stream.take(limit),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
          )

          // 返回结构化文本,便于模型直接读取 skill 内容
          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files,
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
