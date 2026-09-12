/**
 * MemorySnapshotManager — 记忆驱动的 Agent 主动服务
 *
 * ## 职责
 * 1. 每次对话后生成结构化"记忆快照"：压缩最近 N 轮对话摘要、聚合话题标签、提取用户偏好
 * 2. 检测用户连续多日讨论同一话题的模式，为工具预加载提供依据
 * 3. 基于检测到的话题推荐相关工具（Topic → Tool 映射）
 * 4. 生成开场建议，增强会话连贯性（在 SessionGreeting 基础上补充 topic 感知）
 * 5. 提供 getLatestSnapshot() API 供 Agent 启动时拉取最新快照注入系统提示
 *
 * ## 与现有系统的关系
 * - MetaController：在每个交互结束时生成单轮摘要 → SnapshotManager 聚合多轮摘要为快照
 * - SummaryMemory：存储原始摘要条目 → SnapshotManager 从 SummaryMemory 读取并压缩
 * - SessionGreeting：简单的"欢迎回来"问候 → SnapshotManager 提供基于话题的增强建议
 * - TopicTransitionPredictor：话题间转移预测 → SnapshotManager 检测跨天话题模式
 * - InteractionTracker：记录交互基础数据 → SnapshotManager 分析时间维度话题分布
 *
 * ## 风险控制
 * - 无可用摘要时返回 null，不阻塞启动流程
 * - 快照生成异步、非阻塞，不影响主交互响应
 * - 工具推荐基于静态映射 + 置信度阈值，避免误报
 */
import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from './MemoryService'
import type { SummaryMemory } from './SummaryMemory'
import type { InteractionRecord } from './types'
import type { MemorySnapshot, ConsecutiveDayTopic, TopicToolMapping } from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 快照压缩时参考的最近摘要数 */
const SNAPSHOT_SUMMARY_COUNT = 5

/** 快照中保留的最多话题数 */
const MAX_SNAPSHOT_TOPICS = 8

/** 连续多日话题检测：多少天内的数据纳入分析 */
const CONSECUTIVE_DAY_WINDOW_DAYS = 14

/** 连续多日话题检测：至少连续几天才触发工具预加载 */
const CONSECUTIVE_DAY_THRESHOLD = 2

/** 快照版本（递增） */
const SNAPSHOT_VERSION = 1

// ══════════════════════════════════════════
//  话题→工具 映射表
// ══════════════════════════════════════════

const DEFAULT_TOPIC_TOOL_MAPPINGS: TopicToolMapping[] = [
  { topic: '编程', tools: ['run_command', 'list_files', 'read_file', 'grep'], description: '代码开发与调试' },
  { topic: '调试', tools: ['run_command', 'grep', 'read_file'], description: '错误排查与分析' },
  { topic: '学习', tools: ['read_file', 'grep', 'run_command'], description: '学习与示例运行' },
  { topic: '测试', tools: ['run_command'], description: '测试执行' },
  { topic: '部署', tools: ['run_command'], description: '部署操作' },
  { topic: '数据库', tools: ['run_command'], description: '数据库操作' },
  { topic: 'API', tools: ['run_command', 'read_file'], description: 'API 开发与调试' },
  { topic: '架构', tools: ['read_file', 'list_files'], description: '架构分析与设计' },
  { topic: '文档', tools: ['read_file', 'list_files'], description: '文档编写与查看' },
  { topic: '性能', tools: ['run_command'], description: '性能分析与优化' },
  { topic: '安全', tools: ['run_command', 'grep'], description: '安全审查' },
  { topic: '图像生成', tools: ['run_command'], description: '图像生成' },
  { topic: '任务管理', tools: ['read_file'], description: '任务与计划管理' },
  { topic: '配置', tools: ['read_file', 'run_command'], description: '配置管理' },
]

// ══════════════════════════════════════════
//  MemorySnapshotManager
// ══════════════════════════════════════════

