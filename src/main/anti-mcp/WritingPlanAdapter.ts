/**
 * WritingPlanAdapter — 写作计划适配器
 *
 * 【反 MCP】特定于"修正工业颂歌19-27章（按设计文档）"场景的适配器。
 *
 * 展示三个反转版本的可行性原型：
 *
 * 反转 1（Plan 主导）：WritingPlanAdapter 主动初始化 WritingPlanAgent，
 *   而非等待 LLM 通过 writing_plan_start 工具触发。Plan 是执行起点。
 *
 * 反转 2（Plan 先规划）：Adapter 先调用 analyzeDesignDocument + compareChapters +
 *   decomposeRewrite 生成完整计划，再按计划执行。而非边执行边创建计划。
 *
 * 反转 3（Plan 决策）：Adapter 集成 PlanDrivenOrchestrator，根据执行结果
 *   自动判断下一步（重试/跳过/通知用户），而非等待 LLM 决策。
 */

import { log } from '../logger/Logger'
import { writingPlanAgent } from '../writing/WritingPlanAgent'
import { planDrivenOrchestrator, getAssumptionInversions } from './PlanDrivenOrchestrator'
import type { RewritePlan } from '../writing/types'
import type { PlanDrivenReport, ToolCallBridge } from './types'

// ============================================================================
// 配置
// ============================================================================

/** 默认设计文档路径 */
const DEFAULT_DESIGN_DOC = 'docs/工业颂歌_完整设计体系.md'
/** 默认章节目录 */
const DEFAULT_CHAPTER_DIR = 'docs/chapters'
/** 默认章节范围：19-27 */
const DEFAULT_CHAPTER_START = 19
const DEFAULT_CHAPTER_END = 27

// ============================================================================
// WritingPlanAdapter
// ============================================================================

export class WritingPlanAdapter {
  private toolBridge: ToolCallBridge | null = null

  /** 注入工具桥接器 */
  setToolBridge(bridge: ToolCallBridge): void {
    this.toolBridge = bridge
    planDrivenOrchestrator.setToolBridge(bridge)
  }

  /** 检查依赖是否就绪 */
  isReady(): boolean {
    return writingPlanAgent !== null && writingPlanAgent.isReady() && this.toolBridge !== null
  }

  // ========================================================================
  //  反转 1（Plan 主导）— 反向入口
  //
  //  不再等待 LLM 调用 writing_plan_start 工具，而是由 Plan 主动触发。
  //  WritingPlanAdapter.start() 自行调用 analyzeDesignDocument → compareChapters
  //  → decomposeRewrite，生成 RewritePlan 后立即执行。
  // ========================================================================

