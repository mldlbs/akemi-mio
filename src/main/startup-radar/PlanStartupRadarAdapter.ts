/**
 * PlanStartupRadarAdapter — Wallpaper 算法 → Plan:创业雷达 Telegram Bot 适配层
 *
 * ── 设计哲学 ──
 * 提取 Wallpaper 系统的核心算法模式，为「Plan:创业雷达 Telegram Bot 开发」
 * 上下文实现兼容适配层。复用不追求 1:1 精确移植，而是保留算法核心逻辑并用
 * Plan 上下文的数据格式做输入输出转换。
 *
 * ── 复用的 Wallpaper 算法模式 ──
 *
 * 1. Composite Scoring Algorithm（来自 MemoryContextService）
 *    - 原始：behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *    - 适配：relevance * 0.30 + timeliness * 0.25 + impact * 0.25 +
 *            confidence * 0.12 + actionability * 0.08
 *
 * 2. Plugin Adapter Pattern（来自 UserBehaviorPluginAdapter）
 *    - 将源系统（Observer/RadarTools）包装为标准化的契约接口
 *    - 输入输出数据类型转换（↔ normalized snapshot）
 *    - 可选的订阅/通知机制
 *
 * 3. Behavior Snapshot Normalization（来自 UserBehaviorPluginAdapter）
 *    - 将原始输入映射到受限的联合类型域
 *    - 数据完整和 default fallback
 *
 * ── 架构关系 ──
 *   Plan:创业雷达 Telegram Bot（调用方 / TelegramService）
 *       ↓
 *   StartupRadarAdapter (this class)
 *       ↓  delegates to
 *   Observer Service / RadarTools（基础数据采集）
 *       ↓
 *   Wallpaper 算法模式复用（CompositeScore, Normalize, Adapter）
 *
 * ── 使用示例 ──
 * ```ts
 * import { startupRadarAdapter } from './startup-radar/PlanStartupRadarAdapter'
 *
 * // POC — 单次扫描
 * const result = await startupRadarAdapter.scan({
 *   sources: ['hackernews', 'github_trending'],
 *   keywords: ['AI', 'startup', 'SaaS'],
 *   focusArea: 'AI-powered developer tools',
 * })
 * // result.signals[] — 评分排序后的信号列表
 * // result.compositeHeatIndex — 综合热度
 *
 * // Telegram 格式化
 * for (const signal of result.signals) {
 *   const msg = startupRadarAdapter.formatForTelegram(signal)
 *   // → "🔥 [市场趋势] AI Coding 助手获 5000 万美元 B 轮融资\n评分: 0.85 | 来源: hackernews"
 * }
 * ```
 */

