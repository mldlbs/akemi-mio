/**
 * MergeVoiceBroadcastService — 合并进度语音播报服务
 *
 * 在合并计划执行时，集成 TTS 功能实时播报每个合并步骤的状态和结果。
 * 支持：
 * - 步骤状态播报（如"正在合并依赖，遇到冲突"）
 * - 错误/冲突语音警告
 * - 音色选择（通过 EmotionTtsParams 配置）
 * - EventBus 事件发射（供 Wallpaper 显示同步日志）
 * - 完成总结播报
 *
 * 使用方式：
 * 在 AppRuntime 中创建，传入 TtsService，然后通过 subscribeToEvents()
 * 自动监听 EventBus 上的 merge.* 事件。
 *
 * 也可以通过 broadcast* 方法手动触发播报。
 */
import { log } from '../../logger/Logger'
import { eventBus, SubscriptionTracker } from '../../core/EventBus'
import type { TtsService } from '../../tts/TtsService'
import type { EmotionTtsParams } from '../../tts/types'

// ═══════════════════════════════════════════
// 语音配置
// ═══════════════════════════════════════════

/** 合并语音播报配置 */
export interface MergeVoiceConfig {
  /** 是否启用语音播报 */
  enabled: boolean
  /** 步骤播报语音参数（如"正在合并依赖"） */
  stepVoice: EmotionTtsParams
  /** 错误/冲突警告语音参数（如"遇到冲突，正在回滚"） */
  errorVoice: EmotionTtsParams
  /** 成功播报语音参数（如"合并完成"） */
  successVoice: EmotionTtsParams
  /** 总结播报语音参数 */
  summaryVoice: EmotionTtsParams
  /** 是否播报每个缺口的详细信息 */
  verboseSteps: boolean
  /** 是否启用到壁纸的同步日志推送 */
  wallpaperSync: boolean
}

/** 默认合并语音播报配置 */
export const DEFAULT_MERGE_VOICE_CONFIG: MergeVoiceConfig = {
  enabled: true,
  stepVoice: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+8%',
    pitch: '+4Hz',
    label: '合并·步骤',
  },
  errorVoice: {
    voice: 'zh-CN-YunjianNeural',
    rate: '-3%',
    pitch: '-3Hz',
    label: '合并·警告',
  },
  successVoice: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+12%',
    pitch: '+10Hz',
    label: '合并·成功',
  },
  summaryVoice: {
    voice: 'zh-CN-YunyangNeural',
    rate: '+10%',
    pitch: '+6Hz',
    label: '合并·总结',
  },
  verboseSteps: true,
  wallpaperSync: true,
}

// ═══════════════════════════════════════════
// 事件类型（用于日志/状态同步到壁纸）
// ═══════════════════════════════════════════

/** 合并日志条目（供壁纸显示） */
export interface MergeLogEntry {
  timestamp: number
  type: 'step' | 'success' | 'error' | 'conflict' | 'summary'
  message: string
  detail?: string
}

// ═══════════════════════════════════════════
// MergeVoiceBroadcastService
// ═══════════════════════════════════════════

export class MergeVoiceBroadcastService {
  private ttsService: TtsService | null = null
  private config: MergeVoiceConfig
  private subs = new SubscriptionTracker()
  private started = false
  /** 本次合并的开始时间 */
  private cycleStartedAt = 0
  /** 累计的日志条目（供壁纸消费） */
  private logEntries: MergeLogEntry[] = []
  /** 日志更新回调（供壁纸注册） */
  private onLogUpdate: ((entry: MergeLogEntry, allEntries: MergeLogEntry[]) => void) | null = null

  constructor(config?: Partial<MergeVoiceConfig>) {
    this.config = { ...DEFAULT_MERGE_VOICE_CONFIG, ...config }
  }

  /** 设置 TTS 服务实例（由 AppRuntime 在初始化时调用） */
  setTtsService(service: TtsService): void {
    this.ttsService = service
  }

  /** 更新配置 */
  setConfig(config: Partial<MergeVoiceConfig>): void {
    this.config = { ...this.config, ...config }
    log('INFO', 'merge_voice_config_updated', {
      enabled: this.config.enabled,
      verboseSteps: this.config.verboseSteps,
    })
  }