  /**
   * 主动启动写作计划（反转入口）。
   *
   * @param designDocPath  设计文档路径
   * @param chapterDir     章节目录
   * @param start          起始章节号
   * @param end            结束章节号
   * @returns 生成的 RewritePlan 和执行结果
   */
  async startPlan(
    designDocPath: string = DEFAULT_DESIGN_DOC,
    chapterDir: string = DEFAULT_CHAPTER_DIR,
    start: number = DEFAULT_CHAPTER_START,
    end: number = DEFAULT_CHAPTER_END,
  ): Promise<{ plan: RewritePlan | null; report?: PlanDrivenReport; error?: string }> {
    log('INFO', 'antimcp_adapter_start', { designDocPath, chapterDir, start, end })

    if (!writingPlanAgent || !writingPlanAgent.isReady()) {
      return { plan: null, error: 'WritingPlanAgent 未初始化' }
    }

    // Step 1: 分析设计文档
    log('INFO', 'antimcp_adapter_analyze_design')
    const designResult = await writingPlanAgent.analyzeDesignDocument(designDocPath)
    if (designResult.error) {
      return { plan: null, error: `设计文档分析失败: ${designResult.error}` }
    }
    const designAnalysis = designResult.data!

    // Step 2: 收集章节文件（模拟 collectChapterFiles 逻辑）
    const chapterPaths: string[] = []
    for (let ch = start; ch <= end; ch++) {
      chapterPaths.push(`${chapterDir}/${ch}.md`)
    }

    // Step 3: 对比章节
    log('INFO', 'antimcp_adapter_compare_chapters')
    const compareResult = await writingPlanAgent.compareChapters(designAnalysis, chapterPaths)
    if (compareResult.error) {
      return { plan: null, error: `章节对比失败: ${compareResult.error}` }
    }

    // Step 4: 分解重写任务
    log('INFO', 'antimcp_adapter_decompose_tasks')
    const decomposeResult = await writingPlanAgent.decomposeRewrite(compareResult.data!, designAnalysis)
    if (decomposeResult.error) {
      return { plan: null, error: `任务分解失败: ${decomposeResult.error}` }
    }

    const rewritePlan = decomposeResult.data!

    // Step 5: 在 PlanManager 中创建主计划（供传统流程兼容使用）
    try {
      const pm = (await import('../tool/deps')).getPlanManager()
      if (pm) {
        const phaseLabels: Record<string, string> = {
          outline: '调整大纲',
          rewrite: '重写章节',
          quality_check: '质量校验',
        }
        const steps = rewritePlan.tasks.map(
          (t) => `[${phaseLabels[t.phase] || t.phase}] ${t.title} (第${t.chapterNumbers.join(', ')}章)`,
        )
        pm.createPlan(
          `写作计划: ${rewritePlan.storyName}`,
          `反 MCP 自动编排 — ${rewritePlan.storyName}，共 ${rewritePlan.tasks.length} 个子任务`,
          steps,
        )
      }
    } catch (err: any) {
      log('WARN', 'antimcp_adapter_create_plan_skipped', { error: err.message })
    }

    log('INFO', 'antimcp_adapter_plan_ready', {
      planId: rewritePlan.planId,
      tasks: rewritePlan.tasks.length,
    })

    return { plan: rewritePlan }
  }

  // ========================================================================
  //  反转 2（Plan 先规划执行顺序）— 按图执行
  //
  //  PlanDrivenOrchestrator 按 RewritePlan 的依赖图展开执行步骤，
  //  每一步都调用 MCP 工具。MCP 工具只负责执行，不负责决策下一步。
  // ========================================================================

  /**
   * 按 Plan 的依赖图执行写作计划（反转 2 + 反转 3）。
   *
   * @param plan 已生成的 RewritePlan
   * @returns 执行报告
   */
  async executePlan(plan: RewritePlan): Promise<PlanDrivenReport> {
    log('INFO', 'antimcp_adapter_execute', { planId: plan.planId })

    if (!this.toolBridge) {
      throw new Error('工具桥接器未注入')
    }

    return planDrivenOrchestrator.execute(plan)
  }

  // ========================================================================
  //  一键全流程（反转 1 + 2 + 3 集成演示）
  // ========================================================================

  /**
   * 反 MCP 全流程演示：
   * 1. Plan 主动启动（反转 1）
   * 2. Plan 按依赖图执行（反转 2）
   * 3. Plan 根据结果自适应（反转 3）
   *
   * 无需任何 LLM 参与的 Plan→MCP 调用链。
   */
  async runAntiMCPPipeline(
    designDocPath: string = DEFAULT_DESIGN_DOC,
    chapterDir: string = DEFAULT_CHAPTER_DIR,
    start: number = DEFAULT_CHAPTER_START,
    end: number = DEFAULT_CHAPTER_END,
  ): Promise<{
    plan: RewritePlan | null
    report: PlanDrivenReport | null
    error?: string
  }> {
    log('INFO', 'antimcp_pipeline_start', { designDocPath, chapterDir, start, end })

    // Phase 1: Plan 主动创建（反转 1）
    const { plan, error } = await this.startPlan(designDocPath, chapterDir, start, end)
    if (error || !plan) {
      return { plan: null, report: null, error }
    }

    log('INFO', 'antimcp_pipeline_plan_ready', {
      planId: plan.planId,
      tasks: plan.tasks.length,
      phases: [...new Set(plan.tasks.map((t) => t.phase))],
    })

    // Phase 2: Plan 驱动执行（反转 2 + 3）
    const report = await this.executePlan(plan)

    return { plan, report }
  }

