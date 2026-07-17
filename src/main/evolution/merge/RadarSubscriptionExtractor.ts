/**
 * RadarSubscriptionExtractor — radar-bot 订阅数据提取器
 *
 * 从 radar-bot 系统中提取用户订阅列表和自定义参数，标准化为 RadarSubscription[]。
 *
 * ## 数据源优先级
 *
 * 1. Memory 中的已有偏好记录（来自 TelegramMemoryService 的 migrateLegacyData）
 * 2. 雷达适配器 POC 的默认配置
 * 3. 硬编码默认值（首次运行）
 *
 * ## 当前限制（POC 阶段）
 *
 * radar-bot 尚处于 POC 阶段，无真实数据库，订阅数据来源于：
 * - RadarScanInput 的默认参数（sources, keywords, focusArea）
 * - TelegramMemoryService 已迁移的偏好设置
 *
 * 未来对接真实数据库后，此提取器应扩展读取：
 * - SQLite/JSON 中的雷达用户配置表
 * - 雷达适配器持久化的扫描历史
 */

import { log } from '../../logger/Logger'
import type { RadarSubscription, RadarScanFrequency } from '../../telegram/subscription/types'
import { startupRadarAdapter } from '../../startup-radar/PlanStartupRadarAdapter'
import type { SignalSource } from '../../startup-radar/types'

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** 默认订阅 ID 前缀 */
const DEFAULT_SUBSCRIPTION_ID_PREFIX = 'radar_sub_default'

/** 默认订阅名称 */
const DEFAULT_SUBSCRIPTION_NAME = '创业雷达默认订阅'

/** 默认扫描源 */
const DEFAULT_SOURCES: SignalSource[] = ['hackernews', 'github_trending', '36kr']

/** 默认关键词 */
const DEFAULT_KEYWORDS: string[] = ['AI', 'startup', 'SaaS', '创业', '融资']

/** 默认关注领域 */
const DEFAULT_FOCUS_AREA = 'AI-powered developer tools'

/** 最低版本号 */
const SUBSCRIPTION_SCHEMA_VERSION = 1

// ════════════════════════════════════════════════════════════════
// ID 生成
// ════════════════════════════════════════════════════════════════

let idCounter = 0

function nextSubscriptionId(): string {
  return `${DEFAULT_SUBSCRIPTION_ID_PREFIX}_${Date.now()}_${++idCounter}`
}

// ════════════════════════════════════════════════════════════════
// 已存储的偏好 KV
// ════════════════════════════════════════════════════════════════

/**
 * 已存储的偏好映射。
 * 由外部传入，通常来自 MemoryService.getUserPreferences()。
 */
export interface StoredPreferences {
  [key: string]: string
}

// ════════════════════════════════════════════════════════════════
// 提取结果
// ════════════════════════════════════════════════════════════════

export interface ExtractResult {
  subscriptions: RadarSubscription[]
  source: 'memory_preferences' | 'radar_poc_config' | 'default'
  /** 提取时的环境描述 */
  context: string
}

// ════════════════════════════════════════════════════════════════
// RadarSubscriptionExtractor
// ════════════════════════════════════════════════════════════════

export class RadarSubscriptionExtractor {
  readonly name = 'radar-subscription-extractor'

  /**
   * 从 radar-bot 系统中提取订阅数据。
   *
   * 按优先级尝试三个数据源：
   * 1. Memory 中已有的偏好记录（用户之前设置过）
   * 2. 雷达适配器 POC 的缓存配置（适配器最近扫描用过的参数）
   * 3. 硬编码默认值（首次运行）
   *
   * @param storedPrefs 已有偏好映射（来自 MemoryService.getUserPreferences）
   * @returns 提取的订阅列表及来源标记
   */
  extract(storedPrefs?: StoredPreferences): ExtractResult {
    // ── 优先尝试从已有偏好重建 ──
    if (storedPrefs && Object.keys(storedPrefs).length > 0) {
      const fromPrefs = this.extractFromPreferences(storedPrefs)
      if (fromPrefs) {
        log('INFO', 'radar_sub_extracted_from_preferences', {
          count: fromPrefs.subscriptions.length,
        })
        return fromPrefs
      }
    }

    // ── 尝试从雷达适配器 POC 配置提取 ──
    const fromPoc = this.extractFromRadarPoc()
    if (fromPoc.subscriptions.length > 0) {
      log('INFO', 'radar_sub_extracted_from_poc', {
        count: fromPoc.subscriptions.length,
      })
      return fromPoc
    }

    // ── 回退到硬编码默认值 ──
    const defaults = this.createDefaultSubscriptions()
    log('INFO', 'radar_sub_extracted_defaults', {
      count: defaults.subscriptions.length,
    })
    return defaults
  }

