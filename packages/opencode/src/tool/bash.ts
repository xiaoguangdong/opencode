import z from "zod"
import os from "os"
// 引入 Node 的文件写入流(用于把超长输出落盘)
import { createWriteStream } from "node:fs"
// 引入工具定义模块
import * as Tool from "./tool"
import path from "path"
// 引入工具描述模板
import DESCRIPTION from "./bash.txt"
import { Log } from "../util"
import { Instance } from "../project/instance"
// 引入惰性初始化工具
import { lazy } from "@/util/lazy"
// 引入 web-tree-sitter 的 Language / Node 类型(用于解析命令行)
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"

// 引入命令 arity 前缀工具(用于 "always" 权限模式)
import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

// 元数据中保留的最大字符数
const MAX_METADATA_LENGTH = 30_000
// 默认超时时间(可通过实验开关覆盖),默认 2 分钟
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
// PowerShell 家族 shell
const PS = new Set(["powershell", "pwsh"])
// 会改变工作目录的命令
const CWD = new Set(["cd", "push-location", "set-location"])
// 涉及文件/路径、需要检查外部目录的命令集合
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // 暂时先不处理 PowerShell 别名。常见的 cat/cp/mv/rm/mkdir 已包含在上面的集合里,
  // 别名归一化后续应集中在一处,避免重复提示。
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
// PowerShell 中表示路径参数的 flag
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
// PowerShell 中可忽略的开关参数
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

/**
 * bash 工具入参
 * - command:     要执行的命令
 * - timeout:     可选超时(毫秒)
 * - workdir:     工作目录(推荐替代 cd)
 * - description: 命令描述(5~10 词)
 */
