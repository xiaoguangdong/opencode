// 引入配置类型
import type { Config } from "@/config"
// 引入 Provider 类型与转换工具
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
// 引入消息类型
import type { MessageV2 } from "./message-v2"

// 压缩时预留的缓冲区 token 数
const COMPACTION_BUFFER = 20_000

/**
 * 计算模型可用的输入 token 数:
 *  - context 为 0(未知)时直接返回 0
 *  - reserved 为压缩预留量:优先使用配置中的 compaction.reserved,
 *    否则取 COMPACTION_BUFFER 与模型最大输出 token 的较小值
 *  - 若模型显式声明了 limit.input,则用它减去 reserved
 *  - 否则用 context 减去模型最大输出 token
 *  - 最终结果不小于 0
 */
export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))
}

/**
 * 判断当前 token 用量是否溢出可用上下文:
 *  - 显式关闭了自动压缩时直接返回 false
 *  - 模型上下文未知(context = 0)时直接返回 false
 *  - 统计实际 token 用量(tokens.total,或 input + output + cache.read + cache.write 之和)
 *  - 用量超过 usable() 计算出的可用量时视为溢出
 */
export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
