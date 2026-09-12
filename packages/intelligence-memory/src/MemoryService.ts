import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { SummaryMemory } from './SummaryMemory'
import { VectorMemory } from './VectorMemory'
import { KnowledgeGraph } from './KnowledgeGraph'
import { EngineeringMemory } from './EngineeringMemory'
import { DecisionStore } from './DecisionStore'
import { MetaController } from './MetaController'
import { UnifiedMemoryQuery } from './UnifiedMemoryQuery'
import { InteractionTracker } from './InteractionTracker'
import { BehaviorWeightingService } from './BehaviorWeightingService'
import { TopicTransitionPredictor } from './TopicTransitionPredictor'
import { KeywordFrequencyTracker } from './KeywordFrequencyTracker'
import { adaptToPlugin } from './IMemoryPlugin'
import { FictionalMemoryGenerator } from './FictionalMemoryGenerator'
import { MemorySnapshotManager } from './MemorySnapshotManager'
import { MemoryUtilityTracker } from './MemoryUtilityTracker'
import { AdaptiveOrchestrator } from './AdaptiveOrchestrator'
import { MemoryCleaner, type BehaviorWeightingIntegration } from './MemoryCleaner'
import { TaskMemoryCleaner } from './TaskMemoryCleaner'
import { MemorySleepManager } from './MemorySleepManager'
import { memoryConfigManager } from './MemoryOptimizationConfig'
import type { MemoryOptimizationStats } from './MemoryOptimizationConfig'
import type { MemoryTunableConfig } from './MemoryOptimizationConfig'
import type { MemoryEntry } from './types'
import type { InterestProfile } from './BehaviorWeightingService'
import type { SummaryLLM } from './MetaController'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import {
  BEHAVIOR_WEIGHT_WINDOW_SIZE,
  BEHAVIOR_WEIGHT_RECENCY_DECAY,
  BEHAVIOR_WEIGHT_BASE_BOOST,
  BEHAVIOR_WEIGHT_MIN_STRENGTH,
  BEHAVIOR_WEIGHT_UPDATE_INTERVAL,
  BEHAVIOR_REINFORCE_BOOST,
  TOPIC_TRANSITION_WINDOW_SIZE,
  TOPIC_TRANSITION_MIN_FREQUENCY,
  TOPIC_TRANSITION_PREFETCH_MIN_PROB,
  TOPIC_TRANSITION_PREFETCH_MAX_ENTRIES,
  TOPIC_TRANSITION_PREFETCH_TTL_MS,
  TOPIC_TRANSITION_PREFETCH_CACHE_MAX,
} from '@akemi-mio/core/config'

// ===== 任务状态 & 用户画像类型 =====

export interface TaskStep {
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  result?: string
  completedAt?: number
}

export interface TaskStateData {
  taskId: string
  title: string
  description: string
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  steps: TaskStep[]
  lastStepIndex: number
  createdAt: number
  updatedAt: number
  sessionIds: string[]
  tags: string[]
}

export interface UserProfileData {
  key: string
  value: string
  confidence: number
  category: 'style' | 'detail' | 'language' | 'preference' | 'identity' | 'other'
  source: string
  updatedAt: number
}

// ===== 层级容量 =====
const MAX_PERMANENT = 10
const MAX_SEMI = 30
const MAX_EPHEMERAL = 50

// ===== 层级衰减率 =====
const DECAY_PERMANENT = 1.0 // 永不衰减
const DECAY_SEMI = 0.998 // 慢衰减（~346天减半）
const DECAY_EPHEMERAL = 0.99 // 正常衰减（~69天减半）

// ===== 晋升阈值 =====
const PROMOTE_SEMI_CONFIDENCE = 0.85 // 临时→半永久
const PROMOTE_PERMANENT_REINFORCE = 5 // 强化≥5次→永久
const PROMOTE_PERMANENT_CONFIDENCE = 0.97 // 置信度≥0.97→永久

const MIN_CONFIDENCE = 0.5
const INTERACTION_RECORD_INTERVAL = 5

// ===== 行为驱动得分参数 =====
const BEHAVIOR_SCORE_INITIAL = 0.5 // 新记忆初始得分
const BEHAVIOR_SCORE_ACCESS_BOOST = 0.05 // 每次访问加分
const BEHAVIOR_SCORE_EXPLICIT_REMEMBER_BOOST = 0.15 // 明确要求记住加分
const BEHAVIOR_SCORE_DAILY_DECAY = 0.015 // 每天未访问减去（~10.5%/周，符合行为强化的10%/周衰减目标）
const BEHAVIOR_SCORE_MIN = 0.1 // 最低得分（避免归零无法恢复）
const BEHAVIOR_SCORE_MAX = 1.0 // 最高得分
// 综合得分公式中 behaviorScore 的权重（剩余为 confidence）
const BEHAVIOR_WEIGHT = 0.7
const CONFIDENCE_WEIGHT = 0.3
// 后台衰减检查间隔（毫秒）
const DECAY_CHECK_INTERVAL = 30 * 60 * 1000 // 每 30 分钟

// 效用清理检查间隔（毫秒），每 24 小时执行一次完整清理
const UTILITY_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000

let idCounter = 0
function nextId(): string {
  return 'mem_' + Date.now() + '_' + ++idCounter
}

