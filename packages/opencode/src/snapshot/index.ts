// 引入 Effect 核心类型(Cause / Duration / Schedule / Semaphore 等)
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context, Stream } from "effect"
// 引入 Effect 生态的子进程相关类型
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
// 引入 diff 工具(生成 patch)
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import z from "zod"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
// 引入 Hash 工具(用于给 worktree 生成 gitdir 名称)
import { Hash } from "@opencode-ai/shared/util/hash"
import { Config } from "../config"
import { Global } from "../global"
import { Log } from "../util"
// 引入 Schema <-> zod 桥接
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

/**
 * Patch 描述:一次快照中受影响的文件列表
 */
export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Patch = typeof Patch.Type

/**
 * 单个文件的 diff 结果
 * - file:      文件路径
 * - patch:     unified diff 文本
 * - additions/deletions: 增删行数
 * - status:    added / deleted / modified
 */
export const FileDiff = Schema.Struct({
  file: Schema.String,
  patch: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
})
  .annotate({ identifier: "SnapshotFileDiff" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FileDiff = typeof FileDiff.Type

// 本模块 logger
const log = Log.create({ service: "snapshot" })
// 清理时保留的时间窗口
const prune = "7.days"
// 单个文件快照大小上限(2 MB)
const limit = 2 * 1024 * 1024
// git 通用配置(longpaths / symlinks)
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
// 带 autocrlf=false 的 git 配置
const cfg = ["-c", "core.autocrlf=false", ...core]
// 带 quotepath=false 的 git 配置(用于输出文件名不做转义)
const quote = [...cfg, "-c", "core.quotepath=false"]

// git 命令结果
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

// 内部状态:去掉 init 的接口
type State = Omit<Interface, "init">

/**
 * Snapshot 服务接口
 *  - init:     初始化状态
 *  - cleanup:  按时间窗口清理旧对象
 *  - track:    记录当前工作区快照,返回 tree hash
 *  - patch:    给定 hash,返回该快照相对当前工作区的变更文件列表
 *  - restore:  回滚到指定快照
 *  - revert:   撤销若干 patch
 *  - diff:     给定 hash,返回 unified diff 文本
 *  - diffFull: 计算两个快照之间的完整 diff
 */
export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

/**
 * Snapshot 的 Layer 实现
 * 依赖:AppFileSystem / ChildProcessSpawner / Config
 */
export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | ChildProcessSpawner.ChildProcessSpawner | Config.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖注入
    const fs = yield* AppFileSystem.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const config = yield* Config.Service
    // 每个 gitdir 一个互斥锁,避免并发 git 操作互相踩
    const locks = new Map<string, Semaphore.Semaphore>()

    /**
     * 获取(或创建)指定 key 的互斥锁
     */
    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    // 按 Instance 隔离的状态
    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          // 快照专用的 gitdir(独立于用户项目自身的 .git)
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        // 构造 git 参数前缀:指定 git-dir 与 work-tree
        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        // 用于把文件列表喂给 git 的 NUL 分隔 stdin
        const enc = new TextEncoder()
        const feed = (list: string[]) => Stream.make(enc.encode(list.join("\0") + "\0"))

        /**
         * 执行 git 命令并收集 stdout / stderr / 退出码
         * 出错时返回 code = 1,stderr 为错误消息
         */
        const git = Effect.fnUntraced(
          function* (
            cmd: string[],
            opts?: { cwd?: string; env?: Record<string, string>; stdin?: ChildProcess.CommandInput },
          ) {
            const proc = ChildProcess.make("git", cmd, {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
              stdin: opts?.stdin,
            })
            const handle = yield* spawner.spawn(proc)
            const [text, stderr] = yield* Effect.all(
              [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
              { concurrency: 2 },
            )
            const code = yield* handle.exitCode
            return { code, text, stderr } satisfies GitResult
          },
          Effect.scoped,
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        /**
         * 用源仓库的 .gitignore 规则判断哪些文件被忽略:
         * 使用 --no-index 让检查基于模式而非追踪状态
         */
        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          // 0 = 有命中,1 = 无命中,其它视为异常
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(check.text.split("\0").filter(Boolean))
        })

        /**
         * 从快照索引中移除指定文件(避免被 ignore 的文件残留在索引里)
         */
        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
        })

        /**
         * 把指定文件暂存到快照索引
         */
        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return
          log.warn("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        // 工具函数:存在性 / 读取 / 删除 / 加锁
        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        /**
         * 是否启用快照:
         *  - 项目必须是 git 仓库
         *  - 配置中 snapshot 未显式关闭
         */
        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        /**
         * 读取源仓库的 .git/info/exclude 路径(可能不存在)
         */
        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        /**
         * 把源仓库的 excludes 内容 + 额外排除列表写入快照 gitdir 的 info/exclude
         */
        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        /**
         * 把所有已修改 / 未追踪文件加入快照索引:
         *  - 排除被 .gitignore 忽略的文件
         *  - 排除超过 limit 的大文件
         */
        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              // 已追踪但被修改的文件
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              // 未追踪且不在 ignore 列表中的文件
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            log.warn("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // 用源仓库 ignore 规则过滤候选文件
          const ignored = yield* ignore(all)

          // 把新被忽略的文件从快照索引中移除,避免后续被重新加入
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          // 找出大于 limit 的大文件
          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.directory, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          // 仅对未追踪的大文件做排除(已追踪的大文件不排除)
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // 只 stage 白名单内的文件,保持快照范围可控
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        /**
         * 清理过期对象(git gc --prune=7.days)
         */
        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                log.warn("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              log.info("cleanup", { prune })
            }),
          )
        })

        /**
         * 记录当前工作区快照:
         *  - 首次时初始化快照 gitdir 并配置 core.*
         *  - add() 把所有变更加入索引
         *  - write-tree 得到 tree hash 并返回
         */
        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              // 首次:初始化仓库并设置必要的 core 配置
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                log.info("initialized")
              }
              yield* add()
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        /**
         * 给定快照 hash,返回相对当前工作区的变更文件列表:
         *  - 过滤掉被 ignore 的文件(如大文件),避免暴露给用户
         *  - 返回文件路径为绝对路径,且用 "/" 统一分隔符
         */
        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                log.warn("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // 隐藏被 ignore 的文件的删除动作,避免污染用户可见的 patch 输出
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        /**
         * 恢复到指定快照:
         *  - read-tree 把快照读入索引
         *  - checkout-index -a -f 把所有文件写回工作区
         */
        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              log.info("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              log.error("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        /**
         * 撤销若干 patch:
         *  - 对每个文件,尝试从对应 hash 检出
         *  - 若该文件在快照中不存在,则删除之
         *  - 对相邻且路径不冲突的文件批量处理,减少 git 调用
         */
        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              // 单文件回滚:先试 checkout,失败再判断该文件是否存在于快照,不存在则删除
              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                log.info("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                  return
                }
                log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              // 判断两个相对路径是否可能互相影响(相同或互为父子)
              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // 只在路径不冲突且 hash 相同的情况下批量
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                // 只有一个 op 直接单文件处理
                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                // 批量查询这些文件在快照中是否存在
                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  log.info("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                // 存在于快照中的文件,批量 checkout
                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  log.info("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    log.info("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                // 不在快照中的文件,直接删除
                for (const op of run) {
                  if (have.has(op.rel)) continue
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        /**
         * 返回给定快照相对当前工作区的 unified diff 文本
         */
        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                log.warn("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        /**
         * 计算两个快照之间的完整文件差异:
         *  - 用 git diff --name-status / --numstat 拉取文件与增删行数
         *  - 用 cat-file --batch 批量取文件内容(失败时降级为 per-file git show)
         *  - 用 diff 工具生成每文件的 unified patch
         */
        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              // 逐文件读取 before / after 内容(降级路径)
              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              // 批量读取文件内容:构造 refs 列表,调用 git cat-file --batch
              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  // 启动 cat-file --batch,把 refs 逐行喂入
                  const proc = ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                    cwd: state.directory,
                    extendEnv: true,
                    stdin: Stream.make(new TextEncoder().encode(refs.map((item) => item.ref).join("\n") + "\n")),
                  })
                  const handle = yield* spawner.spawn(proc)
                  const [out, err] = yield* Effect.all(
                    [Stream.mkUint8Array(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))],
                    { concurrency: 2 },
                  )
                  const code = yield* handle.exitCode
                  if (code !== 0) {
                    log.info("git cat-file --batch failed during snapshot diff, falling back to per-file git show", {
                      stderr: err,
                      refs: refs.length,
                    })
                    return
                  }

                  // 失败降级:返回 undefined 让调用方走 show 路径
                  const fail = (msg: string, extra?: Record<string, string>) => {
                    log.info(msg, { ...extra, refs: refs.length })
                    return undefined
                  }

                  // 逐条解析 cat-file 输出:header 行 + 内容 + 换行
                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    // "missing" 表示该 ref 在快照中不存在
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              // 记录每个文件的变更类型(added / deleted / modified)
              const status = new Map<string, "added" | "deleted" | "modified">()

              // 拉取文件状态
              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              // 拉取增删行数
              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  // 二进制文件的 numstat 用 "-" 表示
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // 隐藏被 ignore 的文件,避免污染用户可见的 diff
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              // 批量处理大小(每次 cat-file 100 个文件)
              const step = 100
              // 用 diff 库生成 unified patch(上下文行数设为很大,等价于完整文件)
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  // 优先用批量结果;批量失败时降级用 show
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before, after),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        // 后台定期清理(每小时一次,首次延迟 1 分钟)
        yield* cleanup().pipe(
          Effect.catchCause((cause) => {
            log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    // 返回 Service 实例
    return Service.of({
      // 初始化:触发 InstanceState 构造
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

// 默认 Layer:装配 CrossSpawnSpawner / AppFileSystem / Config 依赖
export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

// 以命名空间形式导出
export * as Snapshot from "."
