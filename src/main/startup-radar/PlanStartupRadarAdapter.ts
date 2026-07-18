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

      // 1. 从各源采集原始 feed → 本地分类评分
      const rawItems = await this.collectRawData(sources, keywords, limit)
      const signals: StartupSignal[] = []
      const sourceDist: Record<string, number> = {}
      const categoryDist: Record<string, number> = {}

      if (rawItems && rawItems.length > 0) {
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
          if (compositeScore < minScore) continue

          const urgency = computeUrgency(compositeScore)

          signals.push({
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
            expiresAt: Date.now() + 24 * 3600 * 1000,
          })

          sourceDist[item.source] = (sourceDist[item.source] ?? 0) + 1
          categoryDist[category] = (categoryDist[category] ?? 0) + 1
        }
      }

      // 2. 从远程 Radar API 获取已处理信号（异步，不影响本地采集）
      const remoteSignals = await this.fetchRemoteSignals()
      for (const rs of remoteSignals) {
        signals.push(rs)
        sourceDist['remote_radar'] = (sourceDist['remote_radar'] ?? 0) + 1
        categoryDist[rs.category] = (categoryDist[rs.category] ?? 0) + 1
      }

      if (signals.length === 0) {
        log('WARN', 'startup_radar_no_data', { sources })
        return {
          signals: [],
          timestamp: Date.now(),
          sourceCount: 0,
          totalSignals: 0,
          urgentCount: 0,
          compositeHeatIndex: 0,
          sourceDistribution: sourceDist,
          categoryDistribution: categoryDist,
        }
      }

      // 3. 按复合评分降序排列
      signals.sort((a, b) => b.compositeScore - a.compositeScore)

      // 4. 计算统计
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
        remoteCount: remoteSignals.length,
        localCount: rawItems?.length ?? 0,
        totalSignals: signals.length,
        hotCount,
        warmCount,
        avgScore: avgScore.toFixed(3),
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
   * 采集原始数据 — 从 HackerNews、GitHub Trending 等各源 API 获取原始 feed。
   * 支持多源并发采集 + 关键词 OR 过滤 + 数量限制。
   */
  private async collectRawData(
    sources: SignalSource[],
    keywords?: string[],
    limit?: number,
  ): Promise<RawDataItem[]> {
    const tasks = sources.map((source) => this.fetchSource(source, limit ?? 10))
    const results = await Promise.allSettled(tasks)
    const allItems: RawDataItem[] = []

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const source = sources[i]
      if (result.status === 'rejected') {
        log('WARN', 'startup_radar_source_failed', { source, error: String(result.reason) })
        continue
      }
      let items = result.value
      if (keywords && keywords.length > 0) {
        const kwLower = keywords.map((k) => k.toLowerCase())
        items = items.filter(
          (item) =>
            kwLower.some((kw) => item.title.toLowerCase().includes(kw) || item.summary.toLowerCase().includes(kw)),
        )
      }
      allItems.push(...items)
    }

    if (allItems.length === 0) {
      log('INFO', 'startup_radar_no_raw_data', { sources, keywordCount: keywords?.length ?? 0 })
    }

    return allItems
  }

  /**
   * 从远程 Radar API (https://ai.crlkcloud.cyou) 获取已处理的信号/机会/主题。
   * 返回的是已评分、已分类的信号，直接作为 StartupSignal 使用。
   */
  private async fetchRemoteSignals(): Promise<StartupSignal[]> {
    try {
      const res = await fetch('https://ai.crlkcloud.cyou/radar/pipeline', {
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        log('WARN', 'remote_radar_api_failed', { status: res.status })
        return []
      }
      const body: any = await res.json()
      const signals: StartupSignal[] = []

      // signals → StartupSignal
      if (Array.isArray(body.signals)) {
        for (const sig of body.signals) {
          signals.push({
            id: nextSignalId(),
            category: this.remoteCategory(sig.classification),
            title: sig.problem || sig.title || '',
            summary: `${sig.icp || ''} ${sig.gap || ''}`.trim(),
            source: 'other',
            url: sig.evidence || undefined,
            scores: {
              relevance: 0.7,
              timeliness: 0.7,
              impact: (sig.pain ?? 5) / 10,
              confidence: 0.6,
              actionability: 0.5,
            },
            compositeScore: (sig.score ?? 5) / 10,
            urgency: (sig.score ?? 5) >= 7 ? 'hot' : (sig.score ?? 5) >= 4 ? 'warm' : 'cold',
            pushed: false,
            tags: ['远程雷达', sig.classification || 'signal'].filter(Boolean),
            createdAt: Date.now(),
            expiresAt: Date.now() + 24 * 3600 * 1000,
          })
        }
      }

      // opportunities → StartupSignal
      if (Array.isArray(body.opportunities)) {
        for (const opp of body.opportunities) {
          const score = (opp.avg_score ?? 5) / 10
          signals.push({
            id: nextSignalId(),
            category: this.opportunityCategory(opp.type),
            title: opp.title || '',
            summary: `[机会] 类型:${opp.type || '?'} 出现:${opp.appearances ?? '?'}次 连续:${opp.consecutive_days ?? '?'}天`,
            source: 'other',
            url: opp.evidence || undefined,
            scores: {
              relevance: 0.8,
              timeliness: 0.6,
              impact: score,
              confidence: opp.confidence ?? 0.5,
              actionability: 0.6,
            },
            compositeScore: score,
            urgency: score >= 0.7 ? 'hot' : score >= 0.4 ? 'warm' : 'cold',
            pushed: false,
            tags: ['远程雷达', '机会', opp.type || 'opportunity'].filter(Boolean),
            createdAt: Date.now(),
            expiresAt: Date.now() + 48 * 3600 * 1000,
          })
        }
      }

      return signals
    } catch (err: any) {
      log('WARN', 'remote_radar_api_error', { error: err.message })
      return []
    }
  }

  private remoteCategory(classification?: string): StartupSignalCategory {
    const map: Record<string, StartupSignalCategory> = {
      bug: 'consumer_demand',
      feature_request: 'consumer_demand',
      workflow: 'consumer_demand',
      replacement: 'competitor',
      market_gap: 'market_trend',
    }
    return (classification && map[classification]) || 'market_trend'
  }

  private opportunityCategory(type?: string): StartupSignalCategory {
    const map: Record<string, StartupSignalCategory> = {
      bug: 'consumer_demand',
      feature_request: 'technology',
      workflow: 'market_trend',
      replacement: 'competitor',
      market_gap: 'market_trend',
    }
    return (type && map[type]) || 'market_trend'
  }

  /**
   * 按源名称从对应 API 获取数据。
   */
  private async fetchSource(source: SignalSource, limit: number): Promise<RawDataItem[]> {
    switch (source) {
      case 'hackernews':
        return this.fetchHackerNews(limit)
      case 'github_trending':
        return this.fetchGitHubTrending(limit)
      case 'weibo_hot':
        return this.fetchWeiboHot(limit)
      case 'bilibili':
        return this.fetchBilibili(limit)
      case 'douyin':
        return this.fetchDouyin(limit)
      default:
        log('WARN', 'startup_radar_unsupported_source', { source })
        return []
    }
  }

  private async fetchHackerNews(limit: number): Promise<RawDataItem[]> {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      signal: AbortSignal.timeout(15000),
    })
    if (!idsRes.ok) return []
    const ids: number[] = await idsRes.json()
    const topIds = ids.slice(0, limit * 2)
    const batchSize = 10
    const items: RawDataItem[] = []
    for (let i = 0; i < topIds.length && items.length < limit; i += batchSize) {
      const batch = topIds.slice(i, i + batchSize)
      const stories = await Promise.all(
        batch.map((id) =>
          fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
            signal: AbortSignal.timeout(10000),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      )
      for (const story of stories) {
        if (!story || story.type !== 'story' || !story.title || items.length >= limit) continue
        const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`
        items.push({
          title: story.title,
          summary: `${story.title} (by ${story.by ?? 'unknown'})`,
          source: 'hackernews',
          url,
          createdAt: (story.time || 0) * 1000,
        })
      }
    }
    return items
  }

  private async fetchGitHubTrending(limit: number): Promise<RawDataItem[]> {
    try {
      const res = await fetch('https://api.vvhan.com/api/github/trending', {
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const body: any = await res.json()
        if (body.code === 200 && Array.isArray(body.data)) {
          return body.data.slice(0, limit).map((repo: any) => ({
            title: repo.title || repo.name || 'Unknown',
            summary: repo.description || repo.title || '',
            source: 'github_trending',
            url: repo.url || `https://github.com/${repo.title}`,
            createdAt: Date.now(),
          }))
        }
      }
    } catch { /* fallback */ }
    try {
      const res = await fetch('https://github.com/trending', {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      if (!res.ok) return []
      const html = await res.text()
      const repos: RawDataItem[] = []
      const articleRegex = /<article[\s\S]*?<h2[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
      let match: RegExpExecArray | null
      while ((match = articleRegex.exec(html)) !== null && repos.length < limit) {
        const name = match[1].trim()
        repos.push({
          title: (match[2].replace(/<[^>]+>/g, '').trim()) || name,
          summary: `${name} — GitHub trending`,
          source: 'github_trending',
          url: `https://github.com/${name}`,
          createdAt: Date.now(),
        })
      }
      return repos
    } catch { return [] }
  }

  private async fetchWeiboHot(limit: number): Promise<RawDataItem[]> {
    try {
      const res = await fetch('https://weibo.com/ajax/side/hotSearch', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return []
      const body: any = await res.json()
      const realtime = body?.data?.realtime
      if (!Array.isArray(realtime)) return []
      return realtime.slice(0, limit).map((item: any) => ({
        title: item.word || item.word_scheme || '',
        summary: `[微博热搜] ${item.word || ''} (热度: ${item.raw_hot || item.num || '?'})`,
        source: 'weibo_hot',
        url: item.word_scheme || `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word || '')}`,
        createdAt: Date.now(),
      }))
    } catch { return [] }
  }

  private async fetchBilibili(limit: number): Promise<RawDataItem[]> {
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/popular', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return []
      const body: any = await res.json()
      const list = body?.data?.list
      if (!Array.isArray(list)) return []
      return list.slice(0, limit).map((item: any) => ({
        title: item.title || '',
        summary: `[B站热门] ${item.title || ''} (播放: ${item.stat?.view || '?'})`,
        source: 'bilibili',
        url: `https://www.bilibili.com/video/${item.bvid}`,
        createdAt: new Date((item.pubdate || 0) * 1000).getTime(),
      }))
    } catch { return [] }
  }

  private async fetchDouyin(limit: number): Promise<RawDataItem[]> {
    try {
      const res = await fetch('https://www.douyin.com/aweme/v1/web/hot/search/list/', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return []
      const body: any = await res.json()
      const list = body?.data?.word_list
      if (!Array.isArray(list)) return []
      return list.slice(0, limit).map((item: any) => ({
        title: item.word || '',
        summary: `[抖音热搜] ${item.word || ''} (热度: ${item.hot_value || '?'})`,
        source: 'douyin',
        url: `https://www.douyin.com/search/${encodeURIComponent(item.word || '')}`,
        createdAt: Date.now(),
      }))
    } catch { return [] }
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

/** 原始数据项 */
interface RawDataItem {
  title: string
  summary: string
  source: SignalSource
  url?: string
  createdAt: number
}

// ════════════════════════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════════════════════════

/** 全局单例（类比 songgeCorrectionAdapter / agentWallpaperBridge） */
export const startupRadarAdapter = new StartupRadarAdapter()
