/**
 * Plan:创业雷达 — 类型定义
 *
 * 创业雷达监听多个信息源（HackerNews、微博热搜、GitHub Trending、RSS等），
 * 通过多维度评分算法筛选出高价值的创业机会信号，供 Telegram Bot 推送。
 *
 * 设计原则（遵循 Wallpaper 领域类型风格）：
 * 1. 枚举类型使用受限联合类型（类比 WallpaperBehaviorSnapshot 的 mode/context）
 * 2. 评分维度使用 0-1 归一化值
 * 3. 提供者契约使用接口抽象
 */

// ════════════════════════════════════════════════════════════════
// 创业雷达信号类型
// ════════════════════════════════════════════════════════════════

/**
 * 信号类别（类比 Wallpaper 的 appCategory 分类）。
 * 每条创业信号归属一个主要类别。
 */
export type StartupSignalCategory =
  | 'market_trend'      // 市场趋势（行业增长、新兴市场）
  | 'competitor'        // 竞品动态（新品发布、融资、战略调整）
  | 'funding'           // 投融资事件（融资轮次、金额、投资方）
  | 'technology'        // 技术突破（开源项目、论文、新产品）
  | 'policy'            // 政策法规（监管变化、扶持政策）
  | 'talent'            // 人才流动（高管变动、团队扩张）
  | 'consumer_demand'   // 消费需求（用户行为变化、新兴需求）

/**
 * 信号紧急程度（类比 Wallpaper 的 activityState: 'active'|'idle'|'away'）。
 * 决定 Telegram Bot 的推送优先级和展示样式。
 */
export type SignalUrgency = 'hot' | 'warm' | 'cold'

/**
 * 信号来源（类比 Wallpaper 的 appCategory 分类方式）。
 */
export type SignalSource =
  | 'hackernews'
  | 'weibo_hot'
  | 'github_trending'
  | 'bilibili'
  | 'douyin'
  | 'rss'
  | 'crunchbase'
  | '36kr'
  | 'other'

// ════════════════════════════════════════════════════════════════
// 评分维度
// ════════════════════════════════════════════════════════════════

/**
 * 各维度的信号评分（类比 Wallpaper 的 DimensionScores 和 MemoryContextService 的多维评分）。
 *
 * 每个维度值域 [0, 1]，值越高表示该维度质量越好。
 */
export interface SignalDimensionScores {
  /** 相关性 (0-1) — 信号与创业方向的匹配程度 */
  relevance: number
  /** 时效性 (0-1) — 信号的及时程度（越新越高） */
  timeliness: number
  /** 影响潜力 (0-1) — 信号可能带来的商业影响 */
  impact: number
  /** 置信度 (0-1) — 信号来源可信度和数据质量 */
  confidence: number
  /** 可落地性 (0-1) — 信号转化为行动的可能性 */
  actionability: number
}

// ════════════════════════════════════════════════════════════════
// 核心数据模型
// ════════════════════════════════════════════════════════════════

/**
 * 创业信号条目（类比 Wallpaper 的 MemoryCardItem）。
 * 包含一条创业机会信号的完整信息。
 */
export interface StartupSignal {
  /** 信号 ID */
  id: string
  /** 信号类别 */
  category: StartupSignalCategory
  /** 信号标题 */
  title: string
  /** 信号摘要 */
  summary: string
  /** 来源 */
  source: SignalSource
  /** 原始链接（如果有） */
  url?: string
  /** 各维度评分 */
  scores: SignalDimensionScores
  /** 复合评分 (0-1) */
  compositeScore: number
  /** 紧急程度 */
  urgency: SignalUrgency
  /** 是否已推送 */
  pushed: boolean
  /** 关联标签 */
  tags: string[]
  /** 创建时间戳 */
  createdAt: number
  /** 过期时间戳（超时后不再推送） */
  expiresAt: number
}

/**
 * 创业雷达快照（类比 Wallpaper 的 WallpaperBehaviorSnapshot）。
 * 包含某一时刻的完整信号集合和统计信息。
 */
