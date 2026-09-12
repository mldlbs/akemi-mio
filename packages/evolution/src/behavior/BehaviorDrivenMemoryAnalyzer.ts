/**
 * BehaviorDrivenMemoryAnalyzer — 行为驱动的主动记忆填充
 *
 * 定时运行的离线分析器，从 UserBehavior 中提取行为模式并转化为 Memory 条目。
 *
 * ## 核心算法
 * - TF-IDF：对最近 70 次交互的用户消息计算词频-逆文档频率，提取高重要性话题
 * - 意图聚类：将交互按特征向量（话题标签、消息长度、工具使用率）聚为 K 个意图簇
 * - 时间序列：按小时/按天分桶统计交互频次，检测活跃时段
 *
 * ## 输出记忆类型
 * - 偏好记忆（preference）：用户常问话题、常见操作模式
 * - 频率记忆（frequency）：工具使用频次分布
 * - 情景记忆（episodic）：典型交互序列、常见意图簇
 * - 时段模式记忆（time_pattern）：活跃时段、最佳交互时间
 *
 * ## 集成点
 * - 读取 InteractionTracker / UserBehaviorAnalyzer 的运行时数据
 * - 直接查询 DB 的 interaction_log 和 messages 表获取历史数据
 * - 调用 MemoryService.addFact() 写入结构化记录
 * - 定时器每 2 小时触发一次（匹配进化周期）
 *
 * ## 隐私考虑
 * - 仅分析最近 70 次交互，避免过度保留行为历史
 * - 记忆条目以概括性标签而非原始文本存储
 * - 生成的记忆条目为 ephemeral 层，随衰减自动清理
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import { getRawDb } from '@akemi-mio/core/db/connection'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory/types'
import type { InteractionRecord } from '@akemi-mio/intelligence-memory/types'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import {
  BEHAVIOR_MEMORY_ANALYZER_INTERVAL,
  BEHAVIOR_MEMORY_ANALYZER_WINDOW,
  BEHAVIOR_MEMORY_TFIDF_TOP_K,
  BEHAVIOR_MEMORY_INTENT_CLUSTERS,
  BEHAVIOR_MEMORY_PEAK_Z_SCORE,
  BEHAVIOR_MEMORY_MIN_INTERACTIONS,
  BEHAVIOR_MEMORY_MAX_MEMORIES_PER_CYCLE,
} from '@akemi-mio/core/config'

// ══════════════════════════════════════════
// 配置常量
// ══════════════════════════════════════════

/** 分析窗口大小 —— 最近 N 次交互 */
const WINDOW = BEHAVIOR_MEMORY_ANALYZER_WINDOW // default 70

/** TF-IDF 提取的高频词数量 */
const TFIDF_TOP_K = BEHAVIOR_MEMORY_TFIDF_TOP_K // default 15

/** 意图聚类数 */
const K_CLUSTERS = BEHAVIOR_MEMORY_INTENT_CLUSTERS // default 4

/** 活跃时段判定 z-score 阈值 */
const PEAK_Z_SCORE = BEHAVIOR_MEMORY_PEAK_Z_SCORE // default 1.5

/** 最小交互数（少于该值不执行分析） */
const MIN_INTERACTIONS = BEHAVIOR_MEMORY_MIN_INTERACTIONS // default 10

/** 每次周期最多新创建的条目数 */
const MAX_MEMORIES_PER_CYCLE = BEHAVIOR_MEMORY_MAX_MEMORIES_PER_CYCLE // default 8

/** TF-IDF 中忽略的极低频词 IDF 阈值（低于此值视为噪音） */
const IDF_NOISE_FLOOR = 0.5

/** 用于标记行为分析来源的 structuredData key */
const STRUCTURED_SOURCE_KEY = '_behavior_memory_source'

/** 偏好记忆的最大数量 */
const MAX_PREFERENCE_MEMORIES = 5

/** 中文停用词列表（TF-IDF 过滤用） */
const STOP_WORDS = new Set([
  '的',
  '了',
  '在',
  '是',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
  '他',
  '她',
  '它',
  '们',
  '那',
  '些',
  '吧',
  '吗',
  '啊',
  '呢',
  '哦',
  '嗯',
  '哈',
  '然后',
  '因为',
  '所以',
  '但是',
  '如果',
  '虽然',
  '可以',
  '这个',
  '那个',
  '什么',
  '怎么',
  '为什么',
  '哪个',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'may',
  'might',
  'shall',
  'should',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'and',
  'or',
  'but',
  'not',
  'so',
  'if',
  'than',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'what',
  'which',
  'who',
  'whom',
  'how',
  'when',
  'where',
  'why',
])

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** TF-IDF 分析结果 —— 一个词项及其在各个文档中的平均重要性 */
export interface TfIdfResult {
  term: string
  /** 平均 TF-IDF 得分（跨所有文档） */
  averageScore: number
  /** 最大 TF-IDF 得分（该词在某个文档中的最高分） */
  maxScore: number
  /** 包含该词的文档数 */
  documentFrequency: number
  /** 总出现次数 */
  totalFrequency: number
}

