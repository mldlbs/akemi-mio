/**
 * CapabilityExecutor — 能力执行器（v0）
 *
 * 将 Capability.executor 转化为实际可执行的操作。
 * v0 只做 toolchain 类型的解析和日志模拟执行：
 * - 解析 toolchain body (用 → 分隔的工具链)
 * - 顺序模拟每个工具步骤
 * - 记录 usage 到 CapabilityRegistry
 *
 * v1 将接入真实的 ToolRegistry 调用每个工具。
 */

import { log } from '../logger/Logger'
import type { Capability } from './CapabilityRegistry'
import type { ActionResult } from './ActionRegistry'

// —── CapabilityExecutor ────────────────────────────────

export class CapabilityExecutor {
  /**
   * 执行一个能力，返回 ActionResult
   * @param capability 要执行的能力
   * @param recordUsage 注册表的 usage 记录函数
   */
  async execute(capability: Capability, recordUsage?: (id: string) => void): Promise<ActionResult> {
    const startedAt = Date.now()

    try {
      switch (capability.executor.type) {
        case 'toolchain':
          return await this.executeToolchain(capability, recordUsage, startedAt)
        case 'workflow':
          return await this.executeWorkflow(capability, startedAt)
        case 'code':
          return this.executeCode(capability, startedAt)
        default:
          return {
            success: false,
            summary: `未知 executor 类型: ${capability.executor.type}`,
            durationMs: Date.now() - startedAt,
          }
      }
    } catch (err: any) {
      log('WARN', 'capability_execution_error', {
        id: capability.id,
        error: err.message?.slice(0, 200),
      })
      return {
        success: false,
        summary: `执行失败: ${err.message?.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // —── 工具链执行（v0: 模拟执行，只解析与记录） ─────────

  private async executeToolchain(
    cap: Capability,
    recordUsage: ((id: string) => void) | undefined,
    startedAt: number,
  ): Promise<ActionResult> {
    const steps = cap.executor.body
      .split('→')
      .map((s) => s.trim())
      .filter(Boolean)

    if (steps.length === 0) {
      return { success: false, summary: '空工具链', durationMs: Date.now() - startedAt }
    }

    const stepLogs: string[] = []
    for (let i = 0; i < steps.length; i++) {
      log('INFO', 'capability_execute_step', {
        id: cap.id,
        step: i + 1,
        total: steps.length,
        tool: steps[i],
      })
      stepLogs.push(`${i + 1}/${steps.length}: ${steps[i]}`)
    }

    // v0: 所有工具链步走完后记录 usage
    if (recordUsage) {
      recordUsage(cap.id)
    }

    log('INFO', 'capability_executed', {
      id: cap.id,
      steps: steps.length,
      intent: cap.intent.slice(0, 80),
    })

    return {
      success: true,
      summary: `能力执行完成: ${cap.intent.slice(0, 80)} (${steps.length} 步)`,
      durationMs: Date.now() - startedAt,
      details: { steps: stepLogs, toolchain: steps },
    }
  }

  // —── 工作流执行（v0 占位） ─────────────────────────────

  private async executeWorkflow(cap: Capability, startedAt: number): Promise<ActionResult> {
    log('INFO', 'capability_execute_workflow_placeholder', { id: cap.id })
    return {
      success: true,
      summary: `工作流执行 (v0 占位): ${cap.intent.slice(0, 80)}`,
      durationMs: Date.now() - startedAt,
      details: { type: 'workflow_placeholder', body: cap.executor.body },
    }
  }

  // —── 代码执行（v0 占位） ───────────────────────────────

  private executeCode(cap: Capability, startedAt: number): ActionResult {
    log('INFO', 'capability_execute_code_placeholder', { id: cap.id })
    return {
      success: true,
      summary: `代码执行 (v0 占位): ${cap.intent.slice(0, 80)}`,
      durationMs: Date.now() - startedAt,
      details: { type: 'code_placeholder', bodyLength: cap.executor.body.length },
    }
  }
}
