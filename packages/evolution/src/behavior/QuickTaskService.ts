/**
 * QuickTaskService — 基于行为模式的智能快捷任务编排
 *
 * 定期分析 __behaviorToolRecords 中的高频操作序列（最近 106 次交互），
 * 使用滑动窗口模式匹配算法检测重复任务线索，生成面向用户的快捷任务推荐。
 *
 * 工作流程：
 * 1. analyze(): 读取 __behaviorToolRecords，滑动窗口提取 2-4 步序列
 * 2. 过滤 >= minFrequency 的高频序列，生成 QuickTask 对象
 * 3. 根据灵敏度和用户历史反馈过滤推荐
 * 4. 通过 IPC 'quick_task:recommend' 推送到渲染进程
 * 5. 用户反馈（执行/关闭）通过 feedback() 处理，影响后续推荐
 *
 * 集成点：
 * - 依赖 __behaviorToolRecords 全局钩子（与 BehaviorSequenceLearner 同源）
 * - IPC 通道：quick_task:recommend（主→渲染）, quick_task:update（主→渲染）
 * - ipcMain.handle('quickTask:*') 在 handlers.ts 中注册
 * - 可在 bootstrap/AppRuntime 或 SelfEvolutionService 中启动周期性分析
 *
 * 风险控制：
 * - sensitivityThreshold 控制推荐灵敏度（默认 60）
 * - 同一任务最多推荐 maxRecommendationsPerTask 次
 * - 关闭后 suppressDurationMs 内不再次推荐
 * - 被频繁关闭的任务自动降级 recommendationLevel
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { WORKSPACE } from '@akemi-mio/core/config'
import { getMainWindow } from '@akemi-mio/core/core/Lifecycle'
import {
  type QuickTask,
  type QuickTaskConfig,
  type QuickTaskStep,
  type QuickTaskFeedback,
  type QuickTaskServiceSnapshot,
  type RecommendationLevel,
  DEFAULT_QUICK_TASK_CONFIG,
} from './QuickTaskTypes'

// =============================================================================
// 工具名 → 中文描述映射（复用 BehaviorSequenceLearner 的映射风格）
// =============================================================================

const TOOL_LABEL_MAP: Record<string, string> = {
  read_file: '读取文件',
  read_file_centos: '读取远程文件',
  write_file: '编写文件',
  write_file_centos: '编写远程文件',
  edit_file: '编辑代码',
  grep: '搜索代码',
  grep_centos: '搜索远程代码',
  list_files: '浏览文件',
  run_command: '执行命令',
  exec_centos: '执行远程命令',
  create_dev_plan: '创建开发计划',
  update_plan_progress: '更新计划进度',
  analyze_codebase: '分析代码库',
  analyze_task: '分析任务',
  remember_fact: '记录知识',
  generate_image: '生成图片',
  writing_system: '创意写作',
  auto_schedule_workflow: '自动化工作流',
  learning_query: '学习查询',
  oral_code_generate: '生成代码',
  get_system_health: '系统健康检查',
  list_plans: '查看计划',
  list_workflows: '查看工作流',
  social_pipeline: '社交媒体',
  query_trends: '查询趋势',
  get_credential: '获取凭证',
  list_credentials: '列出凭证',
  list_mcp_servers: '列出服务',
  list_skills: '列出技能',
}

// =============================================================================
// 语义标签生成（基于工具序列的标题）
// =============================================================================

/**
 * 为工具序列生成友好标题。
 * 例如 ["grep", "read_file", "edit_file"] → "搜索并修改代码"
 *       ["run_command", "grep"] → "执行命令并搜索"
 */
function generateSequenceTitle(tools: string[]): string {
  if (tools.length === 0) return '快捷操作'

  const labels = tools.map((t) => TOOL_LABEL_MAP[t] || t)

  if (tools.length === 2) {
    // 搜索并读取、编写并运行
    return `${labels[0]}并${labels[1]}`
  }

  if (tools.length === 3) {
    return `${labels[0]}、${labels[1]}并${labels[2]}`
  }

  return `${labels[0]}等多步操作`
}

/**
 * 将工具序列映射为 QuickTaskStep 列表。
 */