/** 意图簇 —— K-Means 聚类结果 */
export interface IntentCluster {
  id: number
  /** 簇内交互数 */
  size: number
  /** 簇中心特征向量 */
  centroid: number[]
  /** 簇内交互的常见话题标签（按频率降序） */
  dominantTopics: string[]
  /** 簇的语义标签（根据特征推断） */
  label: string
  /** 置信度 (0-1) */
  confidence: number
  /** 近期活跃度：最近 24h 内的交互数占比 */
  recentActivity: number
}

/** 时段模式分析结果 */
export interface TimePattern {
  /** 活跃小时列表（0-23），按活跃度降序 */
  activeHours: Array<{ hour: number; count: number; score: number }>
  /** 活跃日列表（0=周日，6=周六），按活跃度降序 */
  activeDays: Array<{ day: number; count: number; score: number }>
  /** 最活跃的时段名（如"上午""下午""晚间"） */
  peakPeriodLabel: string
  /** 用户交互密集度：总交互数 / 分析天数 */
  dailyIntensity: number
}

/** 单次分析周期的完整结果 */
export interface AnalysisResult {
  /** TF-IDF 提取的高重要性话题词 */
  topTerms: TfIdfResult[]
  /** 意图聚类结果 */
  clusters: IntentCluster[]
  /** 时段模式 */
  timePattern: TimePattern
  /** 工具调用频率统计 */
  toolStats: Array<{ name: string; count: number }>
  /** 新创建的记忆条目数 */
  memoriesCreated: number
  /** 分析时间戳 */
  analyzedAt: number
  /** 是否成功 */
  success: boolean
  /** 失败原因（如果有） */
  error?: string
}

/** DB 行格式（从 interaction_log 表读取） */
interface InteractionLogRow {
  id: string
  user_text: string
  topics: string
  timestamp: number
}

/** DB 行格式（从 messages 表读取） */
interface MessageRow {
  id: string
  content: string
  createdAt: number
}

// ══════════════════════════════════════════
// BehaviorDrivenMemoryAnalyzer
// ══════════════════════════════════════════

export class BehaviorDrivenMemoryAnalyzer {
  private memoryService: MemoryService | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastResult: AnalysisResult | null = null
  private lastAnalyzedAt: number = 0

  /** 是否在运行中 */
  private running = false

  /** TF-IDF 词项缓存：上次分析的 top terms（用于去重） */
  private lastTopTerms: string[] = []

  constructor() {}

  /** 注入 MemoryService 依赖（必选） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
  }

  // ==================== 生命周期 ====================

  /** 启动定时分析器 */
  start(intervalMs: number = BEHAVIOR_MEMORY_ANALYZER_INTERVAL): void {
    if (this.timer) return
    log('INFO', 'behavior_memory_analyzer_started', {
      intervalMs,
      intervalMinutes: Math.round(intervalMs / 60_000),
    })

    // 首次执行延迟 30 秒，等系统稳定
    setTimeout(() => {
      this.runAnalysis().catch((err) => log('WARN', 'behavior_memory_analyzer_init_run_failed', { error: String(err) }))
    }, 30_000)

    this.timer = setInterval(() => {
      this.runAnalysis().catch((err) => log('WARN', 'behavior_memory_analyzer_cycle_failed', { error: String(err) }))
    }, intervalMs)
  }

  /** 停止定时分析器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log('INFO', 'behavior_memory_analyzer_stopped')
  }

  /** 获取最近一次分析结果 */
  getLastResult(): AnalysisResult | null {
    return this.lastResult
  }

  /** 获取上次分析的 Top Terms（用于 API 查询） */
  getLastTopTerms(): string[] {
    return this.lastTopTerms
  }

  // ==================== 主分析周期 ====================

