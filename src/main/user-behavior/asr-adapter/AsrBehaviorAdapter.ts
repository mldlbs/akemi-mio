/**
 * asr-adapter/AsrBehaviorAdapter — ASR→UserBehavior 适配器主类
 *
 * 职责：
 * 将 ASR 领域成熟的数据模型（VoiceEmotion、AcousticEnvironment、Confidence）
 * 和判断规则（置信度启发式、环境分类、情感映射）转换为 UserBehavior
 * 子系统可消费的输入格式（BehaviorContextHint、AsrQualitySignal）。
 *
 * 设计原则：
 * - 纯转换函数：输入 ASR 数据 → 输出 UserBehavior 兼容格式，无副作用
 * - 无重构侵入：UserBehavior 内部类型（BehaviorMode、ActivityContext 等）不变
 * - POC 优先：默认启用 pocMode，仅输出核心转换结果
 * - 判断规则复用：将 ASR 的启发式规则（如低置信关键词检测、环境分类阈值）
 *   映射为 UserBehavior 可理解的情境/质量信号
 *
 * 使用方式（POC）：
 * ```ts
 * import { asrBehaviorAdapter } from './asr-adapter'
 * // 在获得 ASR 结果后
 * const output = asrBehaviorAdapter.adapt({
 *   voiceEmotion: { label: 'calm', confidence: 0.8, ... },
 *   environment: { environment: 'quiet', ... },
 * })
 * // output.contextHint → UserBehavior 可以使用的格式
 * ```
 *
 * 使用方式（UserBehaviorLayer hook）：
 * ```ts
 * const layer = new UserBehaviorLayer(evolutionService, {
 *   features: ['asr_adapter'],
 *   preHooks: [AsrBehaviorAdapter.createPreHook()],
 * })
 * ```
 */

import { log } from '../../logger/Logger'
import type {
  AsrVoiceEmotionInput,
  AsrEnvironmentInput,
  AsrConfidenceInput,
  AsrDomainStatInput,
  BehaviorContextHint,
  AsrQualitySignal,
  AsrBehaviorOutput,
  AsrBehaviorAdapterConfig,
  AdapterState,
} from './AsrBehaviorTypes'
import { DEFAULT_ADAPTER_CONFIG } from './AsrBehaviorTypes'
import type { PreProcessContext, PostProcessContext, PostProcessResult } from '../types'

// =============================================================================
// ASR 判断规则 → UserBehavior 情境映射常量
// =============================================================================

/**
 * VoiceEmotionLabel → 用户活跃度映射。
 * 将 ASR 的语音情感判断规则转换为 UserBehavior 的活跃度评分。
 * 评分越高表示用户越活跃/专注，越低表示越放松/不活跃。
 */
const VOICE_EMOTION_ACTIVITY_MAP: Record<string, number> = {
  happy: 0.8,
  angry: 0.9,
  anxious: 0.7,
  neutral: 0.5,
  calm: 0.3,
  sad: 0.2,
}

/**
 * VoiceEmotionLabel → 行为情境标签。
 * 将 ASR 语音情感映射为 UserBehavior 可理解的情境描述。
 */
const VOICE_EMOTION_LABEL_MAP: Record<string, string> = {
  happy: '用户语音情绪：开心',
  sad: '用户语音情绪：低落',
  angry: '用户语音情绪：激动/生气',
  calm: '用户语音情绪：平静',
  anxious: '用户语音情绪：焦虑',
  neutral: '用户语音情绪：中性',
}

/**
 * AcousticEnvironment → UserBehavior 环境标签映射。
 * 将 ASR 声学环境分类的判断规则转换为 UserBehavior 的情境提示。
 */
const ENVIRONMENT_LABEL_MAP: Record<string, string> = {
  quiet: '安静环境',
  noisy: '噪声环境',
  far_field: '远场/小声',
  music_bg: '背景音乐',
  reverberant: '混响环境',
  unknown: '未知环境',
}

/**
 * AcousticEnvironment → 安静度（0=极安静，1=极嘈杂）。
 * 用于 UserBehavior 判断用户是否需要更简洁/温和的输出。
 */
const ENVIRONMENT_NOISE_MAP: Record<string, number> = {
  quiet: 0.0,
  unknown: 0.1,
  reverberant: 0.3,
  far_field: 0.2,
  music_bg: 0.5,
  noisy: 0.8,
}

