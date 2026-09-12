/**
 * UserSpeechProfileTracker — 用户语音输入特征跟踪器
 *
 * ── 角色 ──
 * 记录用户每次语音交互的输入特征（语音时长、文字长度），
 * 计算用户平均语速（字/秒），为 TTS 自适应提供推荐。
 *
 * ── 数据流 ──
 * ASR 转写完成 → recordInteraction(text, audioDurationMs) → 滑动窗口
 *                                                           ↓
 * TTS 合成前 ← getRecommendation() ← 计算最近 N 次交互的语速均值
 *              rateAdjustment 通过 UserBehaviorTtsContract 流入 PiperBehaviorSidecar
 *
 * ── 设计原则 ──
 * 1. 轻量无锁 — 单线程记录，不涉及异步操作
 * 2. 滑动窗口 — 仅保留最近 N 次交互，不持久化（随服务生命周期重置）
 * 3. 零侵入 — 不依赖任何 TTS/Behavior 模块，纯数据收集 + 计算
 * 4. 容错 — 短文本/短音频/空数据时优雅降级
 *
 * ── 冷启动 ──
 * 首次使用（样本 < 2）返回 rateAdjustment=0（不调整），
 * 此时 TTS 行为完全由现有 BehaviorEmotion/UserContext 等系统决定。
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次语音交互记录 */
export interface SpeechInteraction {
  /** 交互时间戳 */
  timestamp: number
  /** ASR 识别文本 */
  text: string
  /** 文本字符数（不含首尾空白） */
  charCount: number
  /** 语音输入时长（毫秒） */
  audioDurationMs: number
  /** 语速（字符/秒） */
  speechRate: number
}

/** 语速倾向分类 */
export type SpeechPaceCategory = 'very_slow' | 'slow' | 'normal' | 'fast' | 'very_fast'

/** 语音画像推荐 */
export interface SpeechProfileRecommendation {
  /** 语速调整百分比（负值=减速，正值=加速，范围 -30 ~ +30，0=不调整） */
  rateAdjustment: number
  /** 当前语速倾向类别 */
  paceCategory: SpeechPaceCategory
  /** 平均语速（字符/秒） */
  averageSpeechRate: number
  /** 用于计算的有效样本数 */
  sampleCount: number
  /** 推荐的人类可读描述 */
  reason: string
}

/** 静默推荐（样本不足时的回退值） */
const SILENT_RECOMMENDATION: SpeechProfileRecommendation = {
  rateAdjustment: 0,
  paceCategory: 'normal',
  averageSpeechRate: 0,
  sampleCount: 0,
  reason: '样本不足（需至少 2 次语音交互）',
}

// ══════════════════════════════════════════
//  UserSpeechProfileTracker
// ══════════════════════════════════════════

export class UserSpeechProfileTracker {
  /** 滑动窗口中的交互记录 */
  private readonly interactions: SpeechInteraction[] = []

  /** 滑动窗口大小（保留最近多少次交互） */
  private readonly windowSize: number

  /** 用于语速自适应计算的有效窗口（取最近多少次计算均值） */
  private readonly recentWindow: number

  /** 最小文本长度（过滤噪声/幻觉） */
  private readonly minTextLength: number

  /** 最小音频时长（毫秒，过滤点击声等短促噪音） */
  private readonly minAudioDurationMs: number

  // ── 语速阈值（字符/秒，中文普通话参考值）──
  //
  // 参考：中文普通话日常交流语速约 3-5 字/秒
  // - very_slow:  < 2.0   → 用户说话很慢，偏好慢速 TTS
  // - slow:       2.0~3.0 → 用户偏慢
  // - normal:     3.0~5.0 → 正常语速
  // - fast:       5.0~7.0 → 用户偏快
  // - very_fast:  > 7.0   → 用户说话很快，偏好快速 TTS
  private static readonly RATE_THRESHOLDS = {
    verySlow: 2.0,
    slow: 3.0,
    fast: 5.0,
    veryFast: 7.0,
  } as const

  constructor(options?: { windowSize?: number; recentWindow?: number; minTextLength?: number; minAudioDurationMs?: number }) {
    this.windowSize = options?.windowSize ?? 20
    this.recentWindow = options?.recentWindow ?? 4
    this.minTextLength = options?.minTextLength ?? 2
    this.minAudioDurationMs = options?.minAudioDurationMs ?? 500
  }

  // ══════════════════════════════════════════
  //  记录接口
  // ══════════════════════════════════════════

  /**
   * 记录一次语音交互。
   *
   * @param text           ASR 识别出的文本
   * @param audioDurationMs 语音输入时长（毫秒）
   *
   * 自动过滤：
   * - 空文本或纯空白
   * - 文本长度 < minTextLength（过滤噪声/单字幻觉）
   * - 音频时长 < minAudioDurationMs（过滤点击声/误触）
   */
  recordInteraction(text: string, audioDurationMs: number): void {
    // ── 输入校验 ──
    const trimmed = text?.trim() ?? ''
    if (!trimmed) {
      log('DEBUG', 'speech_profile_skip_empty', { reason: '空文本' })
      return
    }
    if (trimmed.length < this.minTextLength) {
      log('DEBUG', 'speech_profile_skip_short', {
        text: trimmed,
        reason: `文本过短 (${trimmed.length} < ${this.minTextLength})`,
      })
      return
    }
    if (audioDurationMs < this.minAudioDurationMs) {
      log('DEBUG', 'speech_profile_skip_short_audio', {
        durationMs: audioDurationMs,
        reason: `音频过短 (${audioDurationMs}ms < ${this.minAudioDurationMs}ms)`,
      })
      return
    }

    // ── 计算语速 ──
    const durationSec = audioDurationMs / 1000
    const speechRate = trimmed.length / durationSec

    const interaction: SpeechInteraction = {
      timestamp: Date.now(),
      text: trimmed,
      charCount: trimmed.length,
      audioDurationMs,
      speechRate,
    }

    // ── 滑动窗口维护 ──
    this.interactions.push(interaction)
    if (this.interactions.length > this.windowSize) {
      this.interactions.shift()
    }

    log('DEBUG', 'speech_profile_interaction_recorded', {
      charCount: trimmed.length,
      durationMs: audioDurationMs,
      speechRate: speechRate.toFixed(2),
      windowSize: this.interactions.length,
    })
  }

