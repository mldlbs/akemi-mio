/**
 * BlogMemoryRecorder — 博客记忆记录器
 *
 * 职责：
 * 1. 订阅 EventBus 的 agent.plan.step / agent.plan.completed 事件
 * 2. 在步骤完成（status === 'done'）时提取关键信息摘要
 * 3. 通过 MemoryService.addEntry() 存入 Memory
 * 4. 按 blogId 组织（默认使用 planId），支持自定义 blogId
 *
 * 风险注意：
 * - Memory 存储膨胀：受 maxEntries 和 tier 控制
 * - 敏感信息暴露：content 字段会截断，不会存储完整代码
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import type { EventPayload } from '@akemi-mio/core/core/EventBus'
import { getMemoryService, getPlanManager } from '@akemi-mio/capabilities/tool/deps'
import type { BlogMemoryStructuredData, BlogMemoryCategory, BlogMemoryRecorderConfig } from './types'
import {
  BLOG_MEMORY_ENABLED,
  BLOG_MEMORY_MAX_ENTRIES,
  BLOG_MEMORY_MAX_CONTENT_LENGTH,
  BLOG_MEMORY_DEFAULT_TIER,
  BLOG_MEMORY_DEFAULT_CONFIDENCE,
} from '@akemi-mio/core/config'

/** 默认配置 */
const DEFAULT_CONFIG: BlogMemoryRecorderConfig = {
  enabled: BLOG_MEMORY_ENABLED,
  maxEntries: BLOG_MEMORY_MAX_ENTRIES,
  maxContentLength: BLOG_MEMORY_MAX_CONTENT_LENGTH,
  defaultTier: BLOG_MEMORY_DEFAULT_TIER,
  defaultConfidence: BLOG_MEMORY_DEFAULT_CONFIDENCE,
}

/**
 * 自动分类启发式：根据步骤描述和结果内容猜测分类
 */
function categorizeStep(description: string, result: string): BlogMemoryCategory {
  const lower = (description + ' ' + result).toLowerCase()

  if (/test|测试|单元测试|集成测试|e2e|覆盖率/.test(lower)) return 'test_result'
  if (/bug|fix|修复|错误|error|exception|crash|崩溃/.test(lower)) return 'bug_fix'
  if (/refactor|重构|重写|简化|提取|extract/.test(lower)) return 'refactoring'
  if (/perf|性能|优化|瓶颈|slow|卡顿|延迟/.test(lower)) return 'performance'
  if (/arch|架构|设计模式|pattern|分层|模块化/.test(lower)) return 'architecture'
  if (/设计|决定|决策|方案|选型|选择|compare|对比/.test(lower)) return 'design_decision'
  if (/分析|analyz|review|审计|audit|评估/.test(lower)) return 'analysis'

  return 'other'
}

/**
 * 截断内容到最大长度，同时保留完整句子边界
 */
function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content
  const truncated = content.slice(0, maxLen)
  // 尝试在句子边界断开
  const lastPeriod = Math.max(truncated.lastIndexOf('。'), truncated.lastIndexOf('. '), truncated.lastIndexOf('\n'))
  if (lastPeriod > maxLen * 0.6) {
    return truncated.slice(0, lastPeriod + 1) + '…'
  }
  return truncated + '…'
}

export class BlogMemoryRecorder {
  private config: BlogMemoryRecorderConfig
  private tracker = new SubscriptionTracker()
  private customBlogId: string | null = null
  private entryCount = 0

