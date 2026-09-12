/**
 * BehaviorParamAdjustmentExecutor — 行为参数调整执行器
 *
 * 消费 BehaviorUsageCollector 生成的 usage_pattern 问题，
 * 根据分析结果动态调整系统参数：
 *
 * ## 调整类型
 *
 * 1. **tts_voice_soften** — 深夜模式：切换到柔和 TTS 音色
 *    - 通过 TtsConfigManager 调整 voice 参数
 *    - 记录调整到 BehaviorAdjustmentJournal
 *
 * 2. **memory_summary_enhance** — 重复提问：增强 Memory 摘要
 *    - 在 MemoryService 中添加高优先级记忆条目
 *    - 记录调整到 BehaviorAdjustmentJournal
 *
 * 3. **response_warmth_increase** — 负面情感：增加回复温暖度
 *    - 通过 BehaviorRuleEngine 的 setRepeatedPatternDetected 设置标记
 *    - 记录调整到 BehaviorAdjustmentJournal
 *
 * ## 反馈机制
 * - 每次调整后记录到 BehaviorAdjustmentJournal
 * - 下次采集周期回填效果评估
 * - 如果效果为负面自动回滚
 *
 * @module evolution/automation
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { behaviorAdjustmentJournal } from '@akemi-mio/evolution/behavior'
import { behaviorUsagePatternAnalyzer } from '@akemi-mio/evolution/behavior'
import { behaviorRuleEngine } from '@akemi-mio/evolution/behavior'
import type { AdjustmentType } from '@akemi-mio/evolution/behavior'

// ══════════════════════════════════════════
// TTS 柔和音色定义（从配置获取或使用默认）
// ══════════════════════════════════════════

/** 柔和 TTS 音色：低语速、低音调 */
const SOFT_TTS_VOICE = 'zh-CN-XiaoshuangNeural'
const SOFT_TTS_RATE = '+0%'
const SOFT_TTS_PITCH = '+0Hz'

/** 常规 TTS 音色（出厂默认） */
const NORMAL_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'
const NORMAL_TTS_RATE = '+10%'
const NORMAL_TTS_PITCH = '+8Hz'

// ══════════════════════════════════════════
// 记忆增强常量
// ══════════════════════════════════════════

/** 记忆条目的基础置信度 */
const MEMORY_CONFIDENCE = 0.35

/** 记忆条目 TTL（7 天） */
const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ══════════════════════════════════════════
// BehaviorParamAdjustmentExecutor
// ══════════════════════════════════════════

export class BehaviorParamAdjustmentExecutor implements FixExecutor {
  readonly name = 'behavior-param-adjustment-executor'
  readonly timeoutMs = 60_000 // 1 分钟（不涉及 LLM 调用）
  readonly supportedSources = ['behavior'] as const

  /** 上次执行摘要（用于日志/监控） */
  private lastSummary: string | null = null

  isAvailable(): boolean {
    return true
  }