  // ══════════════════════════════════════════
  //  查询接口
  // ══════════════════════════════════════════

  /**
   * 获取最近 N 次有效交互的列表（按时间升序）。
   * 返回副本，避免外部修改内部状态。
   */
  getRecentInteractions(n: number = this.recentWindow): SpeechInteraction[] {
    return this.interactions.slice(-n)
  }

  /**
   * 获取全部交互记录的只读视图。
   */
  getAllInteractions(): readonly SpeechInteraction[] {
    return Object.freeze([...this.interactions])
  }

  /**
   * 获取最近 N 次交互的平均语速（字符/秒）。
   * 样本不足 2 次时返回 0。
   */
  getAverageSpeechRate(n: number = this.recentWindow): number {
    const recent = this.getRecentInteractions(n)
    if (recent.length < 2) return 0
    const sum = recent.reduce((acc, i) => acc + i.speechRate, 0)
    return sum / recent.length
  }

  /**
   * 根据当前语速对语音性格进行分类。
   */
  classifyPace(averageRate: number): SpeechPaceCategory {
    if (averageRate <= 0) return 'normal'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.verySlow) return 'very_slow'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.slow) return 'slow'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.fast) return 'normal'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.veryFast) return 'fast'
    return 'very_fast'
  }

  // ══════════════════════════════════════════
  //  推荐接口
  // ══════════════════════════════════════════

  /**
   * 获取当前语音特征对 TTS 的自适应推荐。
   *
   * 基于用户的语速特征（字符/秒），映射到 TTS 语速调整百分比。
   * 核心逻辑：用户说得快 → TTS 稍快；用户说得慢 → TTS 稍慢。
   * 这是最基本的"语速镜像"策略，符合交流适应理论（Communication Accommodation Theory）。
   *
   * 调整幅度限制在 ±20% 以内，防止语音失真。
   *
   * @param n 用于计算的最近交互次数（默认 4 次）
   * @returns SpeechProfileRecommendation
   */
  getRecommendation(n: number = this.recentWindow): SpeechProfileRecommendation {
    const recent = this.getRecentInteractions(n)
    if (recent.length < 2) return SILENT_RECOMMENDATION

    const avgRate = this.getAverageSpeechRate(n)
    const category = this.classifyPace(avgRate)

    // ── 语速 → 速率调整映射 ──
    let rateAdjustment = 0
    switch (category) {
      case 'very_slow':
        // 用户语速极慢 → TTS 明显减速，匹配用户节奏
        rateAdjustment = -15
        break
      case 'slow':
        // 用户偏慢 → TTS 适度减速
        rateAdjustment = -8
        break
      case 'normal':
        // 正常语速 → 不调整
        rateAdjustment = 0
        break
      case 'fast':
        // 用户偏快 → TTS 适度加速
        rateAdjustment = 8
        break
      case 'very_fast':
        // 用户语速极快 → TTS 明显加速
        rateAdjustment = 15
        break
    }

    const reason = `用户平均语速 ${avgRate.toFixed(1)} 字/秒（${paceCategoryLabel(category)}），TTS 语速${rateAdjustment >= 0 ? '+' : ''}${rateAdjustment}%`

    return {
      rateAdjustment,
      paceCategory: category,
      averageSpeechRate: avgRate,
      sampleCount: recent.length,
      reason,
    }
  }

  /**
   * 重置所有记录（用于调试/测试）。
   */
  reset(): void {
    this.interactions.length = 0
    log('INFO', 'speech_profile_tracker_reset')
  }

  /**
   * 获取当前窗口统计信息。
   */
  getStats(): { totalRecorded: number; windowSize: number; recentWindow: number } {
    return {
      totalRecorded: this.interactions.length,
      windowSize: this.windowSize,
      recentWindow: this.recentWindow,
    }
  }
}

// ══════════════════════════════════════════
//  语速分类标签
// ══════════════════════════════════════════

const PACE_CATEGORY_LABELS: Record<SpeechPaceCategory, string> = {
  very_slow: '极慢',
  slow: '偏慢',
  normal: '正常',
  fast: '偏快',
  very_fast: '极快',
}

function paceCategoryLabel(category: SpeechPaceCategory): string {
  return PACE_CATEGORY_LABELS[category]
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 所有语音交互的记录和查询通过此单例完成。
 * 在 ASR IPC handler 中调用 recordInteraction()，
 * 在 ChatExecutor 中调用 getRecommendation() 获取自适应推荐。
 */
export const userSpeechProfileTracker = new UserSpeechProfileTracker({
  windowSize: 20,
  recentWindow: 4,
  minTextLength: 2,
  minAudioDurationMs: 500,
})