// =============================================================================
// ASR 置信度判断规则 → UserBehavior 质量信号映射常量
// =============================================================================

/**
 * 低置信关键词（ASR 判断规则复用）。
 * 来自 AsrConfidenceScorer.LOW_CONFIDENCE_KEYWORDS 的规则，
 * 适配后用于生成 UserBehavior 质量信号。
 */
const ADAPTED_LOW_CONF_KEYWORDS = [
  '嗯', '呃', '啊', '哦', '噢', '哎',
  '嗯哼', '呃呃', '啊啊',
]

/**
 * 置信度分值范围对应的质量等级描述。
 * 将 ASR 的数值置信度判断规则转换为定性描述。
 */
function describeConfidenceLevel(score: number): string {
  if (score >= 0.9) return '高置信度'
  if (score >= 0.7) return '中置信度'
  if (score >= 0.4) return '低置信度'
  return '极低置信度'
}

// =============================================================================
// 辅助函数 — 将 ASR 判断规则转换为 UserBehavior 格式
// =============================================================================

/**
 * 判断文本是否包含低置信关键词（复用 ASR 的判断规则）。
 * 来自 AsrConfidenceScorer 的 LOW_CONFIDENCE_KEYWORDS 规则。
 */
function hasLowConfidenceKeyword(text: string): boolean {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return false
  return ADAPTED_LOW_CONF_KEYWORDS.some((kw) => trimmed.includes(kw))
}

/**
 * 判断文本是否为极短片段（复用 ASR 的 MIN_VALID_TEXT_LENGTH 规则）。
 */
function isVeryShortText(text: string): boolean {
  return (text?.trim()?.length ?? 0) <= 2
}

// =============================================================================
// 映射函数
// =============================================================================

/**
 * 将 ASR VoiceEmotion 映射为 UserBehavior BehaviorContextHint 中的相关字段。
 */
function mapVoiceEmotionToContext(
  voiceEmotion: AsrVoiceEmotionInput,
): Pick<BehaviorContextHint, 'voiceEmotionSummary' | 'voiceEnergy' | 'activityScore'> {
  const label = voiceEmotion.label
  const summary = VOICE_EMOTION_LABEL_MAP[label] ?? '未知语音情绪'
  const energy = Math.max(0, Math.min(1, voiceEmotion.features.energy ?? 0.5))
  const activityScore = VOICE_EMOTION_ACTIVITY_MAP[label] ?? 0.5

  return {
    voiceEmotionSummary: summary,
    voiceEnergy: energy,
    activityScore,
  }
}

/**
 * 将 ASR AcousticEnvironment 映射为 UserBehavior BehaviorContextHint 中的环境相关字段。
 */
function mapEnvironmentToContext(
  environment: AsrEnvironmentInput,
): Pick<BehaviorContextHint, 'environmentLabel' | 'isQuiet' | 'isNoisy'> {
  const env = environment.environment
  const label = ENVIRONMENT_LABEL_MAP[env] ?? '未知环境'
  const noiseLevel = ENVIRONMENT_NOISE_MAP[env] ?? 0

  return {
    environmentLabel: label,
    isQuiet: noiseLevel < 0.2,
    isNoisy: noiseLevel >= 0.5,
  }
}

/**
 * 将 ASR Confidence 分数和规则转换为 UserBehavior 质量信号列表。
 *
 * 复用 ASR 领域已有的判断规则：
 * - 低置信度检测规则（文本长度、幻觉模式、低置信关键词）
 * - 音频特征评估规则（能量、静音比）
 */