  /**
   * 执行一次完整的分析周期。
   * 1. 从 DB 读取最近 WINDOW 次交互记录
   * 2. TF-IDF 提取高频话题
   * 3. K-Means 聚类交互意图
   * 4. 时间序列分析发现活跃时段
   * 5. 生成并写入记忆条目
   */
  async runAnalysis(): Promise<AnalysisResult> {
    if (this.running) {
      return { ...this.getEmptyResult(), error: 'Analyzer already running' }
    }
    if (!this.memoryService) {
      return { ...this.getEmptyResult(), error: 'MemoryService not injected' }
    }

    this.running = true
    const startMs = Date.now()

    try {
      // 1. 读取交互记录
      const interactions = this.loadInteractions(WINDOW)
      if (interactions.length < MIN_INTERACTIONS) {
        log('INFO', 'behavior_memory_insufficient_data', {
          count: interactions.length,
          minRequired: MIN_INTERACTIONS,
        })
        const empty = this.getEmptyResult()
        this.lastResult = empty
        return empty
      }

      const userTexts = interactions.map((r) => r.userText).filter(Boolean)
      const topics = interactions.map((r) => r.topics || [])

      // 2. TF-IDF 话题提取
      const topTerms = userTexts.length >= 2 ? this.computeTfIdf(userTexts) : []

      // 3. 意图聚类
      const clusters = this.clusterIntents(interactions)

      // 4. 时间序列分析
      const timePattern = this.analyzeTimePatterns(interactions)

      // 5. 工具调用统计
      const toolStats = this.getToolStats()

      // 6. 生成记忆条目
      const memoriesCreated = this.generateMemories(topTerms, clusters, timePattern, toolStats)

      const result: AnalysisResult = {
        topTerms,
        clusters,
        timePattern,
        toolStats,
        memoriesCreated,
        analyzedAt: Date.now(),
        success: true,
      }

      this.lastResult = result
      this.lastTopTerms = topTerms.slice(0, 10).map((t) => t.term)
      this.lastAnalyzedAt = Date.now()

      log('INFO', 'behavior_memory_analysis_complete', {
        interactions: interactions.length,
        topTermsCount: topTerms.length,
        clusters: clusters.map((c) => `${c.label}(${c.size})`).join(', '),
        activeHours: timePattern.activeHours.length,
        memoriesCreated,
        durationMs: Date.now() - startMs,
      })

      return result
    } catch (err: any) {
      log('ERROR', 'behavior_memory_analysis_error', { error: String(err).slice(0, 500) })
      const result: AnalysisResult = { ...this.getEmptyResult(), error: String(err).slice(0, 500) }
      this.lastResult = result
      return result
    } finally {
      this.running = false
    }
  }

  /** 手动触发一次分析（供外部调用） */
  async analyzeNow(): Promise<AnalysisResult> {
    return this.runAnalysis()
  }

  // ══════════════════════════════════════════
  //  1. TF-IDF 话题提取
  // ══════════════════════════════════════════

  /**
   * 从用户消息列表中计算 TF-IDF，返回得分最高的词项。
   *
   * 实现：
   * - 每个用户消息作为一个文档
   * - 分词：中文按单字 + 匹配英文词
   * - TF(t,d) = count(t,d) / len(d)
   * - IDF(t)  = log(N / df(t)) + 1
   * - TF-IDF(t,d) = TF(t,d) × IDF(t)
   * - 最终得分为"最大 TF-IDF"×"文档频率归一化"的组合分数
   */
  computeTfIdf(texts: string[]): TfIdfResult[] {
    if (texts.length < 2) return []

    const N = texts.length

    // 预处理：分词、去停用词
    const documents: string[][] = texts.map((text) => this.tokenize(text))

    // 计算文档频率 (DF)：包含该词的文档数
    const df = new Map<string, number>()
    // 计算总出现次数 (TF sum)
    const totalFreq = new Map<string, number>()

    for (const doc of documents) {
      const seen = new Set<string>()
      for (const term of doc) {
        totalFreq.set(term, (totalFreq.get(term) || 0) + 1)
        if (!seen.has(term)) {
          seen.add(term)
          df.set(term, (df.get(term) || 0) + 1)
        }
      }
    }

    // 计算每个文档中每个词的 TF-IDF
    const termMaxScores = new Map<string, number>()
    const termSumScores = new Map<string, number>()
    const termDocCount = new Map<string, number>()

    for (let d = 0; d < documents.length; d++) {
      const doc = documents[d]
      if (doc.length === 0) continue

      // 统计该文档的 term frequency
      const tf = new Map<string, number>()
      for (const term of doc) {
        tf.set(term, (tf.get(term) || 0) + 1)
      }

      const docLen = doc.length
      for (const [term, count] of tf) {
        const tFreq = count / docLen // 归一化 TF
        const dFreq = df.get(term) || 1
        const idFreq = Math.log(N / dFreq) + 1 // IDF 平滑
        const score = tFreq * idFreq

        termMaxScores.set(term, Math.max(termMaxScores.get(term) || 0, score))
        termSumScores.set(term, (termSumScores.get(term) || 0) + score)
        termDocCount.set(term, (termDocCount.get(term) || 0) + 1)
      }
    }

    // 过滤低 IDF 词（噪音）并排序
    const results: TfIdfResult[] = []
    for (const [term, maxScore] of termMaxScores) {
      const docFreq = df.get(term) || 1
      const tFreq = totalFreq.get(term) || 0
      // IDF 噪音过滤：出现在几乎所有文档中的词
      const idFreq = Math.log(N / docFreq)
      if (idFreq < IDF_NOISE_FLOOR) continue

      const avgScore = (termSumScores.get(term) || 0) / (termDocCount.get(term) || 1)

      results.push({
        term,
        averageScore: Math.round(avgScore * 1000) / 1000,
        maxScore: Math.round(maxScore * 1000) / 1000,
        documentFrequency: docFreq,
        totalFrequency: tFreq,
      })
    }

    // 按平均 TF-IDF 降序排列，取 top K
    results.sort((a, b) => b.averageScore - a.averageScore)
    return results.slice(0, TFIDF_TOP_K)
  }