  /** 获取当前配置 */
  getConfig(): MergeVoiceConfig {
    return { ...this.config }
  }

  /** 获取日志条目 */
  getLogEntries(): MergeLogEntry[] {
    return [...this.logEntries]
  }

  /** 注册日志更新回调（供壁纸使用） */
  setOnLogUpdate(cb: ((entry: MergeLogEntry, allEntries: MergeLogEntry[]) => void) | null): void {
    this.onLogUpdate = cb
  }

  /** 启用/禁用语音播报 */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    log('INFO', 'merge_voice_enabled', { enabled })
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /** 启动 EventBus 事件监听 */
  start(): void {
    if (this.started) return
    this.started = true
    this.subscribeToEvents()
    log('INFO', 'merge_voice_broadcast_started')
  }

  /** 停止事件监听 */
  stop(): void {
    this.subs.dispose()
    this.started = false
    this.logEntries = []
    log('INFO', 'merge_voice_broadcast_stopped')
  }

  // ═══════════════════════════════════════════
  //  EventBus 事件订阅
  // ═══════════════════════════════════════════

  /** 订阅所有 merge.* EventBus 事件 */
  private subscribeToEvents(): void {
    // 合并周期开始
    eventBus.track(
      'merge.cycle.started' as any,
      (payload: any) => {
        this.cycleStartedAt = Date.now()
        const gapCount = payload.scanResult?.gapsFound ?? 0
        const planSummary = payload.planSummary ?? ''

        this.addLogEntry('step', `合并周期开始，发现 ${gapCount} 个合并缺口`, planSummary)
        this.broadcastCycleStart(gapCount, planSummary)

        // 壁纸同步：推送合并状态（可选）
        if (this.config.wallpaperSync) {
          this.emitWallpaperEvent('merge.status', {
            status: 'running',
            totalGaps: gapCount,
            completedGaps: 0,
            failedGaps: 0,
            timestamp: Date.now(),
          })
        }
      },
      this.subs,
      'mvb:cycle_start',
    )

    // 缺口开始处理
    eventBus.track(
      'merge.gap.started' as any,
      (payload: any) => {
        const description = payload.description ?? ''
        const targetFile = payload.targetFile ?? ''

        this.addLogEntry('step', `开始处理: ${description}`, targetFile)
        if (this.config.verboseSteps) {
          this.broadcastGapStart(description, targetFile)
        }
      },
      this.subs,
      'mvb:gap_start',
    )

    // 缺口处理成功
    eventBus.track(
      'merge.gap.completed' as any,
      (payload: any) => {
        const description = payload.description ?? ''
        const status = payload.status ?? ''

        this.addLogEntry('success', `完成: ${description}`, status)
        if (this.config.verboseSteps) {
          this.broadcastGapSuccess(description)
        }
      },
      this.subs,
      'mvb:gap_success',
    )

    // 缺口处理失败
    eventBus.track(
      'merge.gap.failed' as any,
      (payload: any) => {
        const description = payload.description ?? ''
        const error = payload.error ?? ''
        const targetFile = payload.targetFile ?? ''

        this.addLogEntry('error', `失败: ${description}`, error)
        this.broadcastGapFailed(description, error, targetFile)
      },
      this.subs,
      'mvb:gap_failed',
    )

    // 冲突检测
    eventBus.track(
      'merge.gap.conflict' as any,
      (payload: any) => {
        const description = payload.description ?? ''
        const detail = payload.detail ?? ''
        const targetFile = payload.targetFile ?? ''

        this.addLogEntry('conflict', `冲突: ${description}`, detail)
        this.broadcastGapConflict(description, targetFile)
      },
      this.subs,
      'mvb:gap_conflict',
    )

    // 合并周期完成
    eventBus.track(
      'merge.cycle.completed' as any,
      (payload: any) => {
        const success = payload.success ?? false
        const summary = payload.summary ?? ''
        const totalFixed = payload.totalFixed ?? 0
        const totalFailed = payload.totalFailed ?? 0

        const durationMs = Date.now() - this.cycleStartedAt
        const durationStr = this.formatDuration(durationMs)

        this.addLogEntry(
          'summary',
          success
            ? `合并完成: 成功修复 ${totalFixed} 个${totalFailed > 0 ? `，${totalFailed} 个失败` : ''} (${durationStr})`
            : `合并失败: ${summary} (${durationStr})`,
        )
        this.broadcastCycleComplete(success, totalFixed, totalFailed, durationStr)

        // 壁纸同步（可选）
        if (this.config.wallpaperSync) {
          this.emitWallpaperEvent('merge.status', {
            status: success ? 'completed' : 'failed',
            totalFixed,
            totalFailed,
            durationMs,
            timestamp: Date.now(),
          })
        }
      },
      this.subs,
      'mvb:cycle_complete',
    )
  }