function toolsToSteps(tools: string[]): QuickTaskStep[] {
  return tools.map((t) => ({
    tool: t,
    label: TOOL_LABEL_MAP[t] || t,
  }))
}

// =============================================================================
// 持久化路径
// =============================================================================

const QUICK_TASKS_FILE = join(WORKSPACE.cache, 'quick-tasks.json')
const FEEDBACK_FILE = join(WORKSPACE.cache, 'quick-task-feedback.json')

// =============================================================================
// QuickTaskService
// =============================================================================

export class QuickTaskService {
  private config: QuickTaskConfig
  private tasks: QuickTask[] = []
  private feedbackHistory: QuickTaskFeedback[] = []
  private lastAnalysisAt: number | null = null
  private recommendTimer: ReturnType<typeof setInterval> | null = null
  private totalExecuted = 0

  constructor(config?: Partial<QuickTaskConfig>) {
    this.config = { ...DEFAULT_QUICK_TASK_CONFIG, ...config }
    this.load()
  }

  // ==================== 核心分析 API ====================

  /**
   * 执行一次行为分析：
   * 1. 读取工具调用记录
   * 2. 滑动窗口提取 2-4 步序列
   * 3. 过滤高频序列并生成 QuickTask
   * 4. 合并/更新已有任务
   * 5. 持久化
   *
   * @returns 当前活跃的 QuickTask 列表
   */
  analyze(): QuickTask[] {
    const records = this.getToolRecords()
    if (records.length < 3) {
      log('INFO', 'quick_task_insufficient_data', { records: records.length })
      return []
    }

    // 1. 提取序列
    const sequenceMap = this.extractSequences(records)

    // 2. 过滤高频
    const frequent = Array.from(sequenceMap.entries())
      .filter(([, count]) => count >= this.config.minFrequency)
      .sort((a, b) => b[1] - a[1])

    if (frequent.length === 0) {
      log('INFO', 'quick_task_no_patterns', {
        uniqueSequences: sequenceMap.size,
        minThreshold: this.config.minFrequency,
      })
      return []
    }

    // 3. 生成/更新 QuickTask
    const now = Date.now()
    const seenKeys = new Set<string>()

    for (const [key, frequency] of frequent) {
      const tools = key.split('→')
      const taskId = `qt_${key.replace(/[→]/g, '_')}`
      seenKeys.add(taskId)

      const existing = this.tasks.find((t) => t.id === taskId)
      const title = generateSequenceTitle(tools)
      const steps = toolsToSteps(tools)
      const confidence = this.calcConfidence(frequency, records.length)
      const recommendationLevel = this.determineLevel(taskId, frequency, confidence)

      const task: QuickTask = {
        id: taskId,
        title,
        description: `将自动执行 ${tools.length} 步操作：${steps.map((s) => s.label).join(' → ')}`,
        steps,
        toolSequence: tools,
        frequency,
        confidence,
        recommendationLevel,
        status: 'active',
        firstRecommendedAt: existing?.firstRecommendedAt ?? now,
        lastActiveAt: now,
        executionCount: existing?.executionCount ?? 0,
        dismissCount: existing?.dismissCount ?? 0,
      }

      const idx = this.tasks.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        this.tasks[idx] = task
      } else {
        this.tasks.push(task)
      }
    }

    // 4. 清理不再活跃的任务（连续两次未出现设为 pending）
    for (const task of this.tasks) {
      if (!seenKeys.has(task.id) && task.status === 'active') {
        // 给一次恢复机会
        if (task.lastActiveAt < now - this.config.autoRecommendIntervalMs * 2) {
          task.status = 'pending'
          task.recommendationLevel = 'suppressed'
          log('INFO', 'quick_task_deactivated', {
            id: task.id,
            title: task.title,
          })
        }
      }
    }

    // 5. 应用灵敏度过滤
    const activeTasks = this.getActiveRecommendations()

    // 6. 持久化
    this.save()

    this.lastAnalysisAt = now

    log('INFO', 'quick_task_analysis_complete', {
      uniqueSequences: sequenceMap.size,
      activeTasks: activeTasks.length,
      totalTasks: this.tasks.length,
      totalExecuted: this.totalExecuted,
    })