  // ========================================================================
  //  执行报告格式化
  // ========================================================================

  /**
   * 将执行报告格式化为可读文本（用于 UI 显示或日志）。
   */
  formatReport(report: PlanDrivenReport): string {
    const statusIcon: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌',
      paused: '⏸️',
    }

    const lines: string[] = [
      `${statusIcon[report.status] || '❓'} 【反 MCP 执行报告】`,
      ``,
      `📖 ${report.storyName}`,
      `🆔 计划 ID: ${report.planId}`,
      `📊 进度: ${report.overallProgress}% (${report.completedTasks}/${report.totalTasks})`,
      `⏱️ 耗时: ${(report.durationMs / 1000).toFixed(1)}s`,
      ``,
      '📋 【步骤执行结果】',
    ]

    for (const step of report.stepResults) {
      const icon = step.success ? '✅' : '❌'
      const tool = step.toolName || '?'
      const time = `${(step.durationMs / 1000).toFixed(1)}s`
      lines.push(`  ${icon} [${step.sequence}] ${tool} (${time})${step.error ? `: ${step.error}` : ''}`)
    }

    if (report.log.length > 0) {
      lines.push('', '📝 【执行日志】')
      for (const entry of report.log.slice(-10)) {
        const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
        const icon = entry.level === 'error' ? '🔴' : entry.level === 'warn' ? '🟡' : '🔵'
        lines.push(`  ${icon} [${time}] ${entry.message}`)
      }
    }

    return lines.join('\n')
  }

  /** 获取假设反转分析的格式化文本 */
  static formatInversionAnalysis(): string {
    const inversions = getAssumptionInversions()

    const feasibilityLabel: Record<string, string> = {
      high: '🟢 高',
      medium: '🟡 中',
      low: '🔴 低',
    }

    const lines: string[] = [
      '═══════════════════════════════════════════',
      '  反 MCP：假设反转分析报告',
      '═══════════════════════════════════════════',
      '',
      '场景: Plan:修正工业颂歌19-27章（按设计文档）',
      '',
    ]

    for (const inv of inversions) {
      lines.push(`━━━ 反转 ${inversions.indexOf(inv) + 1} ━━━`)
      lines.push(`📌 当前假设: ${inv.assumption}`)
      lines.push(`🔄 反转后:   ${inv.inversed}`)
      lines.push(`📊 可行性:   ${feasibilityLabel[inv.feasibility]}`)
      lines.push(`🎯 影响范围: ${inv.scope}`)
      lines.push(`💎 价值:     ${inv.value}`)
      lines.push('')
      lines.push('⚠️ 风险:')
      for (const risk of inv.risks) {
        lines.push(`   - ${risk}`)
      }
      lines.push('')
    }

    lines.push('━━━ 原型验证方向 ━━━')
    lines.push('选择反转 3（Plan 决策，MCP 执行）作为原型方向，原因：')
    lines.push('  1. 与现有 WritingPlanAgent 体系自然衔接')
    lines.push('  2. 状态机模式可增量叠加到现有 PlanManager 上')
    lines.push('  3. 依赖图 + 分支逻辑提供可审计的执行轨迹')
    lines.push('  4. 不改动现有 MCP 基础设施（ServerManager 保持原样）')
    lines.push('')
    lines.push('实现: src/main/anti-mcp/')
    lines.push('  - PlanDrivenOrchestrator.ts — 核心反转引擎')
    lines.push('  - WritingPlanAdapter.ts — 写作计划适配器')
    lines.push('  - types.ts — 类型定义')

    return lines.join('\n')
  }
}

// ============================================================================
// 单例
// ============================================================================

export const writingPlanAdapter = new WritingPlanAdapter()

export function getWritingPlanAdapter(): WritingPlanAdapter {
  return writingPlanAdapter
}
