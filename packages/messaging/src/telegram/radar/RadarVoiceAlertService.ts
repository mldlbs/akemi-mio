/**
 * RadarVoiceAlertService — 动态情感雷达语音预警服务
 *
 * ── 功能 ──
 *
 * 1. 紧急度计算：从雷达信号数据计算综合紧急度（热信号占比、复合评分等）
 * 2. 情感 TTS 参数选择：根据紧急度动态选择 Piper 模型、语速、音调
 * 3. 语音合成：通过 PiperOrchestrator 生成提醒音频
 * 4. HTTP API 推送：通过 Telegram Bot 代理发送语音消息
 * 5. 音色偏好管理：用户可通过对话选择偏好的预警音色
 *
 * ── 数据流 ──
 *
 *   RadarPushScheduler.executePush()
 *       ↓ (文本推送完成后)
 *   RadarVoiceAlertService.triggerVoiceAlert(signals, rule)
 *       ↓ calculateUrgency() → selectTtsParams()
 *   PiperOrchestrator.synthesize({ model, speed, pitch, text })
 *       ↓ audioFile (temp .wav)
 *   sendVoiceToTelegram(chatId, audioFile, caption)
 *       ↓ base64 → POST /voice
 *   Telegram Bot Proxy → sendVoice → Telegram User
 *
 * ── 情感参数映射 ──
 *
 *   Urgency    → Level       → Model              → Speed / Pitch
 *   ─────────────────────────────────────────────────────────────
 *   hot        → emergency   → tx_mati (沉稳男声)  → 1.3× / 0.95
 *   warm       → warning     → huayan (通用女声)   → 1.1× / 1.0
 *   cold       → info        → ling_ling (温柔女声) → 0.85× / 0.95
 *
 * @module telegram/radar/RadarVoiceAlertService
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { piperOrchestrator } from '@akemi-mio/audio/PiperOrchestrator'
import { readFileSync, existsSync } from 'fs'
import type { StartupSignal } from '@akemi-mio/intelligence-startup-radar/types'
import type { RadarPushRule } from '@akemi-mio/messaging/telegram/radar/types'
import {
  ALERT_LEVEL_TTS_MAP,
  VOICE_ALERT_EVENT,
  DEFAULT_VOICE_ALERT_PREFERENCE,
  type VoiceAlertLevel,
  type VoiceAlertTtsParams,
  type VoiceAlertPreference,
  type VoiceAlertEvent,
  type UrgencyMetrics,
} from '@akemi-mio/messaging/telegram/radar/RadarVoiceAlertTypes'

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** Telegram Bot 代理服务器端点超时（毫秒） */
const TELEGRAM_API_TIMEOUT_MS = 60_000

/** 预警语音的最大文本长度（字符），过长会截断 */
const MAX_VOICE_TEXT_LENGTH = 200

/** 静音时段检查的小时数（24 小时制） */
const QUIET_HOUR_START_DEFAULT = 23
const QUIET_HOUR_END_DEFAULT = 7

// ════════════════════════════════════════════════════════════════
// RadarVoiceAlertService
// ════════════════════════════════════════════════════════════════

export class RadarVoiceAlertService {
  /** 用户语音预警偏好 */
  private preference: VoiceAlertPreference = { ...DEFAULT_VOICE_ALERT_PREFERENCE }

  /** Telegram Bot 代理服务器 base URL（由 setBaseUrl 设置） */
  private baseUrl = ''

  /** 推送目标 chatId（由 setChatId 设置） */
  private chatId: number | null = null

  // ════════════════════════════════════════════════════════════════
  // 配置
  // ════════════════════════════════════════════════════════════════

  /**
   * 设置 Telegram Bot 代理服务器 base URL。
   * 在 TelegramService 初始化时由外部注入。
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /**
   * 设置推送目标 chatId。
   * 在 TelegramService 初始化 pushChatId 时由外部注入。
   */
  setChatId(chatId: number): void {
    this.chatId = chatId
    log('INFO', 'radar_voice_alert_chat_set', { chatId })
  }

  /**
   * 设置用户语音预警偏好。
   * 用户在对话中通过命令切换时调用。
   */
  setPreference(pref: Partial<VoiceAlertPreference>): void {
    this.preference = { ...this.preference, ...pref }
    log('INFO', 'radar_voice_alert_preference_updated', {
      enabled: this.preference.enabled,
      minAlertLevel: this.preference.minAlertLevel,
      preferredModel: this.preference.preferredModel,
    })
  }

  /** 获取当前用户偏好（只读快照） */
  getPreference(): Readonly<VoiceAlertPreference> {
    return Object.freeze({ ...this.preference })
  }