export interface StartupRadarSnapshot {
  /** 信号列表 */
  signals: StartupSignal[]
  /** 快照创建时间 */
  timestamp: number
  /** 信号总数 */
  totalSignals: number
  /** 高风险信号数（hot） */
  hotCount: number
  /** 中风险信号数（warm） */
  warmCount: number
  /** 已推送数 */
  pushedCount: number
  /** 综合热度评分 (0-1) */
  compositeHeatIndex: number
  /** 错误信息（如果有） */
  error?: string
}

// ════════════════════════════════════════════════════════════════
// 输入/输出类型
// ════════════════════════════════════════════════════════════════

/**
 * 雷达扫描输入（类比 Wallpaper 的 EnrichedBehaviorState）。
 * 接收来自各个信息源的原始数据。
 */
export interface RadarScanInput {
  /** 要扫描的信息源列表 */
  sources: SignalSource[]
  /** 关键词过滤（可选，OR 匹配） */
  keywords?: string[]
  /** 每个源最大返回条数 */
  limit?: number
  /** 创业方向/领域（用于计算相关性） */
  focusArea?: string
  /** 最小复合评分阈值（0-1，低于此值不返回，默认 0.3） */
  minScore?: number
}

/**
 * 创业雷达扫描结果（类比 Wallpaper 的 MemoryContextPayload）。
 * 适配器处理后返回的结构化数据。
 */
export interface RadarScanResult {
  /** 信号列表（按复合评分降序） */
  signals: StartupSignal[]
  /** 扫描时间 */
  timestamp: number
  /** 扫描覆盖的源数量 */
  sourceCount: number
  /** 返回的信号总数 */
  totalSignals: number
  /** 紧急信号数（hot + warm） */
  urgentCount: number
  /** 综合热度评分 */
  compositeHeatIndex: number
  /** 源 → 信号数映射 */
  sourceDistribution: Record<string, number>
  /** 类别 → 信号数映射 */
  categoryDistribution: Record<string, number>
  /** 错误信息（如果有） */
  error?: string
}

/**
 * 格式化选项（类比 WechatFormatOptions，用于 Telegram Bot 推送格式）。
 */
export interface TelegramFormatOptions {
  /** 是否附带详细信息 */
  detailed?: boolean
  /** 每条信号的最大标题长度 */
  maxTitleLength?: number
  /** 是否包含评分 */
  showScores?: boolean
  /** 是否包含来源标签 */
  showSource?: boolean
  /** 是否包含链接 */
  showUrl?: boolean
}

// ════════════════════════════════════════════════════════════════
// 提供者契约 — 类比 Wallpaper 的 IBehaviorProvider
// ════════════════════════════════════════════════════════════════

/**
 * 创业雷达提供者契约。
 *
 * 类比 Wallpaper 的 IBehaviorProvider：
 * - IBehaviorProvider.getBehaviorSnapshot() → WallpaperBehaviorSnapshot
 * - IStartupRadarProvider.scan() → RadarScanResult
 *
 * 插件实现方（如 Plan:创业雷达 Telegram Bot）通过此契约消费雷达数据，
 * 不关心适配层的内部实现。
 */
export interface IStartupRadarProvider {
  /** 提供者标识 */
  readonly name: string

  /**
   * 执行雷达扫描，返回结构化的创业信号。
   * @param input 扫描参数（信号源、关键词、过滤条件）
   * @returns 扫描结果或 null（数据不足时返回 null）
   */
  scan(input: RadarScanInput): Promise<RadarScanResult | null>

  /**
   * 获取当前缓存的雷达快照。
   * @returns 最近一次扫描的快照，或 null
   */
  getLastSnapshot(): StartupRadarSnapshot | null

  /**
   * 订阅新信号就绪通知。
   * @param callback 新信号就绪时的回调
   * @returns 取消订阅函数
   */
  onSignalsReady(callback: (result: RadarScanResult) => void): () => void

  /**
   * 格式化信号为 Telegram 消息。
   * @param signal 要格式化的信号
   * @param options 格式化选项
   * @returns 格式化后的文本
   */
  formatForTelegram(signal: StartupSignal, options?: TelegramFormatOptions): string
}
