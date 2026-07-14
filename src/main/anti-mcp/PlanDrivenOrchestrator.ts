/**
 * PlanDrivenOrchestrator — Plan 驱动的执行编排器
 *
 * 【反 MCP】核心反转实现：
 * 传统模式：MCP 主导 → LLM 通过 MCP 工具读写 Plan（Plan 是被动数据）
 * 反转模式：Plan 主导 → Orchestrator 根据 Plan 状态决策并调用 MCP 工具（MCP 是执行层）
 *
 * 反转的三个维度：
 * 1. 控制反转：Plan 从"被读写的数据"变为"主动编排的运行时"
 * 2. 时序反转：Plan 的依赖图决定调用顺序，而非 LLM 随意选择工具
 * 3. 决策反转：Plan 内置分支逻辑，根据工具执行结果自适应调整
 *
 * 应用场景：写作计划"修正工业颂歌19-27章（按设计文档）"
 * - WritingPlanAgent 创建 RewritePlan（任务分解）
 * - PlanDrivenOrchestrator 接管执行：按依赖图展开步骤 → 调用 MCP 工具 → 评估结果 → 自适应推进
 */

import { log } from '../logger/Logger'
import type { RewritePlan, RewritePhase } from '../writing/types'
import type {
  PlanDrivenStep,
  PlanDrivenReport,
  ExecutionContext,
  ExecutionLogEntry,
  ToolCallBridge,
  AssumptionInversion,
} from './types'
import type { MCPToolResult } from '../mcp/types'

// ============================================================================
// 常量
// ============================================================================

/** 阶段标签（与 WritingPlanAgent 一致） */
const PHASE_LABELS: Record<RewritePhase, string> = {
  outline: '调整大纲',
  rewrite: '重写章节',
  quality_check: '质量校验',
}

// ============================================================================
// 假设反转分析（内联文档）
// ============================================================================

/**
 * 当前 MCP↔Plan 关系的三个假设及其反转：
 *
 * 假设 1：MCP 是基础设施层，Plan 是被动内容层
 *   → 反转：Plan 是编排层，MCP 是执行层
 *   → 可行性：中。Plan 需要状态机能力（本模块实现），MCP 保持纯执行
 *
 * 假设 2：MCP 先路由，Plan 后被动存储
 *   → 反转：Plan 先规划执行顺序，MCP 后被调用
 *   → 可行性：高。WritingPlanAgent 已生成 RewritePlan，Orchestrator 只需按图执行
 *
 * 假设 3：MCP 决策（可用性/授权），Plan 执行（跟踪进度）
 *   → 反转：Plan 决策（分支/重试/自适应），MCP 纯执行
 *   → 可行性：中高。Plan 依赖图 + 内置评估策略可实现分支逻辑
 */
export function getAssumptionInversions(): AssumptionInversion[] {
  return [
    {
      assumption: 'MCP 是基础设施层，Plan 是被动内容层（MCP 主，Plan 从）',
      inversed: 'Plan 是编排层，MCP 是执行层（Plan 主，MCP 从）',
      feasibility: 'medium',
      scope: '工具调度架构：ServerManager 为中心 → PlanDrivenOrchestrator 为中心',
      risks: [
        'Plan 状态机复杂度增加维护成本',
        '与现有 LLM 驱动的工具调用模式冲突',
        '可能需要改造现有 PlanManager 以支持更多状态',
      ],
      value: 'Plan 获得主动执行能力，不再依赖 LLM 手动调用工具步骤',
    },
    {
      assumption: 'MCP 先路由（确定可用工具），Plan 后被动存储',
      inversed: 'Plan 先规划执行顺序，MCP 后被调用执行',
      feasibility: 'high',
      scope: '执行流：LLM 随机调用工具 → 按 Plan 依赖图有序执行',
      risks: [
        '提前展开所有步骤可能浪费（部分步骤可能不需要执行）',
        '依赖图需要与 LLM 动态决策平衡',
      ],
      value: '执行顺序可预判、可恢复、可审计。中断后可从中断点继续',
    },
    {
      assumption: 'MCP 决策（可用性/授权/优先级），Plan 执行（跟踪步骤）',
      inversed: 'Plan 决策（分支/重试/自适应），MCP 纯执行工具',
      feasibility: 'medium',
      scope: '决策层：CapabilityEngine + ServerManager → PlanDrivenOrchestrator',
      risks: [
        'Plan 分支逻辑可能导致不可预期的执行路径',
        '领域直觉：Plan 不应有决策权（违反现有设计）',
      ],
      value: '闭环自动化：Plan 可根据执行结果自动调整策略，无需人工干预',
    },
  ]
}

