/**
 * ToolCompositeExecutor — 复合工具生成执行器
 *
 * ## 职责
 * 1. 接收 ToolCompositeCollector 产生的 Problem
 * 2. 解析 Problem 上下文中包含的工具序列和元数据
 * 3. 使用 ToolCompositeGenerator 生成复合工具
 * 4. 在 review 模式下保存提案，通过 Evolution 摘要通知用户
 * 5. 高置信度序列（>= 85%）可跳过审核直接注册
 *
 * ## 与 ToolEvolutionExecutor 的区别
 * ToolEvolutionExecutor: 改进现有工具的健壮性（修复 bug）
 * ToolCompositeExecutor: 从频繁序列生成新的复合工具（新增功能）
 *
 * @module evolution/automation
 */

import { log } from '../../logger/Logger'
import { toolCompositeGenerator } from '../../tool/ToolCompositeGenerator'
import { getMainWindow } from '../../core/Lifecycle'
import type { FixExecutor, AssignedProblem, FixResult, ProblemSource } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 支持的问题来源 */
const SUPPORTED_SOURCES: ProblemSource[] = ['tool']

/** 执行超时（毫秒） */
const EXEC_TIMEOUT_MS = 60_000

/** 两次执行最小间隔 */
const MIN_INTERVAL_MS = 30_000

// =============================================================================
// ToolCompositeExecutor
// =============================================================================

export class ToolCompositeExecutor implements FixExecutor {
  readonly name = 'ToolCompositeExecutor'
  readonly supportedSources: ProblemSource[] = SUPPORTED_SOURCES
  readonly timeoutMs = EXEC_TIMEOUT_MS