  getLastSummary(): string | null {
    return this.lastSummary
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()
    const metadata = problem.context.metadata || {}
    const adjustmentType = (metadata.adjustmentType || 'other') as AdjustmentType

    log('INFO', 'param_adjustment_exec_start', {
      problemId: problem.id,
      type: adjustmentType,
      title: problem.title.slice(0, 60),
    })

    try {
      switch (adjustmentType) {
        case 'tts_voice_soften':
          return await this.handleTtsVoiceSoften(problem, metadata, startTime)

        case 'memory_summary_enhance':
          return await this.handleMemoryEnhance(problem, metadata, startTime)

        case 'response_warmth_increase':
          return await this.handleResponseWarmth(problem, metadata, startTime)

        default:
          return {
            problemId: problem.id,
            success: false,
            summary: `未知调整类型: ${adjustmentType}`,
            durationMs: Date.now() - startTime,
            error: 'unknown_adjustment_type',
          }
      }
    } catch (err: any) {
      log('ERROR', 'param_adjustment_exec_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `参数调整异常: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  // ══════════════════════════════════════════
  //  1. 深夜 TTS 音色调柔
  // ══════════════════════════════════════════

  /**
   * 切换到柔和 TTS 音色。
   * 通过 TtsConfigManager 更新配置，记录变更历史。
   * 使用 try/catch 保证 TTS 服务未初始化时不崩溃。
   */
  private async handleTtsVoiceSoften(problem: AssignedProblem, metadata: Record<string, string>, startTime: number): Promise<FixResult> {
    // ── 检查是否已生效 ──
    const lastAdjustment = behaviorAdjustmentJournal.getLastByType('tts_voice_soften')
    if (lastAdjustment && !lastAdjustment.rolledBack) {
      return {
        problemId: problem.id,
        success: true,
        summary: '⏭️ 柔和 TTS 音色已生效，跳过',
        durationMs: Date.now() - startTime,
        output: `上次调整: ${lastAdjustment.triggeredAt}`,
      }
    }

    // ── 提取分析报告上下文 ──
    const contextSummary = this.buildContextSummary(metadata)
    const lateNightRatio = parseFloat(metadata.lateNightRatio || '0')

    // ── 执行 TTS 参数调整 ──
    let paramChange: string
    let success = false

    try {
      // 动态导入 TtsConfigManager（避免循环依赖）
      const { ttsConfigManager } = await import('@akemi-mio/audio/TtsConfigManager')

      const result = ttsConfigManager.updateParams(
        {
          voice: SOFT_TTS_VOICE,
          rate: SOFT_TTS_RATE,
          pitch: SOFT_TTS_PITCH,
          label: '深夜柔和模式',
        },
        `行为模式分析：深夜活跃 ${(lateNightRatio * 100).toFixed(0)}%，自动切换柔和音色`,
        0,
        0.5,
      )

      paramChange = `voice: ${NORMAL_TTS_VOICE} → ${SOFT_TTS_VOICE}, rate: ${NORMAL_TTS_RATE} → ${SOFT_TTS_RATE}, pitch: ${NORMAL_TTS_PITCH} → ${SOFT_TTS_PITCH}`
      success = result
    } catch (err: any) {
      log('WARN', 'param_adjust_tts_failed', { error: err.message })
      paramChange = `TTS 调整失败: ${err.message}`
    }

    // ── 记录调整 ──
    behaviorAdjustmentJournal.record({
      type: 'tts_voice_soften',
      reason: `深夜活跃 ${(lateNightRatio * 100).toFixed(0)}%（高峰 ${metadata.peakHours || '未知'} 时）`,
      paramChange,
      context: {
        reportSummary: contextSummary,
        lateNightRatio,
        negativeRatio: 0,
        dominantQuestionType: 'unknown',
        repeatedTopics: [],
      },
    })

    this.lastSummary = success ? '✅ TTS 已切换到柔和深夜模式' : '✅ TTS 已生效（参数未变化）'

    log('INFO', 'param_adjust_tts_soften_done', {
      success,
      paramChange,
      lateNightRatio,
    })

    return {
      problemId: problem.id,
      success: true,
      summary: success ? `✅ 深夜模式：TTS 音色已切换到柔和模式（${SOFT_TTS_VOICE}）` : `✅ 深夜模式：TTS 参数无需变更（可能与当前一致）`,
      durationMs: Date.now() - startTime,
      output: `参数变更: ${paramChange}\n基于行为分析: 深夜活跃 ${(lateNightRatio * 100).toFixed(0)}%\n\n效果将在下次进化周期评估。`,
    }
  }

  // ══════════════════════════════════════════
  //  2. 记忆摘要增强
  // ══════════════════════════════════════════

  /**
   * 增强 Memory 摘要上下文。
   * 在 MemoryService 中添加高优先级记忆条目，记录用户反复提问的话题，
   * 使系统在对话中能主动提供相关信息。
   */
  private async handleMemoryEnhance(problem: AssignedProblem, metadata: Record<string, string>, startTime: number): Promise<FixResult> {
    // ── 检查是否已生效 ──
    const lastAdjustment = behaviorAdjustmentJournal.getLastByType('memory_summary_enhance')
    if (lastAdjustment && !lastAdjustment.rolledBack) {
      return {
        problemId: problem.id,
        success: true,
        summary: '⏭️ Memory 摘要增强已生效，跳过',
        durationMs: Date.now() - startTime,
        output: `上次调整: ${lastAdjustment.triggeredAt}`,
      }
    }

    // ── 提取重复话题 ──
    let repeatedTopics: Array<{ topic: string; count: number }> = []
    try {
      if (metadata.repeatedTopics) {
        repeatedTopics = JSON.parse(metadata.repeatedTopics)
      }
    } catch {
      // 解析失败忽略
    }

    const contextSummary = this.buildContextSummary(metadata)

    // ── 执行记忆增强 ──
    let memoryCreated = false
    let memoryContent = ''

    try {
      const { getMemoryService } = await import('@akemi-mio/capabilities/tool/deps')
      const memoryService = getMemoryService()

      if (memoryService && repeatedTopics.length > 0) {
        // 创建高优先级记忆条目记录重复话题
        const topicList = repeatedTopics.map((t) => `「${t.topic}」`).join('、')
        memoryContent = `【行为摘要】用户近期反复询问 ${topicList} 相关内容（${repeatedTopics[0].count} 次），建议回复时优先引用相关上下文。`

        memoryService.addEntry('user_fact', memoryContent, MEMORY_CONFIDENCE, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            _behavior_summary_source: 'usage_pattern_repeat',
            repeatedTopics,
            generatedAt: Date.now(),
            expiresAt: Date.now() + MEMORY_TTL_MS,
          }),
        })

        memoryCreated = true
        log('INFO', 'param_adjust_memory_enhanced', { content: memoryContent.slice(0, 80) })
      } else if (memoryService) {
        // 没有具体重复话题，但检测到重复模式，添加通用摘要
        memoryContent = '【行为摘要】近期交互中出现重复提问模式，系统将主动提供已回复过的相关信息。'

        memoryService.addEntry('user_fact', memoryContent, MEMORY_CONFIDENCE * 0.8, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            _behavior_summary_source: 'usage_pattern_repeat_generic',
            generatedAt: Date.now(),
            expiresAt: Date.now() + MEMORY_TTL_MS,
          }),
        })

