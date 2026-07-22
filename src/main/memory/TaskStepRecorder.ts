/**
 * TaskStepRecorder — 跨会话任务记忆与恢复
 *
 * 职责：
 * 1. 自动记录 Agent toolLoop 中每轮的输入/输出/工具调用结果到 Memory 子系统
 * 2. 关联唯一的 taskId（可选）和 sessionId
 * 3. 提供语义匹配检索，支持从断点恢复执行
 * 4. 支持过期策略，防止存储膨胀
 *
 * 集成点：
 * - ChatExecutor.toolLoop()：每轮工具执行后调用 recordToolCallRound()
 * - AgentService 启动时：检查中断任务并生成恢复上下文
 * - MemoryCleaner：整合过期清理
 */

import { log } from '../logger/Logger'
import type { MemoryService, TaskStateData } from './MemoryService'
import type { ToolResult } from '../agent/ToolScheduler'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface TaskStepRecord {
  /** 步骤索引 (工具循环的迭代序号) */
  stepIndex: number
  /** 本轮中该工具的序号 */
  toolIndexInRound: number
  /** 本轮工具总数 */
  roundTotalTools: number
  /** 会话 ID */
  sessionId: string
  /** 任务 ID（可选，由外部上下文提供） */
  taskId?: string
  /** 工具名称 */
  toolName: string
  /** 工具输入参数（JSON 字符串） */
  toolArgs: string
  /** 工具输出（截断至 4000 字符） */
  toolResult: string
  /** 是否成功 */
  toolSuccess: boolean
  /** 错误信息 */
  toolError?: string
  /** 执行耗时（毫秒） */
  latencyMs: number
  /** 记录时间戳 */
  timestamp: number
  /** 本轮 LLM 的回复文本（如有） */
  roundReply?: string
}

/** 任务步骤查询结果 */
export interface TaskStepQueryResult {
  content: string
  record: TaskStepRecord
  score: number
}

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 工具结果截断长度 */
const TRUNCATE_RESULT_LENGTH = 4000
/** 工具参数截断长度 */
const TRUNCATE_ARGS_LENGTH = 2000
/** 语义检索时返回的最大步骤数 */
const MAX_QUERY_STEPS = 20
/** 每个任务步骤的默认置信度 */
const STEP_CONFIDENCE = 0.85
/** 任务步骤默认层级（半永久，不被临时层衰减影响） */
const STEP_TIER = 'semi' as const

// ══════════════════════════════════════════
//  TaskStepRecorder
// ══════════════════════════════════════════