  /**
   * 分词：提取中英文词、数字，过滤停用词和短词。
   * 中文按单字 + 双字组合提取（简单 char n-gram 以捕获中文语境）。
   */
  private tokenize(text: string): string[] {
    if (!text) return []

    const lower = text.toLowerCase()
    const words: string[] = []

    // 1. 提取英文词、数字
    const engTokens = lower.match(/[a-z]+|\d+/g)
    if (engTokens) {
      for (const t of engTokens) {
        if (t.length >= 2 && !STOP_WORDS.has(t)) {
          words.push(t)
        }
      }
    }

    // 2. 提取中文字符（过滤标点、空白）
    const chineseChars = lower.match(/[一-鿿]/g)
    if (chineseChars && chineseChars.length >= 2) {
      // 添加双字组合（bigram）
      for (let i = 0; i < chineseChars.length - 1; i++) {
        const bigram = chineseChars[i] + chineseChars[i + 1]
        if (!STOP_WORDS.has(bigram)) {
          words.push(bigram)
        }
      }
      // 单字中文只在特定情况下保留（非停用字、长度>=2的句子中的高频字）
      // 查找频率高于阈值的单字
      const charFreq = new Map<string, number>()
      for (const c of chineseChars) {
        if (!STOP_WORDS.has(c)) {
          charFreq.set(c, (charFreq.get(c) || 0) + 1)
        }
      }
      // 保留出现 >= 2 次的非停用字
      for (const [c, freq] of charFreq) {
        if (freq >= 3) {
          words.push(c)
        }
      }
    }

    return words
  }

  // ══════════════════════════════════════════
  //  2. 意图聚类（轻量 K-Means）
  // ══════════════════════════════════════════

  /**
   * 将交互记录聚为 K 个意图簇。
   *
   * 特征向量（5 维）：
   * - idx0: 消息长度归一化 (0-1)
   * - idx1: 工具使用密集度 (0-1)
   * - idx2: 技术话题倾向 (0-1)
   * - idx3: 社交/聊天话题倾向 (0-1)
   * - idx4: 创作话题倾向 (0-1)
   *
   * 使用标准的 K-Means 算法:
   * - 随机初始化 K 个中心点
   * - 分配每个点到最近中心
   * - 重新计算中心
   * - 迭代直到收敛（最多 20 次）
   * - 多次重启取最佳结果
   */
  clusterIntents(records: InteractionRecord[]): IntentCluster[] {
    if (records.length < 5) return this.getDefaultClusters()

    const features = this.extractFeatureVectors(records)
    if (features.length < K_CLUSTERS) return this.getDefaultClusters()

    // 运行 K-Means（3 次重启取最佳）
    let bestResult: { labels: number[]; centroids: number[][] } | null = null
    let bestInertia = Infinity

    for (let restart = 0; restart < 3; restart++) {
      const result = this.kMeans(features, K_CLUSTERS)
      const inertia = this.computeInertia(features, result.labels, result.centroids)
      if (inertia < bestInertia) {
        bestInertia = inertia
        bestResult = result
      }
    }

    if (!bestResult) return this.getDefaultClusters()

    const { labels, centroids } = bestResult

    // 构建簇结果
    const clusters: IntentCluster[] = []
    const now = Date.now()
    const oneDayAgo = now - 86_400_000

    for (let k = 0; k < K_CLUSTERS; k++) {
      const memberIndices = labels.map((l, i) => (l === k ? i : -1)).filter((i) => i >= 0)
      const memberRecords = memberIndices.map((i) => records[i])
      const size = memberRecords.length

      if (size === 0) continue

      // 统计簇内主导话题
      const topicCounts = new Map<string, number>()
      let recentCount = 0
      for (const r of memberRecords) {
        for (const t of r.topics || []) {
          topicCounts.set(t, (topicCounts.get(t) || 0) + 1)
        }
        if (r.timestamp >= oneDayAgo) recentCount++
      }

      const dominantTopics = [...topicCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t)

      const recentActivity = size > 0 ? recentCount / size : 0

      // 推断簇标签
      const label = this.inferClusterLabel(centroids[k], dominantTopics)

      // 计算置信度：簇越紧密、越大、话题越明确，置信度越高
      const clusterConfidence = this.computeClusterConfidence(size, features.length, dominantTopics.length)

      clusters.push({
        id: k,
        size,
        centroid: centroids[k],
        dominantTopics,
        label,
        confidence: clusterConfidence,
        recentActivity,
      })
    }

    // 按大小降序排列
    clusters.sort((a, b) => b.size - a.size)

    // 如果无结果或全空，返回默认
    if (clusters.length === 0) return this.getDefaultClusters()

    return clusters
  }

