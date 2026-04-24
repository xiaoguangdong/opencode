import * as Log from "./log"

const secretPattern =
  /(api[_-]?key|authorization|bearer|token|secret|password|credential|cookie|set-cookie|access|refresh|encrypted|cipher|signature)/i
const maxString = Number(process.env.OPENCODE_TRACE_MAX_STRING ?? 20000)
const maxArray = Number(process.env.OPENCODE_TRACE_MAX_ARRAY ?? 200)
const maxDepth = Number(process.env.OPENCODE_TRACE_MAX_DEPTH ?? 8)
const cwd = process.cwd()

function on(value: string | undefined) {
  if (!value) return false
  return ["1", "true", "yes", "on", "debug", "trace"].includes(value.toLowerCase())
}

function scrubSecrets() {
  return on(process.env.OPENCODE_TRACE_SCRUB)
}

export function enabled(scope?: string) {
  if (process.env.OPENCODE_DEBUG_DEFAULT === "1") return true
  if (on(process.env.OPENCODE_TRACE)) return true
  if (!scope) return false
  return on(process.env[`OPENCODE_TRACE_${scope.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`])
}

function limitString(input: string) {
  if (on(process.env.OPENCODE_TRACE_FULL)) return input
  if (input.length <= maxString) return input
  return input.slice(0, maxString) + `...[已截断，原始长度=${input.length}]`
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>, key?: string): unknown {
  if (scrubSecrets() && key && secretPattern.test(key)) {
    if (value === undefined || value === null || value === "") return value
    return "[已脱敏]"
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: limitString(value.stack ?? ""),
      cause: value.cause ? scrub(value.cause, depth + 1, seen) : undefined,
    }
  }
  if (value instanceof Headers) {
    return scrub(Object.fromEntries(value.entries()), depth + 1, seen)
  }
  if (typeof value === "string") return limitString(value)
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[函数:${value.name || "anonymous"}]`
  if (typeof value !== "object") return String(value)
  if (seen.has(value)) return "[循环引用]"
  if (depth >= maxDepth) return "[超过最大深度]"
  seen.add(value)
  if (Array.isArray(value)) {
    const items = on(process.env.OPENCODE_TRACE_FULL) ? value : value.slice(0, maxArray)
    return [
      ...items.map((item, index) => scrub(item, depth + 1, seen, String(index))),
      ...(items.length < value.length ? [`[数组已截断，剩余=${value.length - items.length}]`] : []),
    ]
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([itemKey, itemValue]) => [
      itemKey,
      scrub(itemValue, depth + 1, seen, itemKey),
    ]),
  )
}

export function sanitize<T>(value: T): T {
  return scrub(value, 0, new WeakSet()) as T
}

function normalizeSource(source: string | undefined) {
  if (!source) return undefined
  const value = source.startsWith("file://") ? new URL(source).pathname : source
  if (value.startsWith(cwd + "/")) return value.slice(cwd.length + 1)
  const marker = "/packages/"
  const index = value.indexOf(marker)
  if (index >= 0) return value.slice(index + 1)
  return value
}

function scriptName(source: string | undefined) {
  const normalized = normalizeSource(source)
  return normalized?.split("/").at(-1)
}

function callsite() {
  const stack = new Error().stack?.split("\n").slice(2) ?? []
  return stack
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .find((line) => !line.includes("util/trace") && !line.includes("chunk-") && !line.includes("node_modules"))
}

export function create(scope: string, source?: string) {
  const logger = Log.create({ service: `trace.${scope}` })
  const base = {
    script: scriptName(source),
    source_file: normalizeSource(source),
  }
  return {
    enabled: () => enabled(scope),
    info(message: string, extra?: Record<string, unknown>) {
      if (!enabled(scope)) return
      logger.info(`【追踪】${message}`, sanitize({ ...base, callsite: callsite(), ...(extra ?? {}) }))
    },
    warn(message: string, extra?: Record<string, unknown>) {
      if (!enabled(scope)) return
      logger.warn(`【追踪】${message}`, sanitize({ ...base, callsite: callsite(), ...(extra ?? {}) }))
    },
    error(message: string, extra?: Record<string, unknown>) {
      if (!enabled(scope)) return
      logger.error(`【追踪】${message}`, sanitize({ ...base, callsite: callsite(), ...(extra ?? {}) }))
    },
  }
}