  // ════════════════════════════════════════════════════════════════
  // 核心入口
  // ════════════════════════════════════════════════════════════════

  /**
   * 触发语音预警 — 由 RadarPushScheduler.executePush() 在文本推送完成后调用。
   *
   * 流程：
   * 1. 检查偏好（是否启用、静音时段、最低级别）
   * 2. 计算综合紧急度
   * 3. 选择情感 TTS 参数
   * 4. 生成预警语音文本
   * 5. 通过 PiperOrchestrator 合成语音
   * 6. 通过 Telegram HTTP API 发送语音
   * 7. 发出 VoiceAlertEvent（供其他模块消费）
   *
   * @param signals 本次推送的信号列表
   * @param rule    触发的推送规则
   */
  async triggerVoiceAlert(signals: StartupSignal[], rule: RadarPushRule): Promise<void> {
    // ── 1. 前置检查 ──
    if (!this.preference.enabled) {
      log('DEBUG', 'radar_voice_alert_disabled')
      return
    }

    if (signals.length === 0) {
      log('DEBUG', 'radar_voice_alert_no_signals')
      return
    }

    if (!this.chatId || !this.baseUrl) {
      log('WARN', 'radar_voice_alert_not_configured', {
        hasChatId: !!this.chatId,
        hasBaseUrl: !!this.baseUrl,
      })
      return
    }

    // 静音时段检查
    if (this.isInQuietHours()) {
      log('DEBUG', 'radar_voice_alert_quiet_hours')
      return
    }

    // ── 2. 计算综合紧急度 ──
    const metrics = this.calculateUrgency(signals)

    // ── 3. 级别检查（低于最低级别的不触发语音） ──
    if (!this.isLevelSufficient(metrics.level)) {
      log('DEBUG', 'radar_voice_alert_level_below_min', {
        level: metrics.level,
        minLevel: this.preference.minAlertLevel,
      })
      return
    }

    // ── 4. 选择 TTS 参数（允许用户偏好覆盖自动选择） ──
    const ttsParams = this.selectTtsParams(metrics.level)

    // ── 5. 生成适合语音朗读的预警文本 ──
    const voiceText = this.buildVoiceText(rule, signals, metrics)

    log('INFO', 'radar_voice_alert_triggered', {
      ruleName: rule.name,
      signalCount: signals.length,
      level: metrics.level,
      score: metrics.score.toFixed(2),
      model: ttsParams.piperModel,
      speed: ttsParams.speed,
      pitch: ttsParams.pitch,
      voiceTextLen: voiceText.length,
    })

    // ── 6. 合成语音 ──
    const audioResult = await piperOrchestrator.synthesize({
      text: voiceText,
      model: ttsParams.piperModel,
      speed: ttsParams.speed,
      pitch: ttsParams.pitch,
      taskTag: 'alert',
    })

    if (!audioResult.success || !audioResult.audioFile) {
      log('WARN', 'radar_voice_alert_synthesis_failed', {
        error: audioResult.error,
        model: audioResult.model,
        fallbackUsed: audioResult.fallbackUsed,
      })
      return
    }

    // ── 7. 通过 HTTP API 发送语音到 Telegram ──
    await this.sendVoiceToTelegram(audioResult.audioFile, metrics.level, rule.name)

    // ── 8. 发出事件（供其他模块消费，如统计/日志） ──
    const alertEvent: VoiceAlertEvent = {
      ruleId: rule.id,
      ruleName: rule.name,
      signalCount: signals.length,
      alertLevel: metrics.level,
      messageText: voiceText,
      ttsParams,
      timestamp: Date.now(),
    }
    eventBus.emit(VOICE_ALERT_EVENT, alertEvent as any)
  }

  // ════════════════════════════════════════════════════════════════
  // 紧急度计算
  // ════════════════════════════════════════════════════════════════