  /** 将交互记录转为特征向量 */
  private extractFeatureVectors(records: InteractionRecord[]): number[][] {
    const techTopics = new Set(['编程', '调试', '部署', '测试', '架构', 'API', '数据库', '配置', '代码', '文档', '性能', '安全', '技术'])
    const socialTopics = new Set(['问答', '聊天', '日常'])
    const creativeTopics = new Set(['图像生成', '写作', '创作', '画图'])

    const vectors: number[][] = []
    for (const r of records) {
      const msgLen = Math.min(r.userText.length / 500, 1) // 0-1 归一化
      const hasTools = r.rementionedMemoryIds.length > 0 ? 0.5 : 0
      const topics = r.topics || []

      const techScore = topics.some((t) => techTopics.has(t)) ? 0.8 : 0.1
      const socialScore = topics.some((t) => socialTopics.has(t)) ? 0.8 : 0.1
      const creativeScore = topics.some((t) => creativeTopics.has(t)) ? 0.8 : 0.1

      // 响应耗时的归一化信号
      const responseSignal = r.responseTimeMs ? Math.min(r.responseTimeMs / 5000, 1) : 0.3

      vectors.push([
        Math.round(msgLen * 100) / 100,
        Math.round(hasTools * 100) / 100,
        Math.round(techScore * 100) / 100,
        Math.round(socialScore * 100) / 100,
        Math.round(creativeScore * 100) / 100,
      ])
    }
    return vectors
  }

  /**
   * K-Means 核心实现。
   * @param data 特征向量数组
   * @param k 聚类数
   * @returns 每个点的标签和最终中心点
   */
  private kMeans(data: number[][], k: number): { labels: number[]; centroids: number[][] } {
    const N = data.length
    const dim = data[0].length
    const maxIterations = 20

    // 随机初始化：从数据点中选取 K 个作为初始中心
    const shuffled = [...data].sort(() => Math.random() - 0.5)
    const centroids: number[][] = shuffled.slice(0, k).map((p) => [...p])

    // 如果某个维度为 0 导致退化，用随机扰动
    for (const c of centroids) {
      for (let d = 0; d < dim; d++) {
        if (c[d] === 0) c[d] = Math.random() * 0.3
      }
    }

    const labels: number[] = new Array(N).fill(0)
    let changed = true
    let iter = 0

    while (changed && iter < maxIterations) {
      changed = false
      iter++

      // 分配步骤：每个点归到最近的中心
      for (let i = 0; i < N; i++) {
        let minDist = Infinity
        let bestK = 0
        for (let j = 0; j < k; j++) {
          const dist = this.euclideanDist(data[i], centroids[j])
          if (dist < minDist) {
            minDist = dist
            bestK = j
          }
        }
        if (labels[i] !== bestK) {
          labels[i] = bestK
          changed = true
        }
      }

      // 更新步骤：重新计算中心
      for (let j = 0; j < k; j++) {
        const members = data.filter((_, i) => labels[i] === j)
        if (members.length === 0) continue
        const newCentroid = new Array(dim).fill(0)
        for (const m of members) {
          for (let d = 0; d < dim; d++) {
            newCentroid[d] += m[d]
          }
        }
        for (let d = 0; d < dim; d++) {
          newCentroid[d] /= members.length
        }
        centroids[j] = newCentroid
      }
    }

    return { labels, centroids }
  }

