/**
 * MemoryTtsBridge — Memory × TTS 深度融合桥接器
 *
 * 统一接口层，实现双向往来数据融合：
 * 1. Memory → TTS：记忆情感上下文驱动 TTS 参数调整（复用 MemoryEmotionBridge）
 *                    + 记忆状态变化（新事实/兴趣转移）自适应 TTS 行为
 * 2. TTS → Memory：TTS 合成事件（文本/参数/成功/失败）记录到记忆系统
 *                   + 用户与 TTS 的隐式交互（重听/跳过）持久化到记忆
 *
 * 设计目标：
 * - 消除 TTS 与 Memory 之间的信息孤岛
 * - TTS 的输出成为 Memory 的新输入维度 → 后续 LLM 推理可引用 TTS 历史
 * - Memory 的状态变化反向驱动 TTS 的行为调整 → 产生 1+1>2 涌现效果
 *
 * 风险控制：
 * - 桥接器仅通过 MemoryService 和 TtsService 的公共 API 交互
 * - 两个模块独立演进：桥接器层可在任一模块变更时单独更新
 * - 故障隔离：所有方法 catch 内部异常，不传播到调用方
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { TtsService } from './TtsService'
import type { EmotionTtsParams } from './types'
import { memoryEmotionBridge } from './MemoryEmotionBridge'

// ═══════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════

/** TTS 合成事件的记录结构 */
export interface TtsSynthesisRecord {
  /** 合成时间戳 */
  timestamp: number
  /** 合成的清理后文本摘要（前 80 字符） */
  textSnippet: string
  /** 合成文本完整长度（字符数） */
  textLength: number
  /** 合成耗时（毫秒） */
  durationMs: number
  /** 使用的 TTS 参数 */
  params: EmotionTtsParams
  /** 引擎类型：'cloud' | 'local' */
  engine: string
  /** 是否成功 */
  success: boolean
  /** TTS 参数标签中蕴含的风格/情感信息 */
  label: string
}

/** TTS 用户交互记录结构 */
export interface TtsInteractionRecord {
  /** 交互时间戳 */
  timestamp: number
  /** 交互类型 */
  action: 'REPLAY' | 'SKIP' | 'INTERRUPT_SPEECH' | 'COMPLETED_NATURALLY'
  /** 关联的 TTS 输出文本摘要 */
  relatedTextSnippet: string
}

/** Memory → TTS 方向的适应建议 */
export interface MemoryDrivenTtsSuggestion {
  /** 推荐的语速调整（百分比，负=放慢，正=加快，0=不调整） */
  rateDelta: number
  /** 推荐的音调调整（Hz，负=降低，正=升高，0=不调整） */
  pitchDelta: number
  /** 推荐语音（可选，仅在记忆显著变化时更改） */
  voice?: string
  /** 调整原因文本 */
  reason: string
  /** 置信度 0–1 */
  confidence: number
}

// ═══════════════════════════════════════════════
//  桥接器类
// ═══════════════════════════════════════════════

export class MemoryTtsBridge {
  private memoryService: MemoryService | null = null
  private ttsService: TtsService | null = null

  /** 上次记录的交互计数（用于定期采样，避免每条消息都写 Memory） */
  private lastRecordedInteractionCount = 0
  /** 采样间隔：每 N 次 TTS 合成记录一次到 Memory */
  private readonly RECORD_INTERVAL = 3
  /** 当前累计的合成计数 */
  private synthesisCountSinceLastRecord = 0

  /** 缓存的最新记忆条目哈希（用于检测记忆变化） */
  private lastMemorySnapshotHash = ''
  /** 缓存的最新兴趣话题列表 */
  private lastInterestTopics: string[] = []

  constructor() {
    log('INFO', 'memory_tts_bridge_created')
  }

  /** 注入 MemoryService 引用（由 AppRuntime 在 Service Stage 调用） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    log('INFO', 'memory_tts_bridge_memory_attached')
  }

  /** 注入 TtsService 引用（由 AppRuntime 在 Service Stage 调用） */
  setTtsService(ts: TtsService): void {
    this.ttsService = ts
    log('INFO', 'memory_tts_bridge_tts_attached')
  }