  constructor(config?: Partial<BlogMemoryRecorderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 启动记录器：订阅 EventBus 事件 */
  start(): void {
    if (!this.config.enabled) {
      log('INFO', 'blog_memory_recorder_disabled')
      return
    }

    eventBus.track('agent.plan.step', this.onPlanStep, this.tracker, {
      label: 'blog-memory-recorder',
    })
    eventBus.track('agent.plan.completed', this.onPlanCompleted, this.tracker, {
      label: 'blog-memory-recorder',
    })

    log('INFO', 'blog_memory_recorder_started', {
      maxEntries: this.config.maxEntries,
      maxContentLength: this.config.maxContentLength,
    })
  }

  /** 停止记录器：取消所有订阅 */
  stop(): void {
    this.tracker.dispose()
    log('INFO', 'blog_memory_recorder_stopped')
  }

  /**
   * 设置自定义 blogId。
   * 如果设置了，后续记录的 blogId 将使用此值而非 planId。
   * 适用于多个计划贡献到同一篇博客的场景。
   */
  setCurrentBlogId(blogId: string | null): void {
    this.customBlogId = blogId
    log('INFO', 'blog_memory_recorder_set_blog_id', { blogId })
  }

  /** 获取当前 blogId */
  getCurrentBlogId(): string | null {
    return this.customBlogId
  }

  /** 获取已记录的条目数 */
  getEntryCount(): number {
    return this.entryCount
  }

  /**
   * 手动记录一条博客记忆（无需等待 Plan 事件）。
   * 用于 Agent 在非 Plan 步骤执行时的主动记录。
   */
  record(content: string, category: BlogMemoryCategory = 'other', blogId?: string): boolean {
    if (!this.config.enabled) return false
    const ms = getMemoryService()
    if (!ms) return false

    const id = blogId || this.customBlogId || 'default'
    const truncated = truncateContent(content, this.config.maxContentLength)
    const structuredData: BlogMemoryStructuredData = {
      blogId: id,
      planId: 'manual',
      planTitle: '手动记录',
      stepIndex: -1,
      stepDescription: '',
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

  // ── 事件处理 ──

  private onPlanStep = (payload: EventPayload['agent.plan.step']): void => {
    if (payload.status !== 'done') return
    if (this.entryCount >= this.config.maxEntries) {
      log('WARN', 'blog_memory_max_entries_reached', {
        max: this.config.maxEntries,
      })
      return
    }

    const pm = getPlanManager()
    if (!pm) return

    const plan = pm.getPlan(payload.planId)
    if (!plan) return

    const step = plan.steps[payload.stepIndex]
    if (!step) return

    const result = step.result || payload.result
    if (!result || result.trim().length === 0) return

    const ms = getMemoryService()
    if (!ms) return

    const category = categorizeStep(step.description, result)
    const truncated = truncateContent(result, this.config.maxContentLength)
    const blogId = this.customBlogId || payload.planId

    const structuredData: BlogMemoryStructuredData = {
      blogId,
      planId: payload.planId,
      planTitle: plan.title,
      stepIndex: payload.stepIndex,
      stepDescription: step.description,
      timestamp: Date.now(),
      category,
    }

    ms.addEntry('blog_memory', truncated, this.config.defaultConfidence, {
      tier: this.config.defaultTier,
      structuredData: JSON.stringify(structuredData),
    })

    this.entryCount++

    log('INFO', 'blog_memory_recorded', {
      blogId,
      planId: payload.planId,
      stepIndex: payload.stepIndex,
      category,
      contentLength: truncated.length,
      totalEntries: this.entryCount,
    })
  }

  private onPlanCompleted = (payload: EventPayload['agent.plan.completed']): void => {
    if (this.entryCount >= this.config.maxEntries) return

    const pm = getPlanManager()
    if (!pm) return

    const plan = pm.getPlan(payload.planId)
    if (!plan) return

    // 记录计划完成总结
    const doneCount = plan.steps.filter((s) => s.status === 'done').length
    const totalCount = plan.steps.length
    const summary = `计划完成：${plan.title}（${doneCount}/${totalCount} 步骤完成）`
    const reflection = plan.reflection || ''

    const ms = getMemoryService()
    if (!ms) return

    const blogId = this.customBlogId || payload.planId
    const structuredData: BlogMemoryStructuredData = {
      blogId,
      planId: payload.planId,
      planTitle: plan.title,
      stepIndex: -1, // 表示计划级别的摘要
      stepDescription: '计划完成总结',
      timestamp: Date.now(),
      category: 'other',
    }

    const content = reflection ? `${summary}\n反思：${truncateContent(reflection, this.config.maxContentLength)}` : summary

    ms.addEntry('blog_memory', content, this.config.defaultConfidence, {
      tier: this.config.defaultTier,
      structuredData: JSON.stringify(structuredData),
    })

    this.entryCount++

    log('INFO', 'blog_memory_plan_completed_recorded', {
      blogId,
      planId: payload.planId,
      doneSteps: doneCount,
      totalSteps: totalCount,
    })
  }
}

/** 单例导出 */
export let blogMemoryRecorder: BlogMemoryRecorder | null = null

export function initBlogMemoryRecorder(config?: Partial<BlogMemoryRecorderConfig>): BlogMemoryRecorder {
  if (!blogMemoryRecorder) {
    blogMemoryRecorder = new BlogMemoryRecorder(config)
    blogMemoryRecorder.start()
  }
  return blogMemoryRecorder
}
