import fs from "fs/promises"
import path from "path"
import { inspect } from "util"
import { Global } from "../global"
import * as Log from "./log"

let filepath = ""
let sequence = 0

function on(value: string | undefined) {
  if (!value) return false
  return ["1", "true", "yes", "on", "debug", "trace"].includes(value.toLowerCase())
}

function enabled() {
  if (process.env.OPENCODE_DEBUG_DEFAULT === "1") return true
  return on(process.env.OPENCODE_FLOW_LOG)
}

function limit(input: string) {
  const max = Number(process.env.OPENCODE_FLOW_LOG_MAX_STRING ?? 4000)
  if (on(process.env.OPENCODE_TRACE_FULL) || input.length <= max) return input
  return input.slice(0, max) + `...[已截断，原始长度=${input.length}]`
}

function depthPreview(value: unknown) {
  const rendered = inspect(value, { depth: 4, maxArrayLength: 50, breakLength: 160, compact: true })
  return `[超过最大深度，预览前1000字符] ${rendered.slice(0, 1000)}${
    rendered.length > 1000 ? `...[预览已截断，原始长度=${rendered.length}]` : ""
  }`
}

function normalize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: limit(value.stack ?? ""),
      cause: value.cause ? normalize(value.cause, depth + 1, seen) : undefined,
    }
  }
  if (value instanceof Headers) return normalize(Object.fromEntries(value.entries()), depth + 1, seen)
  if (typeof value === "string") return limit(value)
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[函数:${value.name || "anonymous"}]`
  if (typeof value !== "object") return String(value)
  if (seen.has(value)) return "[循环引用]"
  if (depth >= Number(process.env.OPENCODE_FLOW_LOG_MAX_DEPTH ?? (on(process.env.OPENCODE_TRACE_FULL) ? 100 : 32)))
    return depthPreview(value)
  seen.add(value)
  if (Array.isArray(value)) {
    const max = Number(process.env.OPENCODE_FLOW_LOG_MAX_ARRAY ?? 50)
    const items = on(process.env.OPENCODE_TRACE_FULL) ? value : value.slice(0, max)
    return [
      ...items.map((item) => normalize(item, depth + 1, seen)),
      ...(items.length < value.length ? [`[数组已截断，剩余=${value.length - items.length}]`] : []),
    ]
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalize(item, depth + 1, seen)]),
  )
}

export async function init(runID: string, processRole: string) {
  if (!enabled()) return
  await fs.mkdir(Global.Path.log, { recursive: true })
  filepath = path.join(Global.Path.log, `flow-${runID}-${processRole}.log`)
  await fs
    .appendFile(
      filepath,
      `\n========== ${Log.timestamp()} ${processRole} pid=${process.pid} cwd=${process.cwd()} ==========\n`,
    )
    .catch(() => {})
}

export function file() {
  return filepath
}

export function write(step: string, data?: Record<string, unknown>) {
  if (!enabled()) return
  if (!filepath) return
  const line = [
    Log.timestamp(),
    `#${String(++sequence).padStart(4, "0")}`,
    `[${process.env.OPENCODE_PROCESS_ROLE ?? "main"}]`,
    step,
    data ? JSON.stringify(normalize(data)) : "",
  ]
    .filter(Boolean)
    .join(" ")
  void fs.appendFile(filepath, line + "\n").catch((error) => {
    Log.Default.warn("flow log write failed", { error })
  })
}
