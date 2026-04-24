export * as ConfigCodex from "./codex"

import os from "os"
import path from "path"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Trace } from "@/util"
import type { Info } from "./config"
import { Effect } from "effect"

const trace = Trace.create("codex", "packages/opencode/src/config/codex.ts")

function readString(text: string, key: string) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1]
}

function readBool(text: string, key: string) {
  const value = new RegExp(`^${key}\\s*=\\s*(true|false)`, "m").exec(text)?.[1]
  if (value === undefined) return undefined
  return value === "true"
}

function readProviderBlock(text: string, providerID: string) {
  const escaped = providerID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`\\[model_providers\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(text)
  return match?.[1] ?? ""
}

function wireApiProvider(wireApi: string | undefined) {
  if (wireApi === "chat") return "@ai-sdk/openai-compatible"
  return "@ai-sdk/openai"
}

export function loadCodexConfig(fs: AppFileSystem.Interface): Effect.Effect<Info> {
  const configPath = path.join(os.homedir(), ".codex", "config.toml")
  return Effect.gen(function* () {
    const text = yield* fs.readFileString(configPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!text) return {}

    const providerID = readString(text, "model_provider")
    const modelID = readString(text, "model")
    if (!providerID || !modelID) return {}

    const block = readProviderBlock(text, providerID)
    const baseURL = readString(block, "base_url")
    const wireApi = readString(block, "wire_api")
    const requiresOpenaiAuth = readBool(block, "requires_openai_auth")
    const env = requiresOpenaiAuth === false ? [] : ["OPENAI_API_KEY"]
    const result: Info = {
      $schema: "https://opencode.ai/config.json",
      model: `${providerID}/${modelID}`,
      small_model: `${providerID}/${modelID}`,
      provider: {
        [providerID]: {
          name: readString(block, "name") ?? providerID,
          npm: wireApiProvider(wireApi),
          env,
          options: {
            ...(baseURL ? { baseURL } : {}),
            ...(requiresOpenaiAuth === false ? { apiKey: "codex-local" } : {}),
          },
          models: {
            [modelID]: {
              id: modelID,
              name: modelID,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: {
                context: 400000,
                output: 128000,
              },
            },
          },
        },
      },
    }

    trace.info("已从 .codex/config.toml 生成 opencode provider 配置", {
      configPath,
      providerID,
      modelID,
      baseURL,
      wireApi,
      requiresOpenaiAuth,
      generated: result,
    })
    return result
  })
}
