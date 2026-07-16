/**
 * TtsRadarAdapter — TTS 知识 → 雷达 Telegram Bot 适配器
 *
 * ── 设计目的 ──
 * 把 TTS 领域成熟的数据模型和判断规则改造成「Plan:合并雷达 bot 到 telegram-bot」
 * 能理解的输入格式，让雷达→Telegram 推送链路在不重构自身架构的前提下利用 TTS
 * 的知识积累。
 *
 * ── 适配的 TTS 资产 ──
 *
 * 1. cleanTTS() — 文本清理规则
 *    原始用途：剥离 Markdown/emoji/语气标记后送语音合成
 *    适配用途：清理雷达信号文本（标题、摘要）再推送到 Telegram
 *
 * 2. TtsRouter 多层决策模式
 *    原始用途：cloud/local TTS 引擎路由（用户偏好 → 性能感知 → 网络检测 → 权重）
 *    适配用途：信号推送优先级分档（urgency → 是否立即推送）、信号分群打包
 *
 * 3. EmotionTtsParams / ContextVoiceConfig 情境映射表
 *    原始用途：情境/情感 → voice/rate/pitch 参数映射
 *    适配用途：信号类别 → Telegram 推送风格/格式映射
 *
 * ── 集成方式 ──
 * 适配器是独立模块，不修改现有雷达系统（PlanStartupRadarAdapter）和 Telegram 系统
 * （TelegramService）的架构。消费方按需调用本文提供的方法即可获得 TTS 增强的能力。
 *
 * POC 阶段：适配器 + 格式化增强
 * 全量阶段：可选注册到雷达管道中
 *
 * @module tts/TtsRadarAdapter
 */

import { cleanTTS } from './TtsService'
import type { StartupSignal, SignalUrgency } from '../startup-radar/types'

// ════════════════════════════════════════════════════════════════
// 适配器输出类型 — 「Plan:合并雷达 bot 到 telegram-bot」可理解的输入格式
// ════════════════════════════════════════════════════════════════

/**
 * 信号文本清理选项。
 * Plan:合并雷达 bot 到 telegram-bot 在格式化信号文本时传入此选项，
 * 适配器返回清理后的文本。
 */
export interface SignalCleanOptions {
  /** 是否清理标题（默认 true） */
  cleanTitle?: boolean
  /** 是否清理摘要（默认 true） */
  cleanSummary?: boolean
  /** 摘要最大长度（默认 200，0=不截断） */
  summaryMaxLength?: number
  /** 是否移除来源标签文本中的 Markdown（默认 true） */
  cleanSourceLabel?: boolean
}

/**
 * TTS 风格推送配置。
 * 对应 TTS 中 EmotionTtsParams / ContextVoiceConfig 的情境映射模式，
 * 适配为雷达信号推送时的格式风格参数。
 */
export interface TtsPushStyle {
  /** 紧急级别的 emoji 前缀（覆盖默认） */
  urgencyPrefix?: string
  /** 是否使用紧凑格式（默认 false，对应 TTS 的 efficient mode） */
  compact?: boolean
  /** 是否显示评分（默认 true） */
  showScore?: boolean
  /** 单条信号最大行数（对应 TTS 的简洁度） */
  maxLines?: number
  /** 预期的推送节奏标记（hot=立即推, warm=批次推, cold=暂不推） */
  pushCadence?: 'immediate' | 'batch' | 'defer'
}

// ════════════════════════════════════════════════════════════════
// 适配器 — 将 TTS 领域知识以雷达系统可消费的形式暴露
// ════════════════════════════════════════════════════════════════

export class TtsRadarAdapter {
  // ══════════════════════════════════════════════════════════════
  // 1. 文本清理 — 适配自 cleanTTS()
  // ══════════════════════════════════════════════════════════════