import { log } from '../logger/Logger'
import type {
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

// ════════════════════════════════════════════════════════════════
// 信号 ID 生成
// ════════════════════════════════════════════════════════════════

let signalIdCounter = 0

function nextSignalId(): string {
  return `sr_${Date.now()}_${++signalIdCounter}`
}

// ════════════════════════════════════════════════════════════════
// 复合评分算法 — 复用 Wallpaper MemoryContextService 的评分模式
// ════════════════════════════════════════════════════════════════

/**
 * 维度评分权重。
 * 对应 MemoryContextService 的评分权重：
 *   behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配后权重（创业雷达场景）：
 *   relevance * 0.30 + timeliness * 0.25 + impact * 0.25 +
 *   confidence * 0.12 + actionability * 0.08
 *
 * 权重设计思路：
 * - 相关性和影响力权重最高（决定信号是否值得关注）
 * - 时效性次之（创业机会窗口很重要但非决定因素）
 * - 置信度和可落地性作为调节因子
 */
const SIGNAL_SCORE_WEIGHTS = {
  relevance: 0.30,
  timeliness: 0.25,
  impact: 0.25,
  confidence: 0.12,
  actionability: 0.08,
} as const

/**
 * 来源信誉加分（类比 MemoryContextService 的 pinnedBonus）。
 * 信誉好的源额外加分。
 */
const SOURCE_REPUTATION_BONUS: Partial<Record<SignalSource, number>> = {
  hackernews: 0.03,
  github_trending: 0.02,
  crunchbase: 0.05,
  '36kr': 0.03,
}

/**
 * 类别紧急度加分（类比 MemoryContextService 的 recencyBonus）。
 * 某些类别天然具有更高优先级。
 */
const CATEGORY_URGENCY_BONUS: Partial<Record<StartupSignalCategory, number>> = {
  funding: 0.05,
  competitor: 0.04,
  policy: 0.03,
}

/**
 * 复合评分计算器 — 适配自 Wallpaper MemoryContextService 的 composite score。
 *
 * 原始算法（MemoryContextService）：
 *   compositeScore = behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配算法（创业雷达）：
 *   signalScore = relevance * 0.30 + timeliness * 0.25 + impact * 0.25 +
 *                 confidence * 0.12 + actionability * 0.08
 *                 + sourceReputationBonus  ← 来源信誉加分（类比 pinnedBonus）
 *                 + categoryUrgencyBonus   ← 类别紧急加分（类比 recencyBonus）
 *
 * 阈值映射：
 *   compositeScore >= 0.7 → hot（紧急推送）
 *   compositeScore >= 0.4 → warm（普通推送）
 *   compositeScore < 0.4  → cold（暂不推送）
 */
function computeCompositeScore(
  scores: SignalDimensionScores,
  source: SignalSource,
  category: StartupSignalCategory,
): number {
  const baseScore =
    scores.relevance * SIGNAL_SCORE_WEIGHTS.relevance +
    scores.timeliness * SIGNAL_SCORE_WEIGHTS.timeliness +
    scores.impact * SIGNAL_SCORE_WEIGHTS.impact +
    scores.confidence * SIGNAL_SCORE_WEIGHTS.confidence +
    scores.actionability * SIGNAL_SCORE_WEIGHTS.actionability

  // sourceReputationBonus：类比 pinnedBonus
  const repBonus = SOURCE_REPUTATION_BONUS[source] ?? 0

  // categoryUrgencyBonus：类比 recencyBonus
  const catBonus = CATEGORY_URGENCY_BONUS[category] ?? 0

  return Math.min(1, Math.max(0, baseScore + repBonus + catBonus))
}

/**
 * 复合评分 → 紧急程度映射。
 *
 * 类比 PlanSonggeCorrectionAdapter.computeSeverity() 的阈值映射：
 *   compositeScore < 0.4 → critical/major → hot
 *   compositeScore < 0.6 → minor          → warm
 *   compositeScore >= 0.6 → info           → cold
 */
function computeUrgency(compositeScore: number): SignalUrgency {
  if (compositeScore >= 0.7) return 'hot'
  if (compositeScore >= 0.4) return 'warm'
  return 'cold'
}

// ════════════════════════════════════════════════════════════════
// 维度评分函数 — 类比 Wallpaper 的 normalizeMode/normalizeContext
// ════════════════════════════════════════════════════════════════

/**
 * 评估相关性。
 * 根据关键词匹配度和领域相关性计算信号与创业方向的匹配程度。
 *
 * 类比 UserBehaviorPluginAdapter.normalizeMode()：
 *   normalizeMode() 将 string 映射到受限的联合类型
 *   本函数将文本分析结果映射到 [0, 1] 评分区间
 */
function evaluateRelevance(
  title: string,
  summary: string,
  category: StartupSignalCategory,
  focusArea?: string,
): number {
  if (!title && !summary) return 0.3

  const text = `${title} ${summary}`.toLowerCase()
  let score = 0.5 // 基础分

  // 创业领域通用关键词
  const startupKeywords = [
    'startup', '创业', '融资', '投资', 'funding', 'series', 'venture',
    'launch', '推出', '发布', '新产品', 'platform', 'SaaS', 'AI',
    'B2B', 'marketplace', 'subscription', 'growth', '增长',
  ]
  for (const kw of startupKeywords) {
    if (text.includes(kw)) { score += 0.03 }
  }

  // 特定创业方向关键词匹配（如果指定了 focusArea）
  if (focusArea) {
    const areaWords = focusArea.toLowerCase().split(/[\s,，、]+/).filter(w => w.length >= 2)
    const matchCount = areaWords.filter(w => text.includes(w)).length
    if (areaWords.length > 0) {
      score += (matchCount / areaWords.length) * 0.2
    }
  }

  // 类别相关性
  const categoryBoost: Record<StartupSignalCategory, number> = {
    market_trend: 0.10,
    competitor: 0.08,
    funding: 0.12,
    technology: 0.08,
    policy: 0.05,
    talent: 0.03,
    consumer_demand: 0.10,
  }
  score += categoryBoost[category] ?? 0.05

  return Math.min(1, score)
}

/**
 * 评估时效性。
 * 根据当前时间和信号创建时间的差值计算新鲜度。
 *
 * 类比 Wallpaper 的 recencyBonus 时间衰减逻辑：
 *   越接近当前时间的信号，时效性评分越高
 */
function evaluateTimeliness(createdAt?: number): number {
  if (!createdAt) return 0.5 // 无时间戳，中值

  const ageHours = (Date.now() - createdAt) / (1000 * 3600)

  // 指数衰减：6 小时内新鲜，24 小时后快速衰减，72 小时后基本无关
  if (ageHours <= 6) return 0.95
  if (ageHours <= 12) return 0.85
  if (ageHours <= 24) return 0.70
  if (ageHours <= 48) return 0.50
  if (ageHours <= 72) return 0.30
  return 0.10
}

/**
 * 评估影响潜力。
 * 根据内容中的影响力信号词判断。
 */
function evaluateImpact(title: string, summary: string): number {
  const text = `${title} ${summary}`.toLowerCase()
  let score = 0.4

  // 高影响信号
  const highImpact = [
    'million', 'billion', '亿', '千万', '万美', '融资', 'funding',
    'acquisition', '收购', 'IPO', '上市', '独角兽', 'unicorn',
    'regulation', '监管', 'policy', '政策',
  ]
  for (const kw of highImpact) {
    if (text.includes(kw)) { score += 0.08; break }
  }

  // 中影响信号
  const mediumImpact = [
    'launch', '推出', '发布', 'release', 'partnership', '合作',
    'expansion', '扩张', 'growth', '增长', 'hiring', '招聘',
  ]
  for (const kw of mediumImpact) {
    if (text.includes(kw)) { score += 0.04; break }
  }

  // 根据信号文本长度判断信息密度（太短的可能内容不充分）
  if (text.length >= 200) score += 0.05
  else if (text.length >= 100) score += 0.02

  return Math.min(1, score)
}

/**
 * 评估置信度。
 * 信号来源可信度和数据完整性。
 *
 * 类比 UserBehaviorPluginAdapter.normalizeContext() 的枚举映射。
 */
function evaluateConfidence(source: SignalSource, hasUrl: boolean, textLength: number): number {
  // 来源可信度
  const sourceTrust: Partial<Record<SignalSource, number>> = {
    hackernews: 0.80,
    github_trending: 0.85,
    crunchbase: 0.90,
    '36kr': 0.75,
    rss: 0.70,
    weibo_hot: 0.50,
    bilibili: 0.45,
    douyin: 0.40,
    other: 0.50,
  }

  let score = sourceTrust[source] ?? 0.50

  // 有 URL 链接增加可信度
  if (hasUrl) score += 0.10

  // 文本长度反映信息完整性
  if (textLength >= 200) score += 0.05
  else if (textLength < 30) score -= 0.10

  return Math.min(1, Math.max(0.1, score))
}

/**
 * 评估可落地性。
 * 判断信号是否包含可操作的具体信息。
 */
function evaluateActionability(title: string, summary: string): number {
  const text = `${title} ${summary}`.toLowerCase()
  let score = 0.3

  // 包含具体数字或指标
  const hasNumbers = /\d+/.test(text)
  if (hasNumbers) score += 0.15

  // 包含可操作关键词
  const actionKeywords = [
    'apply', '申请', 'register', '注册', 'sign up', '报名',
    'download', '下载', 'try', '试用', 'demo', '演示',
    'open source', '开源', 'API', 'SDK', 'tutorial', '教程',
    'funding', '融资', 'invest', '投资',
  ]
  for (const kw of actionKeywords) {
    if (text.includes(kw)) { score += 0.05; break }
  }

  // 有明确的时间或地点
  const hasDate = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)
  if (hasDate) score += 0.10

  return Math.min(1, score)
}