export class TaskStepRecorder {
  private memoryService: MemoryService

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService
  }

  // ══════════════════════════════════════════
  //  核心记录方法
  // ══════════════════════════════════════════

  /**
   * 记录一轮工具调用的全部结果。
   * 在 ChatExecutor.toolLoop() 中每轮工具执行完毕后调用。
   *
   * @param params.toolCalls 本轮 LLM 发起的工具调用列表
   * @param params.toolResults 工具执行结果列表
   * @param params.sessionId 当前会话 ID
   * @param params.stepIndex 当前 step 序号
   * @param params.taskId 可选的任务 ID
   * @param params.roundReply 本轮 LLM 的回复文本（可选）
   */
  recordToolCallRound(params: {
    toolCalls: Array<{ name: string; arguments?: Record<string, any> }>
    toolResults: ToolResult[]
    sessionId: string
    stepIndex: number
    taskId?: string
    roundReply?: string
  }): void {
    const { toolCalls, toolResults, sessionId, stepIndex, taskId, roundReply } = params
    const now = Date.now()

    // 为每个工具调用创建独立的 task_step 记忆条目
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const tr = toolResults[i]

      // 构建结构化数据
      const record: TaskStepRecord = {
        stepIndex,
        toolIndexInRound: i,
        roundTotalTools: toolCalls.length,
        sessionId,
        taskId,
        toolName: tc.name,
        toolArgs: JSON.stringify(tc.arguments ?? {}).slice(0, TRUNCATE_ARGS_LENGTH),
        toolResult: (tr?.content ?? tr?.error ?? '').slice(0, TRUNCATE_RESULT_LENGTH),
        toolSuccess: tr?.success ?? false,
        toolError: tr?.error,
        latencyMs: tr?.latencyMs ?? 0,
        timestamp: now,
        roundReply: roundReply?.slice(0, 500),
      }

      // 内容 = 唯一前缀 + 工具名 + 步骤索引，确保不会与已有条目去重冲突
      const uniqueContent = this.buildContentKey(taskId, sessionId, stepIndex, i)
      const content = `[step:${stepIndex}:tool:${i}] ${tc.name}: ${tc.name} — ${record.toolSuccess ? '成功' : '失败'}`

      // 通过结构化数据存储完整记录，不走 addEntry 的精确去重路径
      this.storeTaskStep(uniqueContent, content, record)
    }

    // 如果提供了 taskId，同步更新内存中的任务状态摘要
    if (taskId) {
      this.updateTaskStateSummary(taskId, stepIndex, toolResults, sessionId)
    }
  }

  /**
   * 将任务步骤记录直接存储到 MemoryService。
   * 使用唯一的 content key 避免被 addEntry 的去重逻辑合并。
   */
  private storeTaskStep(uniqueKey: string, content: string, record: TaskStepRecord): void {
    const ms = this.memoryService

    // 构建可检索的内容（前缀便于按 taskId/sessionId 过滤）
    const prefixedContent = `[taskstep:${uniqueKey}] ${content}`

    // 通过 addEntry 存储，传入 structuredData 以便检索时反序列化
    ms.addEntry('task_step', prefixedContent, STEP_CONFIDENCE, {
      tier: STEP_TIER,
      structuredData: JSON.stringify(record),
    })

    // 同时存储到 VectorMemory 以便语义检索
    ms.vector.store(prefixedContent, STEP_CONFIDENCE, 'user_fact')

    log('DEBUG', 'task_step_recorded', {
      toolName: record.toolName,
      stepIndex: record.stepIndex,
      success: record.toolSuccess,
      taskId: record.taskId ?? 'none',
      sessionId: record.sessionId,
    })
  }

  /**
   * 更新任务状态摘要（基于最新一轮工具执行结果）。
   * 使用 MemoryService 现有的 saveTaskState 接口。
   */
  private updateTaskStateSummary(
    taskId: string,
    stepIndex: number,
    toolResults: ToolResult[],
    sessionId: string,
  ): void {
    const ms = this.memoryService
    const existingTasks = ms.getUnfinishedTasks()
    const existing = existingTasks.find((t) => t.taskId === taskId)

    // 工具统计
    const successCount = toolResults.filter((r) => r.success).length
    const failCount = toolResults.filter((r) => !r.success).length

    const stepDescription = `步骤 ${stepIndex}: ${successCount}/${toolResults.length} 工具成功`
    const newStep = {
      description: stepDescription,
      status: failCount > 0 ? ('failed' as const) : ('completed' as const),
      result: toolResults.map((r) => `${r.name}: ${r.success ? 'OK' : `FAIL: ${r.error}`}`).join('; ').slice(0, 200),
      completedAt: Date.now(),
    }

    if (existing) {
      // 更新已有任务
      const updatedSteps = [...existing.steps]
      // 如果该步骤已存在则覆盖，否则追加
      const existingStepIdx = updatedSteps.findIndex((s) => s.description.startsWith(`步骤 ${stepIndex}:`))
      if (existingStepIdx >= 0) {
        updatedSteps[existingStepIdx] = newStep
      } else {
        updatedSteps.push(newStep)
      }

      ms.saveTaskState({
        ...existing,
        steps: updatedSteps,
        lastStepIndex: stepIndex,
        updatedAt: Date.now(),
        sessionIds: existing.sessionIds.includes(sessionId)
          ? existing.sessionIds
          : [...existing.sessionIds, sessionId],
      })
    } else {
      // 新任务
      ms.saveTaskState({
        taskId,
        title: `任务 ${taskId.slice(0, 12)}`,
        description: `自动记录的任务 (${toolResults.length} 工具调用)`,
        status: 'active',
        steps: [newStep],
        lastStepIndex: stepIndex,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionIds: [sessionId],
        tags: [],
      })
    }
  }

  // ══════════════════════════════════════════
  //  查询与恢复
  // ══════════════════════════════════════════

  /**
   * 获取所有中断的任务（active | paused）。
   * 委托给 MemoryService.getUnfinishedTasks()。
   */
  getInterruptedTasks(): TaskStateData[] {
    return this.memoryService.getUnfinishedTasks()
  }

  /**
   * 通过语义匹配查找与查询文本相关的任务步骤。
   * 使用 VectorMemory 的向量搜索能力。
   */
  async findRelatedSteps(query: string, topK = 5): Promise<TaskStepQueryResult[]> {
    const vectorResults = await this.memoryService.vector.query(query, topK * 2)
    if (vectorResults.length === 0) return []

    // 解析向量结果中的 content 为 TaskStepRecord
    const results: TaskStepQueryResult[] = []
    const allEntries = this.memoryService.getEntries()

    for (const vContent of vectorResults) {
      // 查找匹配的记忆条目
      const entry = allEntries.find((e) => e.content === vContent)
      if (!entry || entry.type !== 'task_step' || !entry.structuredData) continue

      try {
        const record = JSON.parse(entry.structuredData) as TaskStepRecord
        results.push({
          content: entry.content,
          record,
          score: 0.6, // VectorMemory 内部已用 cosineSimilarity > 0.5 过滤
        })
      } catch {
        // 解析失败则跳过
      }
    }

    return results.slice(0, topK)
  }

  /**
   * 按 sessionId 获取任务步骤。
   */
  getStepsBySession(sessionId: string): TaskStepRecord[] {
    return this.querySteps((entry) => {
      if (entry.type !== 'task_step' || !entry.structuredData) return false
      try {
        const record = JSON.parse(entry.structuredData) as TaskStepRecord
        return record.sessionId === sessionId
      } catch {
        return false
      }
    })
  }

  /**
   * 按 taskId 获取任务步骤。
   */
  getStepsByTaskId(taskId: string): TaskStepRecord[] {
    return this.querySteps((entry) => {
      if (entry.type !== 'task_step' || !entry.structuredData) return false
      try {
        const record = JSON.parse(entry.structuredData) as TaskStepRecord
        return record.taskId === taskId
      } catch {
        return false
      }
    })
  }

  /**
   * 通用的步骤查询辅助方法。
   */
  private querySteps(filter: (entry: { type: string; structuredData?: string | null }) => boolean): TaskStepRecord[] {
    const allEntries = this.memoryService.getEntries()
    const results: TaskStepRecord[] = []

    for (const entry of allEntries) {
      if (!filter(entry)) continue
      try {
        const record = JSON.parse(entry.structuredData!) as TaskStepRecord
        results.push(record)
      } catch {
        // 跳过格式错误
      }
    }

    // 按 stepIndex + toolIndexInRound 排序
    results.sort((a, b) => {
      if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex
      return a.toolIndexInRound - b.toolIndexInRound
    })

    return results
  }

  // ══════════════════════════════════════════
  //  恢复上下文生成
  // ══════════════════════════════════════════

  /**
   * 生成任务恢复上下文，用于注入 system prompt。
   * 包含中断的任务列表、最近步骤摘要、以及可选的语义匹配结果。
   *
   * @param query 用户输入文本（用于语义匹配），可选
   * @param maxTasks 最多返回的任务数，默认 3
   */
  async getRecoveryContext(query?: string, maxTasks = 3): Promise<string> {
    const parts: string[] = []

    // 1. 中断任务列表
    const interruptedTasks = this.getInterruptedTasks()
    if (interruptedTasks.length > 0) {
      parts.push('---')
      parts.push('【未完成任务恢复】')
      parts.push(`检测到 ${interruptedTasks.length} 个未完成任务：`)
      for (const task of interruptedTasks.slice(0, maxTasks)) {
        const statusLabel = task.status === 'paused' ? '已暂停' : '进行中'
        const completedSteps = task.steps.filter((s) => s.status === 'completed').length
        const totalSteps = task.steps.length
        parts.push(`- ${task.title} (${statusLabel}) [${completedSteps}/${totalSteps} 步骤完成]`)
        parts.push(`  描述: ${task.description.slice(0, 120)}`)

        // 下一步提示
        const nextStep = task.steps.find((s) => s.status === 'pending' || s.status === 'in_progress')
        if (nextStep) {
          parts.push(`  下一步: ${nextStep.description.slice(0, 80)}`)
        }

        // 最近工具的调用记录
        const taskSteps = this.getStepsByTaskId(task.taskId)
        if (taskSteps.length > 0) {
          const lastSteps = taskSteps.slice(-3)
          parts.push(`  最近步骤:`)
          for (const step of lastSteps) {
            const status = step.toolSuccess ? '✓' : '✗'
            parts.push(`    ${status} [${step.toolName}] ${step.toolError ? `失败: ${step.toolError.slice(0, 60)}` : '成功'}`)
          }
        }
      }
      parts.push('')
      parts.push('你可以询问用户是否要继续以上任务，或开始新的任务。')
      parts.push('---')
    }

    // 2. 语义匹配（如果提供了查询文本）
    if (query && query.length > 3) {
      try {
        const relatedSteps = await this.findRelatedSteps(query, 3)
        if (relatedSteps.length > 0) {
          parts.push('---')
          parts.push('【相关任务历史】根据当前对话，以下任务步骤可能相关：')
          for (const rs of relatedSteps) {
            const rec = rs.record
            const taskLabel = rec.taskId ? `任务[${rec.taskId.slice(0, 8)}] ` : ''
            parts.push(`- ${taskLabel}步骤 ${rec.stepIndex} → ${rec.toolName}: ${rec.toolSuccess ? '成功' : `失败: ${(rec.toolError || '').slice(0, 80)}`}`)
          }
          parts.push('---')
        }
      } catch {
        // 语义匹配失败不影响主流程
      }
    }

    return parts.join('\n')
  }

  // ══════════════════════════════════════════
  //  内部工具方法
  // ══════════════════════════════════════════

  /**
   * 构建唯一内容键，用于避免记忆去重冲突。
   * 每次工具调用生成的键都是唯一的。
   */
  private buildContentKey(taskId?: string, sessionId?: string, stepIndex?: number, toolIndex?: number): string {
    const ts = Date.now()
    const rand = Math.random().toString(36).slice(2, 6)
    return `${taskId || 'notask'}_${sessionId || 'nosession'}_s${stepIndex || 0}_t${toolIndex || 0}_${ts}_${rand}`
  }

  /**
   * 从工具调用记录中提取主题标签。
   */
  private extractTopicsFromRecord(record: TaskStepRecord): string[] {
    const topics: string[] = ['task_step']
    if (record.taskId) topics.push(`task:${record.taskId}`)
    if (record.toolSuccess) { topics.push('success') } else { topics.push('failure') }
    // 提取工具类别标签
    const lowerName = record.toolName.toLowerCase()
    if (lowerName.includes('read') || lowerName.includes('get') || lowerName.includes('search') || lowerName.includes('query')) {
      topics.push('read')
    } else if (lowerName.includes('write') || lowerName.includes('create') || lowerName.includes('save') || lowerName.includes('store')) {
      topics.push('write')
    } else if (lowerName.includes('edit') || lowerName.includes('update') || lowerName.includes('modify') || lowerName.includes('patch')) {
      topics.push('modify')
    } else if (lowerName.includes('delete') || lowerName.includes('remove') || lowerName.includes('forget')) {
      topics.push('delete')
    }
    return topics
  }
}