const Parameters = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z
    .string()
    .describe(
      `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    )
    .optional(),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    ),
})

// 解析出的命令片段(类型 + 文本)
type Part = {
  type: string
  text: string
}

// 命令扫描结果:需要检查的外部目录 / bash 模式 / 固化模式
type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

// 输出块(文本 + 字节数)
type Chunk = {
  text: string
  size: number
}

// 本模块 logger
export const log = Log.create({ service: "bash-tool" })

/**
 * 把 wasm 资源解析为本地文件路径:
 *  - file:// 协议直接转 fileURLToPath
 *  - 绝对路径直接返回
 *  - 其它情况按 import.meta.url 相对解析
 */
const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

/**
 * 从一个 command 节点中抽取有效的参数片段:
 *  - command_elements:进一步展开,跳过分隔符和重定向
 *  - 只保留 command_name / command_name_expr / word / string / raw_string / concatenation 等类型
 */
function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

/**
 * 返回命令的源文本:若被重定向包裹,则取重定向语句的文本
 */
function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

/**
 * 展开节点下的所有 command 子节点
 */
function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

/**
 * 去掉两端成对的引号
 */
function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

/**
 * 把 ~ 和 ~/ 展开为 home 目录
 */
function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

/**
 * 读取环境变量(Windows 下大小写不敏感)
 */
function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

/**
 * 处理几个可自动推导的变量(HOME / PWD / PSHOME)
 */
function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

/**
 * 展开字符串中的变量:
 *  - ${env:XXX} / $env:XXX
 *  - $HOME / $PWD / $PSHOME
 *  - ~ 展开为 home
 */
function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

/**
 * 处理 PowerShell 的 provider 前缀(如 `filesystem::C:\foo`)
 *  - 非 filesystem provider 或不带前缀时,按情况返回
 */
function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  // 单字母前缀(如 C:)视为盘符,不改动
  if (prefix[1].length === 1) return text
  return
}

/**
 * 判断文本是否是动态内容(含变量、子表达式等),不参与路径静态解析
 */
function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

/**
 * 取通配符之前的路径前缀(用于静态路径解析)
 */
function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

/**
 * 从命令片段中提取路径参数:
 *  - 非 PowerShell:跳过以 "-" 开头的参数(chmod 特例除外)
 *  - PowerShell:识别 -Path/-LiteralPath/-Destination 等需要接值的 flag
 */
function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      // 跳过纯开关
      if (SWITCHES.has(flag)) continue
      // 需要接值的 flag 下一项作为路径
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

/**
 * 预览文本:超过 MAX_METADATA_LENGTH 时只保留尾部
 */
function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

/**
 * 尾部截断:保留末尾 maxLines 行且不超过 maxBytes 字节,
 * 并处理 UTF-8 多字节字符边界。
 */
function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      // 第一行就超限:从字节级截断,并对齐到 UTF-8 边界
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

/**
 * 解析命令行(Effect 版):
 *  - ps 为 true 时使用 PowerShell 语法树,否则使用 Bash 语法树
 */
const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

/**
 * 根据扫描结果发起权限询问:
 *  - 若涉及外部目录,先问 external_directory
 *  - 若需要 bash 权限,再问 bash
 */
const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

/**
 * 构造要执行的子进程:
 *  - Windows + PowerShell:用 PowerShell 参数形式
 *  - 其它情况:通过 shell 执行 command
 */
function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

/**
 * 惰性初始化 tree-sitter 解析器(加载 bash / powershell 两个 wasm 语法)
 */
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: 或许该改个名,让它在其它 shell 上也更好用
/**
 * bash 工具定义:
 *  - 解析命令行(生成 AST)
 *  - 收集涉及的外部目录与 bash 模式
 *  - 请求权限
 *  - 执行子进程,流式采集输出(超长输出落盘)
 */
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    // 依赖注入
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service

    /**
     * 通过 cygpath 把 POSIX 风格路径转换为 Windows 路径(仅在 Cygwin/MSYS 下有效)
     */
    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    /**
     * 把相对路径解析为绝对路径,并在 Windows + POSIX shell 下尝试 cygpath 转换
     */
    const resolvePath = Effect.fn("BashTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    /**
     * 解析单个参数中的路径(展开变量、取通配符前缀、解析 provider 前缀)
     */
    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    /**
     * 扫描 AST 收集:
     *  - dirs:     需要访问的外部目录
     *  - patterns: 需要请求的 bash 模式(命令原文)
     *  - always:   建议固化的模式前缀(命令 + 通配)
     */
    const collect = Effect.fn("BashTool.collect")(function* (root: Node, cwd: string, ps: boolean, shell: string) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

        // 涉及文件操作:检查其路径参数是否在项目外
        if (cmd && FILES.has(cmd)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        // 收集 bash 模式与固化模式(跳过 cd 类命令)
        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    /**
     * 构造子进程环境变量:
     *  - 以 process.env 为基础
     *  - 允许插件通过 "shell.env" 钩子注入额外变量
     */
    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    /**
     * 执行命令并采集输出:
     *  - 内存中保留尾部 keep 字节,超大时把完整输出落盘到文件
     *  - 通过 ctx.metadata 周期性上报预览
     *  - 与 abort / timeout 竞速,超时或中止则杀进程
     */
    const run = Effect.fn("BashTool.run")(function* (
      input: {
        shell: string
        name: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const bytes = Truncate.MAX_BYTES
      const lines = Truncate.MAX_LINES
      const keep = bytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      // 初始上报元数据
      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      // 执行子进程并等待退出码
      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))

          // 异步消费输出流
          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              // 内存中只保留尾部 keep 字节
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              // 若已落盘则继续追加,否则累积到 full,超过阈值后落盘
              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > bytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          // 中止信号
          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          // 超时信号
          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          // 与进程退出 / 中止 / 超时竞速
          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      // 组装附加元数据(超时 / 中止)
      const meta: string[] = []
      if (expired) {
        meta.push(
          `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, lines, bytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      // 若发生截断,提示完整输出路径
      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      // 附加元数据
      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }
      // 关闭落盘流
      if (sink) {
        const stream = sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    // 返回工具定义工厂(延迟到执行前构造,以便读取当前 shell 等运行时信息)
    return () =>
      Effect.sync(() => {
        // 选择当前可用的 shell
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        // PowerShell 5.1 不支持 && 链式,需要替换说明文本
        const chain =
          name === "powershell"
            ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
            : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
        log.info("bash tool using shell", { shell })

        return {
          // 用运行时信息替换描述模板中的占位符
          description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
            .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
          parameters: Parameters,
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              // 解析 workdir(默认为项目根目录)
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, Instance.directory, shell)
                : Instance.directory
              // 校验 timeout
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = PS.has(name)
              // 解析命令为 AST
              const root = yield* parse(params.command, ps)
              // 扫描涉及的外部目录与 bash 模式
              const scan = yield* collect(root, cwd, ps, shell)
              // 若 cwd 在项目外,加入外部目录询问
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
              // 请求权限
              yield* ask(ctx, scan)

              // 执行
              return yield* run(
                {
                  shell,
                  name,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