// ════════════════════════════════════════════════════════════════
// 分类器 — 类比 Wallpaper 的 ContentClassifierPlugin
// ════════════════════════════════════════════════════════════════

/**
 * 根据内容自动分类创业信号类别。
 *
 * 类比 Wallpaper 的 ContentClassifierPlugin：
 *   ContentClassifierPlugin 通过关键词和模式匹配对用户输入分类
 *   本函数通过关键词匹配对创业信号分类
 */
function classifyCategory(title: string, summary: string, source: SignalSource): StartupSignalCategory {
  const text = `${title} ${summary}`.toLowerCase()

  // 按优先级检测
  if (/(融资|funding|series [ab]|invest|投资|raised|筹)/.test(text)) return 'funding'
  if (/(收购|acquisition|acquired|并购|竞品|competitor|vs|versus)/.test(text)) return 'competitor'
  if (/(监管|policy|regulation|合规|compliance|法律|legal|法案)/.test(text)) return 'policy'
  if (/(开源|open source|github|发布|launch|release|新品|新产品)/.test(text)) return 'technology'
  if (/(招聘|hiring|加入|高管|CEO|CTO|离职|resign)/.test(text)) return 'talent'
  if (/(需求|demand|趋势|trend|增长|growth|用户|users|customer)/.test(text)) return 'consumer_demand'
  if (/(市场|market|行业|industry|赛道)/.test(text)) return 'market_trend'

  // 根据来源归类
  if (source === 'github_trending') return 'technology'
  if (source === 'crunchbase') return 'funding'
  if (source === '36kr') return 'market_trend'

  // 默认
  return 'market_trend'
}