/** 从 DB 的 JSON 字符串解析 topics 数组 */
function parseTopicsFromDb(raw: any): string[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export class MemoryService {
  private entries: MemoryEntry[] = []
  private messageCount: number = 0
  private lastUserText: string = ''
  private removedIds = new Set<string>()
  private decayTimer: ReturnType<typeof setInterval> | null = null
  private quickCleanupTimer: ReturnType<typeof setInterval> | null = null
  private lastCleanupTime: number = 0

  readonly summary: SummaryMemory
  readonly vector: VectorMemory
  readonly knowledgeGraph: KnowledgeGraph
  readonly engineering: EngineeringMemory
  readonly decisionStore: DecisionStore
  readonly metaController: MetaController
  readonly unifiedQuery: UnifiedMemoryQuery
  readonly interactionTracker: InteractionTracker
  readonly behaviorWeighting: BehaviorWeightingService
  readonly topicTransitionPredictor: TopicTransitionPredictor
  readonly fictionalGenerator: FictionalMemoryGenerator
  readonly utilityTracker: MemoryUtilityTracker
  readonly cleaner: MemoryCleaner
  readonly taskCleaner: TaskMemoryCleaner
  readonly sleepManager: MemorySleepManager
  readonly adaptiveOrchestrator: AdaptiveOrchestrator
  readonly keywordFreqTracker: KeywordFrequencyTracker
  /** 记忆驱动的 Agent 主动服务 — 快照管理器 */
  readonly snapshotManager: MemorySnapshotManager

  constructor() {
    this.summary = new SummaryMemory()
    this.vector = new VectorMemory()
    this.knowledgeGraph = new KnowledgeGraph()
    this.engineering = new EngineeringMemory()
    this.decisionStore = new DecisionStore()
    this.fictionalGenerator = new FictionalMemoryGenerator()
    this.utilityTracker = new MemoryUtilityTracker()

    // 构造行为加权集成对象，将 BehaviorWeightingService 关联到 MemoryCleaner
    const behaviorWeightingIntegration: BehaviorWeightingIntegration = {
      computeCleanupMultiplier: (memoryTopics: string[]) => {
        const interactions = this.interactionTracker?.getAll() ?? []
        const profile = this.behaviorWeighting?.computeInterestProfile(interactions)
        if (!profile) return 1.0
        return this.behaviorWeighting.computeCleanupMultiplier(memoryTopics, interactions, profile)
      },
    }
    this.cleaner = new MemoryCleaner(this.utilityTracker, {
      behaviorWeighting: behaviorWeightingIntegration,
    })
    this.taskCleaner = new TaskMemoryCleaner()
    this.lastCleanupTime = Date.now() // 初始化清理计时器
    this.metaController = new MetaController()
    this.metaController.setDeps({
      summary: this.summary,
      decisions: this.decisionStore,
      memory: this,
    })
    this.unifiedQuery = new UnifiedMemoryQuery()
    this.unifiedQuery.register('memory', this)
    this.unifiedQuery.register('vector', this.vector)
    this.unifiedQuery.register('summary', this.summary)
    this.unifiedQuery.register('kg', this.knowledgeGraph)
    this.unifiedQuery.register('engineering', this.engineering)
    // 注册正式插件接口（IMemoryPlugin），使各 store 可通过统一插件协议检索和更新
    this.unifiedQuery.registerPlugin(adaptToPlugin('vector', this.vector))
    this.unifiedQuery.registerPlugin(adaptToPlugin('kg', this.knowledgeGraph))
    this.unifiedQuery.registerPlugin(adaptToPlugin('engineering', this.engineering))
    this.unifiedQuery.registerPlugin(adaptToPlugin('summary', this.summary))
    this.interactionTracker = new InteractionTracker()
    this.behaviorWeighting = new BehaviorWeightingService({
      interestWindowSize: BEHAVIOR_WEIGHT_WINDOW_SIZE,
      recencyDecayRate: BEHAVIOR_WEIGHT_RECENCY_DECAY,
      baseBoostFactor: BEHAVIOR_WEIGHT_BASE_BOOST,
      minInterestStrength: BEHAVIOR_WEIGHT_MIN_STRENGTH,
      updateIntervalMs: BEHAVIOR_WEIGHT_UPDATE_INTERVAL,
    })
    this.topicTransitionPredictor = new TopicTransitionPredictor({
      windowSize: TOPIC_TRANSITION_WINDOW_SIZE,
      minTransitionFrequency: TOPIC_TRANSITION_MIN_FREQUENCY,
      prefetchMinProbability: TOPIC_TRANSITION_PREFETCH_MIN_PROB,
      prefetchMaxEntries: TOPIC_TRANSITION_PREFETCH_MAX_ENTRIES,
      prefetchTtlMs: TOPIC_TRANSITION_PREFETCH_TTL_MS,
      prefetchCacheMax: TOPIC_TRANSITION_PREFETCH_CACHE_MAX,
    })
    this.load()
    this.interactionTracker.load()
    // 从 InteractionTracker 中加载历史数据到话题转移预测器
    this.topicTransitionPredictor.loadFromInteractionRecords(this.interactionTracker.getAll())
    // 初始化关键字频率跟踪器
    this.keywordFreqTracker = new KeywordFrequencyTracker()
    // 从现有交互记录中回填关键字频率
    this.backfillKeywordFrequency()
    this.keywordFreqTracker.startDecayTimer()
    // 启动定期衰减任务（同时管理效用衰减和清理）
    this.startDecayTimer()
    // 启动快速清理定时器（每 6 小时清理长期未访问的低权重记忆）
    this.startQuickCleanupTimer()
    // 初始化智能休眠管理器（空闲检测、低频压缩、活跃预加载）
    this.sleepManager = new MemorySleepManager(
      () => this.entries,
      this.removedIds,
      (entry) => this.upsertInDb(entry),
    )
    this.sleepManager.start()

    // 初始化记忆快照管理器（记忆驱动的 Agent 主动服务）
    this.snapshotManager = new MemorySnapshotManager()
    this.snapshotManager.setDeps({ memory: this, summary: this.summary })
    // 从已有摘要生成初始快照（非阻塞）
    this.snapshotManager.generateSnapshot()

    // 初始化记忆驱动自适应编排器（仅依赖 Memory 自身的数据源）
    this.adaptiveOrchestrator = new AdaptiveOrchestrator({
      getInteractions: () => this.interactionTracker.getAll(),
      getProcedures: () => this.getProceduresFallback(),
      matchTemplates: undefined, // 由 configureAdaptiveOrchestrator 注入
    })
    // 初始挖掘一次模式（基于 InteractionTracker 数据）
    this.adaptiveOrchestrator.triggerMining()
    const kwStats = this.keywordFreqTracker?.getStats()
    log('INFO', 'memory_loaded', {
      entries: this.entries.length,
      permanent: this.entries.filter((e) => e.tier === 'permanent').length,
      semi: this.entries.filter((e) => e.tier === 'semi').length,
      ephemeral: this.entries.filter((e) => e.tier === 'ephemeral').length,
      interactions: this.interactionTracker.getAll().length,
      keywords: kwStats?.totalKeywords ?? 0,
    })
  }

  private load(): void {
    try {
      const db = getRawDb()
      const result = db.exec('SELECT * FROM memories ORDER BY updated_at ASC')
      if (result && result.length > 0) {
        const columns = result[0].columns
        this.entries = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            type: obj.type,
            content: obj.content,
            confidence: obj.confidence,
            tier: obj.tier || 'ephemeral',
            reinforceCount: obj.reinforce_count || 0,
            behaviorScore: obj.behavior_score ?? BEHAVIOR_SCORE_INITIAL,
            lastAccessedAt: obj.last_accessed_at || 0,
            accessCount: obj.access_count || 0,
            isPinned: obj.is_pinned === 1 || obj.is_pinned === true,
            manualScoreOverride: obj.manual_score_override ?? null,
            utilityScore: obj.utility_score ?? 0.5,
            agentReferenceCount: obj.agent_reference_count || 0,
            userConfirmedUsefulCount: obj.user_confirmed_useful_count || 0,
            lastUtilityUpdateAt: obj.last_utility_update_at || 0,
            createdAt: obj.created_at,
            updatedAt: obj.updated_at,
            structuredData: obj.structured_data || null,
            topics: parseTopicsFromDb(obj.topics),
          } as MemoryEntry
        })
      }
    } catch (err) {
      log('WARN', 'memory_load_failed', { error: String(err) })
    }
  }

  /**
   * 从现有交互记录中回填关键字频率。
   * 在构造时调用，使 KeywordFrequencyTracker 从已持久化的交互数据中学习初始频率。
   */
  private backfillKeywordFrequency(): void {
    try {
      const interactions = this.interactionTracker.getAll()
      if (interactions.length === 0) return

      const batchEntries: Array<{ keywords: string[]; timestamp: number }> = []
      for (const record of interactions) {
        if (record.topics && record.topics.length > 0) {
          batchEntries.push({
            keywords: record.topics,
            timestamp: record.timestamp,
          })
        }
      }

      if (batchEntries.length > 0) {
        this.keywordFreqTracker.recordKeywordsBatch(batchEntries)
        log('INFO', 'keyword_freq_backfilled', { count: batchEntries.length })
      }
    } catch (err) {
      log('WARN', 'keyword_freq_backfill_failed', { error: String(err) })
    }
  }

  addEntry(
    type: MemoryEntry['type'],
    content: string,
    confidence: number,
    options?: { tier?: MemoryEntry['tier']; structuredData?: string | null },
  ): void {
    if (confidence < MIN_CONFIDENCE) return

    // 1. 精确去重 → 强化计数 + 置信度提升
    const exactExisting = this.entries.find((e) => e.type === type && e.content === content)
    if (exactExisting) {
      const oldConfidence = exactExisting.confidence
      const oldTier = exactExisting.tier
      exactExisting.updatedAt = Date.now()
      exactExisting.confidence = Math.max(exactExisting.confidence, confidence)
      exactExisting.reinforceCount++
      // 检查是否该晋升
      this.tryPromote(exactExisting)
      this.upsertInDb(exactExisting)

      // 发射记忆更新事件
      const changes: Array<{ field: string; oldValue?: unknown; newValue?: unknown }> = []
      if (exactExisting.confidence !== oldConfidence)
        changes.push({ field: 'confidence', oldValue: oldConfidence, newValue: exactExisting.confidence })
      if (exactExisting.tier !== oldTier) changes.push({ field: 'tier', oldValue: oldTier, newValue: exactExisting.tier })
      eventBus.emit('memory.entry.updated', {
        version: 1,
        entryId: exactExisting.id,
        type: exactExisting.type,
        contentSnippet: exactExisting.content.slice(0, 50),
        tier: exactExisting.tier,
        changes,
        timestamp: Date.now(),
      })

      return
    }

    // 2. 前缀模糊去重（近似内容合并）
    if (type === 'user_fact') {
      const similarIdx = this.entries.findIndex(
        (e) =>
          e.type === 'user_fact' &&
          content.length > 10 &&
          e.content.length > 10 &&
          (content.startsWith(e.content) || e.content.startsWith(content)),
      )
      if (similarIdx >= 0) {
        const existing = this.entries[similarIdx]
        existing.updatedAt = Date.now()
        existing.confidence = Math.max(existing.confidence, confidence)
        existing.reinforceCount++
        if (content.length > existing.content.length) existing.content = content
        this.tryPromote(existing)
        this.upsertInDb(existing)
        return
      }
    }

    // 3. 新建条目（初始入临时层）
    const initialTier = options?.tier ?? 'ephemeral'
    const entryTopics = this.extractTopics(content)

    // ── 关键字驱动初始权重：记忆内容匹配高频关键字则提高初始权重 ──
    const keywordMatchScore = this.keywordFreqTracker?.getKeywordMatchScore(entryTopics) ?? 0
    // 匹配度 0-1，每 0.5 匹配度加 0.05 boost，最高加 0.1
    const keywordBoost = Math.min(0.1, keywordMatchScore * 0.1)
    const initialBehaviorScore = Math.min(BEHAVIOR_SCORE_MAX, BEHAVIOR_SCORE_INITIAL + keywordBoost)

    const entry: MemoryEntry = {
      id: nextId(),
      type,
      content,
      confidence,
      tier: initialTier,
      reinforceCount: initialTier === 'permanent' ? 999 : 0,
      behaviorScore: initialBehaviorScore,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      manualScoreOverride: null,
      utilityScore: BEHAVIOR_SCORE_INITIAL,
      agentReferenceCount: 0,
      userConfirmedUsefulCount: 0,
      lastUtilityUpdateAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      topics: entryTopics,
      structuredData: options?.structuredData ?? null,
    }
    this.entries.push(entry)
    this.upsertInDb(entry)

    // 发射记忆创建事件
    eventBus.emit('memory.entry.created', {
      version: 1,
      entryId: entry.id,
      type: entry.type,
      contentSnippet: entry.content.slice(0, 50),
      tier: entry.tier,
      topics: entryTopics,
      timestamp: Date.now(),
    })

    // 永久层不参与 pruning
    if (initialTier !== 'permanent') this.prune()
    else if (this.entries.filter((e) => e.tier === 'permanent').length > MAX_PERMANENT) {
      this.prunePermanent()
    }

    if (type === 'user_fact') {
      this.vector.store(content, confidence, 'user_fact')
      this.knowledgeGraph.ingest(content, confidence)
    }
  }

  /** 自动晋升逻辑 */
  private tryPromote(entry: MemoryEntry): void {
    if (entry.tier === 'permanent') return // 已经是最高层

    // 临时→半永久
    if (entry.tier === 'ephemeral' && entry.confidence >= PROMOTE_SEMI_CONFIDENCE) {
      entry.tier = 'semi'
      entry.updatedAt = Date.now()
      log('INFO', 'memory_promoted_semi', { content: entry.content.slice(0, 50) })
      eventBus.emit('memory.entry.updated', {
        version: 1,
        entryId: entry.id,
        type: entry.type,
        contentSnippet: entry.content.slice(0, 50),
        tier: 'semi',
        changes: [{ field: 'tier', oldValue: 'ephemeral', newValue: 'semi' }],
        timestamp: Date.now(),
      })
    }

    // 半永久→永久
    if (
      entry.tier === 'semi' &&
      (entry.reinforceCount >= PROMOTE_PERMANENT_REINFORCE || entry.confidence >= PROMOTE_PERMANENT_CONFIDENCE)
    ) {
      entry.tier = 'permanent'
      entry.updatedAt = Date.now()
      this.prunePermanent()
      log('INFO', 'memory_promoted_permanent', { content: entry.content.slice(0, 50), reinforceCount: entry.reinforceCount })
      eventBus.emit('memory.entry.updated', {
        version: 1,
        entryId: entry.id,
        type: entry.type,
        contentSnippet: entry.content.slice(0, 50),
        tier: 'permanent',
        changes: [{ field: 'tier', oldValue: 'semi', newValue: 'permanent' }],
        timestamp: Date.now(),
      })
    }
  }

  addFact(
    content: string,
    confidence: number = 0.6,
    options?: {
      tier?: MemoryEntry['tier']
      identity?: { capability?: string; operation?: string; tool?: string }
    },
  ): void {
    let structuredData: string | null = null
    if (options?.identity) {
      structuredData = JSON.stringify({ identity: options.identity })
    }
    this.addEntry('user_fact', content, confidence, { tier: options?.tier, structuredData })
  }

  recordInteraction(userText?: string, responseTimeMs?: number): void {
    this.messageCount++
    // 通知智能休眠管理器有用户交互
    this.sleepManager.recordInteraction()

    // 行为驱动的交互记录
    if (userText) {
      const isExplicitRemember = this.interactionTracker.detectExplicitRemember(userText)
      const knownContents = this.entries.filter((e) => e.type === 'user_fact').map((e) => e.content)
      const rementionedContents = this.interactionTracker.detectRementions(userText, knownContents)

      // 找到被重新提及的记忆 ID
      const rementionedIds = this.entries.filter((e) => rementionedContents.includes(e.content)).map((e) => e.id)

      // 提取简单主题标签
      const topics = this.extractTopics(userText)

      this.interactionTracker.record({
        userText,
        responseTimeMs,
        topics,
        isExplicitRemember,
        rementionedMemoryIds: rementionedIds,
      })

      // ── 关键字频率跟踪：将话题标签作为关键字记录 ──
      if (topics.length > 0) {
        this.keywordFreqTracker.recordKeywords(topics)
      }

      // ── 话题转移预测与记忆预取 ──
      // 记录当前话题到转移矩阵，并触发下一话题预测和预取
      if (topics.length > 0) {
        this.topicTransitionPredictor.recordTopics(topics)
        const predictions = this.topicTransitionPredictor.predictNextTopics(topics, 3)
        if (predictions.length > 0) {
          this.topicTransitionPredictor.prefetchMemories(predictions, (topic, limit) =>
            this.entries
              .filter((e) => e.type === 'user_fact' && e.topics && e.topics.includes(topic))
              .sort((a, b) => this.getBehaviorWeightedScore(b) - this.getBehaviorWeightedScore(a))
              .slice(0, limit),
          )
        }
      }

      // 新交互到来，清除行为加权缓存以触发重新计算
      this.behaviorWeighting.invalidateCache()

      // 如果明确要求记住，提升相关记忆的行为得分
      if (isExplicitRemember && rementionedIds.length > 0) {
        for (const id of rementionedIds) {
          this.accessMemory(id, { explicitRemember: true })
        }
      } else if (rementionedIds.length > 0) {
        // 重新提及 → 普通加分
        for (const id of rementionedIds) {
          this.accessMemory(id)
        }
      }
    }

    if (this.messageCount % INTERACTION_RECORD_INTERVAL === 0) {
      this.addEntry('interaction', '进行了 ' + this.messageCount + ' 次对话交互', 0.6)
    }
  }

  /** 从用户消息中提取简单主题标签 */
  private extractTopics(text: string): string[] {
    const topics: string[] = []
    const lower = text.toLowerCase()
    const topicPatterns: Array<{ regex: RegExp; label: string }> = [
      { regex: /代码|编程|code|typescript|javascript|python|rust|java/, label: '编程' },
      { regex: /bug|错误|报错|修复|fix|error|debug/, label: '调试' },
      { regex: /记忆|记住|memory|回忆|之前/, label: '记忆' },
      { regex: /部署|deploy|上线|发布|release/, label: '部署' },
      { regex: /测试|test|单元测试|集成测试/, label: '测试' },
      { regex: /架构|设计|architecture|design|重构|refactor/, label: '架构' },
      { regex: /文档|doc|readme|注释|comment/, label: '文档' },
      { regex: /性能|performance|优化|慢|卡/, label: '性能' },
      { regex: /安全|security|漏洞|权限|auth/, label: '安全' },
      { regex: /电报|telegram|消息|推送/, label: 'Telegram' },
      { regex: /进化|evolution|自我|self/, label: '自进化' },
      { regex: /画画|画图|生成|图片|image|生成图/, label: '图像生成' },
      { regex: /任务|task|计划|plan|todo/, label: '任务管理' },
      { regex: /api|接口|请求|响应|http/, label: 'API' },
      { regex: /数据库|database|sql|db|查询/, label: '数据库' },
      { regex: /聊天|对话|问答|ask|question/, label: '问答' },
      { regex: /设置|配置|config|setting|偏好/, label: '配置' },
      { regex: /学习|教程|tutorial|how.?to|示例/, label: '学习' },
    ]
    for (const { regex, label } of topicPatterns) {
      if (regex.test(lower)) topics.push(label)
    }
    return [...new Set(topics)].slice(0, 5)
  }

  // ══════════════════════════════════════════
  //  行为驱动得分
  // ══════════════════════════════════════════

  /**
   * 行为强化记忆巩固：根据 UserBehaviorAnalyzer 检测到的重复话题模式，
   * 自动强化相关记忆条目的检索权重，并生成标签关联。
   *
   * 调用时机：ChatExecutor.refreshMemory() 中检测到重复模式后。
   *
   * @param topics 检测到的话题标签列表
   * @param sourceText 触发强化的用户消息摘要（用于新建记忆条目）
   * @param boostAmount 每次强化的 boost 量（默认 0.08，约需 6 次达标到 1.0）
   * @returns 被强化的条目数和新创建的条目数
   */
  reinforceByBehaviorPattern(
    topics: string[],
    sourceText: string,
    boostAmount: number = BEHAVIOR_REINFORCE_BOOST,
  ): { boosted: number; created: number } {
    if (!topics || topics.length === 0) return { boosted: 0, created: 0 }

    let boosted = 0
    let created = 0

    // 1. 查找与话题标签匹配的记忆条目并提升 behaviorScore
    for (const entry of this.entries) {
      if (entry.tier === 'permanent' || entry.isPinned) continue
      if (!entry.topics || entry.topics.length === 0) continue

      const hasOverlap = entry.topics.some((t) => topics.includes(t))
      if (!hasOverlap) continue

      const oldScore = entry.behaviorScore
      entry.behaviorScore = Math.min(BEHAVIOR_SCORE_MAX, entry.behaviorScore + boostAmount)
      entry.lastAccessedAt = Date.now()
      entry.accessCount++
      entry.updatedAt = Date.now()

      // 合并新话题标签到已有条目
      const newTopics = [...new Set([...(entry.topics || []), ...topics])]
      entry.topics = newTopics.slice(0, 8) // 最多 8 个标签

      this.upsertInDb(entry)
      boosted++

      log('INFO', 'memory_reinforced_by_behavior', {
        id: entry.id,
        content: entry.content.slice(0, 50),
        oldScore: oldScore.toFixed(3),
        newScore: entry.behaviorScore.toFixed(3),
        topics: entry.topics.slice(0, 5),
      })

      // 发射记忆更新事件（行为强化）
      eventBus.emit('memory.entry.updated', {
        version: 1,
        entryId: entry.id,
        type: entry.type,
        contentSnippet: entry.content.slice(0, 50),
        tier: entry.tier,
        changes: [{ field: 'behaviorScore', oldValue: oldScore, newValue: entry.behaviorScore }],
        timestamp: Date.now(),
      })
    }

    // 2. 如果没有匹配的现有条目，创建新的半永久记忆条目
    if (boosted === 0 && sourceText) {
      const topicLabel = topics.slice(0, 3).join('、')
      const content = `【行为强化】用户近期频繁关注：${topicLabel}。触发消息：「${sourceText.slice(0, 100)}」`
      const entry: MemoryEntry = {
        id: nextId(),
        type: 'user_fact',
        content,
        confidence: 0.55,
        tier: 'semi', // 半永久层，慢衰减
        reinforceCount: 0,
        behaviorScore: BEHAVIOR_SCORE_INITIAL + boostAmount,
        lastAccessedAt: Date.now(),
        accessCount: 1,
        isPinned: false,
        manualScoreOverride: null,
        utilityScore: BEHAVIOR_SCORE_INITIAL,
        agentReferenceCount: 0,
        userConfirmedUsefulCount: 0,
        lastUtilityUpdateAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        topics: [...topics],
      }
      this.entries.push(entry)
      this.upsertInDb(entry)
      created++

      log('INFO', 'memory_created_by_behavior_reinforcement', {
        id: entry.id,
        topics: topics.slice(0, 5),
        sourceSnippet: sourceText.slice(0, 60),
      })

      // 发射记忆创建事件（行为强化）
      eventBus.emit('memory.entry.created', {
        version: 1,
        entryId: entry.id,
        type: entry.type,
        contentSnippet: entry.content.slice(0, 50),
        tier: entry.tier,
        timestamp: Date.now(),
      })
    }

    return { boosted, created }
  }

  /** 访问/引用记忆时提升行为得分 */
  accessMemory(id: string, options?: { explicitRemember?: boolean }): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false

    const boost = options?.explicitRemember ? BEHAVIOR_SCORE_EXPLICIT_REMEMBER_BOOST : BEHAVIOR_SCORE_ACCESS_BOOST

    entry.behaviorScore = Math.min(BEHAVIOR_SCORE_MAX, entry.behaviorScore + boost)
    entry.lastAccessedAt = Date.now()
    entry.accessCount++
    entry.updatedAt = Date.now()
    this.upsertInDb(entry)
    return true
  }

  /** 计算记忆的综合重要性得分（行为驱动 + 置信度） */
  getEffectiveScore(entry: MemoryEntry): number {
    // 人工覆盖优先
    if (entry.manualScoreOverride !== null) {
      return entry.manualScoreOverride
    }
    // 固定记忆永远高分
    if (entry.isPinned) return 1.0
    // 永久层记忆天然高分
    if (entry.tier === 'permanent') return 1.0

    // 综合得分：行为分 + 置信度加权
    const now = Date.now()
    const daysSinceAccess =
      entry.lastAccessedAt > 0 ? (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24) : (now - entry.createdAt) / (1000 * 60 * 60 * 24)

    // 线性衰减：每天减 BEHAVIOR_SCORE_DAILY_DECAY
    const decayedBehaviorScore = Math.max(BEHAVIOR_SCORE_MIN, entry.behaviorScore - BEHAVIOR_SCORE_DAILY_DECAY * daysSinceAccess)

    return CONFIDENCE_WEIGHT * entry.confidence + BEHAVIOR_WEIGHT * decayedBehaviorScore
  }

  // ══════════════════════════════════════════
  //  短期行为驱动加权检索
  // ══════════════════════════════════════════

  /** 获取当前兴趣分布（基于最近交互记录） */
  getCurrentInterestProfile(): InterestProfile {
    const interactions = this.interactionTracker.getRecent()
    return this.behaviorWeighting.computeInterestProfile(interactions)
  }

  /**
   * 计算行为加权后的记忆得分（基础分 + 兴趣相似度 boost）。
   * 用于检索时的动态排序。
   */
  getBehaviorWeightedScore(entry: MemoryEntry, profile?: InterestProfile): number {
    const baseScore = this.getEffectiveScore(entry)

    // 固定/永久记忆不受兴趣加权影响
    if (entry.isPinned || entry.tier === 'permanent' || entry.manualScoreOverride !== null) {
      return baseScore
    }

    const interestProfile = profile || this.getCurrentInterestProfile()
    return this.behaviorWeighting.getWeightedScore(baseScore, entry.topics || [], interestProfile)
  }

  /**
   * 获取行为加权排序后的记忆（按得分降序）。
   * 优先返回与当前用户兴趣相关的记忆。
   */
  getBehaviorWeightedEntries(tier?: MemoryEntry['tier'], limit?: number): MemoryEntry[] {
    const profile = this.getCurrentInterestProfile()
    const filtered = tier
      ? this.entries.filter((e) => e.tier === tier && e.type === 'user_fact')
      : this.entries.filter((e) => e.type === 'user_fact')

    const scored = filtered.map((e) => ({ entry: e, score: this.getBehaviorWeightedScore(e, profile) })).sort((a, b) => b.score - a.score)

    return (limit ? scored.slice(0, limit) : scored).map((s) => s.entry)
  }

  /**
   * 按类型查询记忆条目。
   * 用于快照管理、审计和调试场景。
   */
  getEntriesByType(type: MemoryEntry['type']): MemoryEntry[] {
    return this.entries.filter((e) => e.type === type)
  }

  /**
   * 直接移除指定 ID 的记忆条目。
   * 用于快照过期清理等场景。
   * @returns 是否找到并标记了移除
   */
  removeEntryById(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx === -1) return false
    this.entries.splice(idx, 1)
    this.removedIds.add(id)
    return true
  }

  /** 批量应用每日衰减（由定时器调用） */
  applyDecay(): void {
    const now = Date.now()
    let decayed = 0
    for (const entry of this.entries) {
      if (entry.tier === 'permanent' || entry.isPinned) continue
      if (entry.manualScoreOverride !== null) continue

      const daysSinceAccess =
        entry.lastAccessedAt > 0 ? (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24) : (now - entry.createdAt) / (1000 * 60 * 60 * 24)

      const newScore = Math.max(BEHAVIOR_SCORE_MIN, entry.behaviorScore - BEHAVIOR_SCORE_DAILY_DECAY * daysSinceAccess)

      if (newScore < entry.behaviorScore) {
        entry.behaviorScore = newScore
        decayed++
      }
    }

    // 同时应用效用衰减
    const utilityDecayed = this.utilityTracker.applyDecayToAll(this.entries)

    // 同时应用关键字频率衰减（按间隔自动执行）
    const keywordDecayed = this.keywordFreqTracker?.decayFrequencies() ?? 0

    if (decayed > 0 || utilityDecayed > 0 || keywordDecayed > 0) {
      log('INFO', 'behavior_score_decayed', { behaviorDecayed: decayed, utilityDecayed, total: this.entries.length })
      this.prune()
      eventBus.emit('memory.context.changed', {
        version: 1,
        totalEntries: this.entries.length,
        tiers: {
          ephemeral: this.entries.filter((e) => e.tier === 'ephemeral').length,
          semi: this.entries.filter((e) => e.tier === 'semi').length,
          permanent: this.entries.filter((e) => e.tier === 'permanent').length,
        },
        timestamp: Date.now(),
      })
    }

    // 定期效用清理（每 24 小时检查一次）
    if (now - this.lastCleanupTime >= UTILITY_CLEANUP_INTERVAL) {
      this.lastCleanupTime = now
      this.cleaner.runCleanup(this.entries, this.removedIds)
      // 同时执行任务步骤过期清理
      const activeTaskIds = new Set(this.getUnfinishedTasks().map((t) => t.taskId))
      this.taskCleaner.runCleanup(this.entries, activeTaskIds)
    }
  }

  private startDecayTimer(): void {
    if (this.decayTimer) clearInterval(this.decayTimer)
    this.decayTimer = setInterval(() => {
      this.applyDecay()
    }, DECAY_CHECK_INTERVAL)
  }

  /** 快速清理定时器（每 6 小时清理长期未访问的低权重记忆） */
  private startQuickCleanupTimer(): void {
    if (this.quickCleanupTimer) clearInterval(this.quickCleanupTimer)
    const QUICK_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时

    this.quickCleanupTimer = setInterval(() => {
      log('INFO', 'memory_quick_cleanup_tick')
      this.cleaner.quickCleanup(this.entries, this.removedIds)
    }, QUICK_CLEANUP_INTERVAL_MS)
  }

  // ══════════════════════════════════════════
  //  人工干预入口
  // ══════════════════════════════════════════

  /** 固定记忆（不受自动清理影响） */
  pinMemory(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.isPinned = true
    entry.updatedAt = Date.now()
    this.upsertInDb(entry)
    log('INFO', 'memory_pinned', { id, content: entry.content.slice(0, 50) })
    eventBus.emit('memory.entry.updated', {
      version: 1,
      entryId: entry.id,
      type: entry.type,
      contentSnippet: entry.content.slice(0, 50),
      tier: entry.tier,
      changes: [{ field: 'isPinned', oldValue: false, newValue: true }],
      timestamp: Date.now(),
    })
    return true
  }

  /** 取消固定 */
  unpinMemory(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.isPinned = false
    entry.updatedAt = Date.now()
    this.upsertInDb(entry)
    log('INFO', 'memory_unpinned', { id, content: entry.content.slice(0, 50) })
    eventBus.emit('memory.entry.updated', {
      version: 1,
      entryId: entry.id,
      type: entry.type,
      contentSnippet: entry.content.slice(0, 50),
      tier: entry.tier,
      changes: [{ field: 'isPinned', oldValue: true, newValue: false }],
      timestamp: Date.now(),
    })
    return true
  }

  /** 手动覆盖记忆得分（null=恢复自动计算） */
  setManualScore(id: string, score: number | null): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    if (score !== null && (score < 0 || score > 1)) return false
    entry.manualScoreOverride = score
    entry.updatedAt = Date.now()
    this.upsertInDb(entry)
    log('INFO', 'memory_manual_score', { id, score, content: entry.content.slice(0, 50) })
    return true
  }

  /**
   * 设置/更新一条记忆条目的结构化数据（JSON 字符串）。
   * 用于外部模块在不重新创建条目的情况下附加额外元数据。
   * @returns true 如果找到并更新了条目
   */
  setEntryStructuredData(id: string, structuredData: string | null): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.structuredData = structuredData
    entry.updatedAt = Date.now()
    this.upsertInDb(entry)
    return true
  }

  /** 获取被固定的记忆列表 */
  getPinnedMemories(): MemoryEntry[] {
    return this.entries.filter((e) => e.isPinned)
  }

  /** 获取得分最低的 N 条记忆（用于手动审查） */
  getLowestScored(limit = 10): MemoryEntry[] {
    return [...this.entries]
      .filter((e) => e.tier !== 'permanent' && !e.isPinned)
      .map((e) => ({ entry: e, score: this.getEffectiveScore(e) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map((s) => s.entry)
  }

  // ══════════════════════════════════════════
  //  时间模式预加载
  // ══════════════════════════════════════════

  /** 获取当前时段建议预加载的记忆（基于历史行为模式） */
  getPreloadMemoriesForCurrentHour(): MemoryEntry[] {
    const hour = new Date().getHours()
    const suggestedTopics = this.interactionTracker.getSuggestedTopicsForHour(hour)
    if (suggestedTopics.length === 0) return []

    const profile = this.getCurrentInterestProfile()
    return this.entries
      .filter((e) => e.type === 'user_fact')
      .filter((e) => {
        const lower = e.content.toLowerCase()
        return suggestedTopics.some((topic) => lower.includes(topic.toLowerCase()))
      })
      .sort((a, b) => this.getBehaviorWeightedScore(b, profile) - this.getBehaviorWeightedScore(a, profile))
      .slice(0, 5)
  }

  /** 获取预加载记忆的格式化上下文（用于注入 system prompt） */
  getPreloadContext(): string {
    const preload = this.getPreloadMemoriesForCurrentHour()
    if (preload.length === 0) return ''
    const parts = ['---', '【基于行为模式的预加载记忆】', '根据你在此时段的历史行为，以下信息可能相关：']
    for (const e of preload) {
      parts.push('- ' + e.content)
    }
    parts.push('---')
    return parts.join('\n')
  }

  // ══════════════════════════════════════════
  //  话题转移预测与记忆预取
  // ══════════════════════════════════════════

  /**
   * 获取话题转移预测的预取上下文（用于注入 system prompt）。
   * 基于当前最后一条用户消息的话题，预测下一话题并返回预取缓存中
   * 的相关记忆。如果预取缓存已命中，直接使用缓存结果。
   */
  getPredictedTopicPreloadContext(): string {
    if (!this.lastUserText) return ''
    const topics = this.extractTopics(this.lastUserText)
    if (topics.length === 0) return ''
    return this.topicTransitionPredictor.getPrefetchContext(topics)
  }

  /**
   * 快速查询预取缓存：如果目标话题已被预测并预取，直接返回缓存内容。
   * 用于对外提供低延迟的记忆检索路径。
   *
   * @param topic 要查询的话题标签
   * @returns 缓存条目（含记忆列表和来源标记），或 null
   */
  queryPrefetchedMemory(topic: string): { entries: MemoryEntry[]; source: 'cache' } | null {
    return this.topicTransitionPredictor.queryPrefetched(topic)
  }

  /**
   * 获取话题转移统计摘要。
   */
  getTopicTransitionStats(): ReturnType<TopicTransitionPredictor['getStats']> {
    return this.topicTransitionPredictor.getStats()
  }

  getInteractionCount(): number {
    return this.messageCount
  }

  /** 注入 LLM 服务用于生成高质量摘要（传递给 MetaController 和 SleepManager） */
  setSummaryLLM(llm: SummaryLLM): void {
    this.metaController.setDeps({
      summary: this.summary,
      decisions: this.decisionStore,
      memory: this,
      summaryLLM: llm,
    })
    this.sleepManager.setSummaryLLM(llm)
  }

  /** 设置最近的用户消息文本，用于 getFormattedContext 中的语义召回 */
  setLastUserText(text: string): void {
    this.lastUserText = text
  }

  /** 获取最近的用户消息文本 */
  getLastUserText(): string {
    return this.lastUserText
  }

  /**
   * 获取最新记忆快照（记忆驱动的 Agent 主动服务）。
   * 返回结构化快照，包含压缩摘要、话题标签、连续多日话题检测结果、
   * 工具推荐和开场建议。Agent 启动时调用此方法注入系统提示。
   */
  getMemorySnapshot(): ReturnType<MemorySnapshotManager['getLatestSnapshot']> {
    return this.snapshotManager.getLatestSnapshot()
  }

  /**
   * 获取格式化后的记忆快照上下文（用于注入 system prompt）。
   */
  getSnapshotContext(): string {
    return this.snapshotManager.getFormattedSnapshotContext()
  }

  /**
   * 获取虚构初始记忆上下文（用于暖启动）。
   * 仅在真实 user_fact 条目不足时返回，权重随真实记忆增长线性衰减。
   * 返回值已标注为虚构，且在真实记忆达到阈值后完全消失。
   */
  getFictionalMemoryContext(): string {
    // 统计真实 user_fact 条目（排除虚构类型）
    const realFacts = this.entries.filter((e) => e.type === 'user_fact')
    const FICTIONAL_THRESHOLD = 10

    // 真实记忆足够时不再注入虚构记忆
    const weight = FictionalMemoryGenerator.computeWeight(realFacts.length, FICTIONAL_THRESHOLD)
    if (weight <= 0) return ''

    // 检查是否已有缓存的虚构记忆（避免重复生成）
    const existingFictional = this.entries.find((e) => e.type === 'fictional')
    let fictionalText: string
    let selectedTraits: string[]

    if (existingFictional) {
      fictionalText = existingFictional.content
      try {
        selectedTraits = existingFictional.topics || []
      } catch {
        selectedTraits = []
      }
    } else {
      // 生成并缓存虚构记忆
      const result = this.fictionalGenerator.generate()
      fictionalText = result.text
      selectedTraits = result.selectedTraits

      // 作为虚构类型条目缓存（tier=ephemeral，会在真实记忆增长后自然衰减）
      const entry: MemoryEntry = {
        id: 'fictional_init_' + this.fictionalGenerator.getSeed().toString(16),
        type: 'fictional',
        content: fictionalText,
        confidence: 0.3, // 低置信度，标记为虚构
        tier: 'ephemeral',
        reinforceCount: 0,
        behaviorScore: 0.3,
        lastAccessedAt: Date.now(),
        accessCount: 0,
        isPinned: false,
        manualScoreOverride: null,
        utilityScore: 0.3,
        agentReferenceCount: 0,
        userConfirmedUsefulCount: 0,
        lastUtilityUpdateAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        topics: selectedTraits,
      }
      this.entries.push(entry)
      this.upsertInDb(entry)
      log('INFO', 'fictional_memory_generated', {
        traits: selectedTraits,
        seed: this.fictionalGenerator.getSeed().toString(16),
      })
    }

    // 根据权重决定展示强度
    // weight >= 0.7：完整展示，标记为"模糊印象"
    // weight >= 0.3：缩略展示，标记为"可能不太准确的回忆"
    // weight < 0.3：只显示一行提示
    if (weight >= 0.7) {
      return `【关于你的模糊印象】（这些是初始印象，随着相处会变得更准确）\n${fictionalText}`
    }
    if (weight >= 0.3) {
      const shortText = fictionalText.length > 60 ? fictionalText.slice(0, 60) + '…' : fictionalText
      return `【关于你的一些过往回忆】（这些印象可能不太准确，你们已经相处了一段时间）\n${shortText}`
    }
    // weight > 0 but < 0.3: minimal mention
    return '【模糊的印象】你们似乎有过一些交集，但记忆已经淡去了。'
  }

  getFormattedContext(): string {
    const parts: string[] = []

    // ── 虚构初始记忆（真实记忆不足时暖启动）──
    const fictionalCtx = this.getFictionalMemoryContext()
    if (fictionalCtx) {
      parts.push(fictionalCtx)
    }

    // 永久层：始终显示
    const permanent = this.entries.filter((e) => e.tier === 'permanent' && e.type === 'user_fact').slice(0, MAX_PERMANENT)
    if (permanent.length > 0) {
      parts.push('【重要的记忆】')
      permanent.forEach((f) => parts.push('- ' + f.content))
    }

    // 半永久 + 临时层：按行为加权得分取 top 5
    const profile = this.getCurrentInterestProfile()
    const semiAndEphemeral = this.entries.filter((e) => (e.tier === 'semi' || e.tier === 'ephemeral') && e.type === 'user_fact')
    const topFacts = semiAndEphemeral
      .map((e) => ({ entry: e, score: this.getBehaviorWeightedScore(e, profile) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.entry)
    if (topFacts.length > 0) {
      parts.push('')
      parts.push('你记得以下关于主人的事：')
      topFacts.forEach((f) => parts.push('- ' + f.content))
    }

    // 语义召回：从 VectorMemory 中取与最近用户消息相关的记忆
    if (this.lastUserText) {
      const relevant = this.vector.querySync(this.lastUserText, 3)
      if (relevant.length > 0) {
        parts.push('')
        parts.push('相关的历史记忆：')
        relevant.forEach((c) => parts.push('- ' + c))
      }
    }

    // 对话摘要
    const summaries = this.summary.getRecent(3)
    if (summaries.length > 0) {
      parts.push('')
      parts.push('之前的对话总结：')
      summaries.forEach((s) => parts.push('- ' + s))
    }

    // 最近的 interaction
    const interactions = this.entries.filter((e) => e.type === 'interaction').slice(-3)
    if (interactions.length > 0) {
      parts.push('')
      parts.push('你们之前聊过：')
      interactions.forEach((i) => parts.push('- ' + i.content))
    }

    // 知识图谱
    const kgCtx = this.knowledgeGraph.getFormattedContext()
    if (kgCtx) {
      parts.push('')
      parts.push(kgCtx)
    }

    // 工程记忆（失败经验 & 设计决策）：检索与当前查询相关的条目
    const engCtx = this.engineering.getFormattedContext(3)
    if (engCtx) {
      parts.push('')
      parts.push(engCtx)
    }

    // 行为模式预加载（基于时间段）
    const preloadCtx = this.getPreloadContext()
    if (preloadCtx) {
      parts.push('')
      parts.push(preloadCtx)
    }

    // 话题转移预测预取（基于当前话题预测下一话题并预取相关记忆）
    const predictedCtx = this.getPredictedTopicPreloadContext()
    if (predictedCtx) {
      parts.push('')
      parts.push(predictedCtx)
    }

    // 智能休眠预加载缓存（基于活跃时段预测的预加载）
    const sleepPreloadCtx = this.sleepManager.getPreloadCacheContext()
    if (sleepPreloadCtx) {
      parts.push('')
      parts.push(sleepPreloadCtx)
    }

    // 记忆驱动自适应编排：基于用户历史行为模式的操作建议
    const adaptiveCtx = this.adaptiveOrchestrator.getFormattedContext()
    if (adaptiveCtx) {
      parts.push('')
      parts.push(adaptiveCtx)
    }

    // 短期行为驱动加权：显示与当前兴趣最匹配的记忆
    const topInterests = this.behaviorWeighting.getTopInterests(profile)
    if (topInterests.length > 0) {
      const interestWeighted = this.getBehaviorWeightedEntries(undefined, 3)
      if (interestWeighted.length > 0) {
        parts.push('')
        parts.push('【当前兴趣相关记忆】根据你最近关注的话题（' + topInterests.join('、') + '），以下记忆可能特别相关：')
        interestWeighted.forEach((e) => parts.push('- ' + e.content))
      }
    }

    // 效用驱动的上下文优先级：高效用记忆（经常被 Agent 引用或用户确认有用）
    const highUtilityEntries = this.entries
      .filter((e) => e.type === 'user_fact' && e.tier !== 'permanent' && this.utilityTracker.isHighUtility(e))
      .sort((a, b) => b.utilityScore - a.utilityScore)
      .slice(0, 3)
    if (highUtilityEntries.length > 0) {
      parts.push('')
      parts.push('【高效用记忆】以下记忆在实际对话中被频繁引用，具有较高价值：')
      highUtilityEntries.forEach((e) => parts.push('- ' + e.content))
    }

    // 记忆驱动的 Agent 主动服务：注入结构化记忆快照（含连续话题检测 + 工具推荐）
    const snapshotCtx = this.getSnapshotContext()
    if (snapshotCtx) {
      parts.push('')
      parts.push(snapshotCtx)
    }

    return parts.length > 0 ? parts.join('\n') : ''
  }

  // ══════════════════════════════════════════
  //  效用跟踪集成
  // ══════════════════════════════════════════

  /**
   * 在 Agent 回复后检测被引用的记忆并更新效用分数。
   * 由 ChatExecutor 在每次 toolLoop 结束后调用。
   *
   * @param agentReply Agent 生成的回复文本
   * @returns 被引用的记忆 ID 列表
   */
  recordAgentReference(agentReply: string): string[] {
    if (!agentReply || this.entries.length === 0) return []
    const referencedIds = this.utilityTracker.recordAgentReference(this.entries, agentReply)
    // 持久化被引用的记忆
    for (const id of referencedIds) {
      const entry = this.entries.find((e) => e.id === id)
      if (entry) this.upsertInDb(entry)
    }
    return referencedIds
  }

  /** 获取效用统计摘要 */
  getUtilityStats() {
    return this.utilityTracker.getStats(this.entries)
  }

  // ══════════════════════════════════════════
  //  记忆优化统计（供 Evolution 自适应优化使用）
  // ══════════════════════════════════════════

  /**
   * 获取全面的记忆优化统计数据。
   * 包含访问模式、效用分布、行为得分分布和当前配置。
   * 供 MemoryOptimizationCollector 分析使用。
   */
  getOptimizationStats(): MemoryOptimizationStats {
    const userFacts = this.entries.filter((e) => e.type === 'user_fact')
    const now = Date.now()
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

    // ── 访问统计 ──
    const accessCounts = userFacts.map((e) => e.accessCount).sort((a, b) => a - b)
    const neverAccessed = userFacts.filter((e) => e.accessCount === 0)
    const staleEntries = userFacts.filter((e) => e.lastAccessedAt > 0 && now - e.lastAccessedAt > SEVEN_DAYS_MS)
    const longTail = userFacts.filter((e) => e.accessCount <= 1 && e.tier !== 'permanent' && !e.isPinned)

    const meanAccess = accessCounts.length > 0 ? accessCounts.reduce((a, b) => a + b, 0) / accessCounts.length : 0
    const medianAccess = accessCounts.length > 0 ? accessCounts[Math.floor(accessCounts.length / 2)] : 0
    const p90Access = accessCounts.length > 0 ? accessCounts[Math.floor(accessCounts.length * 0.9)] : 0
    const p99Access = accessCounts.length > 0 ? accessCounts[Math.floor(accessCounts.length * 0.99)] : 0

    // ── 效用统计 ──
    const utilityScores = userFacts.map((e) => this.utilityTracker.computeUtilityScore(e)).sort((a, b) => a - b)
    const lowUtility = userFacts.filter((e) => this.utilityTracker.isLowUtility(e))
    const highUtility = userFacts.filter((e) => this.utilityTracker.isHighUtility(e))

    const meanUtility = utilityScores.length > 0 ? utilityScores.reduce((a, b) => a + b, 0) / utilityScores.length : 0
    const medianUtility = utilityScores.length > 0 ? utilityScores[Math.floor(utilityScores.length / 2)] : 0

    // ── 行为得分统计 ──
    const behaviorScores = userFacts.map((e) => e.behaviorScore).sort((a, b) => a - b)
    const decayedCount = userFacts.filter((e) => e.behaviorScore < 0.5).length
    const totalAgentReferences = userFacts.reduce((a, e) => a + e.agentReferenceCount, 0)
    const totalUserConfirmations = userFacts.reduce((a, e) => a + e.userConfirmedUsefulCount, 0)

    const meanBehavior = behaviorScores.length > 0 ? behaviorScores.reduce((a, b) => a + b, 0) / behaviorScores.length : 0
    const medianBehavior = behaviorScores.length > 0 ? behaviorScores[Math.floor(behaviorScores.length / 2)] : 0

    return {
      totalEntries: userFacts.length,
      permanentCount: userFacts.filter((e) => e.tier === 'permanent').length,
      semiCount: userFacts.filter((e) => e.tier === 'semi').length,
      ephemeralCount: userFacts.filter((e) => e.tier === 'ephemeral').length,

      accessStats: {
        meanAccessCount: meanAccess,
        medianAccessCount: medianAccess,
        neverAccessedCount: neverAccessed.length,
        neverAccessedRatio: userFacts.length > 0 ? neverAccessed.length / userFacts.length : 0,
        p90AccessCount: p90Access,
        p99AccessCount: p99Access,
        staleEntriesCount: staleEntries.length,
        longTailCount: longTail.length,
        longTailRatio: userFacts.length > 0 ? longTail.length / userFacts.length : 0,
      },

      utilityStats: {
        meanUtility,
        medianUtility,
        lowUtilityCount: lowUtility.length,
        lowUtilityRatio: userFacts.length > 0 ? lowUtility.length / userFacts.length : 0,
        highUtilityCount: highUtility.length,
        highUtilityRatio: userFacts.length > 0 ? highUtility.length / userFacts.length : 0,
      },

      behaviorStats: {
        meanBehaviorScore: meanBehavior,
        medianBehaviorScore: medianBehavior,
        decayedCount,
        totalAgentReferences,
        totalUserConfirmations,
      },

      currentConfig: memoryConfigManager.getConfig(),
    }
  }

  /**
   * 更新记忆可调参数配置（由 MemoryOptimizationExecutor 调用）。
   * 每次变更会创建快照，支持回滚。
   *
   * @param partial 要更新的参数字段
   * @param reason 变更原因
   * @returns 更新后的完整配置
   */
  updateTunableConfig(partial: Partial<MemoryTunableConfig>, reason: string): MemoryTunableConfig {
    return memoryConfigManager.updateConfig(partial, reason)
  }

  /** 获取当前可调参数配置 */
  getTunableConfig(): MemoryTunableConfig {
    return memoryConfigManager.getConfig()
  }

  /** 获取配置变更快照历史 */
  getConfigSnapshots() {
    return memoryConfigManager.getSnapshots()
  }

  /**
   * 回滚最近一次配置变更。
   * @returns 回滚后的配置，或 null（无快照）
   */
  rollbackMemoryConfig(): MemoryTunableConfig | null {
    return memoryConfigManager.rollback()
  }

  /**
   * 获取清理候选列表（预览，不删除）。
   */
  getCleanupCandidates() {
    return this.cleaner.getCleanupCandidates(this.entries)
  }

  /**
   * 用户确认清理候选记忆。
   */
  confirmCleanup(confirmIds?: string[]) {
    return this.cleaner.confirmCleanup(this.entries, this.removedIds, confirmIds)
  }

  /** 拒绝所有待清理候选 */
  rejectCleanup() {
    this.cleaner.rejectCleanup()
  }

  // ══════════════════════════════════════════
  //  关键字频率跟踪集成
  // ══════════════════════════════════════════

  /**
   * 获取关键字频率统计信息。
   */
  getKeywordFreqStats() {
    return (
      this.keywordFreqTracker?.getStats() ?? {
        totalKeywords: 0,
        highFreqCount: 0,
        lowFreqCount: 0,
        totalFrequency: 0,
        lastDecayTime: 0,
        topKeywords: [],
      }
    )
  }

  /**
   * 获取高频关键字列表。
   */
  getHighFrequencyKeywords(k?: number): string[] {
    return this.keywordFreqTracker?.getHighFrequencyKeywords(k) ?? []
  }

  /**
   * 获取关键字频率详情（所有关键字）。
   */
  getAllKeywordFrequencies() {
    return this.keywordFreqTracker?.getAllKeywords() ?? []
  }

  /**
   * 计算内容与高频关键字的匹配度（用于外部查询）。
   */
  getContentKeywordMatch(content: string): number {
    const topics = this.extractTopics(content)
    return this.keywordFreqTracker?.getKeywordMatchScore(topics) ?? 0
  }

  /** 按行为驱动得分排序（用于上下文注入，优先返回高价值记忆） */
  private getScoredEntries(tier: MemoryEntry['tier']): MemoryEntry[] {
    // 使用行为加权得分（基础分 + 当前兴趣 boost）
    const profile = this.getCurrentInterestProfile()
    return this.entries
      .filter((e) => e.tier === tier && e.type === 'user_fact')
      .map((e) => ({ entry: e, score: this.getBehaviorWeightedScore(e, profile) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry)
  }

  flush(): void {
    this.flushAllToDb()
    this.summary.flush()
    this.vector.flush()
  }

  shutdown(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
    if (this.quickCleanupTimer) {
      clearInterval(this.quickCleanupTimer)
      this.quickCleanupTimer = null
    }
    this.keywordFreqTracker?.stopDecayTimer()
    this.sleepManager.stop()
    this.cleaner.stop()
    this.flush()
  }

  /**
   * 立即触发快速清理（供外部手动调用）。
   * @returns 被清理的条目数
   */
  runQuickCleanup(): number {
    return this.cleaner.quickCleanup(this.entries, this.removedIds)
  }

  clear(): void {
    this.entries = []
    this.messageCount = 0
    this.keywordFreqTracker?.clearAll()
    log('INFO', 'memory_cleared')
  }

  getEntries(): MemoryEntry[] {
    return this.entries
  }

  /**
   * 配置自适应编排器的外部依赖（ProceduralMemory / TaskTemplateRegistry）。
   * 在 AppRuntime 启动完成，所有服务初始化后调用。
   */
  configureAdaptiveOrchestrator(deps: {
    getProcedures: () => any[]
    matchTemplates: (query: string, topK: number) => Array<{ name: string; description: string; steps: string[]; score: number }>
  }): void {
    this.adaptiveOrchestrator.miner.setProcedureProvider(deps.getProcedures)
    this.adaptiveOrchestrator.miner.setTemplateMatcher(deps.matchTemplates)
    // 重新挖掘（现在有了更丰富的数据源）
    this.adaptiveOrchestrator.triggerMining()
  }

  /** 获取 ProceduralMemory 中的流程（作为 fallback） */
  private getProceduresFallback(): Array<{
    id: string
    name: string
    description: string
    steps: string[]
    triggerKeywords: string[]
    embedding?: number[]
    successCount: number
    failCount: number
    createdAt: number
    updatedAt: number
  }> {
    return []
  }

  /**
   * 按 id 删除一条记忆条目。
   * 返回 true 表示成功删除，false 表示未找到。
   * 删除操作会同时标记为待从 DB 中移除（通过 flush() 持久化）。
   */
  forgetEntry(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    const entry = this.entries[idx]
    this.removedIds.add(entry.id)
    this.entries.splice(idx, 1)
    log('INFO', 'memory_forgotten', { id: entry.id, content: entry.content.slice(0, 50) })
    eventBus.emit('memory.entry.deleted', {
      version: 1,
      entryId: entry.id,
      type: entry.type,
      contentSnippet: entry.content.slice(0, 50),
      tier: entry.tier,
      timestamp: Date.now(),
    })
    return true
  }

  // ===== 任务状态管理 =====

  /** 保存/更新任务状态。同一 taskId 会覆盖旧记录 */
  saveTaskState(data: TaskStateData): void {
    const content = '【任务】' + data.title + ': ' + data.description.slice(0, 200)
    const structuredData = JSON.stringify(data)
    const existing = this.entries.find(
      (e) =>
        e.type === 'task_state' &&
        e.structuredData &&
        (() => {
          try {
            return JSON.parse(e.structuredData!).taskId === data.taskId
          } catch {
            return false
          }
        })(),
    )

    if (existing) {
      existing.content = content
      existing.structuredData = structuredData
      existing.updatedAt = Date.now()
      this.upsertInDb(existing)
      log('INFO', 'task_state_updated', { taskId: data.taskId, status: data.status, steps: data.steps.length })
      return
    }

    const entry: MemoryEntry = {
      id: nextId(),
      type: 'task_state',
      content,
      confidence: 0.9,
      tier: 'semi', // 任务状态为半永久层，不受临时层衰减影响
      reinforceCount: 0,
      behaviorScore: BEHAVIOR_SCORE_INITIAL,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      manualScoreOverride: null,
      utilityScore: BEHAVIOR_SCORE_INITIAL,
      agentReferenceCount: 0,
      userConfirmedUsefulCount: 0,
      lastUtilityUpdateAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      structuredData,
      topics: this.extractTopics(content),
    }
    this.entries.push(entry)
    this.upsertInDb(entry)
    log('INFO', 'task_state_saved', { taskId: data.taskId, status: data.status, steps: data.steps.length })
  }

  /** 获取所有未完成的任务（active | paused） */
  getUnfinishedTasks(): TaskStateData[] {
    return this.entries
      .filter((e) => e.type === 'task_state' && e.structuredData)
      .map((e) => {
        try {
          return JSON.parse(e.structuredData!) as TaskStateData
        } catch {
          return null
        }
      })
      .filter((t): t is TaskStateData => t !== null && (t.status === 'active' || t.status === 'paused'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 标记任务完成 */
  markTaskComplete(taskId: string): boolean {
    const entry = this.entries.find(
      (e) =>
        e.type === 'task_state' &&
        e.structuredData &&
        (() => {
          try {
            return JSON.parse(e.structuredData!).taskId === taskId
          } catch {
            return false
          }
        })(),
    )
    if (!entry) return false
    entry.tier = 'ephemeral' // 完成任务降级到临时层，后续自然衰减清理
    try {
      const data = JSON.parse(entry.structuredData!)
      data.status = 'completed'
      data.updatedAt = Date.now()
      entry.structuredData = JSON.stringify(data)
      entry.content = '【已完成】' + data.title
      entry.updatedAt = Date.now()
      this.upsertInDb(entry)
      log('INFO', 'task_completed', { taskId })
      return true
    } catch {
      return false
    }
  }

  /** 放弃任务 */
  markTaskAbandoned(taskId: string): boolean {
    const entry = this.entries.find(
      (e) =>
        e.type === 'task_state' &&
        e.structuredData &&
        (() => {
          try {
            return JSON.parse(e.structuredData!).taskId === taskId
          } catch {
            return false
          }
        })(),
    )
    if (!entry) return false
    entry.tier = 'ephemeral'
    try {
      const data = JSON.parse(entry.structuredData!)
      data.status = 'abandoned'
      data.updatedAt = Date.now()
      entry.structuredData = JSON.stringify(data)
      entry.content = '【已放弃】' + data.title
      entry.updatedAt = Date.now()
      this.upsertInDb(entry)
      log('INFO', 'task_abandoned', { taskId })
      return true
    } catch {
      return false
    }
  }

  /** 格式化未完成任务上下文，用于 system prompt 注入 */
  getTaskStateContext(): string {
    const unfinished = this.getUnfinishedTasks()
    if (unfinished.length === 0) return ''

    const parts = ['---', '【未完成任务恢复】', '以下 ' + unfinished.length + ' 个任务在上次对话中未完成：']
    for (const t of unfinished.slice(0, 3)) {
      const stepSummary = t.steps
        .filter((s) => s.status === 'completed')
        .map((s) => s.description.slice(0, 40))
        .join(', ')
      const nextStep = t.steps.find((s) => s.status === 'pending' || s.status === 'in_progress')
      const statusLabel = t.status === 'paused' ? '已暂停' : '进行中'
      parts.push('- ' + t.title + ' (' + statusLabel + ')')
      parts.push('  已完成: ' + (stepSummary || '无'))
      if (nextStep) {
        parts.push('  下一步: ' + nextStep.description.slice(0, 60))
      }
      parts.push('  上次更新: ' + new Date(t.updatedAt).toLocaleString('zh-CN'))
    }
    parts.push('')
    parts.push('你可以使用 save_task_state 继续上述任务，或用 query_tasks 查看详情。')
    parts.push('如果用户想开始新的任务，不必主动提起旧任务，但若用户询问"上次做了什么"时主动恢复。')
    parts.push('---')
    return parts.join('\n')
  }

  // ===== 用户画像管理 =====

  /** 保存/更新用户偏好 */
  saveUserPreference(data: UserProfileData): void {
    const content = '【偏好】' + data.key + ': ' + data.value
    const structuredData = JSON.stringify(data)
    const existing = this.entries.find(
      (e) =>
        e.type === 'user_profile' &&
        e.structuredData &&
        (() => {
          try {
            return JSON.parse(e.structuredData!).key === data.key
          } catch {
            return false
          }
        })(),
    )

    if (existing) {
      const existingData = JSON.parse(existing.structuredData!)
      // 冲突解决：当前对话写入的优先（置信度更高）
      existing.content = content
      existing.confidence = Math.max(existing.confidence, data.confidence)
      existing.structuredData = JSON.stringify({ ...existingData, ...data, updatedAt: Date.now() })
      existing.updatedAt = Date.now()
      this.upsertInDb(existing)
      return
    }

    const entry: MemoryEntry = {
      id: nextId(),
      type: 'user_profile',
      content,
      confidence: data.confidence,
      tier: 'semi', // 画像为半永久层
      reinforceCount: 0,
      behaviorScore: BEHAVIOR_SCORE_INITIAL,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      manualScoreOverride: null,
      utilityScore: BEHAVIOR_SCORE_INITIAL,
      agentReferenceCount: 0,
      userConfirmedUsefulCount: 0,
      lastUtilityUpdateAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      structuredData,
      topics: this.extractTopics(content),
    }
    this.entries.push(entry)
    this.upsertInDb(entry)
    log('INFO', 'user_preference_saved', { key: data.key, category: data.category })
  }

  /** 获取所有用户画像 */
  getUserPreferences(): UserProfileData[] {
    return this.entries
      .filter((e) => e.type === 'user_profile' && e.structuredData)
      .map((e) => {
        try {
          return JSON.parse(e.structuredData!) as UserProfileData
        } catch {
          return null
        }
      })
      .filter((p): p is UserProfileData => p !== null)
      .sort((a, b) => b.confidence - a.confidence)
  }

  /** 格式化用户画像上下文，用于 system prompt 注入 */
  getUserProfileContext(): string {
    const prefs = this.getUserPreferences()
    if (prefs.length === 0) return ''

    const byCategory: Record<string, string[]> = {}
    for (const p of prefs) {
      if (!byCategory[p.category]) byCategory[p.category] = []
      byCategory[p.category].push(p.key + ': ' + p.value)
    }

    const parts: string[] = ['---', '【用户画像】', '以下是你对用户的了解：']
    for (const [cat, items] of Object.entries(byCategory)) {
      const catLabel: Record<string, string> = {
        style: '风格偏好',
        detail: '详略偏好',
        language: '语言偏好',
        preference: '个人偏好',
        identity: '身份信息',
        other: '其他',
      }
      parts.push('- ' + (catLabel[cat] || cat) + ': ' + items.join('; '))
    }
    parts.push('请参考画像调整回复风格和详略程度，但不要让用户觉得你在刻意强调这些信息。')
    parts.push('---')
    return parts.join('\n')
  }

  // ===== Pruning =====

  private prune(): void {
    this.pruneTier('ephemeral', MAX_EPHEMERAL)
    this.pruneTier('semi', MAX_SEMI)
  }

  private pruneTier(tier: 'ephemeral' | 'semi', max: number): void {
    const tierEntries = this.entries.filter((e) => e.tier === tier && !e.isPinned)
    if (tierEntries.length <= max) return

    const scored = tierEntries.map((e) => ({ entry: e, score: this.getEffectiveScore(e) })).sort((a, b) => b.score - a.score)

    const keep = new Set(scored.slice(0, max).map((s) => s.entry.id))
    const toRemove = scored.slice(max)
    for (const s of toRemove) {
      const idx = this.entries.findIndex((e) => e.id === s.entry.id)
      if (idx >= 0) {
        this.removedIds.add(s.entry.id)
        this.entries.splice(idx, 1)
      }
    }
    if (toRemove.length > 0) {
      log('INFO', 'memory_pruned', { tier, removed: toRemove.length })
      eventBus.emit('memory.context.changed', {
        version: 1,
        totalEntries: this.entries.length,
        tiers: {
          ephemeral: this.entries.filter((e) => e.tier === 'ephemeral').length,
          semi: this.entries.filter((e) => e.tier === 'semi').length,
          permanent: this.entries.filter((e) => e.tier === 'permanent').length,
        },
        timestamp: Date.now(),
      })
    }
  }

  /** 永久层超出上限时移除最弱的（pinned 优先保留） */
  private prunePermanent(): void {
    const perm = this.entries.filter((e) => e.tier === 'permanent')
    if (perm.length <= MAX_PERMANENT) return
    // pinned 优先保留，其余按 reinforcedCount + confidence 排序
    perm.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      return b.reinforceCount - a.reinforceCount || b.confidence - a.confidence
    })
    const keep = new Set(perm.slice(0, MAX_PERMANENT).map((e) => e.id))
    for (const e of perm) {
      if (!keep.has(e.id) && !e.isPinned) {
        e.tier = 'semi' // 降级到半永久，不直接删除
      }
    }
    const demotedCount = perm.filter((e) => !keep.has(e.id) && !e.isPinned).length
    log('INFO', 'memory_demoted_from_permanent', {
      count: demotedCount,
    })
    if (demotedCount > 0) {
      eventBus.emit('memory.context.changed', {
        version: 1,
        totalEntries: this.entries.length,
        tiers: {
          ephemeral: this.entries.filter((e) => e.tier === 'ephemeral').length,
          semi: this.entries.filter((e) => e.tier === 'semi').length,
          permanent: this.entries.filter((e) => e.tier === 'permanent').length,
        },
        timestamp: Date.now(),
      })
    }
  }

  // ===== 持久化 =====

  private upsertInDb(entry: MemoryEntry): void {
    try {
      const db = getRawDb()
      db.run(
        'INSERT OR REPLACE INTO memories (id, type, content, confidence, tier, reinforce_count, behavior_score, last_accessed_at, access_count, is_pinned, manual_score_override, created_at, updated_at, structured_data, topics, utility_score, agent_reference_count, user_confirmed_useful_count, last_utility_update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          entry.id,
          entry.type,
          entry.content,
          entry.confidence,
          entry.tier,
          entry.reinforceCount,
          entry.behaviorScore,
          entry.lastAccessedAt,
          entry.accessCount,
          entry.isPinned ? 1 : 0,
          entry.manualScoreOverride,
          entry.createdAt,
          entry.updatedAt,
          entry.structuredData ?? null,
          JSON.stringify(entry.topics || []),
          entry.utilityScore,
          entry.agentReferenceCount,
          entry.userConfirmedUsefulCount,
          entry.lastUtilityUpdateAt,
        ],
      )
      markDirty()
    } catch (err) {
      log('ERROR', 'memory_save_failed', { error: String(err) })
    }
  }

  private flushAllToDb(): void {
    if (this.removedIds.size === 0) return
    try {
      const db = getRawDb()
      db.run('BEGIN')
      for (const id of this.removedIds) {
        db.run('DELETE FROM memories WHERE id = ?', [id])
      }
      db.run('COMMIT')
      markDirty()
      this.removedIds.clear()
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('ERROR', 'memory_flush_removed_failed', { error: String(err) })
    }
  }
}
