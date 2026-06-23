import { log } from '../logger/Logger'
import type { Message } from './context'

export interface IntegrityIssue {
  type: 'ORPHANED_TOOL_CALL' | 'MISSING_TOOL_RESPONSE' | 'EMPTY_TOOL_CALL_ID' | 'INTERLEAVED_USER_MESSAGE'
  index: number
  description: string
}

/**
 * 校验消息链中 tool_call 结构的完整性。
 * 在发往 LLM API 前调用，阻止已知会触发 400 的脏状态。
 *
 * 检查项：
 * 1. 每个 assistant(tool_calls) 后必须至少有一条 tool 消息响应
 * 2. 每个 tool_call 必须有非空 id
 * 3. user 消息不得插入在 assistant(tool_calls) 和其 tool 响应之间
 */
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
          type: interleavedUser ? 'INTERLEAVED_USER_MESSAGE' : 'ORPHANED_TOOL_CALL',
          index: i,
          description: interleavedUser
            ? `user message interleaved between assistant(tool_calls) and tool response at message[${i}]`
            : `orphaned tool_call block at message[${i}] (no tool response follows)`,
        })
      }
    }

    // 检查孤立的 tool 消息（前面没有对应的 assistant(tool_calls)）
    if (m.role === 'tool') {
      let foundAssistant = false
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant' && messages[j].tool_calls?.length) {
          foundAssistant = true
          break
        }
        if (messages[j].role === 'user' || messages[j].role === 'assistant') break
      }
      if (!foundAssistant) {
        issues.push({
          type: 'MISSING_TOOL_RESPONSE',
          index: i,
          description: `orphaned tool message at message[${i}] (no preceding assistant(tool_calls))`,
        })
      }
    }
  }

  return { valid: issues.length === 0, issues }
}

/**
 * 从检查点数据重建消息上下文，回滚到最近的健康状态。
 * 检查点不保存完整 messages[]，因此通过 shortTermMemory 重构：
 * 1. 保留 system prompt
 * 2. 注入 shortTermMemory 中的 user/assistant 对
 * 3. 重新添加当前 user 消息
 */
export function rollbackToLastKnownGood(
  messages: Message[],
  shortTermMemory: Array<{ user: string; assistant: string }>,
  lastUserMessage?: string,
): void {
  const systemPrompt = messages.length > 0 && messages[0]?.role === 'system' ? messages[0].content : null

  messages.length = 0

  if (systemPrompt !== null && systemPrompt !== undefined) {
    messages.push({ role: 'system', content: systemPrompt as string })
  } else {
    messages.push({ role: 'system', content: '' })
  }

  for (const pair of shortTermMemory) {
    if (pair.user) messages.push({ role: 'user', content: pair.user })
    if (pair.assistant) messages.push({ role: 'assistant', content: pair.assistant })
  }

  if (lastUserMessage) {
    messages.push({ role: 'user', content: lastUserMessage })
  }

  log('INFO', 'context_rolled_back', {
    stmPairs: shortTermMemory.length,
    hasUserMessage: !!lastUserMessage,
  })
}