function mapConfidenceToQualitySignals(
  confidence: AsrConfidenceInput,
): AsrQualitySignal[] {
  const signals: AsrQualitySignal[] = []

  // 综合置信度质量信号
  signals.push({
    name: 'asr_recognition_confidence',
    value: confidence.score,
    description: `ASR 识别置信度: ${describeConfidenceLevel(confidence.score)}`,
  })

  // 文本置信度质量信号（复用 ASR 的文本评分规则）
  signals.push({
    name: 'asr_text_quality',
    value: confidence.textScore,
    description: `ASR 文本质量评分`,
  })

  // 音频置信度质量信号（复用 ASR 的音频评分规则）
  if (confidence.audioScore < 1) {
    signals.push({
      name: 'asr_audio_quality',
      value: confidence.audioScore,
      description: `ASR 音频质量评分`,
    })
  }

  // 低置信度检测（复用 ASR 的 isLowConfidence 判断）
  if (confidence.isLowConfidence) {
    signals.push({
      name: 'asr_low_confidence_detected',
      value: Math.max(0, confidence.score),
      description: `ASR 检测到低置信度识别`,
    })
  }

  // 幻觉模式检测（复用 ASR 的 hallucination 判断规则）
  if (confidence.hallucinationMatch) {
    signals.push({
      name: 'asr_hallucination_detected',
      value: 0.1,
      description: `ASR 检测到幻觉模式: "${confidence.hallucinationMatch}"`,
    })
  }

  // 低置信关键词检测（复用 ASR 的关键词规则）
  if (hasLowConfidenceKeyword(confidence.text)) {
    signals.push({
      name: 'asr_low_confidence_keyword',
      value: 0.3,
      description: 'ASR 文本含低置信关键词（嗯/呃等填充词为主）',
    })
  }

  // 极短文本质检（复用 ASR 的文本长度规则）
  if (isVeryShortText(confidence.text)) {
    signals.push({
      name: 'asr_very_short_text',
      value: 0.2,
      description: 'ASR 文本过短，可能为静音误识别',
    })
  }

  return signals
}

// =============================================================================
// AsrBehaviorAdapter 主类
// =============================================================================

export class AsrBehaviorAdapter {
  /** 适配器配置 */
  private config: AsrBehaviorAdapterConfig

  /** 适配器运行时状态 */
  private state: AdapterState = {
    totalAdaptations: 0,
    successfulAdaptations: 0,
    lastAdaptationTimestamp: 0,
  }

  constructor(config?: Partial<AsrBehaviorAdapterConfig>) {
    this.config = { ...DEFAULT_ADAPTER_CONFIG, ...config }
  }

  // ==================== 配置管理 ====================

  /** 更新适配器配置（支持运行时热更新） */
  updateConfig(patch: Partial<AsrBehaviorAdapterConfig>): void {
    this.config = { ...this.config, ...patch }
    log('INFO', 'asr_adapter_config_updated', {
      pocMode: this.config.pocMode,
      enableVoiceEmotion: this.config.enableVoiceEmotionMapping,
      enableEnvironment: this.config.enableEnvironmentMapping,
      enableConfidence: this.config.enableConfidenceMapping,
    })
  }

  /** 获取当前配置 */
  getConfig(): AsrBehaviorAdapterConfig {
    return { ...this.config }
  }

  /** 获取适配器运行时统计 */
  getState(): AdapterState {
    return { ...this.state }
  }

  // ==================== 核心转换 ====================