  private lastExecuteAt = 0
  private busy = false

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < MIN_INTERVAL_MS) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    try {
      // ── 步骤 1：解析 Problem 上下文 ──
      const metadata = problem.context.metadata
      if (!metadata) {
        return {
          problemId: problem.id,
          success: false,
          summary: '复合工具执行失败：缺少问题元数据',
          durationMs: Date.now() - startedAt,
          error: 'missing_metadata',
        }
      }

      const toolSequenceStr = metadata.toolSequence
      const patternId = metadata.patternId
      const frequency = parseInt(metadata.frequency || '0', 10)
      const confidence = parseFloat(metadata.confidence || '0')

      if (!toolSequenceStr) {
        return {
          problemId: problem.id,
          success: false,
          summary: '复合工具执行失败：缺少工具序列元数据',
          durationMs: Date.now() - startedAt,
          error: 'missing_tool_sequence',
        }
      }

      const toolSequence = toolSequenceStr.split(',').filter((t: string) => t.length > 0)
      if (toolSequence.length < 2) {
        return {
          problemId: problem.id,
          success: false,
          summary: `复合工具执行失败：工具序列太短 (${toolSequence.length})`,
          durationMs: Date.now() - startedAt,
          error: 'sequence_too_short',
        }
      }

      // ── 步骤 2：检查是否已存在同名提案 ──
      const existingProposals = toolCompositeGenerator.getAllProposals()
      const fingerprint = toolSequence.join('→')
      const alreadyExists = existingProposals.some(
        (p) => p.toolSequence.join('→') === fingerprint && p.status !== 'rejected',
      )

      if (alreadyExists) {
        return {
          problemId: problem.id,
          success: true,
          summary: `复合工具序列 "${fingerprint}" 已有提案，跳过重复生成`,
          durationMs: Date.now() - startedAt,
        }
      }

      // ── 步骤 3：构建 BehaviorPattern 结构 ──
      // 从 Problem 上下文还原 PatternMiner 所需的格式
      const steps = toolSequence.map((toolName: string, i: number) => ({
        toolName,
        paramTemplate: {} as Record<string, string>,
        description: this.getStepDescription(toolName),
        optional: false,
      }))

      // 最后几步如果是 readonly 工具，设为 optional
      for (let i = steps.length - 1; i >= Math.max(0, steps.length - 2); i--) {
        const readOnlyTools = ['read_file', 'list_files', 'grep', 'search']
        if (readOnlyTools.includes(steps[i].toolName)) {
          steps[i].optional = true
        }
      }

      // ── 步骤 4：生成复合工具 ──
      const generatedToolName = this.inferToolName(toolSequence)
      const result = await toolCompositeGenerator.generateFromPattern({
        id: patternId || `composite_auto_${Date.now()}`,
        name: generatedToolName,
        steps,
        toolSignature: toolSequence,
        triggerTool: toolSequence[0],
        frequency,
        support: toolSequence.length > 0 ? frequency / 500 : 0, // 估计值
        confidence,
        avgDurationMs: 0,
        associatedCategories: ['tool', 'automation'],
        associatedKeywords: toolSequence,
        enabled: true,
        confirmationThreshold: 0.7,
        createdAt: Date.now(),
        lastMatchedAt: Date.now(),
        notes: '',
      })

      // ── 步骤 5：结果处理 ──
      // result 可能是 CompositeToolProposal 或 CompositeRegistrationResult
      const isProposal = 'status' in result && 'toolName' in result && 'patternId' in result
      const toolName = isProposal ? (result as any).toolName : (result as any).toolName
      const success = isProposal ? true : (result as any).success

      if (!success) {
        return {
          problemId: problem.id,
          success: false,
          summary: `复合工具 "${toolName}" 生成失败: ${(result as any).error || '未知错误'}`,
          durationMs: Date.now() - startedAt,
          error: (result as any).error,
        }
      }

      const isAutoRegistered = isProposal
        ? (result as any).status === 'auto_registered'
        : false

      const statusLabel = isAutoRegistered ? '已自动注册' : '待审核'

      // 发送 IPC 通知（如果审核模式和窗口可用）
      if (!isAutoRegistered) {
        this.sendReviewNotification(toolName, toolSequence)
      }

      const durationMs = Date.now() - startedAt
      log('INFO', 'composite_tool_executor_success', {
        toolName,
        sequence: toolSequence.join(' → '),
        frequency,
        confidence,
        status: isAutoRegistered ? 'auto_registered' : 'pending_review',
        durationMs,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `复合工具 "${toolName}" 已生成${isAutoRegistered ? '并自动注册' : '（待审核）'}。` +
          `\n工具序列: ${toolSequence.join(' → ')}` +
          `\n历史出现: ${frequency} 次` +
          `\n成功率: ${(confidence * 100).toFixed(0)}%` +
          `\n\n【审核提示】` +
          (isAutoRegistered
            ? '\n该工具已自动注册到运行时，可直接使用。'
            : '\n该工具已保存为提案，请通过工具审核后注册。' +
              '\n可使用 composite_tool_review 工具查看和审核提案。' +
              `\n提案 ID: ${isProposal ? (result as any).id : ''}`),
        durationMs,
        output: JSON.stringify({
          toolName,
          toolSequence,
          frequency,
          confidence,
          status: isAutoRegistered ? 'auto_registered' : 'pending_review',
        }),
      }
    } catch (err: any) {
      log('ERROR', 'composite_tool_executor_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `复合工具生成异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.busy = false
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 发送审核通知到渲染进程（如果窗口可用）。
   */
  private sendReviewNotification(toolName: string, toolSequence: string[]): void {
    try {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return

      win.webContents.send('composite_tool:pending_review', {
        toolName,
        sequence: toolSequence.join(' → '),
        timestamp: Date.now(),
        message: `有新复合工具 "${toolName}" 待审核。序列: ${toolSequence.join(' → ')}。请使用工具查看并批准。`,
      })

      log('INFO', 'composite_tool_review_notification_sent', { toolName })
    } catch {
      // 窗口未就绪，静默忽略
    }
  }

  /**
   * 从工具名获取步骤描述。
   */
  private getStepDescription(toolName: string): string {
    const descriptions: Record<string, string> = {
      grep: '搜索代码内容',
      read_file: '读取文件内容',
      write_file: '写入文件内容',
      edit_file: '编辑文件内容',
      run_command: '执行命令',
      list_files: '列出目录文件',
      search: '搜索内容',
      analyze_codebase: '分析代码库',
      remember_fact: '记录事实',
      generate_image: '生成图片',
      planning: '制定计划',
      create_dev_plan: '创建开发计划',
      update_plan_progress: '更新计划进度',
      query_trends: '查询趋势',
    }
    return descriptions[toolName] || `调用 ${toolName}`
  }

  /**
   * 从工具序列推断复合工具名。
   */
  private inferToolName(toolSequence: string[]): string {
    const verbMap: Record<string, string> = {
      grep: 'search',
      read_file: 'read',
      write_file: 'write',
      edit_file: 'edit',
      run_command: 'exec',
      list_files: 'list',
      search: 'find',
      remember_fact: 'remember',
      analyze_codebase: 'analyze',
    }

    const verbs = toolSequence.slice(0, 2).map((t) => verbMap[t] || t.replace(/_/g, ''))
    let name = verbs.join('_and_')
    if (toolSequence.length > 2) name = name + '_multi'
    return name
  }
}