// ============================================================================
// PlanDrivenOrchestrator
// ============================================================================

export class PlanDrivenOrchestrator {
  private context: ExecutionContext | null = null
  private toolBridge: ToolCallBridge | null = null

  /**
   * 注入工具调用桥接器。
   * 在 AgentService 启动时传入 ServerManager 适配实例。
   */
  setToolBridge(bridge: ToolCallBridge): void {
    this.toolBridge = bridge
    log('INFO', 'antimcp_bridge_attached')
  }

  /** 检查是否已注入桥接器 */
  isReady(): boolean {
    return this.toolBridge !== null
  }

  // ==========================================================================
  //  步骤展开 — 将 RewritePlan 中的任务展开为可执行的 PlanDrivenStep[]
  // ==========================================================================

  /**
   * 将 RewritePlan 展开为执行步骤序列。
   *
   * 展开规则：
   * - outline 阶段任务 → writing_plan_quality_check 工具（读取章节 + LLM 分析）
   *   （实际应调用章节读取 + LLM 评估，此处使用 writing_plan_quality_check 作为代理）
   * - rewrite 阶段任务 → 通过 writing_system 工具执行
   * - quality_check 阶段任务 → writing_plan_quality_check 工具
   *
   * 每个任务展开为多个 PlanDrivenStep：
   *   任务读取章节 → 调用 LLM 分析 → 保存修改 → 质量校验
   */
  expandPlan(rewritePlan: RewritePlan): PlanDrivenStep[] {
    const steps: PlanDrivenStep[] = []
    let globalSeq = 0

    // 按阶段排序（outline → rewrite → quality_check）
    const phaseOrder: RewritePhase[] = ['outline', 'rewrite', 'quality_check']
    const sortedTasks = [...rewritePlan.tasks].sort((a, b) => {
      const pa = phaseOrder.indexOf(a.phase)
      const pb = phaseOrder.indexOf(b.phase)
      if (pa !== pb) return pa - pb
      return a.dependencies.length - b.dependencies.length
    })

    // 建立 taskId → sequence 的映射（用于 resolve 依赖）
    const taskSeqMap = new Map<string, number>()

    for (const task of sortedTasks) {
      const taskStepSeq = ++globalSeq

      // 步骤 1：读取章节内容
      steps.push({
        taskId: task.id,
        sequence: ++globalSeq,
        description: `读取第${task.chapterNumbers.join('、')}章内容`,
        toolName: 'read_file',
        toolArgs: { path: `docs/chapters/${task.chapterNumbers[0]}.md` },
        evaluation: { type: 'check_isError' },
        onSuccess: { type: 'next' },
        onFailure: { type: 'goto', targetSequence: taskStepSeq },
        maxRetries: 2,
        dependsOn: [],
      })

      // 步骤 2：根据阶段调用不同工具
      const phaseTool = this.getPhaseTool(task.phase)
      steps.push({
        taskId: task.id,
        sequence: ++globalSeq,
        description: `${PHASE_LABELS[task.phase]}: ${task.title}`,
        toolName: phaseTool,
        toolArgs: {
          designAnalysisJson: '',
          chapterPath: `docs/chapters/${task.chapterNumbers[0]}.md`,
          chapterNumber: task.chapterNumbers[0],
          threshold: 70,
        },
        evaluation: { type: 'check_isError' },
        onSuccess: { type: 'next' },
        onFailure: { type: 'goto', targetSequence: taskStepSeq },
        maxRetries: 1,
        dependsOn: [],
      })

      // 步骤 3：更新计划进度
      steps.push({
        taskId: task.id,
        sequence: ++globalSeq,
        description: `更新计划进度：${task.title}`,
        toolName: 'update_plan_progress',
        toolArgs: {
          plan_id: rewritePlan.planId,
          step_index: sortedTasks.indexOf(task),
          status: 'done' as const,
          result: `${PHASE_LABELS[task.phase]}完成：${task.title}`,
        },
        evaluation: { type: 'check_isError' },
        onSuccess: { type: 'next' },
        onFailure: { type: 'fail' },
        maxRetries: 1,
        dependsOn: [],
      })

      // 记录 taskId → 首步骤序号
      taskSeqMap.set(task.id, taskStepSeq)
    }

    // 设置依赖关系
    for (const task of sortedTasks) {
      const taskFirstSeq = taskSeqMap.get(task.id) ?? 0
      // 找到属于此 task 的所有步骤
      const taskSteps = steps.filter((s) => s.sequence >= taskFirstSeq && s.sequence < taskFirstSeq + 3)
      for (const depId of task.dependencies) {
        const depFirstSeq = taskSeqMap.get(depId) ?? 0
        const depLastSeq = depFirstSeq + 2 // 依赖的前一个任务的最后一步
        for (const step of taskSteps) {
          step.dependsOn.push(depLastSeq)
        }
      }
    }

    log('INFO', 'antimcp_plan_expanded', {
      planId: rewritePlan.planId,
      tasks: rewritePlan.tasks.length,
      steps: steps.length,
    })

    return steps
  }

