/**
 * ProviderTransform — Provider 消息与参数转换模块
 *
 * 职责：
 *  1. 消息标准化 (normalizeMessages)：针对不同 provider 的消息格式约束进行修正
 *  2. 消息缓存 (applyCaching)：为支持 prompt caching 的 provider 标记缓存断点
 *  3. 不支持的模态过滤 (unsupportedParts)：将模型不支持的输入转为错误文本
 *  4. 消息入口转换 (message)：编排上述三步 + providerOptions key 重映射
 *  5. 采样参数推荐 (temperature/topP/topK)：按模型特性返回推荐值
 *  6. 推理变体 (variants)：为推理模型生成不同 effort 级别的 providerOptions
 *  7. 默认选项 (options/smallOptions)：按 provider 生成默认 providerOptions
 *  8. providerOptions 命名空间映射 (providerOptions)：将选项路由到 SDK 期望的 key
 *  9. Schema 转换 (schema)：将 JSON Schema 转为 provider 兼容格式（如 Gemini）
 *
 * 调用方：llm.ts 中 streamText 调用前通过 wrapLanguageModel middleware 的
 *         transformParams 注入此模块的 message() 进行消息转换
 */
import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type * as Provider from "./provider"
import type * as ModelsDev from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

/**
 * 将 MIME 类型映射为模型输入模态（image/audio/video/pdf）
 * 用于判断模型是否支持该类型输入
 */
function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

/** 输出 token 上限，可通过环境变量覆盖，默认 32000 */
export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

/**
 * 将 npm 包名映射为 AI SDK providerOptions 期望的 key
 *
 * AI SDK 的 providerOptions 是按 provider 命名空间组织的，
 * 比如 { anthropic: { ... } } / { openai: { ... } }。
 * 但 OpenCode 内部使用 npm 包名来标识 provider，
 * 需要通过此函数将包名转换为 SDK 期望的命名空间 key。
 */
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
  }
  return undefined
}

/**
 * 消息标准化 — 修正不同 provider 的消息格式约束
 *
 * 各 LLM provider 对消息格式有不同要求，此函数按 provider 逐项修正：
 *  - Anthropic/Bedrock：过滤空内容消息（空字符串/空数组）
 *  - Claude：清洗 toolCallId 中的非法字符（只保留 a-zA-Z0-9_-）
 *  - Anthropic：重排 tool-call 和非 tool-call 内容的顺序（tool-call 必须紧跟 tool-result）
 *  - Mistral：toolCallId 清洗为纯字母数字且固定 9 字符，并修复 tool→user 消息序列
 *  - 支持 interleaved reasoning 的模型：将 reasoning 部分提取到 providerOptions 字段
 */
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  // ── Anthropic / Bedrock：过滤空内容消息 ──
  // Anthropic 拒绝包含空内容的消息（空字符串或空文本/reasoning 部分）
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text" || part.type === "reasoning") {
            return part.text !== ""
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  // ── Claude：清洗 toolCallId 非法字符 ──
  // Claude 的 toolCallId 只允许 a-zA-Z0-9_-，其他字符会被拒绝
  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }

  // ── Anthropic：重排 tool-call 内容顺序 ──
  // Anthropic 拒绝 tool_use 后面紧跟非 tool 内容的消息（如 [tool_use, tool_use, text]），
  // 报错 "tool_use ids were found without tool_result blocks immediately after..."
  // 这里将 [text, tool_use, tool_use] 拆分为 [text] + [tool_use, tool_use] 两条消息，
  // 后续连续的 assistant 消息会被 provider/SDK 合并，从而避免非法 payload
  if (["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
    msgs = msgs.flatMap((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg]

      const parts = msg.content
      const first = parts.findIndex((part) => part.type === "tool-call")
      if (first === -1) return [msg] // 没有 tool-call，无需处理
      if (!parts.slice(first).some((part) => part.type !== "tool-call")) return [msg] // 全是 tool-call，无需处理
      // 将非 tool-call 部分和 tool-call 部分拆分为两条消息
      return [
        { ...msg, content: parts.filter((part) => part.type !== "tool-call") },
        { ...msg, content: parts.filter((part) => part.type === "tool-call") },
      ]
    })
  }

  // ── Mistral：toolCallId 清洗 + 消息序列修复 ──
  if (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLocaleLowerCase().includes("devstral")
  ) {
    // Mistral 要求 toolCallId 为纯字母数字且恰好 9 个字符
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // 移除非字母数字字符
        .substring(0, 9) // 取前 9 个字符
        .padEnd(9, "0") // 不足 9 个用 0 填充
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg)

      // Mistral 不允许 tool 消息后面直接跟 user 消息，
      // 需要插入一条 assistant 消息作为过渡
      if (msg.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  // ── 支持 interleaved reasoning 的模型：提取 reasoning 到 providerOptions ──
  // 部分 OpenAI 兼容 provider 通过 reasoning_content / reasoning_details 字段
  // 传递推理内容，而不是作为消息内容的一部分。
  // 这里将 assistant 消息中的 reasoning 部分提取出来，放到 providerOptions 对应字段中
  if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // 从内容中移除 reasoning 部分
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // 如果有 reasoning 内容，放到 providerOptions 的对应字段
        if (reasoningText) {
          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...msg.providerOptions?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
        }

        return {
          ...msg,
          content: filteredContent,
        }
      }

      return msg
    })
  }

  return msgs
}