// ════════════════════════════════════════════════════════════════
// StartupRadarAdapter — 核心适配器类
// ════════════════════════════════════════════════════════════════

/**
 * StartupRadarAdapter — 实现 IStartupRadarProvider 契约。
 *
 * 类比 UserBehaviorPluginAdapter：
 *   - UserBehaviorPluginAdapter 包装 UserBehaviorService → WallpaperBehaviorSnapshot
 *   - StartupRadarAdapter 包装 数据采集层 → RadarScanResult
 *
 * 内部使用 Wallpaper 算法模式：
 *   1. Composite Scoring（来自 MemoryContextService）
 *   2. Normalization（来自 UserBehaviorPluginAdapter.normalize*）
 *   3. Subscription/Notification（来自 UserBehaviorPluginAdapter.onBehaviorChange）
 */
export class StartupRadarAdapter implements IStartupRadarProvider {
  readonly name = 'startup-radar-adapter'

  /** 订阅者集合（类比 UserBehaviorPluginAdapter.subscribers） */
  private subscribers = new Set<(result: RadarScanResult) => void>()

  /** 最近一次扫描结果缓存 */
  private lastSnapshot: StartupRadarSnapshot | null = null

  /**
   * 执行雷达扫描 — 将原始数据适配为结构化的创业信号。
   *
   * 类比 UserBehaviorPluginAdapter.getBehaviorSnapshot()：
   *   - 收集源数据（UserBehavior state → RadarScanInput）
   *   - 转换为标准化格式（WallpaperBehaviorSnapshot → StartupSignal）
   *   - 应用评分算法（composite score）
   *
   * POC 阶段：使用内置关键词评分和分类逻辑。
   * 全量阶段：对接 Observer Service 的 RadarTools 进行真实数据采集。
   */
  async scan(input: RadarScanInput): Promise<RadarScanResult | null> {
    try {
      const { sources, keywords, limit = 20, focusArea, minScore = 0.3 } = input

      if (!sources || sources.length === 0) {
        log('WARN', 'startup_radar_empty_sources')
        return null
      }

      // POC 阶段：收集原始数据（先做关键词匹配，后续对接 RadarTools）
      const rawItems = await this.collectRawData(sources, keywords, limit)

      if (!rawItems || rawItems.length === 0) {
        log('WARN', 'startup_radar_no_data', { sources })
        return null
      }

      // 1. 分类 & 评分（Wallpaper 算法核心 — 复用 MemoryContextService 评分模式）
      const signals: StartupSignal[] = []
      const sourceDist: Record<string, number> = {}
      const categoryDist: Record<string, number> = {}

      for (const item of rawItems) {
        const category = classifyCategory(item.title, item.summary, item.source)
        const scores: SignalDimensionScores = {
          relevance: evaluateRelevance(item.title, item.summary, category, focusArea),
          timeliness: evaluateTimeliness(item.createdAt),
          impact: evaluateImpact(item.title, item.summary),
          confidence: evaluateConfidence(item.source, !!item.url, item.summary.length),
          actionability: evaluateActionability(item.title, item.summary),
        }

        const compositeScore = computeCompositeScore(scores, item.source, category)

        // 过滤低于阈值的信号
        if (compositeScore < minScore) continue

        const urgency = computeUrgency(compositeScore)

        const signal: StartupSignal = {
          id: nextSignalId(),
          category,
          title: item.title,
          summary: item.summary,
          source: item.source,
          url: item.url,
          scores,
          compositeScore,
          urgency,
          pushed: false,
          tags: this.extractTags(item.title, item.summary, category),
          createdAt: item.createdAt ?? Date.now(),
          expiresAt: Date.now() + 24 * 3600 * 1000, // 24 小时过期
        }

        signals.push(signal)

        // 统计
        sourceDist[item.source] = (sourceDist[item.source] ?? 0) + 1
        categoryDist[category] = (categoryDist[category] ?? 0) + 1
      }

      if (signals.length === 0) {
        log('INFO', 'startup_radar_all_filtered', {
          rawCount: rawItems.length,
          minScore,
        })
        return {
          signals: [],
          timestamp: Date.now(),
          sourceCount: Object.keys(sourceDist).length,
          totalSignals: 0,
          urgentCount: 0,
          compositeHeatIndex: 0,
          sourceDistribution: sourceDist,
          categoryDistribution: categoryDist,
        }
      }

      // 2. 按复合评分降序排列
      signals.sort((a, b) => b.compositeScore - a.compositeScore)

      // 3. 计算统计
      const hotCount = signals.filter(s => s.urgency === 'hot').length
      const warmCount = signals.filter(s => s.urgency === 'warm').length
      const avgScore = signals.reduce((s, sig) => s + sig.compositeScore, 0) / signals.length

      const result: RadarScanResult = {
        signals,
        timestamp: Date.now(),
        sourceCount: Object.keys(sourceDist).length,
        totalSignals: signals.length,
        urgentCount: hotCount + warmCount,
        compositeHeatIndex: avgScore,
        sourceDistribution: sourceDist,
        categoryDistribution: categoryDist,
      }

      // 更新快照缓存
      this.lastSnapshot = {
        signals: [...signals],
        timestamp: Date.now(),
        totalSignals: signals.length,
        hotCount,
        warmCount,
        pushedCount: 0,
        compositeHeatIndex: avgScore,
      }

      log('INFO', 'startup_radar_scan_completed', {
        sources: sources.join(','),
        totalSignals: signals.length,
        hotCount,
        warmCount,
        avgScore: avgScore.toFixed(3),
        topCategory: Object.entries(categoryDist).sort((a, b) => b[1] - a[1])[0]?.[0],
      })

      // 通知订阅者
      this.notify(result)

      return result
    } catch (err: any) {
      log('WARN', 'startup_radar_scan_failed', { error: String(err) })
      return {
        signals: [],
        timestamp: Date.now(),
        sourceCount: 0,
        totalSignals: 0,
        urgentCount: 0,
        compositeHeatIndex: 0,
        sourceDistribution: {},
        categoryDistribution: {},
        error: String(err),
      }
    }
  }