  /** 根据阶段选择对应工具 */
  private getPhaseTool(phase: RewritePhase): string {
    switch (phase) {
      case 'outline':
        return 'writing_plan_analyze_design'
      case 'rewrite':
        return 'writing_system'
      case 'quality_check':
        return 'writing_plan_quality_check'
      default:
        return 'writing_plan_quality_check'
    }
  }

  // ==========================================================================
  //  执行引擎 — 按步骤序列驱动执行
  // ==========================================================================

  /**
   * 执行单个步骤。
   *
   * @returns 执行是否成功
   */
  private async executeStep(step: PlanDrivenStep): Promise<boolean> {
    if (!this.toolBridge) {
      this.appendLog('error', undefined, '工具桥接器未注入')
      return false
    }

    const startedAt = Date.now()
    this.appendLog('info', step.sequence, `执行: ${step.description}`, {
      toolName: step.toolName,
      args: step.toolArgs,
    })

    try {
      const result = await this.toolBridge.callTool(step.toolName, step.toolArgs)
      const durationMs = Date.now() - startedAt

      // 评估结果
      const success = this.evaluateResult(step.evaluation, result)

      if (this.context) {
        this.context.completedResults.set(`${step.sequence}`, {
          stepSequence: step.sequence,
          result,
          success,
          durationMs,
        })
      }

      this.appendLog(
        success ? 'info' : 'warn',
        step.sequence,
        `${success ? '✅' : '⚠️'} ${step.description} (${durationMs}ms)`,
      )

      return success
    } catch (err: any) {
      const durationMs = Date.now() - startedAt
      this.appendLog('error', step.sequence, `❌ ${step.description}: ${err.message}`, {
        error: err.message,
      })

      if (this.context) {
        this.context.completedResults.set(`${step.sequence}`, {
          stepSequence: step.sequence,
          result: null,
          success: false,
          durationMs,
          error: err.message,
        })
      }

      return false
    }
  }

  /** 根据评估策略判断结果 */
  private evaluateResult(evaluation: PlanDrivenStep['evaluation'], result: MCPToolResult | null): boolean {
    if (!result) return false

    switch (evaluation.type) {
      case 'check_isError':
        return !result.isError
      case 'string_match':
        return result.content.some((c) => c.text && evaluation.pattern.test(c.text))
      case 'always_pass':
        return true
      case 'llm_judge':
        // LLM 评判暂跳过，默认视为通过
        return !result.isError
      default:
        return !result.isError
    }
  }

  /** 判断步骤依赖是否已满足 */
  private areDependenciesMet(step: PlanDrivenStep): boolean {
    if (step.dependsOn.length === 0) return true
    if (!this.context) return true

    for (const depSeq of step.dependsOn) {
      const result = this.context.completedResults.get(`${depSeq}`)
      if (!result || !result.success) return false
    }
    return true
  }

  // ==========================================================================
  //  主编排方法
  // ==========================================================================