/**
 * 应用 Prompt Caching — 标记可被 provider 缓存的消息
 *
 * 原理：在 system 消息（前 2 条）和最新消息（末 2 条）上添加 cacheControl 标记，
 * 这样 provider 会将这些消息缓存，减少重复 token 计费。
 *
 * 不同 provider 的缓存标记格式不同：
 *  - anthropic:  cacheControl: { type: "ephemeral" }
 *  - bedrock:    cachePoint: { type: "default" }
 *  - openrouter: cacheControl: { type: "ephemeral" }
 *  - copilot:    copilot_cache_control: { type: "ephemeral" }
 *
 * Anthropic/Bedrock 使用消息级 providerOptions，其他 provider 使用内容级
 */
function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2) // system 消息前 2 条
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2) // 非 system 消息末 2 条

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    // Anthropic/Bedrock 使用消息级 providerOptions
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    // 其他 provider 使用内容级 providerOptions（标记最后一个 content 部分）
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

/**
 * 不支持的模态过滤 — 将模型不支持的多模态输入转为错误文本
 *
 * 检查 user 消息中的 image/file 部分：
 *  1. 空的 base64 图片数据 → 替换为错误文本
 *  2. 模型不支持的模态（如模型不支持 image，但用户发了图片）→ 替换为提示文本
 */
function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // 检查空的 base64 图片数据
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      // 获取 MIME 类型并判断模型是否支持该模态
      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part // 无法识别的 MIME 类型，保留原样
      if (model.capabilities.input[modality]) return part // 模型支持该模态，保留

      // 模型不支持该模态，替换为错误文本
      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

/**
 * 消息转换入口 — 编排消息标准化、缓存标记、providerOptions 重映射
 *
 * 执行顺序：
 *  1. unsupportedParts：过滤不支持的模态
 *  2. normalizeMessages：provider 特定的消息格式修正
 *  3. applyCaching：为 Anthropic/Claude/Alibaba 模型标记缓存断点
 *  4. providerOptions key 重映射：将存储时的 providerID 映射为 SDK 期望的 key
 *
 * 调用方：llm.ts 中 wrapLanguageModel middleware 的 transformParams
 */
export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  // Step 1: 过滤不支持的模态输入
  msgs = unsupportedParts(msgs, model)
  // Step 2: provider 特定的消息格式标准化
  msgs = normalizeMessages(msgs, model, options)
  // Step 3: 为 Anthropic/Claude/Alibaba 模型应用 prompt caching
  if (
    (model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/alibaba") &&
    model.api.npm !== "@ai-sdk/gateway"
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Step 4: 将 providerOptions 的 key 从存储时的 providerID 重映射为 SDK 期望的 key
  // 例如：存储时用 "github-copilot"，SDK 期望 "copilot"
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
            return { ...part }
          }
          return { ...part, providerOptions: remap(part.providerOptions) }
        }),
      } as typeof msg
    })
  }

  return msgs
}

