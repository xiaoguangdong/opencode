import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
// 引入 UI 输出工具
import { UI } from "../ui"
// 引入子命令通用构造器
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
// 引入引导程序(初始化运行时环境)
import { bootstrap } from "../bootstrap"
import { EOL } from "os"
import { Filesystem } from "../../util"
// 引入 SDK 客户端和工具 Part 类型
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
// 引入 Server(本地 HTTP 服务)
import { Server } from "../../server/server"
import { Provider } from "../../provider"
import { Agent } from "../../agent/agent"
import { Permission } from "../../permission"
// 引入所有内置工具的类型(仅用于类型推导)
import { Tool } from "../../tool"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ReadTool } from "../../tool/read"
import { WebFetchTool } from "../../tool/webfetch"
import { EditTool } from "../../tool/edit"
import { WriteTool } from "../../tool/write"
import { CodeSearchTool } from "../../tool/codesearch"
import { WebSearchTool } from "../../tool/websearch"
import { TaskTool } from "../../tool/task"
import { SkillTool } from "../../tool/skill"
import { BashTool } from "../../tool/bash"
import { TodoWriteTool } from "../../tool/todo"
import { Locale } from "../../util"
// 引入 Effect 运行时(用于直接调用 Agent 服务)
import { AppRuntime } from "@/effect/app-runtime"

/**
 * 工具渲染所需的 props 形状
 */
type ToolProps<T> = {
  input: Tool.InferParameters<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

/**
 * 从 ToolPart 中提取渲染所需的 props(input / metadata / part)
 */
function props<T>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as Tool.InferParameters<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

// 内联渲染信息
type Inline = {
  icon: string
  title: string
  description?: string
}

/**
 * 单行渲染:icon + title + (可选)dim 的 description
 */
function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

/**
 * 块状渲染:先空一行,再输出 inline 信息,再输出正文
 */
function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

/**
 * 兜底渲染:未知工具时使用,尝试用 title 或 JSON 化的 input 展示
 */
function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

// ===== 各类工具的渲染函数 =====

/**
 * Glob 工具渲染:标题包含 pattern,描述包含路径与匹配数量
 */
function glob(info: ToolProps<typeof GlobTool>) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

/**
 * Grep 工具渲染:标题包含 pattern,描述包含路径与匹配数量
 */
function grep(info: ToolProps<typeof GrepTool>) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

/**
 * Read 工具渲染:展示文件路径 + 其它参数的 [key=value,...]
 */
function read(info: ToolProps<typeof ReadTool>) {
  const file = normalizePath(info.input.filePath)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "filePath") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

/**
 * Write 工具渲染:块状展示写入内容(仅完成的 part 有输出)
 */
function write(info: ToolProps<typeof WriteTool>) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.filePath)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

/**
 * WebFetch 工具渲染:仅内联展示 URL
 */
function webfetch(info: ToolProps<typeof WebFetchTool>) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

/**
 * Edit 工具渲染:块状展示文件路径 + diff
 */
function edit(info: ToolProps<typeof EditTool>) {
  const title = normalizePath(info.input.filePath)
  const diff = info.metadata.diff
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    diff,
  )
}

/**
 * CodeSearch 工具渲染:仅展示查询语句
 */
function codesearch(info: ToolProps<typeof CodeSearchTool>) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

/**
 * WebSearch 工具渲染:仅展示查询语句
 */
function websearch(info: ToolProps<typeof WebSearchTool>) {
  inline({
    icon: "◈",
    title: `Exa Web Search "${info.input.query}"`,
  })
}

/**
 * Task 工具渲染:
 *  - 从 input 中读取 subagent_type 与 description
 *  - 状态决定 icon:error=✗, running=•, 其它=✓
 */