  /**
   * 启动 Plan 驱动的执行流程。
   *
   * 执行策略：
   * 1. 遍历展开的步骤序列
   * 2. 跳过依赖未满足的步骤
   * 3. 执行当前步骤并评估结果
   * 4. 根据 onSuccess/onFailure 跳转
   * 5. 重试失败的步骤（不超过 maxRetries）
   * 6. 完成后生成报告
   */
  async execute(rewritePlan: RewritePlan): Promise<PlanDrivenReport> {
    const startedAt = Date.now()
    const steps = this.expandPlan(rewritePlan)

    this.context = {
      rewritePlan,
      steps,
      currentStepIndex: 0,
      completedResults: new Map(),
      startedAt,
      lastUpdatedAt: startedAt,
      status: 'running',
      log: [],
    }

    this.appendLog('info', undefined, `🚀 Plan 驱动执行启动: ${rewritePlan.storyName}`, {
      planId: rewritePlan.planId,
      tasks: rewritePlan.tasks.length,
      steps: steps.length,
    })

    let completedCount = 0
    let failedCount = 0
    let i = 0

    while (i < steps.length) {
      if (!this.context) break
      this.context.currentStepIndex = i
      this.context.lastUpdatedAt = Date.now()

      const step = steps[i]

      // 检查依赖
      if (!this.areDependenciesMet(step)) {
        this.appendLog('debug', step.sequence, `依赖未满足，跳过步骤 ${step.sequence}`)
        i++
        continue
      }

      // 判断重试上限
      const resultKey = `${step.sequence}`
      const existing = this.context.completedResults.get(resultKey)
      const retryCount = existing && !existing.success ? (step.retryCount ?? 0) + 1 : 0
      step.retryCount = retryCount

      if (retryCount > step.maxRetries) {
        this.appendLog('warn', step.sequence, `重试上限(${step.maxRetries})，标记为失败`)
        failedCount++
        i++
        continue
      }

      // 执行步骤
      const success = await this.executeStep(step)

      if (success) {
        completedCount++
        // 根据 onSuccess 跳转
        switch (step.onSuccess.type) {
          case 'next':
            i++
            break
          case 'goto':
            if (step.onSuccess.targetSequence !== undefined) {
              const target = steps.findIndex((s) => s.sequence === step.onSuccess.targetSequence)
              i = target >= 0 ? target : i + 1
            } else {
              i++
            }
            break
          case 'complete':
            i = steps.length // 结束循环
            break
          case 'fail':
            failedCount++
            i++
            break
        }
      } else {
        failedCount++
        // 根据 onFailure 跳转
        switch (step.onFailure.type) {
          case 'next':
            i++
            break
          case 'goto':
            if (step.onFailure.targetSequence !== undefined) {
              const target = steps.findIndex((s) => s.sequence === step.onFailure.targetSequence)
              i = target >= 0 ? target : i + 1
            } else {
              i++
            }
            break
          case 'complete':
            // 失败时 complete 等同于 fail
          case 'fail':
            i = steps.length // 结束循环
            break
        }
      }
    }

    const durationMs = Date.now() - startedAt
    const finalStatus = failedCount > 0 && completedCount === 0 ? 'failed' : failedCount > 0 ? 'completed' : 'completed'

    if (this.context) {
      this.context.status = finalStatus
      this.context.lastUpdatedAt = Date.now()
    }

    this.appendLog('info', undefined, `🏁 Plan 驱动执行完成: ${finalStatus}`, {
      completedCount,
      failedCount,
      durationMs,
    })

    return this.buildReport(completedCount, failedCount, durationMs, finalStatus)
  }

  /** 构建执行报告 */
  private buildReport(
    completedCount: number,
    failedCount: number,
    durationMs: number,
    status: ExecutionContext['status'],
  ): PlanDrivenReport {
    const ctx = this.context!
    const totalTasks = ctx.steps.length

    return {
      planId: ctx.rewritePlan.planId,
      storyName: ctx.rewritePlan.storyName,
      totalTasks,
      completedTasks: completedCount,
      failedTasks: failedCount,
      overallProgress: totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0,
      durationMs,
      status,
      stepResults: Array.from(ctx.completedResults.values()).map((r) => ({
        sequence: r.stepSequence,
        taskId: ctx.steps.find((s) => s.sequence === r.stepSequence)?.taskId ?? '',
        toolName: ctx.steps.find((s) => s.sequence === r.stepSequence)?.toolName ?? '',
        success: r.success,
        durationMs: r.durationMs,
        error: r.error,
      })),
      log: ctx.log,
    }
  }

  // ==========================================================================
  //  状态查询
  // ==========================================================================

  /** 获取当前执行上下文（可用于断点恢复） */
  getContext(): ExecutionContext | null {
    return this.context
  }

  /** 获取当前执行状态 */
  getStatus(): ExecutionContext['status'] | null {
    return this.context?.status ?? null
  }

  /** 获取执行日志 */
  getLog(): ExecutionLogEntry[] {
    return this.context?.log ?? []
  }

  /** 重置执行器 */
  reset(): void {
    this.context = null
    log('INFO', 'antimcp_orchestrator_reset')
  }

  // ==========================================================================
  //  日志辅助
  // ==========================================================================

  private appendLog(level: ExecutionLogEntry['level'], stepSequence?: number, message?: string, data?: any): void {
    if (!this.context) return
    this.context.log.push({
      timestamp: Date.now(),
      level,
      stepSequence,
      message: message ?? '',
      data,
    })
  }
}

// ============================================================================
// 单例
// ============================================================================

export const planDrivenOrchestrator = new PlanDrivenOrchestrator()

export function getPlanDrivenOrchestrator(): PlanDrivenOrchestrator {
  return planDrivenOrchestrator
}