/**
 * 推荐采样温度 — 按模型特性返回最佳温度值
 * 不同模型在不同温度下表现差异较大，这里按经验设定推荐值
 */
export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined // Claude 使用 provider 默认值
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

/**
 * 推荐 topP — 按模型特性返回最佳 topP 值
 */
export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  return undefined
}

/**
 * 推荐 topK — 按模型特性返回最佳 topK 值
 */
export function topK(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

// ── 推理努力级别常量 ──
const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

/**
 * Anthropic 自适应推理努力级别
 * 不同版本的 Claude/Opus 支持不同的 effort 级别
 */
function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (["opus-4-7", "opus-4.7"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

/**
 * 生成推理变体 — 为支持推理的模型生成不同 effort 级别的 providerOptions
 *
 * 返回值是一个 Record<effortLevel, providerOptions>，
 * 用户可在配置中选择不同 effort 级别，影响模型的推理深度。
 *
 * 不同 provider 的推理参数格式不同：
 *  - OpenAI:     { reasoningEffort: "low"|"medium"|"high" }
 *  - Anthropic:  { thinking: { type: "enabled", budgetTokens: N } }
 *  - Google:     { thinkingConfig: { includeThoughts: true, thinkingBudget: N } }
 *  - Bedrock:    { reasoningConfig: { type: "enabled", maxReasoningEffort: ... } }
 *  - OpenRouter: { reasoning: { effort: "low"|"high" } }
 */
export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  // 不支持推理的模型返回空
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
  // 这些模型不支持推理变体配置
  if (
    id.includes("deepseek") ||
    id.includes("minimax") ||
    id.includes("glm") ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  )
    return {}

  // ── Grok-3-mini：支持 low/high ──
  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") && id.includes("grok-3-mini")) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        low: { reasoning: { effort: "low" } },
        high: { reasoning: { effort: "high" } },
      }
    }
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }
  // 其他 Grok 版本不支持推理变体
  if (id.includes("grok")) return {}

  // ── 按 provider SDK 分发 ──
  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("claude")) return {}
      return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))

    case "@ai-sdk/gateway":
      // Gateway provider 通过 thinking.type = "adaptive" 实现自适应推理
      if (model.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        // 非自适应版本使用固定 budgetTokens
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      // Google 模型通过 thinkingConfig 配置
      if (model.id.includes("google")) {
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      // 其他模型走 OpenAI 风格 reasoningEffort
      return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      // GPT-5 系列：根据版本号决定支持的 effort 级别
      const copilotEfforts = iife(() => {
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )

    // ── OpenAI 兼容 provider：统一使用 reasoningEffort ──
    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible":
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      const azureEfforts = ["low", "medium", "high"]
      if (id.includes("gpt-5-") || id === "gpt-5") {
        azureEfforts.unshift("minimal")
      }
      return Object.fromEntries(
        azureEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )
    case "@ai-sdk/openai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      if (id === "gpt-5-pro") return {}
      // GPT-5 / Codex 系列：根据版本和发布日期决定支持的 effort 级别
      const openaiEfforts = iife(() => {
        if (id.includes("codex")) {
          if (id.includes("5.2") || id.includes("5.3")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
          return WIDELY_SUPPORTED_EFFORTS
        }
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          arr.unshift("minimal")
        }
        if (model.release_date >= "2025-11-13") {
          arr.unshift("none")
        }
        if (model.release_date >= "2025-12-04") {
          arr.push("xhigh")
        }
        return arr
      })
      return Object.fromEntries(
        openaiEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider

      // GitHub Copilot 上的 Claude 有特殊限制
      if (model.providerID === "github-copilot") {
        if (model.api.id.includes("opus-4.7")) {
          return Object.fromEntries(["medium"].map((effort) => [effort, { reasoningEffort: effort }]))
        }
      }

      // 支持自适应推理的版本
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(model.api.id.includes("opus-4-7") || model.api.id.includes("opus-4.7")
                  ? { display: "summarized" }
                  : {}),
              },
              effort,
            },
          ]),
        )
      }

      // 非自适应版本使用固定 budgetTokens
      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      // 支持自适应推理的版本
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(model.api.id.includes("opus-4-7") || model.api.id.includes("opus-4.7")
                  ? { display: "summarized" }
                  : {}),
              },
            },
          ]),
        )
      }
      // Anthropic 模型使用 reasoningConfig + budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // Amazon Nova 模型使用 reasoningConfig + maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      // Gemini 2.5 使用 thinkingBudget
      if (id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      // Gemini 3.x 使用 thinkingLevel
      let levels = ["low", "high"]
      if (id.includes("3.1")) {
        levels = ["low", "medium", "high"]
      }

      return Object.fromEntries(
        levels.map((effort) => [
          effort,
          {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      // https://docs.mistral.ai/capabilities/reasoning/adjustable
      if (!model.capabilities.reasoning) return {}
      // Only Mistral Small 4 supports reasoning (mistral-small-2603, mistral-small-latest)
      const mistralId = model.api.id.toLowerCase()
      if (!mistralId.includes("mistral-small-2603") && !mistralId.includes("mistral-small-latest")) return {}
      return {
        high: { reasoningEffort: "high" },
      }

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2":
      // SAP AI 上的 Anthropic 模型
      if (model.api.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      // SAP AI 上的 Gemini 2.5 模型
      if (model.api.id.includes("gemini") && id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      // SAP AI 上的 GPT/o 系列模型
      if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id)) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return {}
  }
  return {}
}

/**
 * 生成默认 providerOptions — 按 provider 设置默认行为
 *
 * 包括：
 *  - OpenAI/Copilot：store=false（不存储请求）
 *  - Azure：store=true + promptCacheKey
 *  - OpenRouter/LLMGateway：include usage + Gemini-3 reasoning
 *  - Baseten/自托管：enable_thinking
 *  - ZAI/Zhipu：开启 thinking
 *  - Google：includeThoughts
 *  - Kimi (via Anthropic SDK)：thinking budgetTokens
 *  - Alibaba DashScope：enable_thinking
 *  - GPT-5：reasoningEffort=medium + reasoningSummary + textVerbosity
 *  - Venice：promptCacheKey
 *  - OpenRouter：prompt_cache_key
 *  - Gateway：caching=auto
 */
export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  // openai and providers using openai package should set store to false by default.
  if (
    input.model.providerID === "openai" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/github-copilot"
  ) {
    result["store"] = false
  }

  if (input.model.api.npm === "@ai-sdk/azure") {
    result["store"] = true
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = {
      include: true,
    }
    if (input.model.api.id.includes("gemini-3")) {
      result["reasoning"] = { effort: "high" }
    }
  }

  // Baseten 和自托管的 kimi-k2-thinking / glm-4.6 需要 chat_template_args 开启思考
  if (
    input.model.providerID === "baseten" ||
    (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
  ) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  // Zai / Zhipu 使用 OpenAI 兼容 API，需要手动开启 thinking
  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
    result["promptCacheKey"] = input.sessionID
  }

  // Google 模型默认开启 thinking
  if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
    if (input.model.capabilities.reasoning) {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }
  }

  // Enable thinking by default for kimi models using anthropic SDK
  const modelId = input.model.api.id.toLowerCase()
  if (
    (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
    (modelId.includes("k2p") || modelId.includes("kimi-k2.") || modelId.includes("kimi-k2p"))
  ) {
    result["thinking"] = {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
    }
  }

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  // GPT-5 系列默认推理设置
  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      // Only inject reasoningSummary for providers that support it natively.
      // @ai-sdk/openai-compatible proxies (e.g. LiteLLM) do not understand this
      // parameter and return "Unknown parameter: 'reasoningSummary'".
      if (
        input.model.api.npm === "@ai-sdk/openai" ||
        input.model.api.npm === "@ai-sdk/azure" ||
        input.model.api.npm === "@ai-sdk/github-copilot"
      ) {
        result["reasoningSummary"] = "auto"
      }
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat") &&
      input.model.providerID !== "azure"
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("opencode")) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = ["reasoning.encrypted_content"]
      result["reasoningSummary"] = "auto"
    }
  }

  if (input.model.providerID === "venice") {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.providerID === "openrouter") {
    result["prompt_cache_key"] = input.sessionID
  }
  if (input.model.api.npm === "@ai-sdk/gateway") {
    result["gateway"] = {
      caching: "auto",
    }
  }

  return result
}

