/**
 * Plan:创业雷达 — 模块入口
 *
 * 创业雷达监听多个信息源，通过多维度评分算法筛选高价值创业机会信号，
 * 供 Telegram Bot 推送。本模块是 Wallpaper 算法模式的适配层。
 *
 * 使用方式：
 * ```ts
 * import { startupRadarAdapter } from './startup-radar'
 *
 * // 扫描信号
 * const result = await startupRadarAdapter.scan({
 *   sources: ['hackernews', 'github_trending'],
 *   keywords: ['AI', 'startup'],
 *   focusArea: 'developer tools',
 * })
 *
 * // Telegram 推送
 * const message = startupRadarAdapter.formatBatchForTelegram(result.signals)
 * ```
 */

export { StartupRadarAdapter, startupRadarAdapter } from './PlanStartupRadarAdapter'

export type {
  StartupSignal,
  StartupSignalCategory,
  SignalUrgency,
  SignalSource,
  SignalDimensionScores,
  StartupRadarSnapshot,
  RadarScanInput,
  RadarScanResult,
  TelegramFormatOptions,
  IStartupRadarProvider,
} from './types'
