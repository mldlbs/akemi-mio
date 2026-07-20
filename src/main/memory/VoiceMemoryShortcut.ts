/**
 * VoiceMemoryShortcut — 语音触发的记忆快照与检索快捷通道
 *
 * 在 ASR 转录后、Agent 处理前运行，为简单的记忆操作提供零 LLM 延迟的快捷路径。
 *
 * 工作流程：
 * 1. 接收 ASR 转录文本
 * 2. 使用 VoiceMemoryClassifier 检测写/读意图
 * 3. 写意图：直接存入 MemoryService（addFact）
 * 4. 读意图：从 VectorMemory 模糊搜索后通过 TTS 播报
 * 5. 不阻阻断复杂请求（非记忆文本零开销返回）
 *
 * ⚠️ 与现有 Agent 的关系：
 * - Shortcut 处理完成后，转录文本仍会正常发送给 Agent
 * - Agent 可能对同一文本做出额外响应
 * - TTS 反馈由 Shortcut 直接触发，Agent 的 TTS 会叠加（前者更早、后者更完整）
 */

import type { MemoryService } from './MemoryService'
import type { TtsService } from '../tts/TtsService'
import { classifyVoiceMemoryIntent, formatMemoryFeedback } from './VoiceMemoryClassifier'
import { log } from '../logger/Logger'

export interface VoiceMemoryShortcutResult {
  /** 是否由 shortcut 处理了记忆操作 */
  handled: boolean
  /** 处理的意图类型 */
  type: 'write' | 'read' | 'none'
  /** 写入/查询的具体内容 */
  payload?: string
}

/**
 * 执行语音触发的记忆快捷操作。
 *
 * 该函数是 fire-and-forget 设计的：
 * - 非记忆文本：零额外延迟，立即返回
 * - 记忆文本：异步执行存储/检索 + TTS 播报，不阻塞调用者
 *
 * @param text ASR 转录文本
 * @param memoryService 记忆服务实例
 * @param ttsService TTS 服务实例（用于播报反馈）
 * @returns 处理结果摘要
 */
export async function runVoiceMemoryShortcut(
  text: string,
  memoryService: MemoryService | null,
  ttsService: TtsService | null,
): Promise<VoiceMemoryShortcutResult> {
  if (!text || !memoryService) {
    return { handled: false, type: 'none' }
  }

  // 1. 分类
  const intent = classifyVoiceMemoryIntent(text)

  if (intent.type === 'none') {
    return { handled: false, type: 'none' }
  }

  log('INFO', 'voice_memory_shortcut_triggered', {
    type: intent.type,
    text: text.slice(0, 80),
    payload: intent.type === 'write' ? intent.entity.slice(0, 60) : intent.query.slice(0, 60),
  })

  try {
    // 2. 执行
    switch (intent.type) {
      case 'write': {
        // 写入记忆（user_fact 类型，半永久层，较高置信度）
        memoryService.addFact(intent.entity, 0.75, { tier: 'semi' })
        const feedback = formatMemoryFeedback(intent)
        if (feedback && ttsService) {
          // 异步播报，不等待完成
          ttsService.speak(feedback).catch(() => {})
        }
        return { handled: true, type: 'write', payload: intent.entity }
      }

      case 'read': {
        // 从 VectorMemory 模糊搜索
        const results = memoryService.vector.querySync(intent.query, 3)
        const feedback = formatMemoryFeedback(intent, results)
        if (feedback && ttsService) {
          // 异步播报，不等待完成
          ttsService.speak(feedback).catch(() => {})
        }
        return { handled: true, type: 'read', payload: results[0] || intent.query }
      }
    }
  } catch (err) {
    log('WARN', 'voice_memory_shortcut_execution_failed', {
      type: intent.type,
      error: String(err),
    })
  }

  return { handled: false, type: 'none' }
}