export class MemorySnapshotManager {
  private memory: MemoryService | null = null
  private summary: SummaryMemory | null = null
  /** 缓存的快照 — 每次 onInteractionEnd 后更新 */
  private lastSnapshot: MemorySnapshot | null = null
  /** 最后处理的摘要 ID 集合（用于判断是否需要重新生成快照） */
  private lastProcessedSummaryIds = new Set<string>()
  /** 当前对话是否为新会话（用于触发开场建议） */
  private isNewSession = true

  constructor() {
    log('INFO', 'memory_snapshot_manager_created')
  }

  /** 注入依赖 */
  setDeps(deps: { memory: MemoryService; summary: SummaryMemory }): void {
    this.memory = deps.memory
    this.summary = deps.summary
    log('INFO', 'memory_snapshot_deps_set')
  }

  // ══════════════════════════════════════════
  //  会话状态管理
  // ══════════════════════════════════════════

  /** 标记新会话开始（通常在 Agent 启动时调用） */
  markNewSession(): void {
    this.isNewSession = true
  }

  /** 标记会话已激活（开场建议已消费） */
  markSessionActive(): void {
    this.isNewSession = false
  }

  // ══════════════════════════════════════════
  //  快照生成
  // ══════════════════════════════════════════

  /**
   * 生成最新的记忆快照。
   * 在每次交互结束时由 MemoryService 触发（非阻塞，不抛出异常）。
   * 如果自上次生成以来摘要无变化，则返回缓存的快照。
   *
   * @returns 生成的快照（或 null 表示无足够数据）
   */
  generateSnapshot(): MemorySnapshot | null {
    if (!this.summary || !this.memory) return null

    try {
      const recentSummaries = this.summary.getRecentFull(SNAPSHOT_SUMMARY_COUNT)
      if (recentSummaries.length === 0) {
        if (this.lastSnapshot) return this.lastSnapshot
        return null
      }

      // 增量检测：如果摘要没有新增，返回缓存
      const currentIds = new Set(recentSummaries.map((s) => s.id))
      if (this.lastSnapshot && this.idsEqual(currentIds, this.lastProcessedSummaryIds)) {
        return this.lastSnapshot
      }

      // 1. 压缩摘要文本
      const compressedSummary = this.compressSummaries(recentSummaries)

      // 2. 聚合话题标签
      const topTopics = this.aggregateTopics(recentSummaries)

      // 3. 提取用户偏好
      const preferences = this.extractPreferences()

      // 4. 检测连续多日话题
      const consecutiveDayTopics = this.detectConsecutiveDayTopics(topTopics)

      // 5. 基于话题推荐工具
      const suggestedTools = this.suggestTools(topTopics, consecutiveDayTopics)

      // 6. 生成开场建议（仅在新会话且检测到连续话题时）
      const openingSuggestion =
        this.isNewSession && consecutiveDayTopics.length > 0
          ? this.generateOpeningSuggestion(consecutiveDayTopics, topTopics, compressedSummary)
          : ''

      const snapshot: MemorySnapshot = {
        id: `snap_${Date.now()}`,
        createdAt: Date.now(),
        compressedSummary,
        topTopics,
        preferences,
        consecutiveDayTopics,
        suggestedTools,
        openingSuggestion,
        version: SNAPSHOT_VERSION,
        basedOnSummaryIds: recentSummaries.map((s) => s.id),
      }

      this.lastSnapshot = snapshot
      this.lastProcessedSummaryIds = currentIds

      // 如果生成了开场建议，一次性消费（避免下次重复生成）
      if (openingSuggestion) {
        this.isNewSession = false
      }

      log('INFO', 'memory_snapshot_generated', {
        summaryCount: recentSummaries.length,
        topics: topTopics.length,
        consecutiveTopics: consecutiveDayTopics.length,
        toolsSuggested: suggestedTools.length,
        hasOpening: !!openingSuggestion,
      })

      return snapshot
    } catch (err) {
      log('WARN', 'memory_snapshot_generate_failed', { error: String(err) })
      if (this.lastSnapshot) return this.lastSnapshot
      return null
    }
  }

