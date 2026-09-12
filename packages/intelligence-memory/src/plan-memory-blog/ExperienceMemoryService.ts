/**
 * ExperienceMemoryService — 经验记忆工作流引擎
 *
 * 职责：
 * 1. 订阅 workflow.run.step 事件，在博客工作流每个步骤执行后自动记录
 * 2. 提供语义相似度检索，在新任务启动时为当前步骤提供历史经验参考
 * 3. 支持用户标记重要经验、删除经验
 * 4. 按任务、步骤、时间组织记忆数据
 *
 * 与 BlogMemoryRecorder 的区别：
 * - BlogMemoryRecorder 监听 Plan 事件（agent.plan.step/agent.plan.completed）
 * - ExperienceMemoryService 监听工作流事件（workflow.run.step），覆盖 blog-workflow.json 的每一步
 *
 * 风险注意：
 * - 记忆存储膨胀：受 maxEntries 控制，超出时自动修剪旧条目
 * - 隐私控制：所有经验数据用户可控（删除、固定），可通过配置关闭
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import type { EventPayload } from '@akemi-mio/core/core/EventBus'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { workflowStore } from '@akemi-mio/capabilities/workflow/WorkflowStoreV2'
import { getEmbedding, cosineSimilarity, fallbackEmbed } from '../embedding'
import type { MemoryEntry } from '../types'
import type {
  BlogMemoryStructuredData,
  BlogMemoryCategory,
  BlogMemoryRecorderConfig,
  ExperienceSearchOptions,
  ExperienceSearchResult,
} from './types'
import {
  BLOG_MEMORY_ENABLED,
  BLOG_MEMORY_MAX_ENTRIES,
  BLOG_MEMORY_MAX_CONTENT_LENGTH,
  BLOG_MEMORY_DEFAULT_TIER,
  BLOG_MEMORY_DEFAULT_CONFIDENCE,
} from '@akemi-mio/core/config'

// =============================================================================
// 常量
// =============================================================================

/** 博客工作流的定义 ID（来自 blog-workflow.json） */
const BLOG_WORKFLOW_DEF_ID = 'preset_blog_workflow'

/** 语义搜索的最低相似度阈值 */
const SIMILARITY_THRESHOLD = 0.45

/** 语义搜索的最大返回条数 */
const MAX_SEARCH_RESULTS = 10

/** 工作流步骤 ID → BlogMemoryCategory 映射 */
const STEP_CATEGORY_MAP: Record<string, BlogMemoryCategory> = {
  s1_intent: 'analysis',
  s1_gate: 'design_decision',
  s2_material: 'analysis',
  s3_outline: 'design_decision',
  s3_gate: 'design_decision',
  s4_draft: 'other',
  s4_gate: 'design_decision',
  s5_polish: 'other',
  s5_gate: 'design_decision',
  s6_publish: 'other',
  s6_gate: 'design_decision',
}