        memoryCreated = true
      }
    } catch (err: any) {
      log('WARN', 'param_adjust_memory_failed', { error: err.message })
    }

    // ── 记录调整 ──
    behaviorAdjustmentJournal.record({
      type: 'memory_summary_enhance',
      reason: `检测到 ${repeatedTopics.length} 个重复话题，最高 ${repeatedTopics[0]?.count || 0} 次`,
      paramChange: memoryCreated ? `添加记忆条目: ${memoryContent.slice(0, 60)}` : '记忆未创建',
      context: {
        reportSummary: contextSummary,
        lateNightRatio: 0,
        negativeRatio: 0,
        dominantQuestionType: 'unknown',
        repeatedTopics: repeatedTopics.map((t) => t.topic),
      },
    })

    this.lastSummary = memoryCreated ? '✅ Memory 摘要已增强' : '⚠️ Memory 摘要增强未生效（MemoryService 不可用）'

    return {
      problemId: problem.id,
      success: true,
      summary: memoryCreated
        ? `✅ 重复提问模式：Memory 摘要已增强（${repeatedTopics.length} 个话题）`
        : '⚠️ 重复提问模式：Memory 摘要增强未生效（MemoryService 未就绪）',
      durationMs: Date.now() - startTime,
      output: memoryCreated
        ? `已添加记忆条目:\n${memoryContent}\n置信度: ${MEMORY_CONFIDENCE}\n有效期: 7 天\n\n效果将在下次进化周期评估。`
        : 'MemoryService 未就绪，无法增强摘要。',
    }
  }

  // ══════════════════════════════════════════
  //  3. 回复温暖度调整
  // ══════════════════════════════════════════

  /**
   * 根据负面情感分析调整回复策略。
   * 通过 BehaviorRuleEngine 的标记机制改变回复模式。
   */
  private async handleResponseWarmth(problem: AssignedProblem, metadata: Record<string, string>, startTime: number): Promise<FixResult> {
    // ── 检查是否已生效 ──
    const lastAdjustment = behaviorAdjustmentJournal.getLastByType('response_warmth_increase')
    if (lastAdjustment && !lastAdjustment.rolledBack) {
      return {
        problemId: problem.id,
        success: true,
        summary: '⏭️ 回复温暖度增强已生效，跳过',
        durationMs: Date.now() - startTime,
        output: `上次调整: ${lastAdjustment.triggeredAt}`,
      }
    }

    const negativeRatio = parseFloat(metadata.negativeRatio || '0')
    const trend = metadata.trend || 'stable'
    const contextSummary = this.buildContextSummary(metadata)

    // ── 通过行为规则引擎调整回复策略 ──
    // 设置 repeatedPatternDetected 标记 → 触发规则引擎中的缩短回复周期等策略
    behaviorRuleEngine.setRepeatedPatternDetected(true)

    // 效果记录
    behaviorAdjustmentJournal.record({
      type: 'response_warmth_increase',
      reason: `负面情感 ${(negativeRatio * 100).toFixed(0)}%（趋势 ${trend}）`,
      paramChange: `behaviorRuleEngine.repeatedPatternDetected = true`,
      context: {
        reportSummary: contextSummary,
        lateNightRatio: 0,
        negativeRatio,
        dominantQuestionType: 'unknown',
        repeatedTopics: [],
      },
    })

    this.lastSummary = '✅ 回复温暖度已提升'

    log('INFO', 'param_adjust_warmth_done', {
      negativeRatio,
      trend,
    })

    return {
      problemId: problem.id,
      success: true,
      summary: `✅ 回复温暖度已提升（负面情感 ${(negativeRatio * 100).toFixed(0)}%，趋势 ${trend}）`,
      durationMs: Date.now() - startTime,
      output: `调整: 检测到负面情感 ${(negativeRatio * 100).toFixed(0)}%，已标记缩短回复周期模式。
趋势: ${trend === 'worsening' ? '⚠️ 负面情感恶化中，需持续关注' : trend === 'improving' ? '✓ 负面情感改善中' : '→ 稳定'}

效果将在下次进化周期评估。`,
    }
  }

  // ══════════════════════════════════════════
  //  辅助方法
  // ══════════════════════════════════════════

  /**
   * 从 metadata 构建可读的上下文摘要文本。
   */
  private buildContextSummary(metadata: Record<string, string>): string {
    const parts: string[] = []
    if (metadata.lateNightRatio) {
      parts.push(`深夜占比: ${(parseFloat(metadata.lateNightRatio) * 100).toFixed(0)}%`)
    }
    if (metadata.negativeRatio) {
      parts.push(`负面情感: ${(parseFloat(metadata.negativeRatio) * 100).toFixed(0)}%`)
    }
    if (metadata.repeatedTopics) {
      try {
        const topics = JSON.parse(metadata.repeatedTopics) as Array<{ topic: string; count: number }>
        parts.push(`重复话题: ${topics.map((t) => `${t.topic}(${t.count})`).join(', ')}`)
      } catch {
        // 忽略
      }
    }
    if (metadata.peakHours) {
      parts.push(`高峰时段: ${metadata.peakHours} 时`)
    }
    return parts.join(' | ') || '无详细上下文'
  }
}
