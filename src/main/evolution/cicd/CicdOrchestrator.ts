/**
 * CicdOrchestrator — CI/CD 编排器
 *
 * 将 Evolution 系统的计划执行与 MCP CI/CD 工具桥接。
 * 核心职责：
 * 1. 接收 Evolution 计划步骤，自动映射到 CI/CD MCP 工具
 * 2. 通过 MCP 统一接口执行工具并收集结果
 * 3. 根据结果判定是否通过门禁、需要回滚或调整
 * 4. 支持自动部署预览
 * 5. 生成周期执行报告供 Evolution 系统消费
 *
 * 生命周期：init() → [executeStep() 循环] → destroy()
 * 与 EvolutionExecutor 互补，可独立注入或共同使用。
 */

import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { planStepMapper } from './PlanStepMapper'
import { getAllTools } from '../../tool/index'
import type { CicdAction, CicdStepResult, CicdCycleReport, CicdOrchestratorConfig } from './types'
import type { MCPToolResult } from '../../mcp/types'

// ==============================================================================
// 默认配置
// ==============================================================================

const DEFAULT_CONFIG: CicdOrchestratorConfig = {
  runQualityGateBeforeSteps: false,
  qualityGateRequired: true,
  autoDeployOnSuccess: false,
  deployTagPrefix: 'auto',
  maxParallelChecks: 4,
}

// ==============================================================================
// CicdOrchestrator
// ==============================================================================

export class CicdOrchestrator {
  readonly name = 'CicdOrchestrator'
  private config: CicdOrchestratorConfig
  /** MCP CI/CD 工具处理器映射 */
  private tools: Map<string, (args: Record<string, any>) => Promise<MCPToolResult>> = new Map()
  private initialized = false

