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

function readCodexAuthKey(auth: unknown) {
  if (typeof auth === "string") return auth
  if (!auth || typeof auth !== "object") return undefined
  const value = (auth as Record<string, unknown>)["OPENAI_API_KEY"]
  return typeof value === "string" && value !== "" ? value : undefined
}

export function loadCodexConfig(fs: AppFileSystem.Interface): Effect.Effect<Info> {
  const configPath = path.join(os.homedir(), ".codex", "config.toml")
  const authPath = path.join(os.homedir(), ".codex", "auth.json")
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
    const codexAuth = yield* fs.readJson(authPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const codexApiKey = requiresOpenaiAuth === false ? undefined : readCodexAuthKey(codexAuth)
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
            ...(codexApiKey ? { apiKey: codexApiKey } : {}),
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
      authPath,
      authSource: codexApiKey ? ".codex/auth.json" : env.length > 0 ? "environment" : "none",
      generated: result,
    })
    return result
  })
}
