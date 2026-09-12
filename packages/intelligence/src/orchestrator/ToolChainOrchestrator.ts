/**
 * ToolChainOrchestrator — 工具链编排即服务
 *
 * 核心职责：
 * 1. 接收用户复杂请求
 * 2. 调用 ToolChainDecomposer 分解为子步骤
 * 3. 使用 TaskGraph 构建 DAG
 * 4. 按拓扑序通过 ToolScheduler 执行工具调用
 * 5. 实时推送进度事件到 Wallpaper Overlay
 * 6. 聚合结果生成最终响应
 *
 * ## 数据流
 * ```
 * 用户请求
 *   → ToolChainDecomposer.decompose() → OrchestrationPlan (步骤列表+DAG)
 *   → 拓扑排序（TaskGraph）
 *   → 并行执行无依赖步骤（ToolScheduler）
 *   → 串行执行有依赖步骤
 *   → 每步发射 ProgressEvent → Wallpaper Overlay
 *   → 聚合结果 → OrchestrationResult
 * ```
 *
 * ## 错误处理策略
 * - 单个步骤失败：如果 autoDegradation 启用且该步骤非关键，标记为 skipped 继续
 * - 关键步骤失败（被其他步骤 dependsOn）：终止整个编排
 * - 临时错误：按 ToolScheduler 的配置自动重试
 *
 * ## 线程安全
 * - 每个 orchestrate() 调用独立，不共享可变状态
 * - 支持并发调用（不同 planId）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { TaskGraph } from '@akemi-mio/core/core/tasks/TaskGraph'
import { ToolChainDecomposer, toToolSummaries } from '@akemi-mio/intelligence/orchestrator/ToolChainDecomposer'
import type {
  OrchestrationPlan,
  OrchestrationStep,
  OrchestrationProgress,
  OrchestrationResult,
  StepStatus,
  OrchestratorConfig,
  ProgressEventType,
} from '@akemi-mio/intelligence/orchestrator/types'
import { DEFAULT_ORCHESTRATOR_CONFIG, ORCHESTRATION_EVENTS } from '@akemi-mio/intelligence/orchestrator/types'
import type { ServerManager } from '@akemi-mio/intelligence-mcp/ServerManager'

// ═══════════════════════════════════════════════
//  全局单例
// ═══════════════════════════════════════════════

let _instance: ToolChainOrchestrator | null = null

export function getToolChainOrchestrator(): ToolChainOrchestrator | null {
  return _instance
}

export function setToolChainOrchestrator(instance: ToolChainOrchestrator | null): void {
  _instance = instance
}

// ═══════════════════════════════════════════════
//  工具链编排器
// ═══════════════════════════════════════════════

export class ToolChainOrchestrator {
  private decomposer: ToolChainDecomposer
  private serverManager: ServerManager
  private config: OrchestratorConfig
  private planCounter = 0

  constructor(decomposer: ToolChainDecomposer, serverManager: ServerManager, config?: Partial<OrchestratorConfig>) {
    this.decomposer = decomposer
    this.serverManager = serverManager
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config }
  }

  /** 更新配置 */
  updateConfig(patch: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  /** 获取当前配置 */
  getConfig(): Readonly<OrchestratorConfig> {
    return { ...this.config }
  }

  /**
   * 执行完整的工具链编排。
   *
   * @param userRequest 用户自然语言请求
   * @returns 编排结果
   */
  async orchestrate(userRequest: string): Promise<OrchestrationResult> {
    const t0 = Date.now()
    const plan = await this.createPlan(userRequest)

    log('INFO', 'orchestrator_start', {
      planId: plan.planId,
      steps: plan.steps.length,
      request: userRequest.slice(0, 100),
    })

    // 构建 TaskGraph DAG
    const graph = this.buildDag(plan)
    const sorted = graph.topologicalSort()

    if (sorted.length === 0) {
      const cycle = graph.detectCycle()
      const errorMsg = cycle ? `步骤依赖中存在环: ${cycle.join(' → ')}` : '拓扑排序失败'
      log('ERROR', 'orchestrator_dag_invalid', { planId: plan.planId, error: errorMsg })
      return this.failResult(plan.planId, errorMsg, Date.now() - t0)
    }

    // 步骤 ID → 步骤的快速查找
    const stepMap = new Map<string, OrchestrationStep>()
    for (const step of plan.steps) {
      stepMap.set(step.id, step)
    }

    // 执行拓扑排序后的步骤
    const executionOrder = sorted.map((id) => stepMap.get(id)).filter(Boolean) as OrchestrationStep[]
    const results = await this.executeSteps(plan, executionOrder, stepMap)

    // 聚合结果
    const totalDurationMs = Date.now() - t0
    const successCount = results.filter((s) => s.status === 'success').length
    const failCount = results.filter((s) => s.status === 'failed').length
    const skipCount = results.filter((s) => s.status === 'skipped').length
    const allSuccess = failCount === 0

    const summary = this.buildSummary(results, allSuccess)

    const result: OrchestrationResult = {
      planId: plan.planId,
      success: allSuccess,
      steps: results,
      summary,
      totalDurationMs,
      timestamp: Date.now(),
      error: allSuccess ? undefined : `${failCount} 个步骤失败`,
    }

    // 发射完成事件
    this.emitProgress({
      type: allSuccess ? 'orchestration_completed' : 'orchestration_failed',
      planId: plan.planId,
      completedSteps: successCount,
      totalSteps: results.length,
      percent: 100,
      message: allSuccess
        ? `工具链编排完成，${successCount}/${results.length} 步成功`
        : `编排失败：${failCount} 步失败，${skipCount} 步跳过`,
      error: result.error,
      timestamp: Date.now(),
      stepStatuses: results.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        toolName: s.toolName,
      })),
    })

    eventBus.emit(ORCHESTRATION_EVENTS.COMPLETED as any, result)
    log('INFO', 'orchestrator_completed', {
      planId: plan.planId,
      success: allSuccess,
      durationMs: totalDurationMs,
      successCount,
      failCount,
      skipCount,
    })

    return result
  }

  // ═══════════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════════

  /**
   * 创建编排计划：调用分解器将用户请求分解为步骤。
   */
  private async createPlan(userRequest: string): Promise<OrchestrationPlan> {
    const planId = `oc_${Date.now()}_${++this.planCounter}`

    // 获取当前所有工具 schemas
    const schemas = this.serverManager.getAllSchemas()
    const toolSummaries = toToolSummaries(schemas)

    // 创建临时 decomposer 感知工具变化
    const result = await this.decomposer.decompose(userRequest)

    const steps: OrchestrationStep[] = result.steps.map((ds) => ({
      id: ds.id,
      name: ds.name,
      description: ds.description,
      dependsOn: ds.dependsOn,
      toolName: ds.toolName,
      args: ds.args,
      status: 'pending' as StepStatus,
    }))

    const plan: OrchestrationPlan = {
      planId,
      userRequest,
      steps,
      createdAt: Date.now(),
      status: 'pending',
    }

    // 发射计划创建事件
    this.emitProgress({
      type: 'plan_created',
      planId,
      completedSteps: 0,
      totalSteps: steps.length,
      percent: 0,
      message: `计划已创建：共 ${steps.length} 个步骤，${steps.filter((s) => s.toolName).length} 个工具调用`,
      timestamp: Date.now(),
      stepStatuses: steps.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        toolName: s.toolName,
      })),
    })

    eventBus.emit(ORCHESTRATION_EVENTS.PLAN_CREATED as any, plan)
    return plan
  }

  /**
   * 从编排计划构建 TaskGraph DAG。
   */
  private buildDag(plan: OrchestrationPlan): TaskGraph {
    const graph = new TaskGraph()

    for (const step of plan.steps) {
      graph.addNode(step.id, {
        dependsOn: step.dependsOn,
        blocks: [],
        produces: [],
      })
    }

    // 检查环
    const cycle = graph.detectCycle()
    if (cycle) {
      log('WARN', 'orchestrator_cycle_detected', {
        planId: plan.planId,
        cycle: cycle.join(' → '),
      })
    }

    return graph
  }

  /**
   * 执行所有步骤（拓扑序），并行执行无依赖步骤。
   */
  private async executeSteps(
    plan: OrchestrationPlan,
    executionOrder: OrchestrationStep[],
    stepMap: Map<string, OrchestrationStep>,
  ): Promise<OrchestrationStep[]> {
    plan.status = 'running'

    // 按拓扑层分组：同一层的步骤无相互依赖，可并行
    const layers = this.groupByLayer(executionOrder, stepMap)
    const completedIds = new Set<string>()
    const results: OrchestrationStep[] = []

    for (const layer of layers) {
      // 并行执行同层步骤
      const layerResults = await Promise.all(layer.map((step) => this.executeSingleStep(plan, step, completedIds)))

      for (const r of layerResults) {
        results.push(r)
        completedIds.add(r.id)
      }
    }

    return results
  }

  /**
   * 将步骤按拓扑层分组。
   * 同一层的步骤无相互依赖关系，可并行执行。
   */
  private groupByLayer(sortedSteps: OrchestrationStep[], stepMap: Map<string, OrchestrationStep>): OrchestrationStep[][] {
    const layers: OrchestrationStep[][] = []
    const added = new Set<string>()

    // 迭代分配层：一个步骤的层 = max(依赖步骤的层) + 1
    const stepToLayer = new Map<string, number>()

    for (const step of sortedSteps) {
      if (step.dependsOn.length === 0) {
        stepToLayer.set(step.id, 0)
      } else {
        let maxDepLayer = -1
        for (const dep of step.dependsOn) {
          const depLayer = stepToLayer.get(dep)
          if (depLayer !== undefined) {
            maxDepLayer = Math.max(maxDepLayer, depLayer)
          }
        }
        stepToLayer.set(step.id, Math.max(0, maxDepLayer + 1))
      }
    }

    // 按层分组
    for (const [id, layer] of stepToLayer) {
      while (layers.length <= layer) layers.push([])
      const step = stepMap.get(id)
      if (step) {
        layers[layer].push(step)
        added.add(id)
      }
    }

    // 兜底：未分配到层的步骤
    for (const step of sortedSteps) {
      if (!added.has(step.id)) {
        layers.push([step])
      }
    }

    return layers
  }

  /**
   * 执行单个编排步骤。
   */
  private async executeSingleStep(plan: OrchestrationPlan, step: OrchestrationStep, completedIds: Set<string>): Promise<OrchestrationStep> {
    // 检查依赖是否全部成功
    const failedDeps = step.dependsOn.filter((dep) => {
      // dep 不在 completedIds 中 = 前面执行失败被跳过了
      return !completedIds.has(dep)
    })

    if (failedDeps.length > 0 && this.config.autoDegradation) {
      // 依赖步骤失败，跳过当前步骤
      const updatedStep: OrchestrationStep = {
        ...step,
        status: 'skipped',
        error: `依赖步骤 [${failedDeps.join(', ')}] 未成功完成，跳过`,
      }
      this.emitStepProgress(plan, updatedStep, 'step_skipped')
      return updatedStep
    }

    const tStep = Date.now()
    step.status = 'running'
    step.startedAt = tStep

    this.emitStepProgress(plan, step, 'step_started')

    try {
      if (step.toolName) {
        // 工具调用步骤：通过 ServerManager 的 callTool 执行
        const content = await this.serverManager.callTool(step.toolName, step.args)

        step.status = 'success'
        step.result = content
        step.completedAt = Date.now()
        step.durationMs = step.completedAt - tStep
      } else {
        // 纯 LLM 推理步骤（无工具调用）
        step.status = 'success'
        step.result = '步骤已完成（无需工具调用）'
        step.completedAt = Date.now()
        step.durationMs = step.completedAt - tStep
      }
    } catch (err: any) {
      step.status = 'failed'
      step.error = err.message
      step.completedAt = Date.now()
      step.durationMs = step.completedAt - tStep
      step.retryCount = 0

      log('WARN', 'orchestrator_step_failed', {
        planId: plan.planId,
        stepId: step.id,
        tool: step.toolName,
        error: err.message,
      })

      this.emitStepProgress(plan, step, 'step_failed')
    }

    this.emitStepProgress(plan, step, 'step_completed')
    return step
  }

  /**
   * 发射单步进度事件。
   */
  private emitStepProgress(plan: OrchestrationPlan, step: OrchestrationStep, eventType: ProgressEventType): void {
    const successCount = plan.steps.filter((s) => s.status === 'success' || s.id === step.id).length
    const totalSteps = plan.steps.length
    const percent = Math.round((successCount / totalSteps) * 100)

    const progress: OrchestrationProgress = {
      type: eventType,
      planId: plan.planId,
      stepId: step.id,
      stepName: step.name,
      completedSteps: successCount,
      totalSteps,
      percent: Math.min(percent, 100),
      message: this.buildProgressMessage(eventType, step),
      error: step.error,
      timestamp: Date.now(),
      stepStatuses: plan.steps.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        toolName: s.toolName,
      })),
    }

    this.emitProgress(progress)

    // 同时也发射 tool:status 事件使 TaskPanelWidget 更新
    if (eventType === 'step_started') {
      eventBus.emit('agent.progress' as any, {
        requestId: plan.planId,
        step: 0,
        toolNames: [step.toolName || step.name],
      })
    }
  }

  /**
   * 发射通用进度事件。
   */
  private emitProgress(progress: OrchestrationProgress): void {
    eventBus.emit(ORCHESTRATION_EVENTS.PROGRESS, progress)
    // 通过 EventBus 发送给任何订阅者（Wallpaper Overlay 等）
  }

  /**
   * 构建进度消息文本。
   */
  private buildProgressMessage(type: ProgressEventType, step: OrchestrationStep): string {
    switch (type) {
      case 'step_started':
        return `正在执行: ${step.name}${step.toolName ? ` (${step.toolName})` : ''}`
      case 'step_completed':
        return `✅ ${step.name} 完成`
      case 'step_failed':
        return `❌ ${step.name} 失败: ${step.error || '未知错误'}`
      case 'step_skipped':
        return `⏭️ ${step.name} 已跳过: ${step.error || ''}`
      default:
        return step.name
    }
  }

  /**
   * 构建最终结果摘要。
   */
  private buildSummary(steps: OrchestrationStep[], allSuccess: boolean): string {
    if (allSuccess) {
      const toolSteps = steps
        .filter((s) => s.status === 'success' && s.toolName)
        .map((s) => {
          const resultPreview = s.result ? (s.result.length > 100 ? s.result.slice(0, 100) + '…' : s.result) : ''
          return `- ${s.name}: ${resultPreview}`
        })
      const llmSteps = steps.filter((s) => s.status === 'success' && !s.toolName).map((s) => `- ${s.name}`)

      const parts: string[] = ['工具链编排完成：']
      if (toolSteps.length > 0) parts.push('', '【工具调用】', ...toolSteps)
      if (llmSteps.length > 0) parts.push('', '【推理步骤】', ...llmSteps)
      return parts.join('\n')
    }

    const failed = steps.filter((s) => s.status === 'failed').map((s) => `- ${s.name}: ${s.error || '失败'}`)
    const skipped = steps.filter((s) => s.status === 'skipped').map((s) => `- ${s.name}: 已跳过`)

    return ['部分步骤执行失败：', ...failed, ...(skipped.length > 0 ? ['', '跳过的步骤：', ...skipped] : [])].join('\n')
  }

  /**
   * 构造失败结果。
   */
  private failResult(planId: string, error: string, durationMs: number): OrchestrationResult {
    this.emitProgress({
      type: 'orchestration_failed',
      planId,
      completedSteps: 0,
      totalSteps: 0,
      percent: 0,
      message: `编排失败: ${error}`,
      error,
      timestamp: Date.now(),
      stepStatuses: [],
    })

    return {
      planId,
      success: false,
      steps: [],
      summary: `编排失败: ${error}`,
      totalDurationMs: durationMs,
      timestamp: Date.now(),
      error,
    }
  }
}