  constructor(config?: Partial<CicdOrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化：加载已注册的 CI/CD MCP 工具
   */
  async init(): Promise<void> {
    // 从 tool 注册表加载所有 CI/CD 工具
    const allTools = getAllTools()
    const cicdTools = allTools.filter((t) => t.name.startsWith('cicd_'))

    for (const tool of cicdTools) {
      this.tools.set(tool.name, tool.handler)
    }

    log('INFO', 'cicd_orchestrator_init', {
      toolsLoaded: this.tools.size,
      toolNames: Array.from(this.tools.keys()),
    })

    this.initialized = true
  }

  isReady(): boolean {
    return this.initialized
  }

  // ==================== 核心方法 ====================

  /**
   * 执行一个 Evolution 计划步骤
   * 1. 映射步骤描述到 CI/CD 操作
   * 2. 通过 MCP 工具执行
   * 3. 返回执行结果
   */
  async executeStep(stepDescription: string): Promise<CicdStepResult> {
    if (!this.initialized) {
      return {
        stepDescription,
        action: 'unknown',
        toolName: '',
        success: false,
        passed: false,
        summary: 'CicdOrchestrator 未初始化',
        durationMs: 0,
        error: 'not_initialized',
      }
    }

    const startedAt = Date.now()

    // 1. 映射步骤
    const mapping = planStepMapper.map(stepDescription)
    if (mapping.action === 'unknown') {
      return {
        stepDescription,
        action: 'unknown',
        toolName: '',
        success: false,
        passed: false,
        summary: `无法将步骤映射到 CI/CD 工具: "${stepDescription.slice(0, 100)}"`,
        durationMs: Date.now() - startedAt,
        error: 'unmappable_step',
      }
    }

    // 2. 执行工具
    const handler = this.tools.get(mapping.toolName)
    if (!handler) {
      return {
        stepDescription,
        action: mapping.action,
        toolName: mapping.toolName,
        success: false,
        passed: false,
        summary: `CI/CD 工具 "${mapping.toolName}" 未注册`,
        durationMs: Date.now() - startedAt,
        error: 'tool_not_found',
      }
    }

    log('INFO', 'cicd_execute_step', {
      action: mapping.action,
      toolName: mapping.toolName,
      step: stepDescription.slice(0, 80),
    })

    try {
      // 根据工具名构建合适的参数
      const args = this.buildArgs(mapping.action, stepDescription)
      const result = await handler(args)

      const durationMs = Date.now() - startedAt

      // 3. 解析结果
      const rawText = result.content?.[0]?.text || '{}'
      let parsed: Record<string, any> = {}
      try {
        parsed = JSON.parse(rawText)
      } catch {
        // 非 JSON 返回（格式错误等）
        parsed = { passed: false, summary: rawText.slice(0, 500) }
      }

      const passed = parsed.passed !== false
      const summary = parsed.summary || `${mapping.action} 执行完成`

      log('INFO', 'cicd_step_result', {
        action: mapping.action,
        passed,
        durationMs,
        summary: summary.slice(0, 80),
      })

      // 4. 触发事件
      eventBus.emit('cicd.step.completed' as any, {
        action: mapping.action,
        passed,
        durationMs,
        stepDescription: stepDescription.slice(0, 100),
        summary,
      })

      return {
        stepDescription,
        action: mapping.action,
        toolName: mapping.toolName,
        success: true,
        passed,
        summary,
        rawResult: parsed,
        durationMs,
      }
    } catch (err: any) {
      const durationMs = Date.now() - startedAt
      log('WARN', 'cicd_step_error', {
        action: mapping.action,
        error: err.message,
        durationMs,
      })

      return {
        stepDescription,
        action: mapping.action,
        toolName: mapping.toolName,
        success: false,
        passed: false,
        summary: `执行失败: ${err.message}`,
        durationMs,
        error: err.message,
      }
    }
  }

  /**
   * 执行完整的 CI/CD 周期
   * - 可选：先运行质量门禁
   * - 执行所有可映射步骤
   * - 可选：成功后自动部署预览
   */
  async executeFullCycle(stepDescriptions: string[]): Promise<CicdCycleReport> {
    const startedAt = Date.now()
    const stepResults: CicdStepResult[] = []
    const config = this.config

    // Phase 1: 可选的质量门禁前置检查
    if (config.runQualityGateBeforeSteps) {
      const gateResult = await this.executeStep('[quality_gate] 综合质量门禁检查')
      stepResults.push(gateResult)

      if (!gateResult.passed && config.qualityGateRequired) {
        log('WARN', 'cicd_quality_gate_blocked', { summary: gateResult.summary })

        const completedAt = Date.now()
        return {
          startedAt,
          completedAt,
          totalDurationMs: completedAt - startedAt,
          steps: stepResults,
          allPassed: false,
          failures: stepResults.filter((s) => !s.passed || !s.success),
          needsRollback: false,
        }
      }
    }

    // Phase 2: 执行各步骤（仅映射到 CI/CD 工具的步骤）
    const mappableSteps = stepDescriptions.filter((desc) => planStepMapper.isMappable(desc))

    for (const desc of mappableSteps) {
      const result = await this.executeStep(desc)
      stepResults.push(result)
    }

    // Phase 3: 可选的后置质量门禁
    if (!config.runQualityGateBeforeSteps && mappableSteps.length > 0) {
      // 在步骤执行后运行质量门禁确认没有退化
      const postGateResult = await this.executeStep('[quality_gate] 后置质量门禁验证')
      stepResults.push(postGateResult)
    }

    // Phase 4: 自动部署
    const allPassed = stepResults.length > 0 && stepResults.every((s) => s.passed && s.success)
    const failures = stepResults.filter((s) => !s.passed || !s.success)

    if (allPassed && config.autoDeployOnSuccess) {
      const tag = `${config.deployTagPrefix}_${Date.now()}`
      const deployResult = await this.executeStep(`[deploy_preview] 自动部署预览 (${tag})`)
      stepResults.push(deployResult)
    }

    const completedAt = Date.now()
    const report: CicdCycleReport = {
      startedAt,
      completedAt,
      totalDurationMs: completedAt - startedAt,
      steps: stepResults,
      allPassed,
      failures,
      needsRollback: !allPassed && failures.length > 0,
    }

    // 发射周期完成事件
    eventBus.emit('cicd.cycle.completed' as any, {
      passed: report.allPassed,
      totalSteps: report.steps.length,
      failures: report.failures.length,
      totalDurationMs: report.totalDurationMs,
    })

    log('INFO', 'cicd_cycle_completed', {
      allPassed: report.allPassed,
      totalSteps: report.steps.length,
      failures: report.failures.length,
      durationMs: report.totalDurationMs,
    })

    return report
  }

  /**
   * 根据操作类型和步骤描述构建工具参数
   */
  private buildArgs(action: CicdAction, stepDescription: string): Record<string, any> {
    const lower = stepDescription.toLowerCase()

    switch (action) {
      case 'typecheck': {
        // 提取 tsconfig 路径（如 --tsconfig tsconfig.app.json）
        const tsconfigMatch = lower.match(/tsconfig[:\s]+(\S+)/)
        return tsconfigMatch ? { tsconfig: tsconfigMatch[1] } : {}
      }
      case 'lint': {
        const fix = lower.includes('--fix') || lower.includes('auto fix') || lower.includes('自动修复')
        return { fix }
      }
      case 'test': {
        const fileMatch = lower.match(/test[:\s]+(\S+\.test\.ts)/)
        return {
          file: fileMatch ? fileMatch[1] : undefined,
          coverage: lower.includes('--coverage') || lower.includes('覆盖率'),
        }
      }
      case 'build': {
        const scriptMatch = lower.match(/build[:\s]+(\S+)/)
        return scriptMatch ? { script: scriptMatch[1] } : {}
      }
      case 'build_docs': {
        return {}
      }
      case 'deploy_preview': {
        const tagMatch = lower.match(/tag[:\s]+(\S+)/)
        const clean = lower.includes('--clean') || lower.includes('clean')
        return {
          tag: tagMatch ? tagMatch[1] : `auto_${Date.now()}`,
          clean,
        }
      }
      case 'quality_gate': {
        return {
          skipLint: lower.includes('--skip-lint') || lower.includes('跳过lint'),
          skipTest: lower.includes('--skip-test') || lower.includes('跳过测试'),
          skipBuild: lower.includes('--skip-build') || lower.includes('跳过构建'),
        }
      }
      default:
        return {}
    }
  }
}
