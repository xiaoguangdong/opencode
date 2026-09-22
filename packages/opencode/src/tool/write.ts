import z from "zod"
import * as path from "path"
import { Effect } from "effect"
// 引入工具定义模块
import * as Tool from "./tool"
// 引入 LSP 服务(用于写入后拉取诊断)
import { LSP } from "../lsp"
// 引入 diff 生成工具
import { createTwoFilesPatch } from "diff"
// 引入工具描述模板
import DESCRIPTION from "./write.txt"
// 引入事件总线
import { Bus } from "../bus"
// 引入 File 相关事件定义
import { File } from "../file"
// 引入文件监听器事件
import { FileWatcher } from "../file/watcher"
// 引入格式化服务
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../project/instance"
// 引入 diff 修剪工具(来自 edit 工具)
import { trimDiff } from "./edit"
// 引入外部目录断言工具
import { assertExternalDirectoryEffect } from "./external-directory"
// 引入 BOM 处理工具
import * as Bom from "@/util/bom"

// 其它文件诊断信息最多展示的数量
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

/**
 * write 工具定义:
 *  - 输入:文件绝对路径 + 要写入的内容
 *  - 行为:
 *      1. 校验路径是否在外部目录(必要时询问权限)
 *      2. 读取旧内容并与新内容生成 diff,请求 edit 权限
 *      3. 写入文件(自动创建父目录,处理 BOM)
 *      4. 触发格式化(若配置了)
 *      5. 发布编辑/文件变更事件
 *      6. 通过 LSP 拉取诊断信息,附加到输出中
 */
export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    // 依赖注入
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
      }),
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // 路径处理:绝对路径直接用,相对路径拼到项目根目录
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(Instance.directory, params.filePath)
          // 若在外部目录则请求权限
          yield* assertExternalDirectoryEffect(ctx, filepath)

          // 读取旧内容(可能包含 BOM),不存在则视为空
          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          // 拆分新内容中可能携带的 BOM
          const next = Bom.split(params.content)
          // 最终是否保留 BOM:旧文件有 BOM 或新内容有 BOM
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          // 生成 diff 并请求 edit 权限
          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(Instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          // 写入文件(自动创建父目录,并按需保留 BOM)
          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          // 若格式化成功,同步 BOM(格式化工具可能改写文件)
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          // 发布编辑事件与文件变更事件
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          // 默认输出;随后追加 LSP 诊断信息
          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          // 统计"其它文件"的诊断数量,超过上限则跳过
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            // 当前文件的诊断优先完整展示
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
