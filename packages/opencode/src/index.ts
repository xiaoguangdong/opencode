// ===== 引入 yargs(命令行解析器)与工具函数 =====
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
// ===== 引入各子命令实现 =====
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util"
import { FlowLog } from "./util"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "./installation/version"
import { NamedError } from "@opencode-ai/shared/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { Filesystem } from "./util"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import path from "path"
import { Global } from "./global"
// 引入旧 JSON 存储到 SQLite 的一次性迁移工具
import { JsonMigration } from "./storage"
import { Database } from "./storage"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
// 引入 drizzle ORM(用于 SQLite)
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "./util/opencode-process"
import fs from "fs/promises"

// 生成/获取本次进程的元信息(runID、processRole 等)
const processMetadata = ensureProcessMetadata("main")

// ===== 全局未处理错误兜底 =====

// Promise 未处理拒绝:仅记录日志
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

// 未捕获异常:仅记录日志
process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

// 解析命令行参数(去掉 node/bun 可执行路径)
const args = hideBin(process.argv)

/**
 * 展示 help / 用法输出:
 *  - 若文本以 "opencode " 开头,认为是 yargs 的正常输出,直接写入
 *  - 否则在输出前面打印 logo
 */
function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

// ===== 构建 yargs CLI =====

const cli = yargs(args)
  // 允许 "--" 后的参数被收集到 argv["--"],以便透传给子命令
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  // 通用选项:--print-logs 是否把日志打到 stderr
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  // 通用选项:--log-level 指定日志级别
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  // 通用选项:--pure 禁用外部插件
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  // 中间件:所有子命令执行前的通用初始化
  .middleware(async (opts) => {
    // --pure 时通过环境变量通知内部逻辑
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    // 判断是否处于 debug 默认模式(可执行文件名含 opencode_debug,或显式设置环境变量)
    const debugDefault =
      [process.argv[0], process.argv[1], process.execPath].some((item) => path.basename(item ?? "") === "opencode_debug") ||
      process.env.OPENCODE_DEBUG_DEFAULT === "1"
    if (debugDefault) process.env.OPENCODE_DEBUG_DEFAULT = "1"
    if (debugDefault) {
      // debug 模式下把日志写到当前目录的 .opencode/logs
      Global.Path.log = path.join(process.cwd(), ".opencode", "logs")
      process.env.OPENCODE_LOG_DIR = Global.Path.log
      await fs.mkdir(Global.Path.log, { recursive: true })
    }
    // 初始化主日志
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (debugDefault) return "DEBUG"
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })
    // 初始化流程日志(以本次 runID 和 processRole 作为标识)
    await FlowLog.init(processMetadata.runID, processMetadata.processRole)

    // 启动堆监控
    Heap.start()

    // 设置运行标记,便于子进程 / 插件识别当前运行在 opencode 下
    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    // 记录启动日志
    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
      log_path: Log.file(),
      flow_log_path: FlowLog.file(),
    })
    FlowLog.write("进程启动", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      processRole: processMetadata.processRole,
      runID: processMetadata.runID,
      logPath: Log.file(),
      flowLogPath: FlowLog.file(),
      cwd: process.cwd(),
    })

    // ===== 一次性数据库迁移:旧 JSON 存储 -> SQLite =====
    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      // TTY 下隐藏光标,避免进度条闪烁
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            // 进度百分比未变且不是最后一条时跳过刷新
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              // TTY 下渲染进度条
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              // 非 TTY 下按行打印进度
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        // 恢复光标
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  // 生成 shell 补全脚本
  .completion("completion", "generate shell completion script")
  // ===== 注册所有子命令 =====
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  // 失败处理:对"参数错误"类的 msg 展示帮助信息
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  // strict 模式:拒绝未知参数
  .strict()

// ===== 执行 CLI =====

try {
  // 若直接请求帮助,则走自定义输出路径(带 logo)
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  // ===== 顶层异常处理:收集尽可能多的错误信息 =====
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  // Bun 特有的 ResolveMessage(模块解析错误)
  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  // 让格式化器决定展示方式
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  // 无法格式化时,提示查日志文件
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // 某些子进程(尤其是基于 docker 容器的 MCP 服务器)不响应 SIGTERM 之类的信号,
  // 除非用 `docker run --init` 启动。此处显式退出以避免挂起。
  process.exit()
}