  /**
   * 从信号列表计算综合紧急度。
   *
   * 计算方法：
   * - 基础分值：所有信号 compositeScore 的平均值
   * - hot 占比加权：hot 信号越多，整体紧急度越高
   * - 信号数量加权：信号量大意味着事态重要
   * - 最终映射为 VoiceAlertLevel
   */
  calculateUrgency(signals: StartupSignal[]): UrgencyMetrics {
    if (signals.length === 0) {
      return {
        score: 0,
        level: 'info',
        hotRatio: 0,
        signalCount: 0,
        description: '无信号',
      }
    }

    // 计算各紧急级别的数量
    let hotCount = 0
    let warmCount = 0
    let totalScore = 0

    for (const signal of signals) {
      if (signal.urgency === 'hot') hotCount++
      else if (signal.urgency === 'warm') warmCount++
      totalScore += signal.compositeScore
    }

    const n = signals.length
    const avgScore = totalScore / n
    const hotRatio = hotCount / n
    const warmRatio = warmCount / n

    // 综合分值 = 平均分 × (1 + hot 占比 × 0.5) × (1 + 信号密级因子)
    // 信号密级因子：信号多时适当提升紧急度
    const densityFactor = Math.min(n / 10, 0.3) // max 0.3 boost for 10+ signals
    const rawScore = avgScore * (1 + hotRatio * 0.5 + warmRatio * 0.2) * (1 + densityFactor)

    // 限幅到 [0, 1]
    const score = Math.min(1, Math.max(0, rawScore))

    // 映射为级别
    const level: VoiceAlertLevel = score >= 0.6 ? 'emergency' : score >= 0.35 ? 'warning' : 'info'

    // 人类可读描述
    const description = this.describeUrgency(level, score, hotCount, n)

    return { score, level, hotRatio, signalCount: n, description }
  }

