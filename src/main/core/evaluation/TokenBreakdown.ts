/**
 * TokenBreakdown — 输入 Token 来源分类
 *
 * 在 LlmService.chatWithTools() 入口处，对已拼装完成的 messages 数组
 * 按来源分类统计各部分的 Token 估算值。
 *
 * 分类依据是 Message.role + 内容特征（模式匹配，非语义分析），
 * 不读取/存储消息的具体内容。
 *
 * ── 分类规则 ──
 * system  → 角色：system（身份 + 基座 Prompt）
 * memory  → 角色：system 中的【长期记忆】段落
 * retrieval → 角色：system 中的扩展模块（Skill / Persona / Drift）
 * runtime → 角色：user，内容以 [system_hint] / [error_hint] / [observe] / [think] / [reflect] 开头
 * user    → 角色：user，非 scratchpad 消息
 * history → 角色：assistant，仅含文本回复
 * tools   → 角色：tool + assistant 中带 tool_calls 的消息
 *
 * ── 使用方式 ──
 * const breakdown = classifyMessageBreakdown(messages)
 * // { system: 1234, memory: 567, retrieval: 89, runtime: 1011, user: 1213, history: 1415, tools: 1617 }
 */

import type { Message } from '../../agent/context'
import { estimateMessageTokens } from '../../agent/context'

export interface TokenBreakdown {
  system: number // 身份 + 基座 Prompt
  memory: number // 长期记忆
  retrieval: number // Skill 模块 / Persona / Drift 修正
  runtime: number // 反射上下文 + Scratchpad（system_hint / error_hint / observe / think / reflect）
  user: number // 用户输入（当前轮次 + 历史 user 消息）
  history: number // 助手文本回复（历史 assistant 无 tool_calls）
  tools: number // 工具调用声明 + 工具返回结果
}

/** 已知的 Scratchpad 条目前缀 */
const SCRATCHPAD_PREFIXES = ['[system_hint]', '[error_hint]', '[observe]', '[think]', '[reflect]']

function isScratchpad(content: string | null): boolean {
  if (!content) return false
  const trimmed = content.trimStart()
  return SCRATCHPAD_PREFIXES.some((p) => trimmed.startsWith(p))
}

/** 从 system prompt 中提取【长期记忆】段落的起始索引 */
function findMemorySection(content: string): number {
  const markers = ['\n\n【长期记忆】\n', '\n\n【反省摘要】\n', '\n\n【外部知识】\n']
  for (const m of markers) {
    const idx = content.indexOf(m)
    if (idx !== -1) return idx
  }
  return -1
}

/**
 * 对已拼装的 messages 数组进行 Token 来源分类。
 *
 * 不解析语义，仅通过 role + 内容前缀进行模式匹配。
 * 对 system prompt 内的子段落通过已知分隔符拆分。
 *
 * @param messages — 传入 chatWithTools 的消息数组
 * @param estimateFn — Token 估算函数，默认使用 estimateMessageTokens
 */
export function classifyMessageBreakdown(
  messages: Message[],
  estimateFn: (msg: Message) => number = estimateMessageTokens,
): TokenBreakdown {
  const breakdown: TokenBreakdown = {
    system: 0,
    memory: 0,
    retrieval: 0,
    runtime: 0,
    user: 0,
    history: 0,
    tools: 0,
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const tokens = estimateFn(msg)

    if (msg.role === 'system') {
      // ── system prompt：尝试拆分子段落 ──
      const content = msg.content || ''
      const memIdx = findMemorySection(content)

      if (memIdx === -1) {
        // 无【长期记忆】标记 → 全部分配到 system
        breakdown.system += tokens
      } else {
        // 拆分：标记前的部分 → system，标记后 → memory + retrieval
        const beforeMem = content.slice(0, memIdx)
        const afterMem = content.slice(memIdx)

        // beforeMem 分段估算（字面长度比例）
        const totalLen = content.length
        const beforeRatio = totalLen > 0 ? beforeMem.length / totalLen : 0
        const afterRatio = totalLen > 0 ? afterMem.length / totalLen : 0

        const beforeTokens = Math.round(tokens * beforeRatio)
        const afterTokens = tokens - beforeTokens

        breakdown.system += beforeTokens

        // afterMem 中的第一个段落是 memory，后续是 retrieval
        const memEndIdx = afterMem.indexOf('\n\n', afterMem.indexOf('】') + 1)
        if (memEndIdx === -1) {
          breakdown.memory += afterTokens
        } else {
          const memSectionLen = memEndIdx
          const memRatio = afterMem.length > 0 ? memSectionLen / afterMem.length : 0
          breakdown.memory += Math.round(afterTokens * memRatio)
          breakdown.retrieval += afterTokens - Math.round(afterTokens * memRatio)
        }
      }
    } else if (msg.role === 'user') {
      // ── user 消息：scratchpad vs 用户输入 ──
      if (isScratchpad(msg.content)) {
        breakdown.runtime += tokens
      } else {
        breakdown.user += tokens
      }
    } else if (msg.role === 'assistant') {
      // ── assistant 消息：工具调用声明 vs 文本回复 ──
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        breakdown.tools += tokens
      } else {
        breakdown.history += tokens
      }
    } else if (msg.role === 'tool') {
      // ── tool 结果 ──
      breakdown.tools += tokens
    }
  }

  return breakdown
}