/**
 * 小模型/辅助模型选项 — 用于上下文压缩等次要推理任务
 * 相比主模型，降低推理努力以节省成本和延迟
 */
export function smallOptions(model: Provider.Model) {
  if (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/github-copilot"
  ) {
    if (model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.") || model.api.id.includes("5-mini")) {
        return { store: false, reasoningEffort: "low" }
      }
      return { store: false, reasoningEffort: "minimal" }
    }
    return { store: false }
  }
  if (model.providerID === "google") {
    // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
    if (model.api.id.includes("gemini-3")) {
      return { thinkingConfig: { thinkingLevel: "minimal" } }
    }
    return { thinkingConfig: { thinkingBudget: 0 } }
  }
  if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
    if (model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
    return { reasoningEffort: "minimal" }
  }

  if (model.providerID === "venice") {
    return { veniceParameters: { disableThinking: true } }
  }

  return {}
}

// Maps model ID prefix to provider slug used in providerOptions.
// Example: "amazon/nova-2-lite" → "bedrock"
const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

/**
 * providerOptions 命名空间映射 — 将选项路由到 SDK 期望的 provider key
 *
 * AI SDK 的 providerOptions 是按 provider 命名空间组织的，
 * 例如 { openai: { ... } } / { anthropic: { ... } }。
 * 此函数将用户提供的选项包装到正确的命名空间下。
 *
 * 特殊处理：
 *  - Gateway：拆分为 gateway 命名空间 + 上游 provider 命名空间
 *  - Azure：同时写入 openai 和 azure 命名空间（因 Azure SDK 内部委托给 OpenAI 实现）
 */
