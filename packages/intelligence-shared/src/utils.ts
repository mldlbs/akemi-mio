/**
 * shared/utils.ts — 跨 agent/memory/llm 的共享工具函数
 *
 * 这些函数被多个模块使用，提取到这里消除循环依赖。
 */

import type { Message } from './types'

// ── From memory/embedding.ts ──

export const EMBED_DIM = 384

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/**
 * 基于字符 n-gram 哈希的 fallback 嵌入。
 * 不需要网络或预训练模型，确定性、跨会话一致。
 */
export function fallbackEmbed(text: string): number[] {
  const vec = new Float64Array(EMBED_DIM)
  const chars = text.toLowerCase().replace(/\s+/g, ' ')

  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i <= chars.length - n; i++) {
      const gram = chars.slice(i, i + n)
      let hash = 5381
      for (let j = 0; j < gram.length; j++) {
        hash = (hash << 5) + hash + gram.charCodeAt(j)
      }
      const idx = Math.abs(hash) % EMBED_DIM
      vec[idx] += 1.0 / n
    }
  }

  let norm = 0
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm

  return Array.from(vec)
}

// ── From agent/context.ts ──

export function getBasePromptTokens(): number {
  // BASE_PROMPT is defined in agent/context.ts, we use a placeholder here
  // The actual value will be computed from the original location
  return 0
}

export function estimateTokens(text: string | null | undefined): number {
  const bytes = Buffer.byteLength(text || '', 'utf-8')
  const t = text || ''
  let cjkCount = 0
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x2e80 && code <= 0x2fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount++
    }
  }
  const cjkRatio = t.length > 0 ? cjkCount / t.length : 0
  if (cjkRatio > 0.3) {
    return Math.ceil(bytes / 2)
  }
  return Math.ceil(bytes / 4)
}

/** 完整估算一条消息的 token 数（含 content + tool_calls + tool_call_id） */
export function estimateMessageTokens(msg: Message): number {
  let total = estimateTokens(msg.content)
  total += estimateTokens(msg.reasoning_content)
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.id)
      total += estimateTokens(tc.function?.name)
      total += estimateTokens(tc.function?.arguments)
    }
  }
  if (msg.tool_call_id) {
    total += estimateTokens(msg.tool_call_id)
  }
  return total
}

// ── From agent/ContextIntegrityChecker.ts ──

import type { IntegrityIssue } from './types'

export function validateToolCallChain(messages: Message[]): { valid: boolean; issues: IntegrityIssue[] } {
  const issues: IntegrityIssue[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // 检查是否有空 id 的 tool_call
      for (const tc of m.tool_calls) {
        if (!tc.id || !tc.id.trim()) {
          issues.push({
            type: 'EMPTY_TOOL_CALL_ID',
            index: i,
            description: `tool_call id is empty at message[${i}]`,
          })
        }
      }

      // 向后扫描：必须在遇到下一条 assistant 或末尾之前找到 tool 响应
      let hasToolResponse = false
      let interleavedUser = false
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]
        if (next.role === 'tool') {
          hasToolResponse = true
          break
        }
        if (next.role === 'user') {
          interleavedUser = true
          break
        }
        if (next.role === 'assistant') {
          break
        }
      }

      if (!hasToolResponse) {
        issues.push({
          type: 'MISSING_TOOL_RESPONSE',
          index: i,
          description: `assistant message[${i}] has tool_calls but no tool response follows`,
        })
      }

      if (interleavedUser) {
        issues.push({
          type: 'INTERLEAVED_USER_MESSAGE',
          index: i,
          description: `user message interleaved between assistant tool_calls and tool response at message[${i}]`,
        })
      }
    }
  }

  return { valid: issues.length === 0, issues }
}

// ── From agent/context.ts ──

export function trimOrphanedToolCallsFrom(messages: Message[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Check if there's a tool response after this message
      let hasResponse = false
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === 'tool') {
          hasResponse = true
          break
        }
        if (messages[j].role === 'assistant') {
          break
        }
      }
      if (!hasResponse) {
        // Remove tool_calls from this message
        delete m.tool_calls
      }
    }
  }
}