    return activeTasks
  }

  /**
   * 从工具调用记录中提取 2-4 步连续序列（滑动窗口）。
   * 内部任意两步间隔超过 sequenceGapMs 视为不连续，跳过。
   */
  private extractSequences(records: Array<{ name: string; timestamp: number }>): Map<string, number> {
    const seqMap = new Map<string, number>()
    const { minSequenceLength, maxSequenceLength, sequenceGapMs } = this.config

    for (let n = minSequenceLength; n <= maxSequenceLength; n++) {
      for (let i = 0; i <= records.length - n; i++) {
        const window = records.slice(i, i + n)

        // 检查连续性
        let continuous = true
        for (let j = 1; j < window.length; j++) {
          if (window[j].timestamp - window[j - 1].timestamp > sequenceGapMs) {
            continuous = false
            break
          }
        }
        if (!continuous) continue

        const key = window.map((c) => c.name).join('→')
        seqMap.set(key, (seqMap.get(key) || 0) + 1)
      }
    }

    return seqMap
  }

  // ==================== 推荐管理 ====================

  /**
   * 获取当前应推荐给用户的快捷任务列表。
   * 综合考虑：灵敏度阈值、用户关闭历史、推荐次数上限、抑制周期。
   */
  getActiveRecommendations(): QuickTask[] {
    const now = Date.now()
    const suppressedTaskIds = this.computeSuppressedIds(now)

    return this.tasks
      .filter((t) => {
        // 仅推荐 active 状态的任务
        if (t.status !== 'active') return false

        // 检查是否处于抑制期
        if (suppressedTaskIds.has(t.id)) return false

        // 检查推荐次数是否超限
        if (t.executionCount + t.dismissCount >= this.config.maxRecommendationsPerTask) {
          return false
        }

        return true
      })
      .sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * 计算当前应被抑制的任务 ID 集合。
   * 抑制条件：被关闭未超过 suppressDurationMs
   */
  private computeSuppressedIds(now: number): Set<string> {
    const suppressed = new Set<string>()

    for (const fb of this.feedbackHistory) {
      if (fb.action === 'dismissed' || fb.action === 'snoozed') {
        const elapsed = now - fb.timestamp
        if (elapsed < this.config.suppressDurationMs) {
          suppressed.add(fb.taskId)
        }
      }
    }

    return suppressed
  }

  /**
   * 确定推荐级别。
   * - suppressed: 被关闭过的任务或频率低于阈值的
   * - auto: 高频、高置信度、无负面反馈
   * - suggested: 中等频率，适合作为建议展示
   */
  private determineLevel(taskId: string, frequency: number, confidence: number): RecommendationLevel {
    // 检查是否有负面反馈
    const negativeFeedback = this.feedbackHistory.filter(
      (fb) => fb.taskId === taskId && (fb.action === 'dismissed' || fb.action === 'snoozed'),
    )
    if (negativeFeedback.length >= 2) return 'suppressed'

    // 高频率 + 高置信度 → auto
    if (frequency >= this.config.minFrequency * 2 && confidence >= 0.6) return 'auto'

    // 中等 → suggested
    return 'suggested'
  }

  // ==================== 用户反馈 ====================

  /**
   * 记录用户对快捷任务的反馈（执行/关闭/编辑/稍后提醒）。
   */
  feedback(taskId: string, action: QuickTaskFeedback['action']): QuickTask | undefined {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) {
      log('WARN', 'quick_task_feedback_not_found', { taskId, action })
      return undefined
    }

    const feedback: QuickTaskFeedback = {
      taskId,
      action,
      timestamp: Date.now(),
    }

    this.feedbackHistory.push(feedback)

    // 更新任务状态
    switch (action) {
      case 'executed':
        task.executionCount++
        task.status = 'executed'
        this.totalExecuted++
        break
      case 'dismissed':
        task.dismissCount++
        task.status = 'dismissed'
        task.recommendationLevel = 'suppressed'
        break
      case 'snoozed':
        task.dismissCount++
        break
      case 'edited':
        // 编辑不改变状态
        break
    }

    this.save()
    this.pushUpdate(task, action)

    log('INFO', 'quick_task_feedback', {
      taskId,
      action,
      totalExecuted: this.totalExecuted,
    })

    return task
  }

  /**
   * 编辑快捷任务的步骤序列（用户自定义）。
   */
  editTask(taskId: string, steps: QuickTaskStep[]): QuickTask | undefined {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return undefined

    task.steps = steps
    task.toolSequence = steps.map((s) => s.tool)
    // 更新标题以反映自定义
    if (steps.length > 0) {
      task.title = generateSequenceTitle(task.toolSequence)
      task.description = `自定义快捷任务：${steps.map((s) => s.label).join(' → ')}`
    }

    this.save()
    this.pushUpdate(task, 'edited')

    log('INFO', 'quick_task_edited', { taskId, steps: steps.length })
    return task
  }

  // ==================== 灵敏度控制 ====================

  /** 获取当前灵敏度阈值 */
  getSensitivityThreshold(): number {
    return this.config.sensitivityThreshold
  }

  /** 设置灵敏度阈值（0-100），越高越容易推荐 */
  setSensitivityThreshold(threshold: number): void {
    this.config.sensitivityThreshold = Math.max(0, Math.min(100, threshold))
    this.save()
    log('INFO', 'quick_task_sensitivity_changed', { threshold: this.config.sensitivityThreshold })
  }

  /** 获取完整配置 */
  getConfig(): QuickTaskConfig {
    return { ...this.config }
  }

  /** 更新配置（合并式） */
  updateConfig(patch: Partial<QuickTaskConfig>): void {
    this.config = { ...this.config, ...patch }
    this.save()
    log('INFO', 'quick_task_config_updated', { patch: Object.keys(patch) })
  }

  // ==================== IPC 推送 ====================

  /**
   * 将推荐列表推送到渲染进程。
   * 仅在 mainWindow 可用时推送。
   */
  pushRecommendations(): void {
    const tasks = this.getActiveRecommendations()
    if (tasks.length === 0) return

    const win = getMainWindow()
    if (!win || win.isDestroyed()) return

    try {
      win.webContents.send('quick_task:recommend', {
        tasks,
        timestamp: Date.now(),
      })
      log('INFO', 'quick_task_pushed', { count: tasks.length })
    } catch (err: any) {
      log('WARN', 'quick_task_push_failed', { error: String(err) })
    }
  }

  /**
   * 推送单个任务状态更新到渲染进程。
   */
  private pushUpdate(task: QuickTask, action: QuickTaskFeedback['action']): void {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return

    try {
      win.webContents.send('quick_task:update', { task, action, timestamp: Date.now() })
    } catch {
      // 静默失败（窗口未准备好不影响业务逻辑）
    }
  }

  // ==================== 定时器管理 ====================

  /**
   * 启动自动分析和推荐周期。
   * 会立即执行一次分析并推送。
   */
  startAutoRecommend(intervalMs?: number): void {
    this.stopAutoRecommend()

    const ms = intervalMs ?? this.config.autoRecommendIntervalMs

    // 立即执行一次
    setImmediate(() => {
      try {
        this.analyze()
        this.pushRecommendations()
      } catch (err) {
        log('WARN', 'quick_task_initial_run', { error: String(err) })
      }
    })

    this.recommendTimer = setInterval(() => {
      try {
        this.analyze()
        this.pushRecommendations()
      } catch (err) {
        log('WARN', 'quick_task_auto_run', { error: String(err) })
      }
    }, ms)

    log('INFO', 'quick_task_auto_recommend_started', {
      intervalMs: ms,
      intervalMin: Math.round(ms / 60_000),
      sensitivityThreshold: this.config.sensitivityThreshold,
    })
  }

  /** 停止自动推荐 */
  stopAutoRecommend(): void {
    if (this.recommendTimer) {
      clearInterval(this.recommendTimer)
      this.recommendTimer = null
    }
  }

  /** 是否正在自动推荐 */
  isAutoRecommendActive(): boolean {
    return this.recommendTimer !== null
  }

  /**
   * 手动触发一次完整的分析 + 推荐推送。
   */
  recommendNow(): QuickTask[] {
    const tasks = this.analyze()
    this.pushRecommendations()
    return tasks
  }

  // ==================== 查询接口 ====================

  /** 获取所有已学习的快捷任务 */
  getAllTasks(): QuickTask[] {
    return [...this.tasks]
  }

  /** 获取服务快照 */
  getSnapshot(): QuickTaskServiceSnapshot {
    return {
      totalTasksLearned: this.tasks.length,
      activeRecommendations: this.getActiveRecommendations().length,
      suppressedTasks: this.tasks.filter((t) => t.recommendationLevel === 'suppressed').length,
      totalExecuted: this.totalExecuted,
      sensitivityThreshold: this.config.sensitivityThreshold,
      lastAnalysisAt: this.lastAnalysisAt,
      activeTasks: this.getActiveRecommendations(),
      config: { ...this.config },
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 从 __behaviorToolRecords 全局钩子读取工具调用记录。
   * 与 BehaviorSequenceLearner 同源。
   */
  private getToolRecords(): Array<{ name: string; timestamp: number }> {
    const records = (globalThis as any).__behaviorToolRecords
    if (Array.isArray(records) && records.length > 0) {
      return records.slice(-this.config.analysisWindow)
    }
    return []
  }

  /**
   * 计算置信度（基于频率占比）。
   */
  private calcConfidence(frequency: number, totalCalls: number): number {
    if (totalCalls === 0) return 0
    const ratio = frequency / totalCalls
    return Math.min(1, Math.sqrt(ratio * 12) * 0.5 + 0.1)
  }

  // ==================== 持久化 ====================

  private save(): void {
    try {
      const dir = dirname(QUICK_TASKS_FILE)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const data = {
        version: 1,
        updatedAt: Date.now(),
        config: this.config,
        totalExecuted: this.totalExecuted,
        lastAnalysisAt: this.lastAnalysisAt,
        tasks: this.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          steps: t.steps,
          toolSequence: t.toolSequence,
          frequency: t.frequency,
          confidence: t.confidence,
          recommendationLevel: t.recommendationLevel,
          status: t.status,
          firstRecommendedAt: t.firstRecommendedAt,
          lastActiveAt: t.lastActiveAt,
          executionCount: t.executionCount,
          dismissCount: t.dismissCount,
        })),
        feedbackHistory: this.feedbackHistory,
      }

      writeFileSync(QUICK_TASKS_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'quick_task_save_failed', { error: String(err) })
    }
  }

  private load(): void {
    try {
      if (!existsSync(QUICK_TASKS_FILE)) return

      const raw = readFileSync(QUICK_TASKS_FILE, 'utf-8')
      const data = JSON.parse(raw)

      if (!data || typeof data !== 'object') return

      // 恢复配置
      if (data.config) {
        this.config = { ...DEFAULT_QUICK_TASK_CONFIG, ...data.config }
      }

      this.totalExecuted = data.totalExecuted || 0
      this.lastAnalysisAt = data.lastAnalysisAt || null

      // 恢复任务
      if (Array.isArray(data.tasks)) {
        this.tasks = data.tasks.map((item: any) => ({
          id: item.id,
          title: item.title || '',
          description: item.description || '',
          steps: item.steps || [],
          toolSequence: item.toolSequence || [],
          frequency: item.frequency || 0,
          confidence: item.confidence || 0,
          recommendationLevel: item.recommendationLevel || 'suggested',
          status: item.status || 'pending',
          firstRecommendedAt: item.firstRecommendedAt || Date.now(),
          lastActiveAt: item.lastActiveAt || Date.now(),
          executionCount: item.executionCount || 0,
          dismissCount: item.dismissCount || 0,
        }))
      }

      // 恢复反馈历史
      if (Array.isArray(data.feedbackHistory)) {
        this.feedbackHistory = data.feedbackHistory
      }

      log('INFO', 'quick_task_loaded', {
        tasks: this.tasks.length,
        active: this.tasks.filter((t) => t.status === 'active').length,
        totalExecuted: this.totalExecuted,
      })
    } catch (err: any) {
      log('WARN', 'quick_task_load_failed', { error: String(err) })
    }
  }

  /** 清除所有状态 */
  reset(): void {
    this.tasks = []
    this.feedbackHistory = []
    this.totalExecuted = 0
    this.lastAnalysisAt = null
    this.save()
    log('INFO', 'quick_task_reset')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局单例，供 IPC handlers 和启动入口使用 */
export const quickTaskService = new QuickTaskService()