  /** 欧几里得距离 */
  private euclideanDist(a: number[], b: number[]): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      sum += (a[i] - b[i]) ** 2
    }
    return Math.sqrt(sum)
  }

  /** 计算惯性（簇内平方和） */
  private computeInertia(data: number[][], labels: number[], centroids: number[][]): number {
    let inertia = 0
    for (let i = 0; i < data.length; i++) {
      inertia += this.euclideanDist(data[i], centroids[labels[i]]) ** 2
    }
    return inertia
  }

  /** 根据中心点和主导话题推断簇的语义标签 */
  private inferClusterLabel(centroid: number[], topics: string[]): string {
    if (topics.length > 0) {
      const topicKeywords = topics.join('')
      if (/编程|调试|代码|技术/.test(topicKeywords)) return '技术开发'
      if (/聊天|问答|日常/.test(topicKeywords)) return '日常聊天'
      if (/图像|生成|画图|创作/.test(topicKeywords)) return '创意生成'
      if (/记忆|记住|回忆/.test(topicKeywords)) return '知识查询'
      if (/学习|教程|教学/.test(topicKeywords)) return '学习探究'
    }

    // 根据特征向量推断
    const [msgLen, toolUse, techScore, socialScore, creativeScore] = centroid

    if (techScore > 0.5 && toolUse > 0.3) return '技术任务'
    if (socialScore > 0.5 && msgLen < 0.5) return '日常聊天'
    if (creativeScore > 0.5) return '创意任务'
    if (msgLen < 0.3 && toolUse < 0.2) return '快速问答'

    return '综合交互'
  }

  /** 计算簇置信度 */
  private computeClusterConfidence(clusterSize: number, totalSize: number, topicCount: number): number {
    if (totalSize === 0) return 0

    const sizeRatio = clusterSize / totalSize
    const topicBonus = Math.min(topicCount / 3, 1) * 0.2

    // 大小占比越大、话题越明确，置信度越高
    return Math.min(1, Math.round((sizeRatio * 0.8 + topicBonus) * 100) / 100)
  }

  /** 数据不足时的默认簇 */
  private getDefaultClusters(): IntentCluster[] {
    return [
      {
        id: 0,
        size: 0,
        centroid: [0.5, 0.3, 0.5, 0.1, 0.1],
        dominantTopics: [],
        label: '技术任务',
        confidence: 0.3,
        recentActivity: 0,
      },
      {
        id: 1,
        size: 0,
        centroid: [0.2, 0.1, 0.1, 0.5, 0.1],
        dominantTopics: [],
        label: '日常聊天',
        confidence: 0.3,
        recentActivity: 0,
      },
    ]
  }

  // ══════════════════════════════════════════
  //  3. 时间序列分析
  // ══════════════════════════════════════════

  /**
   * 分析交互的时间分布模式。
   * - 按小时分桶：检测哪些小时交互最密集
   * - 按天分桶：检测一周中哪些天最活跃
   * - 使用 z-score（均值 + PEAK_Z_SCORE×标准差）作为活跃阈值
   */
  analyzeTimePatterns(records: InteractionRecord[]): TimePattern {
    if (records.length === 0) {
      return {
        activeHours: [],
        activeDays: [],
        peakPeriodLabel: '未知',
        dailyIntensity: 0,
      }
    }

    // ── 小时分布 ──
    const hourCounts = new Array(24).fill(0)
    for (const r of records) {
      const hour = new Date(r.timestamp).getHours()
      hourCounts[hour]++
    }

    const hourStats = this.computeZScoreStats(hourCounts)
    const activeHours = hourCounts
      .map((count, hour) => ({
        hour,
        count,
        score: hourStats.stdDev > 0 ? (count - hourStats.mean) / hourStats.stdDev : 0,
      }))
      .filter((h) => h.score >= PEAK_Z_SCORE)
      .sort((a, b) => b.score - a.score)

    // 如果没有活跃小时，取最高的几个
    const finalActiveHours =
      activeHours.length > 0
        ? activeHours
        : hourCounts
            .map((count, hour) => ({ hour, count, score: 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3)

    // ── 天分布（7 天滑动窗口，按一周中的天来算活跃度） ──
    const dayCounts = new Array(7).fill(0)
    for (const r of records) {
      const day = new Date(r.timestamp).getDay()
      dayCounts[day]++
    }

    const dayStats = this.computeZScoreStats(dayCounts)
    const activeDays = dayCounts
      .map((count, day) => ({
        day,
        count,
        score: dayStats.stdDev > 0 ? (count - dayStats.mean) / dayStats.stdDev : 0,
      }))
      .filter((d) => d.score >= PEAK_Z_SCORE * 0.7) // 宽松阈值
      .sort((a, b) => b.score - a.score)

    const finalActiveDays =
      activeDays.length > 0
        ? activeDays
        : dayCounts
            .map((count, day) => ({ day, count, score: 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3)

    // ── 计算密集度 ──
    const timespans = records.map((r) => r.timestamp).filter(Boolean)
    const daySpan = timespans.length >= 2 ? Math.max(1, (Math.max(...timespans) - Math.min(...timespans)) / 86_400_000) : 1
    const dailyIntensity = Math.round((records.length / daySpan) * 10) / 10

    // ── 高峰时段标签 ──
    const peakPeriodLabel = this.inferPeakPeriod(finalActiveHours)

    return {
      activeHours: finalActiveHours,
      activeDays: finalActiveDays,
      peakPeriodLabel,
      dailyIntensity,
    }
  }

  /** 计算均值和标准差 */
  private computeZScoreStats(values: number[]): { mean: number; stdDev: number } {
    const n = values.length
    if (n === 0) return { mean: 0, stdDev: 0 }
    const mean = values.reduce((s, v) => s + v, 0) / n
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    return { mean, stdDev: Math.sqrt(variance) }
  }

  /** 根据活跃小时推断时段名 */
  private inferPeakPeriod(activeHours: Array<{ hour: number; count: number; score: number }>): string {
    if (activeHours.length === 0) return '未知'

    const topHour = activeHours[0].hour

    if (topHour >= 6 && topHour < 9) return '早晨'
    if (topHour >= 9 && topHour < 12) return '上午'
    if (topHour >= 12 && topHour < 14) return '中午'
    if (topHour >= 14 && topHour < 18) return '下午'
    if (topHour >= 18 && topHour < 22) return '晚间'
    return '深夜'
  }

  // ══════════════════════════════════════════
  //  4. 工具调用统计
  // ══════════════════════════════════════════

  /** 获取工具调用频率统计 */
  private getToolStats(): Array<{ name: string; count: number }> {
    const pattern = userBehaviorAnalyzer.analyze({ windowSize: WINDOW })
    return Object.entries(pattern.toolCallCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }

  // ══════════════════════════════════════════
  //  5. 记忆条目生成
  // ══════════════════════════════════════════

  /**
   * 将分析结果转化为 Memory 条目。
   * 用 {@link MemoryService.addFact()} 写入，使用 structuredData 标记来源。
   *
   * 生成策略：
   * 1. 偏好记忆：TF-IDF 高频话题 + 高频工具
   * 2. 频率记忆：工具调用分布（每周更新一次）
   * 3. 情景记忆：目标簇 + 活跃时段
   * 4. 时间段模式记忆：时段活跃度
   */
  private generateMemories(
    topTerms: TfIdfResult[],
    clusters: IntentCluster[],
    timePattern: TimePattern,
    toolStats: Array<{ name: string; count: number }>,
  ): number {
    const ms = this.memoryService
    if (!ms) return 0

    let created = 0

    // 清除上次生成的偏好记忆（避免重复积累）
    this.removePreviousBehaviorMemories()

    // ── 1. 偏好记忆（preference）──
    if (topTerms.length >= 3) {
      // 构建偏好话题列表
      const topTopics = topTerms.filter((t) => t.documentFrequency >= 2).slice(0, MAX_PREFERENCE_MEMORIES)

      for (const term of topTopics) {
        const content = this.buildPreferenceContent(term)
        // 避免创建内容完全相同的条目
        if (this.hasExistingMemory(content)) continue

        ms.addEntry('user_fact', content, 0.6, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            [STRUCTURED_SOURCE_KEY]: 'preference',
            term: term.term,
            tfidfScore: term.averageScore,
            docFreq: term.documentFrequency,
            totalFreq: term.totalFrequency,
            generatedAt: Date.now(),
          }),
        })
        created++
        if (created >= MAX_MEMORIES_PER_CYCLE) break
      }
    }

    // ── 2. 频率记忆（frequency）──
    if (toolStats.length >= 3 && created < MAX_MEMORIES_PER_CYCLE) {
      const topTools = toolStats.slice(0, 5)
      const toolList = topTools.map((t) => `${t.name}(${t.count}次)`).join('、')
      const content = `【行为频率】最近常用的工具：${toolList}`

      if (!this.hasExistingMemory(content)) {
        ms.addEntry('user_fact', content, 0.65, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            [STRUCTURED_SOURCE_KEY]: 'frequency',
            tools: topTools,
            generatedAt: Date.now(),
          }),
        })
        created++
      }
    }

    // ── 3. 情景记忆（episodic）──
    if (clusters.length >= 2 && created < MAX_MEMORIES_PER_CYCLE) {
      const dominantClusters = clusters.filter((c) => c.size >= 2 && c.confidence >= 0.3).slice(0, 2)

      for (const cluster of dominantClusters) {
        const topicStr = cluster.dominantTopics.length > 0 ? cluster.dominantTopics.join('、') : '综合类'
        const content = `【行为情景】常见交互模式 — ${cluster.label}（占比 ${Math.round((cluster.size / this.getTotalInteractionCount()) * 100)}%，话题：${topicStr}）`

        if (!this.hasExistingMemory(content)) {
          ms.addEntry('user_fact', content, 0.55, {
            tier: 'ephemeral',
            structuredData: JSON.stringify({
              [STRUCTURED_SOURCE_KEY]: 'episodic',
              clusterLabel: cluster.label,
              clusterSize: cluster.size,
              dominantTopics: cluster.dominantTopics,
              generatedAt: Date.now(),
            }),
          })
          created++
        }
        if (created >= MAX_MEMORIES_PER_CYCLE) break
      }
    }

    // ── 4. 时段模式记忆（time_pattern）──
    if (timePattern.activeHours.length > 0 && created < MAX_MEMORIES_PER_CYCLE) {
      const hourLabels = timePattern.activeHours
        .slice(0, 3)
        .map((h) => `${h.hour}时`)
        .join('、')
      const content = `【行为时段】活跃时间段：${hourLabels}（${timePattern.peakPeriodLabel}为主，日均约 ${timePattern.dailyIntensity} 次交互）`

      if (!this.hasExistingMemory(content)) {
        ms.addEntry('user_fact', content, 0.6, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            [STRUCTURED_SOURCE_KEY]: 'time_pattern',
            activeHours: timePattern.activeHours.slice(0, 5),
            peakPeriod: timePattern.peakPeriodLabel,
            dailyIntensity: timePattern.dailyIntensity,
            generatedAt: Date.now(),
          }),
        })
        created++
      }
    }

    return created
  }

  /** 构建偏好记忆的内容文本 */
  private buildPreferenceContent(term: TfIdfResult): string {
    return `【行为偏好】你似乎关注「${term.term}」相关的内容（在最近 ${WINDOW} 次交互中出现 ${term.documentFrequency} 次）`
  }

  /** 检查是否已存在相似的记忆条目（按 content 精确匹配） */
  private hasExistingMemory(content: string): boolean {
    const ms = this.memoryService
    if (!ms) return false
    return ms
      .getEntries()
      .some((e) => e.type === 'user_fact' && e.structuredData && e.structuredData.includes(STRUCTURED_SOURCE_KEY) && e.content === content)
  }

  /** 移除上次生成的 behavior-driven 记忆条目（避免累积过期信息） */
  private removePreviousBehaviorMemories(): void {
    const ms = this.memoryService
    if (!ms) return

    // 复制数组以避免在迭代中 splice 导致跳过元素
    const entries = [...ms.getEntries()]
    let removed = 0
    for (const entry of entries) {
      if (entry.type === 'user_fact' && entry.structuredData && entry.structuredData.includes(STRUCTURED_SOURCE_KEY)) {
        // 用 forgetEntry 删除（允许在 memoryService 上调用）
        // 注意：仅删除 ephemeral 层条目，避免误删用户手动保存的记忆
        if (entry.tier === 'ephemeral') {
          ms.forgetEntry(entry.id)
          removed++
        }
      }
    }
    if (removed > 0) {
      log('INFO', 'behavior_memory_removed_previous', { removed })
    }
  }

  /** 获取交互总数 */
  private getTotalInteractionCount(): number {
    const ms = this.memoryService
    if (!ms) return 1
    return Math.max(1, ms.getInteractionCount())
  }

  // ══════════════════════════════════════════
  //  数据加载
  // ══════════════════════════════════════════

  /**
   * 从 DB 加载最近 WINDOW 条交互记录。
   * 数据来源：interaction_log + messages 表（按时间戳降序）。
   */
  private loadInteractions(limit: number): InteractionRecord[] {
    const records: InteractionRecord[] = []

    try {
      const db = getRawDb()

      // 从 interaction_log 表加载
      const logResult = db.exec(`SELECT id, user_text, topics, timestamp FROM interaction_log ORDER BY timestamp DESC LIMIT ${limit}`)
      if (logResult && logResult.length > 0) {
        const columns = logResult[0].columns
        for (const row of logResult[0].values) {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
          const rowData = obj as InteractionLogRow

          const parsedTopics = this.parseJsonArray(rowData.topics)
          records.push({
            id: rowData.id,
            userText: rowData.user_text || '',
            responseTimeMs: null,
            topics: parsedTopics,
            isExplicitRemember: false,
            rementionedMemoryIds: [],
            timestamp: rowData.timestamp || 0,
            createdAt: rowData.timestamp || 0,
          })
        }
      }

      // 如果 interaction_log 数据不够，从 messages 表补充
      if (records.length < limit) {
        const msgResult = db.exec(
          `SELECT id, content, created_at FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT ${limit - records.length}`,
        )
        if (msgResult && msgResult.length > 0) {
          const columns = msgResult[0].columns
          for (const row of msgResult[0].values) {
            const obj: any = {}
            for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
            const rowData = obj as MessageRow

            // 避免重复（已有日志记录的消息）
            if (records.some((r) => r.userText === rowData.content)) continue

            records.push({
              id: rowData.id,
              userText: rowData.content || '',
              responseTimeMs: null,
              topics: [],
              isExplicitRemember: false,
              rementionedMemoryIds: [],
              timestamp: rowData.createdAt || 0,
              createdAt: rowData.createdAt || 0,
            })
          }
        }
      }
    } catch (err) {
      log('WARN', 'behavior_memory_load_failed', { error: String(err) })
    }

    // 按时间升序排列（最早的在前，用于时序分析）
    records.sort((a, b) => a.timestamp - b.timestamp)

    // 取最近的 limit 条
    return records.slice(-limit)
  }

  /** 安全解析 JSON 数组字段 */
  private parseJsonArray(raw: any): string[] {
    if (raw === null || raw === undefined) return []
    if (Array.isArray(raw)) return raw
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 空的 AnalysisResult 模板 */
  private getEmptyResult(): AnalysisResult {
    return {
      topTerms: [],
      clusters: [],
      timePattern: {
        activeHours: [],
        activeDays: [],
        peakPeriodLabel: '未知',
        dailyIntensity: 0,
      },
      toolStats: [],
      memoriesCreated: 0,
      analyzedAt: Date.now(),
      success: false,
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

export const behaviorDrivenMemoryAnalyzer = new BehaviorDrivenMemoryAnalyzer()