  /**
   * 生成紧急度的人类可读描述（用于日志和事件）。
   */
  private describeUrgency(level: VoiceAlertLevel, score: number, hotCount: number, total: number): string {
    switch (level) {
      case 'emergency':
        return `紧急: 综合 ${(score * 100).toFixed(0)} 分, ${hotCount}/${total} 条高风险信号`
      case 'warning':
        return `警示: 综合 ${(score * 100).toFixed(0)} 分, ${hotCount}/${total} 条高风险信号`
      case 'info':
        return `常规: 综合 ${(score * 100).toFixed(0)} 分, ${total} 条信号`
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 情感 TTS 参数选择
  // ════════════════════════════════════════════════════════════════

  /**
   * 根据预警级别选择 PiperTTS 参数。
   *
   * 自动选择逻辑：
   * - 如果用户设置了 preferredModel，使用用户偏好的模型（保留速度/音调映射）
   * - 否则使用 ALERT_LEVEL_TTS_MAP 中的默认映射
   */
  selectTtsParams(level: VoiceAlertLevel): VoiceAlertTtsParams {
    const defaults = ALERT_LEVEL_TTS_MAP[level]

    if (this.preference.preferredModel) {
      return {
        ...defaults,
        piperModel: this.preference.preferredModel,
        description: `${defaults.description}·用户偏好`,
      }
    }

    return defaults
  }

  // ════════════════════════════════════════════════════════════════
  // 语音文本生成
  // ════════════════════════════════════════════════════════════════

  /**
   * 构建适合语音朗读的预警文本。
   *
   * 设计原则：
   * - 开头用语气词表达紧急度，即使不看文字也能感知级别
   * - 内容极简：规则名、信号数、核心分类
   * - 不使用 Markdown/emoji（TTS 会误读）
   * - 长度控制在 200 字以内，避免语音过长
   */
  buildVoiceText(rule: RadarPushRule, signals: StartupSignal[], metrics: UrgencyMetrics): string {
    const lines: string[] = []

    switch (metrics.level) {
      case 'emergency': {
        lines.push('紧急预警！')
        lines.push(`${rule.name}，发现 ${signals.length} 条高风险信号。`)
        // 按类别摘要
        const catSummary = this.summarizeCategories(signals)
        if (catSummary) lines.push(catSummary)
        // 如果 hot 信号多，追加一句提醒
        const hotCount = signals.filter((s) => s.urgency === 'hot').length
        if (hotCount >= 3) {
          lines.push(`其中 ${hotCount} 条为紧急级别，请尽快查看。`)
        }
        break
      }
      case 'warning': {
        lines.push('预警提示。')
        lines.push(`${rule.name}，有 ${signals.length} 条信号值得关注。`)
        const catSummary = this.summarizeCategories(signals)
        if (catSummary) lines.push(catSummary)
        break
      }
      case 'info': {
        lines.push(`${rule.name}，推送了 ${signals.length} 条新信号。`)
        const topSignal = signals[0]
        if (topSignal) {
          lines.push(`其中：${topSignal.category}，${topSignal.title}。`)
        }
        break
      }
    }

    // 截断并返回
    const fullText = lines.join('')
    return fullText.length > MAX_VOICE_TEXT_LENGTH ? fullText.slice(0, MAX_VOICE_TEXT_LENGTH - 1) + '。' : fullText
  }

  /**
   * 按类别汇总信号分布（用于语音文本）。
   * 例如 "主要涉及：市场趋势 3 条，技术突破 2 条。"
   */
  private summarizeCategories(signals: StartupSignal[]): string {
    const catCount = new Map<string, number>()
    for (const s of signals) {
      catCount.set(s.category, (catCount.get(s.category) || 0) + 1)
    }

    // 按数量降序取前 3 个类别
    const sorted = Array.from(catCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    if (sorted.length === 0) return ''

    const catNames: Record<string, string> = {
      market_trend: '市场趋势',
      competitor: '竞品动态',
      funding: '投融资',
      technology: '技术突破',
      policy: '政策法规',
      talent: '人才流动',
      consumer_demand: '消费需求',
    }

    const parts = sorted.map(([cat, count]) => {
      const name = catNames[cat] || cat
      return `${name} ${count} 条`
    })

    return `主要涉及：${parts.join('，')}。`
  }

  // ════════════════════════════════════════════════════════════════
  // Telegram HTTP API 发送
  // ════════════════════════════════════════════════════════════════

  /**
   * 通过 Telegram Bot 代理服务器的 /voice 端点发送语音。
   *
   * 发送格式（与 /photo 端点一致）：
   * - POST /voice
   * - Content-Type: application/json
   * - Body: { chatId, audio: base64, caption, bot: 'push' }
   *
   * @param audioFilePath 音频文件路径（.wav，PiperOrchestrator 生成）
   * @param level         预警级别（用于日志）
   * @param ruleName      规则名（用于日志）
   */
  private async sendVoiceToTelegram(audioFilePath: string, level: VoiceAlertLevel, ruleName: string): Promise<void> {
    try {
      // 1. 检查文件是否存在
      if (!existsSync(audioFilePath)) {
        log('WARN', 'radar_voice_alert_file_missing', { path: audioFilePath })
        return
      }

      // 2. 读取音频文件并 base64 编码
      const audioBuffer = readFileSync(audioFilePath)
      const base64Audio = audioBuffer.toString('base64')

      // 3. 构建与图片发送一致的 caption
      const caption = this.buildCaption(level, ruleName)

      // 4. 发送到 Telegram Bot 代理服务器的 /voice 端点
      const response = await fetch(`${this.baseUrl}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: this.chatId,
          audio: base64Audio,
          caption,
          bot: 'push',
        }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      })

      if (response.ok) {
        log('INFO', 'radar_voice_alert_sent', {
          level,
          ruleName,
          audioSizeKB: Math.round(audioBuffer.length / 1024),
          durationSec: Math.round(audioBuffer.length / 16000 / 2), // 估算: ~16KB/s for PCM 16kHz
        })
      } else {
        const errorText = await response.text().catch(() => 'unknown')
        log('WARN', 'radar_voice_alert_send_failed', {
          status: response.status,
          error: errorText.slice(0, 200),
        })
      }
    } catch (err) {
      log('WARN', 'radar_voice_alert_send_error', {
        error: String(err).slice(0, 200),
      })
    }
  }

  /**
   * 构建语音消息的 caption（显示在语音消息下方的文本）。
   * 极短，仅用于标识。
   */
  private buildCaption(level: VoiceAlertLevel, ruleName: string): string {
    switch (level) {
      case 'emergency':
        return `🔴 紧急预警 · ${ruleName}`
      case 'warning':
        return `🟡 预警提示 · ${ruleName}`
      case 'info':
        return `🔵 雷达简报 · ${ruleName}`
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 辅助方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 检查当前时间是否在静音时段内。
   *
   * 静音时段配置：quietHourStart ~ quietHourEnd（跨天支持）。
   * 默认静音时段：23:00 ~ 07:00。
   */
  private isInQuietHours(): boolean {
    const start = this.preference.quietHourStart ?? QUIET_HOUR_START_DEFAULT
    const end = this.preference.quietHourEnd ?? QUIET_HOUR_END_DEFAULT
    const now = new Date().getHours()

    if (start <= end) {
      // 不跨天：如 7-23
      return now >= start && now < end
    }
    // 跨天：如 23-7
    return now >= start || now < end
  }

  /**
   * 检查给定的预警级别是否达到用户设置的最低触发级别。
   *
   * 级别优先级：emergency > warning > info
   */
  private isLevelSufficient(level: VoiceAlertLevel): boolean {
    const levels: VoiceAlertLevel[] = ['emergency', 'warning', 'info']
    const minIdx = levels.indexOf(this.preference.minAlertLevel)
    const actualIdx = levels.indexOf(level)
    return actualIdx <= minIdx // 索引越小越紧急
  }
}

// ════════════════════════════════════════════════════════════════
// 单例
// ════════════════════════════════════════════════════════════════

/** 全局单例，由 RadarPushScheduler 在文本推送后调用 */
export const radarVoiceAlertService = new RadarVoiceAlertService()