export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  if (model.api.npm === "@ai-sdk/gateway") {
    // Gateway providerOptions are split across two namespaces:
    // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
    // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
    // We keep `gateway` as-is and route every other top-level option under the
    // model-derived upstream slug.
    const i = model.api.id.indexOf("/")
    const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
    const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
    const gateway = options.gateway
    const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
    const has = Object.keys(rest).length > 0

    const result: Record<string, any> = {}
    if (gateway !== undefined) result.gateway = gateway

    if (has) {
      if (slug) {
        // Route model-specific options under the provider slug
        result[slug] = rest
      } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
        result.gateway = { ...gateway, ...rest }
      } else {
        result.gateway = rest
      }
    }

    return result
  }

  const key = sdkKey(model.api.npm) ?? model.providerID
  // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
  // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
  // "azure" first. Pass both so model options work on either code path.
  if (model.api.npm === "@ai-sdk/azure") {
    return { openai: options, azure: options }
  }
  return { [key]: options }
}

/**
 * 最大输出 token 数 — 取模型限制与全局上限的较小值
 */
export function maxOutputTokens(model: Provider.Model): number {
  return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

/**
 * Schema 转换 — 将 JSON Schema 转为 provider 兼容格式
 *
 * 主要针对 Google/Gemini 模型的特殊要求：
 *  - enum 值必须为字符串（整数类型 + enum → 转为 string 类型）
 *  - 非对象类型不能有 properties/required 字段
 *  - array 类型必须有 items 且 items 必须有 type
 *  - required 数组只能包含 properties 中存在的字段
 */
export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  // ── Gemini Schema 清洗 ──
  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    /**
     * Gemini Schema 递归清洗器
     * - enum 值转为字符串
     * - integer/number + enum → type 改为 string
     * - array 必须有 items，items 必须有 type
     * - 非对象类型删除 properties/required
     * - required 只保留 properties 中存在的字段
     */
    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema as JSONSchema7
}
