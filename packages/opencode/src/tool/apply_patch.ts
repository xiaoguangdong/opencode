import z from "zod"
import * as path from "path"
import { Effect } from "effect"
// 引入工具定义模块
import * as Tool from "./tool"
// 引入事件总线
import { Bus } from "../bus"
// 引入文件监听器事件
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
// 引入 Patch 解析与应用模块
import { Patch } from "../patch"
// 引入 diff 生成与逐行比较工具
import { createTwoFilesPatch, diffLines } from "diff"
// 引入外部目录断言工具
import { assertExternalDirectoryEffect } from "./external-directory"
// 引入 diff 修剪工具
import { trimDiff } from "./edit"
// 引入 LSP 服务
import { LSP } from "../lsp"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
// 引入工具描述模板
import DESCRIPTION from "./apply_patch.txt"
// 引入 File 相关事件
import { File } from "../file"
import { Format } from "../format"
// 引入 BOM 处理工具
import * as Bom from "@/util/bom"

/**
 * apply_patch 工具入参
 * - patchText: 描述所有改动的完整 patch 文本
 */
const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

/**
 * apply_patch 工具定义:
 *  - 输入:一段 patch 文本(类似 unified diff 格式)
 *  - 行为:
 *      1. 解析 patch 得到一批 hunk(add / update / delete / move)
 *      2. 逐个校验路径、读出旧内容并生成新内容
 *      3. 请求 edit 权限(附带每个文件的 diff 与统计)
 *      4. 应用改动(写入 / 移动 / 删除,处理 BOM 与格式化)
 *      5. 发布编辑与文件变更事件
 *      6. 通过 LSP 拉取诊断信息,附加到输出
 */
export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    // 依赖注入
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (params: z.infer<typeof PatchParams>, ctx: Tool.Context) {
      // 空 patch 直接报错
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // 解析 patch,拿到 hunk 列表
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      // 无 hunk 时:区分"空 patch"和其它错误
      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      // 收集所有文件改动(用于权限请求与最终应用)
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
      }> = []

      // 累积所有文件的 diff 文本
      let totalDiff = ""

      for (const hunk of hunks) {
        // 解析为绝对路径,并做外部目录检查
        const filePath = path.resolve(Instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          // ===== 新增文件 =====
          case "add": {
            const oldContent = ""
            // 内容末尾若无换行则补一个
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            // 统计增删行数
            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          // ===== 更新(可选移动)文件 =====
          case "update": {
            // 文件必须存在且不是目录
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // 按 chunks 逐块应用得到新内容
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            // 统计增删行数
            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            // 若带 move_path,则解析目标路径并做外部目录检查
            const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
            })

            totalDiff += diff + "\n"
            break
          }

          // ===== 删除文件 =====
          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            // 与原内容比较,生成"删除"diff(新内容为空)
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            // 删除行数按行拆分粗略估算
            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // 为 UI 渲染准备每个文件的元信息(权限请求与结果都会用到)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // 请求 edit 权限(附带所有相关路径与完整 diff)
      const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // 应用所有改动
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        // 实际需要格式化的目标(delete 为 undefined)
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          // 新增:写文件
          case "add":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "add" })
            break

          // 更新:写文件
          case "update":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "change" })
            break

          // 移动:写新位置 + 删除旧位置
          case "move":
            if (change.movePath) {
              yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          // 删除:直接移除
          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        // 若非删除,触发格式化与编辑事件
        if (edited) {
          if (yield* format.file(edited)) {
            yield* Bom.syncFile(afs, edited, change.bom)
          }
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      // 发布文件变更事件
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // 通知 LSP 文件变化并拉取诊断
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // 生成输出摘要(A 新增 / D 删除 / M 修改)
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      // 把每个受影响文件的 LSP 诊断追加到输出
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: PatchParams,
      execute: (params: z.infer<typeof PatchParams>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