function task(info: ToolProps<typeof TaskTool>) {
  const input = info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof input.subagent_type === "string" && input.subagent_type.trim().length > 0 ? input.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc =
    typeof input.description === "string" && input.description.trim().length > 0 ? input.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

/**
 * Skill 工具渲染:展示技能名
 */
function skill(info: ToolProps<typeof SkillTool>) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

/**
 * Bash 工具渲染:块状展示命令 + 输出
 */
function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

/**
 * TodoWrite 工具渲染:展示 todo 列表
 */
function todo(info: ToolProps<typeof TodoWriteTool>) {
  block(
    {
      icon: "#",
      title: "Todos",
    },
    info.input.todos.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n"),
  )
}

/**
 * 把绝对路径规范为相对 cwd 的相对路径;已是相对路径则原样返回
 */
function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

/**
 * run 子命令:
 *  - 用法:`opencode run [message..]`
 *  - 支持参数:消息、--command、--continue/-c、--session/-s、--fork、
 *              --share、--model/-m、--agent、--format、--file/-f、--title、
 *              --attach、--password/-p、--dir、--port、--variant、
 *              --thinking、--dangerously-skip-permissions
 */
export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      // 位置参数:消息内容(可多个)
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      // --command 用命令替代自由文本,message 作为参数
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      // --continue / -c 继续上次会话
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      // --session / -s 指定要续接的会话 ID
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      // --fork 在续接前 fork 出新会话
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      // --share 共享会话
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      // --model / -m 指定模型(provider/model)
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      // --agent 指定使用的 agent
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      // --format 输出格式:default(美化) / json(原始事件)
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      // --file / -f 附加文件到消息(可多个)
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      // --title 会话标题(空时用消息截断)
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      // --attach 连接到已运行的 server
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      // --password / -p Basic 鉴权密码
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      // --dir 工作目录(attach 时为服务端目录)
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      // --port 本地服务端口
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      // --variant 模型变体(推理强度等)
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      // --thinking 显示 thinking 块
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
        default: false,
      })
      // --dangerously-skip-permissions 自动放行未显式 deny 的权限(危险)
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
  },
  handler: async (args) => {
    // ===== 1. 拼接消息 =====
    // 把位置参数 + "--" 后的参数拼为一条消息,含空格的参数加引号
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    // ===== 2. 处理 --dir =====
    // 非 attach 时:切换进程 cwd;attach 时:作为服务端目录透传
    const directory = (() => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        process.exit(1)
      }
    })()

    // ===== 3. 处理 --file:构造 file 类 part =====
    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        // 目录用 x-directory 的 MIME,其它按 text/plain
        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    // ===== 4. 非 TTY 时:从 stdin 读取追加到 message =====
    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    // ===== 5. 参数校验 =====
    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    // ===== 6. 会话创建时的默认权限规则 =====
    // run 模式下:禁止 question / plan_enter / plan_exit
    const rules: Permission.Ruleset = [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_enter",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      },
    ]

    /**
     * 计算会话标题:
     *  - 未指定 --title:返回 undefined(由 server 决定)
     *  - 指定空标题:取 message 前 50 字符
     *  - 指定非空:直接使用
     */
    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    /**
     * 获取/创建会话 ID:
     *  - --continue:取列表中第一个无 parentID 的会话
     *  - --session:直接使用指定 ID
     *  - --fork:对 baseID 做 fork 得到新会话
     *  - 都没有:创建新会话
     */
    async function session(sdk: OpencodeClient) {
      const baseID = args.continue ? (await sdk.session.list()).data?.find((s) => !s.parentID)?.id : args.session

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        return forked.data?.id
      }

      if (baseID) return baseID

      const name = title()
      const result = await sdk.session.create({ title: name, permission: rules })
      return result.data?.id
    }

    /**
     * 共享会话:
     *  - 需要 config.share === "auto" 或 OPENCODE_AUTO_SHARE 或显式 --share
     *  - 共享成功后打印 URL
     */
    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.OPENCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    /**
     * 主执行流程:订阅事件流 + 渲染 + 发送 prompt/command
     */
    async function execute(sdk: OpencodeClient) {
      /**
       * 根据工具类型分派到对应渲染函数;失败时走 fallback
       */
      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "glob") return glob(props<typeof GlobTool>(part))
          if (part.tool === "grep") return grep(props<typeof GrepTool>(part))
          if (part.tool === "read") return read(props<typeof ReadTool>(part))
          if (part.tool === "write") return write(props<typeof WriteTool>(part))
          if (part.tool === "webfetch") return webfetch(props<typeof WebFetchTool>(part))
          if (part.tool === "edit") return edit(props<typeof EditTool>(part))
          if (part.tool === "codesearch") return codesearch(props<typeof CodeSearchTool>(part))
          if (part.tool === "websearch") return websearch(props<typeof WebSearchTool>(part))
          if (part.tool === "task") return task(props<typeof TaskTool>(part))
          if (part.tool === "todowrite") return todo(props<typeof TodoWriteTool>(part))
          if (part.tool === "skill") return skill(props<typeof SkillTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      /**
       * JSON 模式的事件输出:命中时返回 true 表示已消费
       */
      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      // 订阅 SDK 事件流
      const events = await sdk.event.subscribe()
      let error: string | undefined

      // 事件循环:处理各类事件
      async function loop() {
        // 按 part.id 去重的 toggles(用于首次打印一次的信息)
        const toggles = new Map<string, boolean>()

        for await (const event of events.stream) {
          // 助手消息开始时输出一行 header(默认格式下)
          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            args.format !== "json" &&
            toggles.get("start") !== true
          ) {
            UI.empty()
            UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
            UI.empty()
            toggles.set("start", true)
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            // 工具 part:完成或出错时渲染
            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              if (emit("tool_use", { part })) continue
              if (part.state.status === "completed") {
                tool(part)
                continue
              }
              // 出错时输出错误
              inline({
                icon: "✗",
                title: `${part.tool} failed`,
              })
              UI.error(part.state.error)
            }

            // task 工具 running 时立即渲染一次(默认格式)
            if (
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              args.format !== "json"
            ) {
              if (toggles.get(part.id) === true) continue
              task(props<typeof TaskTool>(part))
              toggles.set(part.id, true)
            }

            // step-start / step-finish:仅 JSON 模式输出
            if (part.type === "step-start") {
              if (emit("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (emit("step_finish", { part })) continue
            }

            // 文本 part 完成时输出
            if (part.type === "text" && part.time?.end) {
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              // 非 TTY:直接写 stdout
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            // reasoning part 完成时输出(仅 --thinking 开启)
            if (part.type === "reasoning" && part.time?.end && args.thinking) {
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }
          }

          // 会话错误
          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            error = error ? error + EOL + err : err
            if (emit("error", { error: props.error })) continue
            UI.error(err)
          }

          // 会话 idle:退出事件循环
          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            break
          }

          // 权限询问:根据 --dangerously-skip-permissions 决定自动放行或拒绝
          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue

            if (args["dangerously-skip-permissions"]) {
              await sdk.permission.reply({
                requestID: permission.id,
                reply: "once",
              })
            } else {
              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "!",
                UI.Style.TEXT_NORMAL +
                  `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
              )
              await sdk.permission.reply({
                requestID: permission.id,
                reply: "reject",
              })
            }
          }
        }
      }

      // ===== 校验 --agent =====
      // attach 时通过 SDK 查询远端可用 agent;本地时通过 AppRuntime 查询
      const agent = await (async () => {
        if (!args.agent) return undefined
        const name = args.agent

        // attach 模式:从远端查询 agent 列表
        if (args.attach) {
          const modes = await sdk.app
            .agents(undefined, { throwOnError: true })
            .then((x) => x.data ?? [])
            .catch(() => undefined)

          if (!modes) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `failed to list agents from ${args.attach}. Falling back to default agent`,
            )
            return undefined
          }

          const agent = modes.find((a) => a.name === name)
          if (!agent) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${name}" not found. Falling back to default agent`,
            )
            return undefined
          }

          if (agent.mode === "subagent") {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
            )
            return undefined
          }

          return name
        }

        // 本地模式:通过 Effect 服务查询 agent
        const entry = await AppRuntime.runPromise(Agent.Service.use((svc) => svc.get(name)))
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      })()

      // ===== 创建/获取会话 =====
      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }
      await share(sdk, sessionID)

      // 启动事件消费循环(不 await,后台消费)
      loop().catch((e) => {
        console.error(e)
        process.exit(1)
      })

      // ===== 发送 prompt 或 command =====
      if (args.command) {
        // --command:以命令形式发送
        await sdk.session.command({
          sessionID,
          agent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        // 默认:以 prompt 形式发送(parts = 附加文件 + 文本)
        const model = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.prompt({
          sessionID,
          agent,
          model,
          variant: args.variant,
          parts: [...files, { type: "text", text: message }],
        })
      }
    }

    // ===== attach 模式:直接连接远端 server =====
    if (args.attach) {
      // 构造 Basic 鉴权头
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await execute(sdk)
    }

    // ===== 非 attach:本地启动 server + 内联 fetch =====
    await bootstrap(process.cwd(), async () => {
      // 用 Server.Default().app.fetch 拦截 fetch 请求,不真正走网络
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.Default().app.fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
      await execute(sdk)
    })
  },
})