/** 工作流步骤 ID → 中文描述 */
const STEP_DESCRIPTION_MAP: Record<string, string> = {
  s1_intent: '主题与意图分析',
  s1_gate: '意图确认（用户决策）',
  s2_material: '素材收集与分析',
  s3_outline: '文章大纲生成',
  s3_gate: '大纲审核（用户决策）',
  s4_draft: '初稿生成',
  s4_gate: '初稿审核（用户决策）',
  s5_polish: '终稿润色',
  s5_gate: '终稿确认（用户决策）',
  s6_publish: '发布规划',
  s6_gate: '发布确认（用户决策）',
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: BlogMemoryRecorderConfig = {
  enabled: BLOG_MEMORY_ENABLED,
  maxEntries: BLOG_MEMORY_MAX_ENTRIES,
  maxContentLength: BLOG_MEMORY_MAX_CONTENT_LENGTH,
  defaultTier: BLOG_MEMORY_DEFAULT_TIER,
  defaultConfidence: BLOG_MEMORY_DEFAULT_CONFIDENCE,
}

// =============================================================================
// 核心服务
// =============================================================================

export class ExperienceMemoryService {
  private config: BlogMemoryRecorderConfig
  private tracker = new SubscriptionTracker()
  private entryCount = 0
  /** 当前活跃的 blogId（由 startBlogSession 设置） */
  private currentBlogId: string | null = null
  /** 工作流运行 ID → blogId 映射 */
  private runBlogMap = new Map<string, string>()
  /** 工作流运行 ID → 工作流定义 ID 映射 */
  private runDefMap = new Map<string, string>()

  constructor(config?: Partial<BlogMemoryRecorderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ===========================================================================
  // 生命周期
  // ===========================================================================

  /** 启动服务：订阅事件 */
  start(): void {
    if (!this.config.enabled) {
      log('INFO', 'experience_memory_disabled')
      return
    }

    // 订阅工作流步骤事件
    eventBus.track('workflow.run.step', this.onWorkflowStep, this.tracker, {
      label: 'experience-memory-service',
    })

    // 订阅工作流创建事件，追踪定义 ID
    eventBus.track('workflow.run.created', this.onWorkflowCreated, this.tracker, {
      label: 'experience-memory-service',
    })

    log('INFO', 'experience_memory_started', {
      maxEntries: this.config.maxEntries,
    })
  }

  /** 停止服务：取消所有订阅 */
  stop(): void {
    this.tracker.dispose()
    log('INFO', 'experience_memory_stopped')
  }

  // ===========================================================================
  // 博客会话管理
  // ===========================================================================

  /**
   * 开始一个新的博客写作会话，关联 blogId 和工作流。
   * 调用此方法时，会自动检索相似历史经验并返回参考信息。
   */
  startBlogSession(topic: string, blogId?: string, workflowRunId?: string): { blogId: string; references: ExperienceSearchResult[] } {
    const id = blogId || `blog_${Date.now()}`
    this.currentBlogId = id

    if (workflowRunId) {
      this.runBlogMap.set(workflowRunId, id)
    }

    // 自动检索相似历史经验
    const references = this.searchSimilarSync(topic, 5)

    log('INFO', 'experience_memory_session_started', {
      blogId: id,
      topic: topic.slice(0, 50),
      referencesFound: references.length,
    })

    return { blogId: id, references }
  }

  /** 结束当前博客会话 */
  endBlogSession(): void {
    this.currentBlogId = null
    log('INFO', 'experience_memory_session_ended')
  }

  /** 设置当前 blogId */
  setCurrentBlogId(blogId: string | null): void {
    this.currentBlogId = blogId
  }

  /** 获取当前 blogId */
  getCurrentBlogId(): string | null {
    return this.currentBlogId
  }

  // ===========================================================================
  // 手动记录经验
  // ===========================================================================

  /**
   * 手动记录一条经验记忆。
   * 用于 Agent 主动记录重要发现、决策等。
   */
  recordExperience(
    content: string,
    category: BlogMemoryCategory = 'other',
    blogId?: string,
    metadata?: { planId?: string; stepDescription?: string; stepIndex?: number },
  ): boolean {
    if (!this.config.enabled) return false
    const ms = getMemoryService()
    if (!ms) return false

    const id = blogId || this.currentBlogId || 'default'
    const truncated = this.truncateContent(content)
    const structuredData: BlogMemoryStructuredData = {
      blogId: id,
      planId: metadata?.planId || 'manual',
      planTitle: '',
      stepIndex: metadata?.stepIndex ?? -1,
      stepDescription: metadata?.stepDescription || '',
      timestamp: Date.now(),
      category,
    }

    ms.addEntry('blog_memory', truncated, this.config.defaultConfidence, {
      tier: this.config.defaultTier,
      structuredData: JSON.stringify(structuredData),
    })

    this.entryCount++
    return true
  }

  // ===========================================================================
  // 语义搜索
  // ===========================================================================

  /**
   * 异步语义搜索：基于 embedding 的高级相似度检索。
   * 使用 Xenova/all-MiniLM-L6-v2 模型（如果可用）或 fallback n-gram 嵌入。
   */
  async searchSimilar(query: string, limit = 5): Promise<ExperienceSearchResult[]> {
    if (!query.trim()) return []

    const ms = getMemoryService()
    if (!ms) return []

    const blogEntries = this.getBlogMemoryEntries(ms)
    if (blogEntries.length === 0) return []

    // 获取查询的 embedding
    const queryEmb = await getEmbedding(query)
    if (queryEmb.length === 0) return []

    return this.scoreAndRank(queryEmb, blogEntries, limit)
  }

  /**
   * 同步语义搜索：使用 fallback n-gram 嵌入，适合非关键路径快速检索。
   */
  searchSimilarSync(query: string, limit = 5): ExperienceSearchResult[] {
    if (!query.trim()) return []

    const ms = getMemoryService()
    if (!ms) return []

    const blogEntries = this.getBlogMemoryEntries(ms)
    if (blogEntries.length === 0) return []

    const queryEmb = fallbackEmbed(query)
    return this.scoreAndRank(queryEmb, blogEntries, limit)
  }

  /**
   * 按关键词搜索（传统全文匹配）。
   * 用于需要精确匹配的场景。
   */
  searchByKeyword(keyword: string, options?: ExperienceSearchOptions): ExperienceSearchResult[] {
    if (!keyword.trim()) return []

    const ms = getMemoryService()
    if (!ms) return []

    const lower = keyword.toLowerCase()
    const results: ExperienceSearchResult[] = []

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData

        // 应用过滤条件
        if (options?.category) {
          const cats = Array.isArray(options.category) ? options.category : [options.category]
          if (!cats.includes(data.category)) continue
        }
        if (options?.blogId && data.blogId !== options.blogId) continue

        // 检查内容是否匹配
        if (
          !entry.content.toLowerCase().includes(lower) &&
          !data.stepDescription.toLowerCase().includes(lower) &&
          !data.planTitle.toLowerCase().includes(lower)
        ) {
          continue
        }

        results.push({
          memoryEntry: entry,
          data,
          score: 1.0,
        })
      } catch {
        continue
      }
    }

    // 按时间降序排列
    results.sort((a, b) => b.data.timestamp - a.data.timestamp)

    const limit = options?.limit || MAX_SEARCH_RESULTS
    return results.slice(0, limit)
  }

  // ===========================================================================
  // 经验管理
  // ===========================================================================

  /**
   * 标记/取消标记经验为重要（固定）。
   * 被固定的条目不受自动清理影响。
   */
  togglePin(memoryId: string): boolean {
    const ms = getMemoryService()
    if (!ms) return false

    const entry = ms.getEntries().find((e) => e.id === memoryId && e.type === 'blog_memory')
    if (!entry) return false

    if (entry.isPinned) {
      ms.unpinMemory(memoryId)
    } else {
      ms.pinMemory(memoryId)
    }

    log('INFO', 'experience_memory_pin_toggled', {
      id: memoryId,
      pinned: entry.isPinned,
      content: entry.content.slice(0, 50),
    })
    return true
  }

  /** 删除一条经验记忆 */
  deleteExperience(memoryId: string): boolean {
    const ms = getMemoryService()
    if (!ms) return false

    const entry = ms.getEntries().find((e) => e.id === memoryId && e.type === 'blog_memory')
    if (!entry) return false

    return ms.forgetEntry(memoryId)
  }

  /** 清空指定 blogId 的所有经验（保留固定的） */
  clearBlogExperiences(blogId: string, includePinned = false): number {
    const ms = getMemoryService()
    if (!ms) return 0

    let count = 0
    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        if (data.blogId === blogId && (includePinned || !entry.isPinned)) {
          if (ms.forgetEntry(entry.id)) count++
        }
      } catch {
        continue
      }
    }

    log('INFO', 'experience_memory_cleared', { blogId, count, includePinned })
    return count
  }

  /**
   * 按 blogId 列出经验。
   */
  listExperiences(blogId?: string, options?: ExperienceSearchOptions): ExperienceSearchResult[] {
    const ms = getMemoryService()
    if (!ms) return []

    const results: ExperienceSearchResult[] = []

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData

        // 过滤
        if (blogId && data.blogId !== blogId) continue
        if (options?.category) {
          const cats = Array.isArray(options.category) ? options.category : [options.category]
          if (!cats.includes(data.category)) continue
        }
        if (options?.pinnedOnly && !entry.isPinned) continue
        if (options?.fromTimestamp && data.timestamp < options.fromTimestamp) continue
        if (options?.toTimestamp && data.timestamp > options.toTimestamp) continue

        results.push({
          memoryEntry: entry,
          data,
          score: entry.isPinned ? 1.0 : 0.5,
        })
      } catch {
        continue
      }
    }

    // 按时间降序排列
    results.sort((a, b) => b.data.timestamp - a.data.timestamp)

    const limit = options?.limit || MAX_SEARCH_RESULTS
    return results.slice(0, limit)
  }

  /** 获取所有包含经验的 blogId 列表 */
  listBlogIds(): string[] {
    const ms = getMemoryService()
    if (!ms) return []

    const ids = new Set<string>()
    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory' || !entry.structuredData) continue
      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        ids.add(data.blogId)
      } catch {
        continue
      }
    }
    return Array.from(ids).sort()
  }

  /** 获取经验统计 */
  getStats(): { totalEntries: number; pinnedCount: number; blogCount: number; categoryCounts: Record<string, number> } {
    const ms = getMemoryService()
    if (!ms) {
      return { totalEntries: 0, pinnedCount: 0, blogCount: 0, categoryCounts: {} }
    }

    const blogIds = new Set<string>()
    const categoryCounts: Record<string, number> = {}
    let pinnedCount = 0
    let totalEntries = 0

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      totalEntries++
      if (entry.isPinned) pinnedCount++
      if (entry.structuredData) {
        try {
          const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
          blogIds.add(data.blogId)
          categoryCounts[data.category] = (categoryCounts[data.category] || 0) + 1
        } catch {
          // skip
        }
      }
    }

    return { totalEntries, pinnedCount, blogCount: blogIds.size, categoryCounts }
  }

  // ===========================================================================
  // 内部方法
  // ===========================================================================

  /** 从 MemoryService 获取所有 blog_memory 条目 */
  private getBlogMemoryEntries(ms: { getEntries(): MemoryEntry[] }): ParsedExperienceEntry[] {
    const result: ParsedExperienceEntry[] = []

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        result.push({ memoryEntry: entry, data })
      } catch {
        continue
      }
    }

    return result
  }

  /** 计算相似度并排序 */
  private scoreAndRank(queryEmb: number[], entries: ParsedExperienceEntry[], limit: number): ExperienceSearchResult[] {
    const scored: ExperienceSearchResult[] = []

    for (const { memoryEntry, data } of entries) {
      // 计算 content 的 fallback embedding（作为相似度近似）
      const contentEmb = fallbackEmbed(memoryEntry.content)
      const score = cosineSimilarity(queryEmb, contentEmb)

      if (score >= SIMILARITY_THRESHOLD) {
        scored.push({ memoryEntry, data, score })
      }
    }

    // 按相似度降序排列
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** 截断内容到最大长度 */
  private truncateContent(content: string): string {
    if (content.length <= this.config.maxContentLength) return content
    const truncated = content.slice(0, this.config.maxContentLength)
    const lastPeriod = Math.max(truncated.lastIndexOf('。'), truncated.lastIndexOf('. '), truncated.lastIndexOf('\n'))
    if (lastPeriod > this.config.maxContentLength * 0.6) {
      return truncated.slice(0, lastPeriod + 1) + '…'
    }
    return truncated + '…'
  }

  /** 根据工作流步骤 ID 推断分类 */
  private categorizeStep(stepId: string, content: string): BlogMemoryCategory {
    // 优先使用预定义映射
    const mapped = STEP_CATEGORY_MAP[stepId]
    if (mapped) return mapped

    // 回退到内容启发式
    const lower = content.toLowerCase()
    if (/test|测试|单元测试|集成测试|e2e|覆盖率/.test(lower)) return 'test_result'
    if (/bug|fix|修复|错误|error|exception|crash|崩溃/.test(lower)) return 'bug_fix'
    if (/refactor|重构|重写|简化|提取|extract/.test(lower)) return 'refactoring'
    if (/perf|性能|优化|瓶颈|slow|卡顿|延迟/.test(lower)) return 'performance'
    if (/arch|架构|设计模式|pattern|分层|模块化/.test(lower)) return 'architecture'
    if (/设计|决定|决策|方案|选型|选择|compare|对比/.test(lower)) return 'design_decision'
    if (/分析|analyz|review|审计|audit|评估/.test(lower)) return 'analysis'

    return 'other'
  }

  // ===========================================================================
  // 事件处理
  // ===========================================================================

  /** 处理工作流创建事件：追踪 defId */
  private onWorkflowCreated = (payload: EventPayload['workflow.run.created']): void => {
    if (payload.workflowDefId) {
      this.runDefMap.set(payload.runId, payload.workflowDefId)
    }
  }

  /** 处理工作流步骤事件：自动记录经验记忆 */
  private onWorkflowStep = (payload: EventPayload['workflow.run.step']): void => {
    if (!this.config.enabled) return
    if (this.entryCount >= this.config.maxEntries) {
      log('WARN', 'experience_memory_max_entries', { max: this.config.maxEntries })
      return
    }

    // 只记录完成（done）的步骤
    if (payload.status !== 'done') return

    const ms = getMemoryService()
    if (!ms) return

    // 获取工作流定义 ID，判断是否是博客工作流
    const defId = this.runDefMap.get(payload.runId)
    if (defId && defId !== BLOG_WORKFLOW_DEF_ID) {
      // 非博客工作流，不记录
      return
    }

    // 如果还没有 defId，从 workStore 中查找
    if (!defId) {
      try {
        const run = workflowStore.getRun(payload.runId)
        if (run?.workflowDefId) {
          this.runDefMap.set(payload.runId, run.workflowDefId)
          if (run.workflowDefId !== BLOG_WORKFLOW_DEF_ID) return
        } else {
          return // 暂时无法确认工作流类型，跳过
        }
      } catch {
        return
      }
    }

    // 构建步骤描述
    const stepDescription = STEP_DESCRIPTION_MAP[payload.stepId] || payload.stepId
    const agentResult = payload.agentResult

    // agentResult 可能是 null/undefined/空字符串/无有用内容
    if (!agentResult) return

    // 将 agentResult 转为字符串
    const resultStr = typeof agentResult === 'string' ? agentResult : JSON.stringify(agentResult, null, 2)

    if (!resultStr || resultStr.trim().length === 0) return

    // 确定分类
    const category = this.categorizeStep(payload.stepId, resultStr)

    // 获取 blogId
    const blogId = this.runBlogMap.get(payload.runId) || this.currentBlogId || `wf_${payload.runId}`

    const truncated = this.truncateContent(resultStr)

    const structuredData: BlogMemoryStructuredData = {
      blogId,
      planId: payload.runId,
      planTitle: stepDescription,
      stepIndex: -1,
      stepDescription,
      timestamp: Date.now(),
      category,
    }

    ms.addEntry('blog_memory', truncated, this.config.defaultConfidence, {
      tier: this.config.defaultTier,
      structuredData: JSON.stringify(structuredData),
    })

    this.entryCount++

    log('INFO', 'experience_memory_recorded', {
      blogId,
      stepId: payload.stepId,
      category,
      contentLength: truncated.length,
      totalEntries: this.entryCount,
    })
  }
}

// =============================================================================
// 内部类型
// =============================================================================

interface ParsedExperienceEntry {
  memoryEntry: MemoryEntry
  data: BlogMemoryStructuredData
}

// =============================================================================
// 单例导出
// =============================================================================

/** 全局单例 */
export let experienceMemoryService: ExperienceMemoryService | null = null

/**
 * 初始化经验记忆工作流引擎。
 * 应在应用启动时调用一次。
 */
export function initExperienceMemoryService(config?: Partial<BlogMemoryRecorderConfig>): ExperienceMemoryService {
  if (!experienceMemoryService) {
    experienceMemoryService = new ExperienceMemoryService(config)
    experienceMemoryService.start()
  }
  return experienceMemoryService
}