  /**
   * 从已有偏好的 KV 映射重建订阅。
   * 兼容 TelegramMemoryService.migrateLegacyData() 写入的格式。
   */
  private extractFromPreferences(prefs: StoredPreferences): ExtractResult | null {
    const sourcesRaw = prefs['radar_sources'] || prefs['telegram_radar_sources']
    const keywordsRaw = prefs['radar_keywords'] || prefs['telegram_radar_keywords']
    const focusArea = prefs['radar_focus_area'] || prefs['telegram_radar_focus_area']
    const minScoreRaw = prefs['radar_min_score'] || prefs['telegram_radar_min_score']

    // 没有足够的偏好数据 → 返回 null 让上层尝试下一数据源
    if (!sourcesRaw && !keywordsRaw && !focusArea) return null

    const sources = sourcesRaw
      ? sourcesRaw.split(',').map((s: string) => s.trim()).filter(Boolean) as SignalSource[]
      : DEFAULT_SOURCES

    const keywords = keywordsRaw
      ? keywordsRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
      : DEFAULT_KEYWORDS

    const minScore = minScoreRaw ? parseFloat(minScoreRaw) : 0.3

    const subscription: RadarSubscription = {
      id: nextSubscriptionId(),
      name: DEFAULT_SUBSCRIPTION_NAME,
      sources,
      keywords,
      focusArea: focusArea || DEFAULT_FOCUS_AREA,
      minScore: isNaN(minScore) ? 0.3 : minScore,
      frequency: 'realtime',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    return {
      subscriptions: [subscription],
      source: 'memory_preferences',
      context: `从已有偏好重建（${sources.length} 个源，${keywords.length} 个关键词）`,
    }
  }

  /**
   * 从雷达适配器 POC 的配置提取。
   * 读取适配器最后一次 scan 调用的参数缓存。
   *
   * 当前 POC 阶段：读取适配器的 mock 数据源映射中的源列表。
   */
  private extractFromRadarPoc(): ExtractResult {
    const subscriptions: RadarSubscription[] = []

    // 读取 StartupRadarAdapter 的 mock 数据配置
    // POC 阶段，适配器内置了三个数据源：hackernews, github_trending, 36kr
    const pocSources: SignalSource[] = ['hackernews', 'github_trending', '36kr']

    // 创建主订阅（包含所有 POC 源）
    const mainSubscription: RadarSubscription = {
      id: nextSubscriptionId(),
      name: '创业雷达（POC）',
      sources: pocSources,
      keywords: DEFAULT_KEYWORDS,
      focusArea: DEFAULT_FOCUS_AREA,
      minScore: 0.3,
      frequency: 'realtime',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    subscriptions.push(mainSubscription)

    return {
      subscriptions,
      source: 'radar_poc_config',
      context: '从 POC 适配器配置提取（包含 3 个内置数据源）',
    }
  }

  /**
   * 创建硬编码的默认订阅（首次运行/无任何数据时使用）。
   */
  private createDefaultSubscriptions(): ExtractResult {
    const subscription: RadarSubscription = {
      id: nextSubscriptionId(),
      name: DEFAULT_SUBSCRIPTION_NAME,
      sources: DEFAULT_SOURCES,
      keywords: DEFAULT_KEYWORDS,
      focusArea: DEFAULT_FOCUS_AREA,
      minScore: 0.3,
      frequency: 'realtime',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    return {
      subscriptions: [subscription],
      source: 'default',
      context: '首次运行，创建默认订阅（3 个源，5 个关键词）',
    }
  }
}

/** 全局单例 */
export const radarSubscriptionExtractor = new RadarSubscriptionExtractor()