  /** 获取缓存的雷达快照 */
  getLastSnapshot(): StartupRadarSnapshot | null {
    return this.lastSnapshot
  }

  /**
   * 订阅信号就绪通知（类比 UserBehaviorPluginAdapter.onBehaviorChange）。
   */
  onSignalsReady(callback: (result: RadarScanResult) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  /**
   * 通知所有订阅者（类比 UserBehaviorPluginAdapter.notify）。
   */
  private notify(result: RadarScanResult): void {
    for (const cb of this.subscribers) {
      try {
        cb(result)
      } catch {
        // 单个订阅者失败不影响其他订阅者
      }
    }
  }

  /**
   * 格式化信号为 Telegram 消息。
   *
   * 类比 PlanSonggeCorrectionAdapter 的格式化输出逻辑：
   *   将结构化数据转换为人类可读的文本
   *
   * Telegram Bot 直接调用此方法获取推送内容。
   */
  formatForTelegram(signal: StartupSignal, options?: TelegramFormatOptions): string {
    const {
      detailed = false,
      showScores = true,
      showSource = true,
      showUrl = true,
    } = options ?? {}

    const urgencyEmoji: Record<SignalUrgency, string> = {
      hot: '🔥',
      warm: '⚡',
      cold: '💤',
    }

    const categoryLabel: Record<StartupSignalCategory, string> = {
      market_trend: '市场趋势',
      competitor: '竞品动态',
      funding: '投融资',
      technology: '技术突破',
      policy: '政策法规',
      talent: '人才流动',
      consumer_demand: '消费需求',
    }

    const sourceLabel: Record<SignalSource, string> = {
      hackernews: 'HN',
      weibo_hot: '微博',
      github_trending: 'GitHub',
      bilibili: 'B站',
      douyin: '抖音',
      rss: 'RSS',
      crunchbase: 'Crunchbase',
      '36kr': '36氪',
      other: '其他',
    }

    const lines: string[] = [
      `${urgencyEmoji[signal.urgency]} [${categoryLabel[signal.category]}] ${signal.title}`,
    ]

    if (detailed && signal.summary) {
      lines.push(`  ${signal.summary.slice(0, 200)}`)
    }

    const metaParts: string[] = []
    if (showScores) {
      metaParts.push(`评分: ${(signal.compositeScore * 100).toFixed(0)}`)
    }
    if (showSource) {
      metaParts.push(`来源: ${sourceLabel[signal.source]}`)
    }
    if (signal.url && showUrl) {
      metaParts.push(`链接: ${signal.url}`)
    }
    if (metaParts.length > 0) {
      lines.push(`  ${metaParts.join(' | ')}`)
    }

    if (detailed && signal.tags.length > 0) {
      lines.push(`  🏷 ${signal.tags.slice(0, 5).join(', ')}`)
    }

    return lines.join('\n')
  }

  /**
   * 批量格式化信号为 Telegram 消息（适合一次推送多条）。
   *
   * POC 验证用 — TelegramService 可直接使用此方法生成推送内容。
   */
  formatBatchForTelegram(signals: StartupSignal[], options?: TelegramFormatOptions): string {
    if (signals.length === 0) return '📡 创业雷达扫描完成，暂无高价值信号'

    const lines: string[] = [
      '📡 **创业雷达 — 信号报告**',
      `━━━ ${signals.length} 条新信号 ━━━`,
      '',
    ]

    for (const signal of signals) {
      lines.push(this.formatForTelegram(signal, options))
      lines.push('')
    }

    // 统计概览
    const hotCount = signals.filter(s => s.urgency === 'hot').length
    const warmCount = signals.filter(s => s.urgency === 'warm').length
    const categories = [...new Set(signals.map(s => s.category))]
    const catLabels = categories.map(c => {
      const label: Record<StartupSignalCategory, string> = {
        market_trend: '市场', competitor: '竞品', funding: '融资',
        technology: '技术', policy: '政策', talent: '人才', consumer_demand: '需求',
      }
      return label[c] ?? c
    })

    lines.push(`━━━ 📊 概览 ━━━`)
    if (hotCount > 0) lines.push(`🔥 ${hotCount} 条紧急`)
    if (warmCount > 0) lines.push(`⚡ ${warmCount} 条关注`)
    lines.push(`📂 覆盖: ${catLabels.join('、')}`)

    return lines.join('\n')
  }

  /** 重置缓存 */
  clearCache(): void {
    this.lastSnapshot = null
  }

  // ════════════════════════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════════════════════════

  /**
   * 采集原始数据。
   *
   * POC 阶段：返回伪数据用于验证适配层逻辑。
   * 全量阶段：对接 Observer Service / RadarTools 进行真实采集。
   *
   * 类比 UserBehaviorPluginAdapter 对 UserBehavior 的代理调用。
   */
  private async collectRawData(
    sources: SignalSource[],
    keywords?: string[],
    limit?: number,
  ): Promise<RawDataItem[]> {
    // ── POC 阶段：返回模拟数据 ──

    const allItems: RawDataItem[] = []

    // 声明 POC 数据内联，避免外部依赖
    const mockData: RawDataMap = {
      hackernews: [
        { title: 'Show HN: 基于 AI 的代码审查助手开源发布', summary: '一个使用大语言模型自动审查 Pull Request 的开源工具，支持 GitHub 和 GitLab 集成，已获得 2000+ star', url: 'https://news.ycombinator.com/item?id=example1' },
        { title: 'YC W25 批量申请启动，AI + SaaS 方向项目激增', summary: 'Y Combinator 2025 冬季批次收到创纪录的申请量，其中 AI-powered SaaS 工具占比超过 40%', url: 'https://news.ycombinator.com/item?id=example2' },
        { title: 'Cursor IDE 获 6000 万美元 B 轮融资', summary: 'AI 编程助手 Cursor 完成 6000 万美元 B 轮融资，估值达 4 亿美元，由 a16z 领投', url: 'https://news.ycombinator.com/item?id=example3' },
      ],
      github_trending: [
        { title: 'n8n — 开源工作流自动化工具持续增长', summary: 'n8n 本周 GitHub Star 突破 5 万，企业级工作流自动化领域开源替代 Zapier 的最佳选择', url: 'https://github.com/n8n-io/n8n' },
        { title: 'LangChain v0.3 发布：Agent 框架重大升级', summary: 'LangChain 发布 v0.3，引入全新的 Agent Executor 架构和更简单的工具定义 API', url: 'https://github.com/langchain-ai/langchain' },
      ],
      '36kr': [
        { title: '2025 年 Q2 中国 SaaS 市场融资报告：AIGC 赛道占比超六成', summary: '2025 年 Q2 中国 SaaS 行业共完成 127 笔融资，总金额超 85 亿元人民币，AIGC 相关项目占比 62%', url: 'https://36kr.com/p/example1' },
        { title: '低代码平台「轻流」完成 5 亿元 C 轮融资', summary: '低代码开发平台轻流宣布完成 5 亿元人民币 C 轮融资，由红杉中国领投，估值达 30 亿元', url: 'https://36kr.com/p/example2' },
      ],
    }

    for (const source of sources) {
      const sourceData = mockData[source] ?? []
      const capped = keywords
        ? sourceData.filter(item =>
            keywords.some(kw => item.title.includes(kw) || item.summary.includes(kw)),
          ).slice(0, limit)
        : sourceData.slice(0, limit)

      for (const item of capped) {
        allItems.push({
          title: item.title,
          summary: item.summary,
          source,
          url: item.url,
          createdAt: Date.now() - Math.random() * 12 * 3600 * 1000, // 0-12小时前
        })
      }
    }

    return allItems
  }

  /**
   * 从信号内容中提取标签。
   *
   * 类比 Wallpaper MemoryContextService 的话题标签提取。
   */
  private extractTags(title: string, summary: string, category: StartupSignalCategory): string[] {
    const text = `${title} ${summary}`
    const tags: string[] = []

    // 类别标签
    const categoryTag: Record<StartupSignalCategory, string> = {
      market_trend: '市场',
      competitor: '竞品',
      funding: '融资',
      technology: '技术',
      policy: '政策',
      talent: '人才',
      consumer_demand: '需求',
    }
    tags.push(categoryTag[category] ?? '创业')

    // 技术关键词
    const techKeywords = ['AI', 'SaaS', '开源', 'open source', 'API', 'low-code', '低代码', 'LLM', 'Agent']
    for (const kw of techKeywords) {
      if (text.includes(kw) || text.includes(kw.toLowerCase())) {
        tags.push(kw)
        if (tags.length >= 5) break
      }
    }

    return [...new Set(tags)]
  }
}

// ════════════════════════════════════════════════════════════════
//  内部类型
// ════════════════════════════════════════════════════════════════

/** POC 阶段的原始数据项 */
interface RawDataItem {
  title: string
  summary: string
  source: SignalSource
  url?: string
  createdAt: number
}

/** POC 阶段的数据源映射 */
interface RawDataMap {
  [source: string]: Array<{
    title: string
    summary: string
    url?: string
  }>
}

// ════════════════════════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════════════════════════

/** 全局单例（类比 songgeCorrectionAdapter / agentWallpaperBridge） */
export const startupRadarAdapter = new StartupRadarAdapter()