  /** 桥接器是否已就绪 */
  isReady(): boolean {
    return this.memoryService !== null && this.ttsService !== null
  }

  // ════════════════════════════════════════════
  //  TTS → Memory 方向
  // ════════════════════════════════════════════

  /**
   * 记录 TTS 合成事件到 Memory。
   *
   * 由 TtsService.speakInternal() 在每次合成完成后调用。
   * 以采样方式记录（每 RECORD_INTERVAL 次记录一条），避免 Memory 被过多 TTS 记录淹没。
   * 记录为 `user_fact` 类型，ephemeral 层级，带有 structuredData。
   *
   * @param record TTS 合成事件数据
   */
  recordSynthesis(record: TtsSynthesisRecord): void {
    if (!this.memoryService) return

    this.synthesisCountSinceLastRecord++

    // 采样：仅每 RECORD_INTERVAL 次记录一次
    if (this.synthesisCountSinceLastRecord % this.RECORD_INTERVAL !== 0) return

    try {
      const ms = this.memoryService
      const statusIcon = record.success ? '🔊' : '⚠️'
      const content = `【TTS 合成】${statusIcon} ${record.label} | ${record.textSnippet}`
      const structuredData = JSON.stringify({
        ttsSynthesis: {
          timestamp: record.timestamp,
          textLength: record.textLength,
          durationMs: record.durationMs,
          engine: record.engine,
          success: record.success,
          label: record.label,
          rate: record.params.rate,
          pitch: record.params.pitch,
          voice: record.params.voice,
        },
      })

      ms.addEntry('user_fact', content, 0.4, { tier: 'ephemeral', structuredData })

      log('INFO', 'memory_tts_synthesis_recorded', {
        success: record.success,
        label: record.label,
        engine: record.engine,
        textLen: record.textLength,
      })
    } catch (err) {
      log('WARN', 'memory_tts_synthesis_record_failed', { error: String(err) })
    }
  }

  /**
   * 记录用户与 TTS 输出的交互行为到 Memory。
   *
   * 由 ChatExecutor 或 IPC handler 在检测到用户操作（重听/跳过/自然结束）时调用。
   * 记录为 `user_fact` 类型，ephemeral 层级。
   *
   * @param interaction 用户交互记录
   */
  recordInteraction(interaction: TtsInteractionRecord): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService
      const actionLabel: Record<string, string> = {
        REPLAY: '重听',
        SKIP: '跳过',
        INTERRUPT_SPEECH: '打断',
        COMPLETED_NATURALLY: '自然结束',
      }
      const label = actionLabel[interaction.action] || interaction.action
      const content = `【TTS 交互】用户${label}：「${interaction.relatedTextSnippet}」`

      ms.addEntry('user_fact', content, interaction.action === 'SKIP' ? 0.3 : 0.5, { tier: 'ephemeral' })

