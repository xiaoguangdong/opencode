// 引入 Node 的 os 模块(用于获取 home 目录)
import os from "os"
import path from "path"
// 引入 Effect 核心类型
import { Effect, Layer, Context } from "effect"
// 引入 Effect 生态下的 HTTP 客户端相关模块
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
// 引入配置服务
import { Config } from "@/config"
// 引入基于 Instance 的状态管理
import { InstanceState } from "@/effect"
// 引入特性开关
import { Flag } from "@/flag/flag"
// 引入文件系统服务
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
// 引入带瞬时读重试的 HTTP 客户端包装
import { withTransientReadRetry } from "@/util/effect-http-client"
// 引入全局路径
import { Global } from "../global"
// 引入日志工具
import { Log } from "../util"
// 引入消息类型
import type { MessageV2 } from "./message-v2"
// 引入消息 ID 类型
import type { MessageID } from "./schema"

// 创建本模块的 logger
const log = Log.create({ service: "instruction" })

// 支持的项目级指令文件名,按优先级顺序查找
const FILES = [
  "AGENTS.md",
  // 未禁用 Claude Code prompt 时同时支持 CLAUDE.md
  ...(Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // 已废弃
]

/**
 * 返回全局级指令文件的候选路径(按优先级顺序)
 */
function globalFiles() {
  const files = []
  // 若显式配置了 OPENCODE_CONFIG_DIR,优先使用其中的 AGENTS.md
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  // 全局配置目录下的 AGENTS.md
  files.push(path.join(Global.Path.config, "AGENTS.md"))
  // 未禁用 Claude Code prompt 时,追加 ~/.claude/CLAUDE.md
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  return files
}

/**
 * 从历史消息中提取已经被 read 工具加载过的文件路径集合
 */
function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      // 只关心 read 工具且执行完成的调用
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        // 已被压缩的结果跳过
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

/**
 * Instruction 服务接口
 * - clear:       清除某条消息关联的指令文件记录
 * - systemPaths: 返回系统级指令文件路径集合
 * - system:      读取并返回系统级指令内容
 * - find:        在指定目录查找第一个匹配的指令文件
 * - resolve:     针对某次读取的文件,从上层目录查找附近的指令文件
 */
export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

// 定义 Effect Service Tag
export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

/**
 * Instruction 的 Layer 实现
 * 依赖:AppFileSystem / Config / HttpClient
 */
export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Config.Service | HttpClient.HttpClient> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // 依赖注入
      const cfg = yield* Config.Service
      const fs = yield* AppFileSystem.Service
      // 带瞬时读重试的 HTTP 客户端,并且只接受 2xx 状态
      const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))

      // 按 Instance 隔离的状态
      const state = yield* InstanceState.make(
        Effect.fn("Instruction.state")(() =>
          Effect.succeed({
            // 记录每条 assistant 消息已附加过哪些指令文件,避免重复附加
            claims: new Map<MessageID, Set<string>>(),
          }),
        ),
      )

      /**
       * 以"相对于项目"的方式解析一个指令路径:
       * - 未禁用项目配置时:从 ctx.directory 向上查找到 ctx.worktree
       * - 已禁用项目配置时:回退到 OPENCODE_CONFIG_DIR 中查找
       */
      const relative = Effect.fnUntraced(function* (instruction: string) {
        const ctx = yield* InstanceState.context
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          return yield* fs
            .globUp(instruction, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        }
        if (!Flag.OPENCODE_CONFIG_DIR) {
          log.warn(
            `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
          )
          return []
        }
        return yield* fs
          .globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      })

      /**
       * 读取文件内容,读取失败时返回空字符串
       */
      const read = Effect.fnUntraced(function* (filepath: string) {
        return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
      })

      /**
       * 拉取远程指令内容,5 秒超时,失败返回空字符串
       */
      const fetch = Effect.fnUntraced(function* (url: string) {
        const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
          Effect.timeout(5000),
          Effect.catch(() => Effect.succeed(null)),
        )
        if (!res) return ""
        const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
        return new TextDecoder().decode(body)
      })

      /**
       * 清除某条消息关联的指令文件记录
       */
      const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
        const s = yield* InstanceState.get(state)
        s.claims.delete(messageID)
      })

      /**
       * 计算"系统级"指令文件路径集合:
       *  1. 项目级:从 FILES 中按顺序查找,第一个命中的生效(避免叠加多层祖先目录的指令)
       *  2. 全局级:从 globalFiles() 中查找第一个存在的文件
       *  3. 用户配置里的 instructions(相对/绝对路径形式)
       */
      const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
        const config = yield* cfg.get()
        const ctx = yield* InstanceState.context
        const paths = new Set<string>()

        // 项目级:第一个匹配生效
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of FILES) {
            const matches = yield* fs.findUp(file, ctx.directory, ctx.worktree)
            if (matches.length > 0) {
              matches.forEach((item) => paths.add(path.resolve(item)))
              break
            }
          }
        }

        // 全局级:第一个存在的生效
        for (const file of globalFiles()) {
          if (yield* fs.existsSafe(file)) {
            paths.add(path.resolve(file))
            break
          }
        }

        // 用户配置中显式声明的 instructions(排除 http(s) URL,由 system 单独处理)
        if (config.instructions) {
          for (const raw of config.instructions) {
            if (raw.startsWith("https://") || raw.startsWith("http://")) continue
            // 展开 ~ 为 home 目录
            const instruction = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw
            const matches = yield* (
              path.isAbsolute(instruction)
                ? fs.glob(path.basename(instruction), {
                    cwd: path.dirname(instruction),
                    absolute: true,
                    include: "file",
                  })
                : relative(instruction)
            ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
            matches.forEach((item) => paths.add(path.resolve(item)))
          }
        }

        return paths
      })

      /**
       * 加载所有系统级指令的文本内容:
       * - 本地文件(并发 8)
       * - 远程 URL(并发 4)
       */
      const system = Effect.fn("Instruction.system")(function* () {
        const config = yield* cfg.get()
        const paths = yield* systemPaths()
        // 用户配置里的 http(s) URL
        const urls = (config.instructions ?? []).filter(
          (item) => item.startsWith("https://") || item.startsWith("http://"),
        )

        const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
        const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

        return [
          ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
          ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ]
      })

      /**
       * 在指定目录下查找第一个存在的指令文件
       */
      const find = Effect.fn("Instruction.find")(function* (dir: string) {
        for (const file of FILES) {
          const filepath = path.resolve(path.join(dir, file))
          if (yield* fs.existsSafe(filepath)) return filepath
        }
      })

      /**
       * 针对某次文件读取,从其所在目录向上查找附近的指令文件并返回内容。
       * - 已作为"系统级"加载过的文件跳过
       * - 已在历史消息里加载过的文件跳过
       * - 每条消息对同一文件只声明一次(claims)
       */
      const resolve = Effect.fn("Instruction.resolve")(function* (
        messages: MessageV2.WithParts[],
        filepath: string,
        messageID: MessageID,
      ) {
        const sys = yield* systemPaths()
        // 已经出现在历史 read 记录里的文件
        const already = extract(messages)
        const results: { filepath: string; content: string }[] = []
        const s = yield* InstanceState.get(state)
        const root = path.resolve(yield* InstanceState.directory)

        const target = path.resolve(filepath)
        // 从目标文件所在目录开始向上遍历
        let current = path.dirname(target)

        // 从读取的文件向上,逐级附加附近的指令文件(每条消息只附加一次)
        while (current.startsWith(root) && current !== root) {
          const found = yield* find(current)
          if (!found || found === target || sys.has(found) || already.has(found)) {
            current = path.dirname(current)
            continue
          }

          let set = s.claims.get(messageID)
          if (!set) {
            set = new Set()
            s.claims.set(messageID, set)
          }
          if (set.has(found)) {
            current = path.dirname(current)
            continue
          }

          set.add(found)
          const content = yield* read(found)
          if (content) {
            results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
          }

          current = path.dirname(current)
        }

        return results
      })

      // 返回 Service 实例
      return Service.of({ clear, systemPaths, system, find, resolve })
    }),
  )

// 默认 Layer:装配 Config / AppFileSystem / FetchHttpClient 依赖
export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

/**
 * 从消息历史中提取已被 read 工具加载的文件路径集合(对外导出)
 */
export function loaded(messages: MessageV2.WithParts[]) {
  return extract(messages)
}

// 以命名空间形式导出
export * as Instruction from "./instruction"