  /**
   * 获取最新快照（供 Agent 启动时调用）。
   * 不会重新生成，只返回缓存的最后一个快照。
   */
  getLatestSnapshot(): MemorySnapshot | null {
    return this.lastSnapshot
  }

  // ══════════════════════════════════════════
  //  内部方法：压缩摘要
  // ══════════════════════════════════════════

  /**
   * 将多条摘要压缩为一段精炼文本。
   * 当前使用简单拼接（后续可升级为 LLM 压缩）。
   */
  private compressSummaries(summaries: Array<{ summary: string; topics: string[] }>): string {
    if (summaries.length === 0) return ''
    if (summaries.length === 1) return summaries[0].summary

    // 去重话题
    const allTopics = [...new Set(summaries.flatMap((s) => s.topics || []))]
    const topicStr = allTopics.length > 0 ? `（话题：${allTopics.slice(0, 5).join('、')}）` : ''

    // 如果只有 2-3 条，直接拼接
    if (summaries.length <= 3) {
      const texts = summaries.map((s) => s.summary).filter(Boolean)
      if (texts.length === 0) return ''
      return `最近对话：${texts.join(' → ')}${topicStr}`
    }

    // 4-5 条：提取关键信息
    const recent = summaries
      .slice(-3)
      .map((s) => s.summary)
      .filter(Boolean)
    const olderCount = summaries.length - recent.length
    if (recent.length === 0) return topicStr || ''

    const prefix = olderCount > 0 ? `（已合并 ${olderCount} 轮早期对话）` : ''
    return `最近对话：${prefix}${recent.join(' → ')}${topicStr}`
  }

  // ══════════════════════════════════════════
  //  内部方法：话题聚合
  // ══════════════════════════════════════════