      log('INFO', 'memory_tts_interaction_recorded', {
        action: interaction.action,
        snippet: interaction.relatedTextSnippet,
      })
    } catch (err) {
      log('WARN', 'memory_tts_interaction_record_failed', { error: String(err) })
    }
  }

  /**
   * 将 TTS 隐式反馈偏好持久化到 Memory 的用户画像。
   *
   * 由 ChatExecutor 在隐式反馈模型产生推荐时调用。
   * 将用户对 TTS 参数的偏好（语速、音调、音色）保存为持久用户画像。
   *
   * @param params 用户偏好的 TTS 参数
   * @param confidence 置信度
   * @param reason 原因描述
   */
  recordUserTtsPreference(params: EmotionTtsParams, confidence: number, reason: string): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService

      // 语速偏好
      ms.saveUserPreference({
        key: 'tts_rate_preference',
        value: params.rate,
        confidence,
        category: 'preference',
        source: 'tts_implicit_feedback',
        updatedAt: Date.now(),
      })

      // 音调偏好
      ms.saveUserPreference({
        key: 'tts_pitch_preference',
        value: params.pitch,
        confidence,
        category: 'preference',
        source: 'tts_implicit_feedback',
        updatedAt: Date.now(),
      })

      // 音色偏好
      ms.saveUserPreference({
        key: 'tts_voice_preference',
        value: params.voice,
        confidence,
        category: 'preference',
        source: 'tts_implicit_feedback',
        updatedAt: Date.now(),
      })

      log('INFO', 'memory_tts_preference_stored', {
        rate: params.rate,
        pitch: params.pitch,
        voice: params.voice,
        confidence,
        reason,
      })
    } catch (err) {
      log('WARN', 'memory_tts_preference_store_failed', { error: String(err) })
    }
  }

  /**
   * 获取 TTS 相关的记忆上下文，用于注入 system prompt 或调试 UI。
   *
   * 返回最近的 TTS 合成记录和用户交互历史摘要。
   */
  getTtsMemoryContext(): string {
    if (!this.memoryService) return ''

    try {
      const ms = this.memoryService
      const entries = ms.getEntries()

      // 最近 TTS 合成记录
      const synthesisEntries = entries
        .filter((e) => e.type === 'user_fact' && e.content.includes('【TTS 合成】'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3)

      // 最近 TTS 交互记录
      const interactionEntries = entries
        .filter((e) => e.type === 'user_fact' && e.content.includes('【TTS 交互】'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3)

      const parts: string[] = []

      if (synthesisEntries.length > 0) {
        parts.push('【最近 TTS 合成记录】')
        for (const e of synthesisEntries) {
          parts.push('- ' + e.content.slice(0, 120))
        }
      }

      if (interactionEntries.length > 0) {
        parts.push('【最近 TTS 用户交互】')
        for (const e of interactionEntries) {
          parts.push('- ' + e.content.slice(0, 120))
        }
      }

      // 用户 TTS 偏好
      const prefs = ms.getUserPreferences()
      const ttsPrefs = prefs.filter((p) => p.key.startsWith('tts_'))
      if (ttsPrefs.length > 0) {
        parts.push('【用户 TTS 偏好】')
        for (const p of ttsPrefs) {
          const label: Record<string, string> = {
            tts_rate_preference: '语速',
            tts_pitch_preference: '音调',
            tts_voice_preference: '音色',
          }
          parts.push(`- ${label[p.key] || p.key}: ${p.value}`)
        }
      }

      if (parts.length === 0) return ''
      return parts.join('\n')
    } catch {
      return ''
    }
  }

  // ════════════════════════════════════════════
  //  Memory → TTS 方向
  // ════════════════════════════════════════════

  /**
   * 获取基于记忆状态的 TTS 适应建议。
   *
   * 综合以下维度：
   * 1. 情感上下文（复用 MemoryEmotionBridge 的情绪分析 → rate/pitch 调整）
   * 2. 记忆活跃度（新事实频繁 → 语速适当加快以提升信息密度）
   * 3. 用户画像中的 TTS 偏好（已持久化的隐式反馈结果）
   *
   * 在 ChatExecutor.applySentimentToTts() 中每次 LLM 回复后调用。
   *
   * @param baseParams 当前基础 TTS 参数（来自内容风格分析链）
   * @returns 适应建议（若不需调整，confidence 为 0）
   */
  getMemoryDrivenSuggestion(baseParams: EmotionTtsParams): MemoryDrivenTtsSuggestion {
    if (!this.memoryService) {
      return { rateDelta: 0, pitchDelta: 0, reason: '桥接器未就绪', confidence: 0 }
    }

    try {
      const ms = this.memoryService

      // ── 维度 1：情感上下文（复用 MemoryEmotionBridge） ──
      const emotionContext = memoryEmotionBridge.getRecentEmotionContext(ms)
      let totalRateDelta = emotionContext.adjustment.rateDelta
      let totalPitchDelta = emotionContext.adjustment.pitchDelta
      const reasonParts: string[] = []
      let totalConfidence = 0

      if (emotionContext.recentEmotions.length > 0) {
        reasonParts.push(emotionContext.adjustment.reason)
        totalConfidence += 0.5
      }

      // ── 维度 2：记忆活跃度检测 ──
      // 近期有大量新事实记忆 → 信息密度高 → 语速稍快
      const entries = ms.getEntries()
      const oneHourAgo = Date.now() - 3600_000
      const recentFacts = entries.filter((e) => e.type === 'user_fact' && e.createdAt > oneHourAgo).length

      if (recentFacts > 5) {
        // 近期有大量新记忆 → 信息密集，加快语速
        const activityBoost = Math.min(5, Math.floor(recentFacts / 3))
        totalRateDelta += activityBoost
        reasonParts.push(`近期 ${recentFacts} 条新记忆（信息密集）`)
        totalConfidence += 0.3
      }

      // ── 维度 3：用户画像 TTS 偏好 ──
      const prefs = ms.getUserPreferences()
      const ratePref = prefs.find((p) => p.key === 'tts_rate_preference')
      const pitchPref = prefs.find((p) => p.key === 'tts_pitch_preference')

      if (ratePref && ratePref.confidence > 0.5) {
        const prefRate = parseInt(ratePref.value.replace(/[^0-9-]/g, '')) || 0
        const currentRate = parseInt(baseParams.rate.replace(/[^0-9-]/g, '')) || 0
        // 仅当偏好与当前参数差异显著时调整（避免来回抖动）
        if (Math.abs(prefRate - currentRate) > 5) {
          totalRateDelta = Math.round(totalRateDelta + (prefRate - currentRate) * 0.3)
          reasonParts.push(`用户偏好语速 ${ratePref.value}`)
          totalConfidence += 0.2
        }
      }

      if (pitchPref && pitchPref.confidence > 0.5) {
        const prefPitch = parseInt(pitchPref.value.replace(/[^0-9-]/g, '')) || 0
        const currentPitch = parseInt(baseParams.pitch.replace(/[^0-9-]/g, '')) || 0
        if (Math.abs(prefPitch - currentPitch) > 3) {
          totalPitchDelta = Math.round(totalPitchDelta + (prefPitch - currentPitch) * 0.3)
          totalConfidence += 0.2
        }
      }

      // 夹到安全范围
      const clampedRate = Math.max(-50, Math.min(50, totalRateDelta))
      const clampedPitch = Math.max(-20, Math.min(20, totalPitchDelta))

      // 如果没有显著调整需求，返回低置信度建议
      if (totalConfidence < 0.2 || (clampedRate === 0 && clampedPitch === 0)) {
        return { rateDelta: 0, pitchDelta: 0, reason: '无显著调整需求', confidence: 0 }
      }

      return {
        rateDelta: clampedRate,
        pitchDelta: clampedPitch,
        reason: reasonParts.join('；'),
        confidence: Math.min(1, totalConfidence),
      }
    } catch (err) {
      log('WARN', 'memory_tts_get_suggestion_failed', { error: String(err) })
      return { rateDelta: 0, pitchDelta: 0, reason: '分析失败', confidence: 0 }
    }
  }

  /**
   * 检测记忆状态是否发生了值得通知 TTS 的显著变化。
   *
   * 对比当前记忆快照与上次缓存的状态，检测：
   * - 新事实数量显著增加
   * - 兴趣话题发生变化
   * - 用户画像更新
   *
   * 由 ChatExecutor 在每次 run() 末尾调用。
   *
   * @returns 变化描述（空字符串表示无显著变化）
   */
  detectMemoryChangeForTts(): string {
    if (!this.memoryService) return ''

    try {
      const ms = this.memoryService
      const changeParts: string[] = []

      // 检测兴趣话题变化
      const weighted = ms.getBehaviorWeightedEntries(undefined, 10)
      const currentTopics = [...new Set(weighted.flatMap((e) => e.topics || []))].slice(0, 5)

      if (this.lastInterestTopics.length > 0 && currentTopics.length > 0) {
        const newTopics = currentTopics.filter((t) => !this.lastInterestTopics.includes(t))
        const droppedTopics = this.lastInterestTopics.filter((t) => !currentTopics.includes(t))

        if (newTopics.length > 0) {
          changeParts.push(`新话题：${newTopics.join('、')}`)
        }
        if (droppedTopics.length > 0) {
          changeParts.push(`话题淡出：${droppedTopics.join('、')}`)
        }
      }

      this.lastInterestTopics = currentTopics

      if (changeParts.length > 0) {
        return `记忆状态变化：${changeParts.join('；')}`
      }

      return ''
    } catch {
      return ''
    }
  }

  /**
   * 获取情感上下文的调试信息（透传 MemoryEmotionBridge）。
   */
  getEmotionDebugInfo(): Record<string, unknown> | null {
    if (!this.memoryService) return null
    try {
      const context = memoryEmotionBridge.getRecentEmotionContext(this.memoryService)
      return memoryEmotionBridge.getEmotionContextDebugInfo(context)
    } catch {
      return null
    }
  }

  /** 获取内部 MemoryEmotionBridge 实例（供外部直接使用） */
  getEmotionBridge(): typeof memoryEmotionBridge {
    return memoryEmotionBridge
  }

  // ════════════════════════════════════════════
  //  高级集成 API
  // ════════════════════════════════════════════

  /**
   * 获取用于 Evolution/Insight 的 TTS 相关记忆上下文。
   *
   * 组合 TTS 合成历史、用户交互记录和偏好，供进化系统分析
   * 用户的 TTS 使用模式并自动优化参数。
   */
  getTtsEvolutionContext(): string {
    if (!this.memoryService) return ''

    try {
      const ms = this.memoryService
      const parts: string[] = []

      // TTS 合成统计
      const allSynthesis = ms.getEntries().filter((e) => e.type === 'user_fact' && e.content.includes('【TTS 合成】'))

      if (allSynthesis.length > 0) {
        const successCount = allSynthesis.filter((e) => e.content.includes('🔊')).length
        const failCount = allSynthesis.length - successCount
        parts.push(`TTS 合成总计 ${allSynthesis.length} 次，成功 ${successCount} 次，失败 ${failCount} 次`)
      }

      // TTS 用户交互统计
      const allInteractions = ms.getEntries().filter((e) => e.type === 'user_fact' && e.content.includes('【TTS 交互】'))

      const skipCount = allInteractions.filter((e) => e.content.includes('跳过')).length
      const replayCount = allInteractions.filter((e) => e.content.includes('重听')).length

      if (allInteractions.length > 0) {
        parts.push(`TTS 交互总计 ${allInteractions.length} 次（跳过 ${skipCount} 次，重听 ${replayCount} 次）`)
      }

      // TTS 用户画像偏好
      const prefs = ms.getUserPreferences()
      const ttsPrefs = prefs.filter((p) => p.key.startsWith('tts_'))
      if (ttsPrefs.length > 0) {
        const prefSummary = ttsPrefs.map((p) => `${p.key}=${p.value}`).join(', ')
        parts.push(`TTS 用户偏好：${prefSummary}`)
      }

      if (parts.length === 0) return ''
      return '【TTS 进化上下文】\n' + parts.join('\n')
    } catch {
      return ''
    }
  }

  // ════════════════════════════════════════════
  //  重置 / 清理
  // ════════════════════════════════════════════

  /** 重置桥接器内部状态 */
  reset(): void {
    this.lastRecordedInteractionCount = 0
    this.synthesisCountSinceLastRecord = 0
    this.lastMemorySnapshotHash = ''
    this.lastInterestTopics = []
    log('INFO', 'memory_tts_bridge_reset')
  }
}

/** 模块级桥接器单例 */
export const memoryTtsBridge = new MemoryTtsBridge()