  /**
   * 将 ASR 数据适配为 UserBehavior 可消费的格式。
   *
   * 这是适配器的核心入口：
   * 1. 接收 ASR 各模块的原始数据（VoiceEmotion / Environment / Confidence）
   * 2. 通过映射函数转换格式
   * 3. 输出 UserBehavior 子系统可以直接使用的 BehaviorContextHint + QualitySignals
   *
   * POC 模式（默认启用）：只输出核心映射结果，减少日志。
   *
   * @param input 适配器输入（ASR 数据，至少包含一项）
   * @returns AsrBehaviorOutput（UserBehavior 可消费的输出）
   */
  adapt(input: {
    voiceEmotion?: AsrVoiceEmotionInput
    environment?: AsrEnvironmentInput
    confidence?: AsrConfidenceInput
    domainStats?: AsrDomainStatInput[]
  }): AsrBehaviorOutput {
    this.state.totalAdaptations++
    const t0 = Date.now()
    const messages: string[] = []
    const qualitySignals: AsrQualitySignal[] = []

    // ── 1. VoiceEmotion → BehaviorContextHint ──

    let contextHint: BehaviorContextHint | null = null

    if (input.voiceEmotion && this.config.enableVoiceEmotionMapping) {
      const emotion = input.voiceEmotion

      if (emotion.confidence > 0.3) {
        const emotionResult = mapVoiceEmotionToContext(emotion)

        contextHint = {
          environmentLabel: '（未分类）',
          isQuiet: true,
          isNoisy: false,
          ...emotionResult,
        }

        if (!this.config.pocMode) {
          messages.push(
            `[ASR适配] 语音情感 "${emotion.label}" → 活跃度 ${emotionResult.activityScore.toFixed(2)}`,
          )
        }

        if (this.config.debug) {
          log('DEBUG', 'asr_adapter_emotion_mapped', {
            sourceLabel: emotion.label,
            activityScore: emotionResult.activityScore,
            voiceEnergy: emotionResult.voiceEnergy,
            confidence: emotion.confidence,
          })
        }
      } else {
        if (!this.config.pocMode) {
          messages.push('[ASR适配] 语音情感置信度过低，跳过映射')
        }
      }
    }

    // ── 2. AcousticEnvironment → BehaviorContextHint 合并 ──

    if (input.environment && this.config.enableEnvironmentMapping) {
      const env = input.environment

      if (env.confidence > 0.3) {
        const envResult = mapEnvironmentToContext(env)

        if (contextHint) {
          // 合并环境信息到已有的 contextHint
          contextHint.environmentLabel = envResult.environmentLabel
          contextHint.isQuiet = envResult.isQuiet || contextHint.isQuiet
          contextHint.isNoisy = envResult.isNoisy || contextHint.isNoisy
        } else {
          contextHint = {
            environmentLabel: envResult.environmentLabel,
            isQuiet: envResult.isQuiet,
            isNoisy: envResult.isNoisy,
            voiceEmotionSummary: '（无语音情感数据）',
            voiceEnergy: 0.5,
            activityScore: 0.5,
          }
        }

        if (!this.config.pocMode) {
          messages.push(
            `[ASR适配] 声学环境 "${env.environment}" → ${envResult.isQuiet ? '安静' : envResult.isNoisy ? '嘈杂' : '一般'}`,
          )
        }

        if (this.config.debug) {
          log('DEBUG', 'asr_adapter_environment_mapped', {
            sourceEnv: env.environment,
            isQuiet: envResult.isQuiet,
            isNoisy: envResult.isNoisy,
            confidence: env.confidence,
          })
        }
      }
    }

    // ── 3. Confidence → QualitySignals ──

    if (input.confidence && this.config.enableConfidenceMapping) {
      const confidenceSignals = mapConfidenceToQualitySignals(input.confidence)
      qualitySignals.push(...confidenceSignals)

      if (!this.config.pocMode && confidenceSignals.length > 0) {
        messages.push(
          `[ASR适配] 置信度评分 ${(input.confidence.score * 100).toFixed(0)} → ${confidenceSignals.length} 个质量信号`,
        )
      }
    }

    // ── 4. DomainStats → QualitySignals ──

    if (input.domainStats && input.domainStats.length > 0 && this.config.enableConfidenceMapping) {
      const totalWords = input.domainStats.reduce((sum, d) => sum + d.count, 0)
      qualitySignals.push({
        name: 'asr_vocabulary_domain_count',
        value: Math.min(1, input.domainStats.length / 10),
        description: `ASR 热词覆盖 ${input.domainStats.length} 个领域，共 ${totalWords} 词`,
      })

      if (!this.config.pocMode) {
        const topDomains = input.domainStats
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map((d) => `${d.domain}(${d.count})`)
          .join(', ')
        messages.push(`[ASR适配] 热词领域分布: ${topDomains}`)
      }
    }

    // ── 完成 ──

    this.state.successfulAdaptations++
    this.state.lastAdaptationTimestamp = Date.now()
    const durationMs = Date.now() - t0

    if (this.config.debug) {
      log('DEBUG', 'asr_adapter_adapt_done', {
        durationMs,
        hasContextHint: !!contextHint,
        qualitySignals: qualitySignals.length,
        messages: messages.length,
      })
    }

    const output: AsrBehaviorOutput = {
      contextHint,
      qualitySignals,
      messages,
      success: true,
    }

    this.state.lastResult = `adapted in ${durationMs}ms: ${messages.length > 0 ? messages[0] : 'no messages'}`
    return output
  }

  // ==================== UserBehaviorLayer Hook 工厂 ====================