  /**
   * 从最近的摘要中聚合高频话题标签。
   */
  private aggregateTopics(summaries: Array<{ topics: string[] }>): string[] {
    const freq = new Map<string, number>()
    for (const s of summaries) {
      for (const topic of s.topics || []) {
        freq.set(topic, (freq.get(topic) || 0) + 1)
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SNAPSHOT_TOPICS)
      .map(([topic]) => topic)
  }

  // ══════════════════════════════════════════
  //  内部方法：偏好提取
  // ══════════════════════════════════════════

  /**
   * 从 MemoryService 的用户画像中提取偏好摘要。
   */
  private extractPreferences(): Array<{ key: string; value: string; category: string }> {
    if (!this.memory) return []
    try {
      const prefs = this.memory.getUserPreferences()
      // 只取高置信度（>= 0.5）的偏好
      return prefs
        .filter((p) => p.confidence >= 0.5)
        .slice(0, 5)
        .map((p) => ({
          key: p.key,
          value: p.value,
          category: p.category,
        }))
    } catch {
      return []
    }
  }

  // ══════════════════════════════════════════
  //  内部方法：连续多日话题检测
  // ══════════════════════════════════════════

  /**
   * 检测用户是否连续多日讨论同一话题。
   *
   * 从 InteractionTracker 获取历史交互记录，按天分组，
   * 检测每个话题是否在连续日期出现。
   */
  detectConsecutiveDayTopics(currentTopics: string[], interactions?: InteractionRecord[]): ConsecutiveDayTopic[] {
    if (!this.memory) return []

    try {
      const records = interactions ?? this.getInteractionRecords()
      if (records.length === 0) return []

      const cutoff = Date.now() - CONSECUTIVE_DAY_WINDOW_DAYS * 24 * 60 * 60 * 1000
      const recentRecords = records.filter((r) => r.timestamp >= cutoff)
      if (recentRecords.length === 0) return []

      // 按天统计话题出现情况
      const topicDayMap = new Map<string, Set<string>>() // topic → Set<YYYY-MM-DD>
      for (const rec of recentRecords) {
        if (!rec.topics || rec.topics.length === 0) continue
        const dayStr = new Date(rec.timestamp).toISOString().slice(0, 10)
        for (const topic of rec.topics) {
          if (!topicDayMap.has(topic)) topicDayMap.set(topic, new Set())
          topicDayMap.get(topic)!.add(dayStr)
        }
      }

      const result: ConsecutiveDayTopic[] = []
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const todayMs = today.getTime()

      for (const [topic, daySet] of topicDayMap) {
        if (daySet.size < CONSECUTIVE_DAY_THRESHOLD) continue

        // 将日期字符串转为排序的 Date 数组
        const sortedDays = [...daySet].map((d) => new Date(d)).sort((a, b) => a.getTime() - b.getTime())

        // 计算最大连续天数
        let maxConsecutive = 1
        let currentStreak = 1
        for (let i = 1; i < sortedDays.length; i++) {
          const diffMs = sortedDays[i].getTime() - sortedDays[i - 1].getTime()
          const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000))
          if (diffDays === 1) {
            currentStreak++
            maxConsecutive = Math.max(maxConsecutive, currentStreak)
          } else if (diffDays > 0) {
            currentStreak = 1
          }
        }

        // 检查是否包含今天或昨天（保证是"近期连续"）
        const hasRecent = daySet.has(this.formatDate(todayMs)) || daySet.has(this.formatDate(todayMs - 24 * 60 * 60 * 1000))

        if (maxConsecutive >= CONSECUTIVE_DAY_THRESHOLD && hasRecent) {
          result.push({
            topic,
            consecutiveDayCount: maxConsecutive,
            firstSeenAt: sortedDays[0].getTime(),
            lastSeenAt: sortedDays[sortedDays.length - 1].getTime(),
            totalDayCount: daySet.size,
          })
        }
      }

      // 在当前话题列表中的优先，按连续天数降序
      result.sort((a, b) => {
        const aInCurrent = currentTopics.includes(a.topic) ? 1 : 0
        const bInCurrent = currentTopics.includes(b.topic) ? 1 : 0
        if (aInCurrent !== bInCurrent) return bInCurrent - aInCurrent
        return b.consecutiveDayCount - a.consecutiveDayCount
      })

      return result
    } catch (err) {
      log('WARN', 'consecutive_day_detection_failed', { error: String(err) })
      return []
    }
  }

  /** 格式化时间戳为 YYYY-MM-DD */
  private formatDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10)
  }

  /** 获取 InteractionTracker 中的交互记录 */
  private getInteractionRecords(): InteractionRecord[] {
    if (!this.memory) return []
    try {
      const tracker = (this.memory as any).interactionTracker
      if (tracker && typeof tracker.getAll === 'function') {
        return tracker.getAll()
      }
    } catch {
      // silent
    }
    return []
  }

  // ══════════════════════════════════════════
  //  内部方法：工具推荐
  // ══════════════════════════════════════════

  /**
   * 基于话题推荐预加载的工具。
   *
   * @param topTopics 当前高频话题列表
   * @param consecutiveTopics 被检测为连续多日讨论的话题
   * @returns 去重后的工具名称列表
   */
  suggestTools(topTopics: string[], consecutiveTopics: ConsecutiveDayTopic[], mappings?: TopicToolMapping[]): string[] {
    const toolMap = mappings ?? DEFAULT_TOPIC_TOOL_MAPPINGS
    const tools = new Set<string>()

    // 连续多日话题 → 对应工具（加入白名单优先）
    for (const ct of consecutiveTopics) {
      const mapping = toolMap.find((m) => m.topic === ct.topic)
      if (mapping) {
        for (const tool of mapping.tools) {
          tools.add(tool)
        }
      }
    }

    // 当前高频话题 → 对应工具
    for (const topic of topTopics) {
      const mapping = toolMap.find((m) => m.topic === topic)
      if (mapping) {
        for (const tool of mapping.tools) {
          tools.add(tool)
        }
      }
    }

    return [...tools]
  }

  // ══════════════════════════════════════════
  //  内部方法：开场建议生成
  // ══════════════════════════════════════════

  /**
   * 生成会话开场建议文本。
   * 基于连续多日话题和最新摘要，生成提示 Agent 主动关注的话题。
   *
   * @param consecutiveTopics 连续多日话题
   * @param topTopics 当前高频话题
   * @param compressedSummary 压缩后的摘要文本
   * @returns 开场建议文本（空字符串表示无需建议）
   */
  generateOpeningSuggestion(consecutiveTopics: ConsecutiveDayTopic[], topTopics: string[], compressedSummary: string): string {
    if (consecutiveTopics.length === 0 && topTopics.length === 0) return ''

    const parts: string[] = ['【开场建议】']

    // 连续多日话题 → 主动关注
    if (consecutiveTopics.length > 0) {
      const topicNames = consecutiveTopics
        .slice(0, 3)
        .map((ct) => ct.topic)
        .join('、')
      const maxDays = consecutiveTopics[0].consecutiveDayCount
      parts.push(`用户已连续 ${maxDays} 天关注「${topicNames}」，可能持续感兴趣。`)
    }

    // 最新对话摘要
    if (compressedSummary) {
      parts.push(`上次交流：${compressedSummary.slice(0, 120)}`)
    }

    // 推荐工具
    const tools = this.suggestTools(topTopics, consecutiveTopics)
    if (tools.length > 0) {
      parts.push(`建议准备好以下工具：${tools.slice(0, 5).join('、')}。`)
    }

    parts.push('开场时可主动延续上次话题，不要重复询问用户想做什么。')

    return parts.join('\n')
  }

  // ══════════════════════════════════════════
  //  内部方法：辅助
  // ══════════════════════════════════════════

  private idsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const id of a) {
      if (!b.has(id)) return false
    }
    return true
  }

  /** 在每次交互结束时触发快照重新生成（由外部调用） */
  onInteractionEnd(): void {
    this.generateSnapshot()
  }

  /** 获取格式化后的快照上下文（用于注入系统提示） */
  getFormattedSnapshotContext(): string {
    const snapshot = this.getLatestSnapshot()
    if (!snapshot) return ''

    const parts: string[] = ['---', '【记忆快照】基于最近对话的结构化摘要：']

    if (snapshot.compressedSummary) {
      parts.push(snapshot.compressedSummary)
    }

    if (snapshot.topTopics.length > 0) {
      parts.push('近期话题：' + snapshot.topTopics.slice(0, 5).join('、'))
    }

    if (snapshot.consecutiveDayTopics.length > 0) {
      const topicNames = snapshot.consecutiveDayTopics.map((ct) => `${ct.topic}（连续${ct.consecutiveDayCount}天）`).join('、')
      parts.push('持续关注：' + topicNames)
    }

    if (snapshot.preferences.length > 0) {
      const prefTexts = snapshot.preferences.map((p) => `${p.key}=${p.value}`)
      parts.push('用户偏好：' + prefTexts.join('；'))
    }

    if (snapshot.suggestedTools.length > 0) {
      parts.push('推荐关注工具：' + snapshot.suggestedTools.slice(0, 5).join('、'))
    }

    if (snapshot.openingSuggestion) {
      parts.push(snapshot.openingSuggestion)
    }

    parts.push('以上信息基于记忆快照自动生成，用于开场连贯性参考。')
    parts.push('---')
    return parts.join('\n')
  }
}

/** 模块级单例 */
export const memorySnapshotManager = new MemorySnapshotManager()