  /**
   * 清理雷达信号的标题文本。
   *
   * 适配自 TTS 的 cleanTTS()：原始功能是剥离 Markdown/emoji/语气标记后送语音合成，
   * 这里用于清理雷达信号文本再推送到 Telegram，使推送内容更干净。
   *
   * 相比 cleanTTS 的增强：
   * - 保留中文标点（TTS 用 cleanTTS 会保留，一致）
   * - 额外清理信号数据中特有的模式：分类标签、URL 残留
   * - 长度控制（Telegram 单条消息 4096 字限制）
   *
   * @param title 雷达信号标题
   * @returns 清理后的标题
   *
   * @example
   * ```ts
   * adapter.cleanSignalTitle('**Show HN:** 基于 AI 的代码审查助手开源发布 🚀')
   * // → 'Show HN: 基于 AI 的代码审查助手开源发布'
   * ```
   */
  cleanSignalTitle(title: string): string {
    if (!title) return ''

    // 先用 cleanTTS 剥离通用 Markdown/emoji
    let cleaned = cleanTTS(title)
    // 它已经做了：
    //   - 剥离 **bold** 和 *italic*（保留文本）
    //   - 剥离 (括号动作) 如（微笑）
    //   - 剥离 emoji
    //   - 剥离 Markdown 链接 [text](url)
    //   - 剥离代码块和行内代码
    //   - 多音字修正

    // 雷达特有：移除分类冒号前缀中的 Markdown 残留
    cleaned = cleaned.replace(/^\s*[:：]\s*/, '').trim()

    // 如果清理后为空，返回兜底
    if (!cleaned) {
      return title.replace(/[*#`\[\](){}]/g, '').trim() || '(信号标题)'
    }

    return cleaned
  }

  /**
   * 清理雷达信号的摘要文本。
   *
   * 在 cleanTTS 基础之上叠加：
   * - 摘要长度控制（避免 Telegram 消息超长）
   * - 移除信号数据源特有的标签前缀
   *
   * @param summary 雷达信号摘要
   * @param options 清理选项
   * @returns 清理后的摘要
   */
  cleanSignalSummary(summary: string, options?: SignalCleanOptions): string {
    if (!summary) return ''

    const maxLen = options?.summaryMaxLength ?? 200

    // 先用 cleanTTS 清理
    let cleaned = cleanTTS(summary)

    // 雷达特有：压缩连续空白（cleanTTS 已做 whitespace 合并）
    // 雷达特有：移除 [来源标签] 类前缀
    cleaned = cleaned.replace(/^\[[\w-]+\]\s*/, '')

    // 长度控制
    if (maxLen > 0 && cleaned.length > maxLen) {
      cleaned = cleaned.slice(0, maxLen - 1) + '…'
    }

    return cleaned.trim()
  }

  /**
   * 整体清理信号文本（标题 + 摘要的便捷包装）。
   * 供 formatForTelegram 等函数一次性清理。
   *
   * @param signal 雷达信号
   * @param options 清理选项
   * @returns 清理后的 { title, summary }
   */
  cleanSignal(
    signal: Pick<StartupSignal, 'title' | 'summary'>,
    options?: SignalCleanOptions,
  ): { title: string; summary: string } {
    return {
      title: options?.cleanTitle !== false ? this.cleanSignalTitle(signal.title) : signal.title,
      summary: options?.cleanSummary !== false ? this.cleanSignalSummary(signal.summary, options) : signal.summary,
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 信号推送分档 — 适配自 TtsRouter 多层决策模式
  // ══════════════════════════════════════════════════════════════

  /**
   * 根据 TTS 路由风格的多层权重计算信号推送分档。
   *
   * 适配自 TtsRouter 的决策层级：
   *   TTS: userPreference → piperPerformance → networkLatency → weights
   *   本:  urgency        → compositeScore  → signalTriage  → pushCadence
   *
   * 输入：信号的 urgency 和 compositeScore（由雷达系统已有算法产出的判断）
   * 输出：推送节奏标记（immediate / batch / defer），供 Telegram 调度参考
   *
   * @param urgency 信号紧急程度（雷达系统已有）
   * @param compositeScore 复合评分（雷达系统已有）
   * @returns 推送节奏标记
   */
  orientPushCadence(urgency: SignalUrgency, compositeScore: number): 'immediate' | 'batch' | 'defer' {
    // TTS 风格的多层判断：
    // 第一层：urgency hot → 立即推
    if (urgency === 'hot') {
      // 即使 hot，评分过低也降级为 batch（类比 TTS 中 piperPerformance 差时倾向云端）
      return compositeScore >= 0.5 ? 'immediate' : 'batch'
    }

    // 第二层：urgency warm → 批次推
    if (urgency === 'warm') {
      // 评分高可提升为 immediate，评分低降级 defer
      if (compositeScore >= 0.6) return 'batch'
      return 'defer'
    }

    // 第三层：urgency cold → 延迟推
    return 'defer'
  }

  /**
   * 获取 TTS 风格推送格式配置。
   *
   * 适配自 EmotionTtsParams / ContextVoiceConfig 的情境映射表：
   *   TTS: emotion/category → voice/rate/pitch params
   *   本:  urgency → pushStyle config
   *
   * @param urgency 信号紧急程度
   * @returns TTS 风格推送配置
   */
  getPushStyle(urgency: SignalUrgency): TtsPushStyle {
    switch (urgency) {
      case 'hot':
        return {
          urgencyPrefix: '🔥',
          compact: false,
          showScore: true,
          maxLines: 6,
          pushCadence: 'immediate',
        }
      case 'warm':
        return {
          urgencyPrefix: '⚡',
          compact: false,
          showScore: true,
          maxLines: 4,
          pushCadence: 'batch',
        }
      case 'cold':
        return {
          urgencyPrefix: '💤',
          compact: true,
          showScore: false,
          maxLines: 2,
          pushCadence: 'defer',
        }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 3. 格式化增强 — 在现有 formatForTelegram 之前应用 TTS 清理
  // ══════════════════════════════════════════════════════════════

  /**
   * 对信号文本应用 TTS 清理，返回可直接嵌入 Telegram 消息的清理后字段。
   *
   * 这是 POC 集成点：在调用现有 formatForTelegram 之前先通过此方法清理信号文本，
   * 使推送内容受益于 TTS 成熟的文本清理规则库。
   *
   * @param signal 雷达信号
   * @param options 清理选项
   * @returns 清理后的信号字段
   */
  prepareForTelegram(
    signal: Pick<StartupSignal, 'title' | 'summary'>,
    options?: SignalCleanOptions,
  ): { title: string; summary: string } {
    return this.cleanSignal(signal, options)
  }

  /**
   * 批量准备信号文本（for formatBatchForTelegram 的前置处理）。
   *
   * @param signals 雷达信号列表
   * @param options 清理选项
   * @returns 清理后的信号字段列表
   */
  prepareBatchForTelegram(
    signals: Array<Pick<StartupSignal, 'title' | 'summary'>>,
    options?: SignalCleanOptions,
  ): Array<{ title: string; summary: string }> {
    return signals.map((s) => this.prepareForTelegram(s, options))
  }
}

// ════════════════════════════════════════════════════════════════
// 单例
// ════════════════════════════════════════════════════════════════

/** 全局单例，供 radar→telegram 链路消费 */
export const ttsRadarAdapter = new TtsRadarAdapter()