  // ═══════════════════════════════════════════
  //  手动播报方法（供直接调用，不依赖 EventBus）
  // ═══════════════════════════════════════════

  /** 播报合并周期开始 */
  async broadcastCycleStart(gapCount: number, planSummary: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = gapCount > 0
      ? `合并计划开始，发现 ${gapCount} 个需要合并的缺口。${planSummary}`
      : '合并扫描完成，未发现新的合并缺口。'
    await this.speak(text, this.config.stepVoice)
  }

  /** 播报缺口开始处理 */
  async broadcastGapStart(description: string, targetFile: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = `正在合并: ${description}`
    await this.speak(text, this.config.stepVoice)
  }

  /** 播报缺口处理成功 */
  async broadcastGapSuccess(description: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = `${description}，合并完成。`
    await this.speak(text, this.config.successVoice)
  }

  /** 播报缺口处理失败 */
  async broadcastGapFailed(description: string, error: string, targetFile: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = `合并失败: ${description}。${error ? `错误信息: ${error}` : '已自动回滚'}。`
    await this.speak(text, this.config.errorVoice)
  }

  /** 播报冲突警告 */
  async broadcastGapConflict(description: string, targetFile: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = `冲突警告: ${description}。文件 ${targetFile} 存在合并冲突，请手动处理。`
    await this.speak(text, this.config.errorVoice)
  }

  /** 播报合并周期完成总结 */
  async broadcastCycleComplete(success: boolean, totalFixed: number, totalFailed: number, duration: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    let text: string
    if (success && totalFailed === 0) {
      text = `合并全部完成，成功处理 ${totalFixed} 个缺口，耗时 ${duration}。`
    } else if (success && totalFailed > 0) {
      text = `合并完成。成功 ${totalFixed} 个，失败 ${totalFailed} 个，请检查失败项目，耗时 ${duration}。`
    } else {
      text = `合并执行失败，共 ${totalFixed + totalFailed} 个缺口未全部完成，请检查日志。`
    }
    await this.speak(text, this.config.summaryVoice)
  }

  /** 播报错误 */
  async broadcastError(error: string): Promise<void> {
    if (!this.config.enabled || !this.ttsService) return
    const text = `合并执行异常: ${error}`
    await this.speak(text, this.config.errorVoice)
  }

  // ═══════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════

  /** 调用 TTS 合成语音（带清理） */
  private async speak(text: string, voice: EmotionTtsParams): Promise<void> {
    if (!this.ttsService || !text.trim()) return

    try {
      // 暂时切换语音参数
      const prevEmotion = this.ttsService.getEmotionParams()
      this.ttsService.setEmotion(voice)
      await this.ttsService.speak(text)
      // 恢复原来的语音参数
      this.ttsService.setEmotion(prevEmotion)
    } catch (err: any) {
      log('WARN', 'merge_voice_speak_error', { error: String(err).slice(0, 100) })
    }
  }

  /** 添加日志条目并通知回调 */
  private addLogEntry(type: MergeLogEntry['type'], message: string, detail?: string): void {
    const entry: MergeLogEntry = {
      timestamp: Date.now(),
      type,
      message,
      detail,
    }
    this.logEntries.push(entry)
    this.onLogUpdate?.(entry, this.logEntries)
  }

  /** 发射壁纸事件（用于同步到桌面 overlay） */
  private emitWallpaperEvent(event: string, payload: Record<string, unknown>): void {
    try {
      eventBus.emit('wallpaper.config.changed' as any, {
        changes: [{ key: event, oldValue: null, newValue: payload }],
        timestamp: Date.now(),
      })
    } catch {
      // 壁纸事件发射失败不应影响核心功能
    }
  }

  /** 格式化耗时 */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} 毫秒`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes} 分 ${seconds} 秒`
  }
}