  /**
   * 创建 UserBehaviorLayer 可注册的预处理钩子。
   *
   * 钩子行为（POC 阶段）：
   * 1. 读取预处理上下文中 ASR 相关数据（通过 eventBus 或直接注入）
   * 2. 调用 adapt() 将 ASR 数据转为 BehaviorContextHint
   * 3. 将 hint 注入 PreProcessContext，供后续 Evolution 管道使用
   *
   * POC 阶段，ASR 数据尚未通过 EventBus 持续推送，
   * 此钩子仅占位，核心转换通过直接调用 adapt() 验证。
   *
   * @param adapter 可选的自定义适配器实例（默认使用全局单例）
   * @returns PreProcessHook
   */
  static createPreHook(adapter?: AsrBehaviorAdapter): (ctx: PreProcessContext) => Promise<PreProcessContext> {
    const instance = adapter ?? asrBehaviorAdapter

    return async (ctx: PreProcessContext): Promise<PreProcessContext> => {
      if (!instance.config.enableVoiceEmotionMapping && !instance.config.enableEnvironmentMapping) {
        return ctx
      }

      try {
        // POC 阶段：如果上下文已有 ASR 原始数据，进行转换
        const ctxAny = ctx as Record<string, unknown>
        const asrVoice = ctxAny.asrVoiceEmotion as AsrVoiceEmotionInput | undefined
        const asrEnv = ctxAny.asrEnvironment as AsrEnvironmentInput | undefined

        if (!asrVoice && !asrEnv) {
          // 无 ASR 数据，不做处理
          return ctx
        }

        const result = instance.adapt({
          voiceEmotion: asrVoice,
          environment: asrEnv,
        })

        if (result.contextHint) {
          // 将适配后的 contextHint 注入预处理上下文
          // UserBehaviorLayer 的其他钩子或 Evolution 管道可通过 ctx.asrContext 读取
          ;(ctx as Record<string, unknown>).asrContext = result.contextHint

          if (instance.config.debug) {
            log('DEBUG', 'asr_adapter_pre_hook_injected', {
              environmentLabel: result.contextHint.environmentLabel,
              activityScore: result.contextHint.activityScore,
            })
          }
        }

        return ctx
      } catch (err: any) {
        log('WARN', 'asr_adapter_pre_hook_error', {
          error: err.message ?? String(err),
        })
        return ctx // 钩子失败不阻断主流程
      }
    }
  }

  /**
   * 创建 UserBehaviorLayer 可注册的后处理钩子。
   *
   * 在 Evolution 周期后，如果预处理阶段注入了 ASR 适配数据，
   * 在报告中附加 ASR 相关的情境摘要。
   *
   * @param adapter 可选的自定义适配器实例
   * @returns PostProcessHook
   */
  static createPostHook(adapter?: AsrBehaviorAdapter): (ctx: PostProcessContext) => Promise<PostProcessResult> {
    const instance = adapter ?? asrBehaviorAdapter

    return async (ctx: PostProcessContext): Promise<PostProcessResult> => {
      if (!ctx.success || !ctx.preProcessData) return {}

      try {
        const preData = ctx.preProcessData as Record<string, unknown>
        const asrContext = preData.asrContext as BehaviorContextHint | undefined

        if (!asrContext) return {}

        // POC 阶段：仅当有数据时才输出增强摘要
        const lines: string[] = []

        if (asrContext.environmentLabel && asrContext.environmentLabel !== '（未分类）') {
          lines.push(`🎤 声学环境: ${asrContext.environmentLabel}`)
        }

        if (asrContext.isNoisy) {
          lines.push('⚠️ 检测到噪声环境，UserBehavior 已调整输出策略')
        }

        if (asrContext.voiceEmotionSummary && asrContext.voiceEmotionSummary !== '（无语音情感数据）') {
          lines.push(`💬 ${asrContext.voiceEmotionSummary}`)
        }

        if (asrContext.activityScore > 0.7) {
          lines.push('⚡ 用户语音活跃度较高，交互响应可适当加快')
        } else if (asrContext.activityScore < 0.3) {
          lines.push('🍃 用户语音活跃度较低，交互响应可适当放缓')
        }

        if (lines.length === 0) return {}

        const enhancedSummary = ctx.rawSummary
          ? `${ctx.rawSummary}\n\n---\n### ASR 情境摘要\n${lines.join('\n')}`
          : lines.join('\n')

        if (instance.config.debug) {
          log('DEBUG', 'asr_adapter_post_hook_enhanced', {
            linesAdded: lines.length,
          })
        }

        return {
          enhancedSummary,
          extraData: {
            asrContextHint: {
              environmentLabel: asrContext.environmentLabel,
              isQuiet: asrContext.isQuiet,
              isNoisy: asrContext.isNoisy,
              activityScore: asrContext.activityScore,
            },
          },
          messages: lines.length > 0 ? [`🎤 ASR 情境感知: ${lines[0]}`] : [],
        }
      } catch {
        return {}
      }
    }
  }
}

// =============================================================================
// 单例
// =============================================================================

export const asrBehaviorAdapter = new AsrBehaviorAdapter()
