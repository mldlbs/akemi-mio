/**
 * SonggeReasoningChainExecutor — ASR 引导 Plan:修正工业颂歌19-27章（按设计文档）推理链执行器
 *
 * ASR 不直接输出修正结果，而是生成一条推理路径（中间步骤链），
 * Plan:修正工业颂歌19-27章 沿着这条路径逐步验证和执行。
 *
 * 职责分配：
 * - ASR 分析层：任务分解、优先级排序（本类中的 generateReasoningChain）
 * - Plan 执行层：步骤执行、中间结果追踪（PlanManager + SonggeCorrectionAdapter）
 * - 结果汇总：最终修正报告由 Plan 汇总返回
 *
 * 推理链步骤：
 *   0. 分析设计文档需求 — 从设计文档提取修正标准和维度权重
 *   1. 逐章评分评估 — 对第19-27章执行多维度评分（复用 SonggeCorrectionAdapter）
 *   2. 生成逐章修正方案 — 基于评分结果生成每章的修正问题列表
 *   3. 验证修正兼容性 — 检查跨章节修正是否冲突，以及修正与风格指南的一致性
 *   4. 执行章节修正 — 批量应用修正结果到各章节
 *   5. 创建评估快照 — 记录修正前后的评分基线，供下轮对比
 *
 * 中断恢复支持：
 * - 通过 PlanManager 创建 DevPlan，步骤状态持久化
 * - 如果执行中断，下次可通过 PlanManager 查询当前活跃计划及执行到的步骤
 * - 从中断步骤恢复继续执行
 *
 * 安全机制：
 * - PlanManager 的计划上限控制（MAX_ACTIVE_PLANS = 3）
 * - 幂等性检查：同一章节范围不重复生成推理链（1h TTL）
 * - 步骤级超时保护
 * - 关键步骤失败自动停止后续执行
 * - 累积误差检测：长推理链中检查评分偏移
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getPlanManager } from '@akemi-mio/capabilities/tool/deps'
import { songgeCorrectionAdapter } from '@akemi-mio/blog-publish/gongye-songge/PlanSonggeCorrectionAdapter'
import { issuePatternAnalyzer } from '@akemi-mio/blog-publish/gongye-songge/IssuePatternAnalyzer'
import type { FixExecutor, AssignedProblem, FixResult } from '@akemi-mio/evolution/automation/types'
import type { ReasoningChain, ReasoningStep } from '@akemi-mio/evolution/automation/types'
import type { CorrectionInput, CorrectionResult, CorrectionIssue, CorrectionSeverity } from '@akemi-mio/blog-publish/gongye-songge/PlanSonggeCorrectionAdapter'

// =============================================================================
// 配置
// =============================================================================

/** 执行超时（毫秒） */
const EXECUTION_TIMEOUT_MS = 60000
/** 推理链计划的标题模板 */
const PLAN_TITLE_PREFIX = 'ASR 引导 Plan:修正工业颂歌19-27章'
/** 幂等缓存 TTL（毫秒），同一任务在 1h 内不重复生成 */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000
/** 推理链最短步骤数 */
const MIN_REASONING_STEPS = 4
/** 推理链最长步骤数 */
const MAX_REASONING_STEPS = 8
/** 累积误差检测阈值：连续两步评分差异超过此值视为异常 */
const ACCUMULATED_ERROR_THRESHOLD = 0.25
/** 默认章节范围 */
const DEFAULT_CHAPTER_START = 19
const DEFAULT_CHAPTER_END = 27

// =============================================================================
// SonggeReasoningChainExecutor
// =============================================================================

export class SonggeReasoningChainExecutor implements FixExecutor {
  readonly name = 'SonggeReasoningChainExecutor'
  readonly timeoutMs = EXECUTION_TIMEOUT_MS
  readonly supportedSources = ['log', 'feature'] as const

  private isExecuting = false
  /** 幂等缓存 — 最近已生成推理链的任务 key */
  private recentChains = new Set<string>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  // ═══════════════════════════════════════════════════════════════════
  //  FixExecutor 接口实现
  // ═══════════════════════════════════════════════════════════════════

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // ── 0. 从 Problem 提取输入 ──────────────────────────
      const input = this.extractCorrectionInput(problem)
      if (!input) {
        return {
          problemId: problem.id,
          success: false,
          summary: '无法从 Problem 提取章节修正输入',
          durationMs: Date.now() - startedAt,
          error: 'missing_input',
        }
      }

      // ── 1. 幂等性检查 ──────────────────────────────────
      const problemKey = this.buildIdempotencyKey(problem, input)
      if (this.recentChains.has(problemKey)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `章节 ${input.chapterStart}-${input.chapterEnd} 已生成过推理链，跳过重复执行`,
          durationMs: Date.now() - startedAt,
        }
      }

      // ── 2. 生成推理链 ──────────────────────────────────
      const chain = this.generateReasoningChain(problem, input)

      if (chain.steps.length < MIN_REASONING_STEPS) {
        return {
          problemId: problem.id,
          success: true,
          summary: `推理链步骤数不足（${chain.steps.length}/${MIN_REASONING_STEPS}），跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      // ── 3. 通过 PlanManager 创建开发计划 ──────────────
      const pm = getPlanManager()
      let planId: string | undefined
      if (pm) {
        try {
          const plan = pm.createPlan(
            `${PLAN_TITLE_PREFIX}: ${chain.title}`,
            chain.steps.map((s) => `${s.description}${s.detail ? ` — ${s.detail}` : ''}`).join('\n'),
            chain.steps.map((s) => s.description),
            2, // 高优先级（工业颂歌修正）
          )
          planId = plan.id
          log('INFO', 'songge_reasoning_chain_plan_created', {
            planId,
            problemId: problem.id,
            steps: chain.steps.length,
          })
        } catch (err: any) {
          log('WARN', 'songge_reasoning_chain_plan_failed', {
            problemId: problem.id,
            error: err.message,
          })
        }
      }

      // ── 4. 逐步执行推理链 ──────────────────────────────
      const stepResults: Array<{
        index: number
        success: boolean
        summary: string
        output?: string
      }> = []
      let allSucceeded = true
      let executionStoppedEarly = false
      let prevCompositeScore = -1 // 累积误差检测

      for (let i = 0; i < chain.steps.length; i++) {
        const step = chain.steps[i]
        const stepStartedAt = Date.now()

        // 更新 Plan 步骤状态
        if (planId && pm) {
          pm.updateStep(planId, i, 'in_progress')
        }

        // 执行当前步骤
        const stepResult = await this.executeStep(step, chain, input, stepStartedAt)
        step.durationMs = Date.now() - stepStartedAt
        step.status = stepResult.success ? 'completed' : 'failed'
        step.result = stepResult.summary

        // 累积误差检测
        if (stepResult.output) {
          try {
            const parsed = JSON.parse(stepResult.output)
            if (typeof parsed.compositeScore === 'number') {
              const score = parsed.compositeScore
              if (prevCompositeScore >= 0 && Math.abs(score - prevCompositeScore) > ACCUMULATED_ERROR_THRESHOLD) {
                log('WARN', 'songge_reasoning_chain_accumulated_error', {
                  step: step.index,
                  prevScore: prevCompositeScore,
                  currentScore: score,
                  threshold: ACCUMULATED_ERROR_THRESHOLD,
                })
              }
              prevCompositeScore = score
            }
          } catch {
            // output 不是 JSON，跳过误差检测
          }
        }

        // 记录结果
        stepResults.push({
          index: step.index,
          success: stepResult.success,
          summary: stepResult.summary,
          output: stepResult.output,
        })

        // 更新 Plan 步骤完成状态
        if (planId && pm) {
          pm.updateStep(planId, i, stepResult.success ? 'done' : 'failed', stepResult.summary)
        }

        log('INFO', 'songge_reasoning_step_completed', {
          problemId: problem.id,
          step: step.index,
          stepDesc: step.description,
          success: stepResult.success,
          durationMs: step.durationMs,
        })

        if (!stepResult.success) {
          allSucceeded = false
          if (this.isCriticalStep(step)) {
            executionStoppedEarly = true
            for (let j = i + 1; j < chain.steps.length; j++) {
              chain.steps[j].status = 'skipped'
              chain.steps[j].result = '前置关键步骤失败，跳过'
              stepResults.push({
                index: chain.steps[j].index,
                success: true,
                summary: '前置关键步骤失败，跳过',
              })
              if (planId && pm) {
                pm.updateStep(planId, j, 'failed', '前置关键步骤失败，跳过')
              }
            }
            break
          }
        }
      }

      // ── 5. 完成 Plan ────────────────────────────────────
      chain.allSucceeded = allSucceeded
      chain.completedAt = Date.now()
      const conclusion = this.buildConclusion(chain, stepResults)
      chain.conclusion = conclusion

      if (planId && pm) {
        if (allSucceeded) {
          pm.completePlan(planId, conclusion)
        } else if (executionStoppedEarly) {
          pm.freezePlan(planId, `执行中断于步骤 ${stepResults.filter((r) => !r.success).length + 1}/${chain.steps.length}: ${conclusion}`)
        }
      }

      // ── 6. 记录幂等缓存 ──────────────────────────────
      this.recentChains.add(problemKey)
      setTimeout(() => this.recentChains.delete(problemKey), IDEMPOTENCY_TTL_MS)

      // ── 7. 返回聚合结果 ──────────────────────────────
      const summary = this.buildReasoningSummary(chain, stepResults)
      log('INFO', 'songge_reasoning_chain_completed', {
        problemId: problem.id,
        planId,
        steps: chain.steps.length,
        succeeded: stepResults.filter((r) => r.success).length,
        allSucceeded,
        executionDurationMs: Date.now() - startedAt,
      })

      return {
        problemId: problem.id,
        success: allSucceeded,
        summary,
        durationMs: Date.now() - startedAt,
        output: JSON.stringify({
          planId,
          chainTitle: chain.title,
          totalSteps: chain.steps.length,
          succeededSteps: stepResults.filter((r) => r.success).length,
          allSucceeded,
          chapterRange: `${input.chapterStart}-${input.chapterEnd}`,
        }),
      }
    } catch (err) {
      log('ERROR', 'songge_reasoning_chain_execute_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `工业颂歌推理链执行异常: ${String(err)}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.isExecuting = false
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  直接执行接口（供 PlanFirstCorrectionPipeline 或外部直接调用）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 直接使用 CorrectionInput 执行推理链（绕过 FixExecutor 接口）。
   * 用于需要直接传入章节内容和设计文档的场景。
   */
  async executeDirect(input: CorrectionInput): Promise<{
    success: boolean
    summary: string
    chain: ReasoningChain
    result?: CorrectionResult
  }> {
    const startedAt = Date.now()

    // 构建模拟 Problem
    const mockProblem: AssignedProblem = {
      id: `songge_direct_${Date.now()}`,
      source: 'feature',
      severity: 'info',
      title: `ASR 引导:修正工业颂歌 ${Object.keys(input.chapters).length} 章`,
      description: '通过直接调用执行工业颂歌章节修正推理链',
      estimatedCostChars: 2000,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: JSON.stringify(input),
        metadata: {
          chapterStart: String(Math.min(...Object.keys(input.chapters).map(Number))),
          chapterEnd: String(Math.max(...Object.keys(input.chapters).map(Number))),
          designDoc: input.designDoc.slice(0, 500),
        },
      },
      attempt: 1,
      assignedAt: Date.now(),
    }

    const extracted = this.extractCorrectionInput(mockProblem)
    if (!extracted) {
      return {
        success: false,
        summary: '无法提取修正输入',
        chain: { problemId: '', title: '', steps: [], createdAt: Date.now(), allSucceeded: false },
      }
    }

    const chain = this.generateReasoningChain(mockProblem, extracted)
    const stepResults: Array<{ index: number; success: boolean; summary: string; output?: string }> = []
    let allSucceeded = true

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i]
      const stepStartedAt = Date.now()
      const stepResult = await this.executeStep(step, chain, extracted, stepStartedAt)
      step.durationMs = Date.now() - stepStartedAt
      step.status = stepResult.success ? 'completed' : 'failed'
      step.result = stepResult.summary
      stepResults.push({ index: step.index, success: stepResult.success, summary: stepResult.summary, output: stepResult.output })

      if (!stepResult.success && this.isCriticalStep(step)) {
        allSucceeded = false
        for (let j = i + 1; j < chain.steps.length; j++) {
          chain.steps[j].status = 'skipped'
        }
        break
      }
    }

    chain.allSucceeded = allSucceeded
    chain.completedAt = Date.now()
    chain.conclusion = this.buildConclusion(chain, stepResults)

    return {
      success: allSucceeded,
      summary: this.buildReasoningSummary(chain, stepResults),
      chain,
      result: this.extractCorrectionResult(stepResults),
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  输入提取
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 从 AssignedProblem 中提取修正输入。
   * 支持两种输入方式：
   * 1. metadata 方式：通过 context.metadata 字段传入（适用于简单场景）
   * 2. raw JSON 方式：通过 context.raw 传入完整的 CorrectionInput JSON
   */
  private extractCorrectionInput(problem: AssignedProblem): {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  } | null {
    const metadata = problem.context.metadata ?? {}

    // 方式1：从 context.raw 解析完整 CorrectionInput
    if (problem.context.raw) {
      try {
        const parsed = JSON.parse(problem.context.raw)
        if (parsed.chapters && typeof parsed.chapters === 'object') {
          const chapters = parsed.chapters as Record<number, string>
          const chapterKeys = Object.keys(chapters).map(Number)
          return {
            chapters,
            designDoc: parsed.designDoc || metadata.design_doc || '',
            styleGuide: parsed.styleGuide || metadata.style_guide || '',
            chapterStart: Math.min(...chapterKeys),
            chapterEnd: Math.max(...chapterKeys),
          }
        }
      } catch {
        // raw 不是 JSON，降级到 metadata
      }
    }

    // 方式2：从 metadata 提取（简单场景，无完整章节内容）
    const chapterStart = Number(metadata.chapterStart) || DEFAULT_CHAPTER_START
    const chapterEnd = Number(metadata.chapterEnd) || DEFAULT_CHAPTER_END
    const designDoc = metadata.design_doc || ''
    const styleGuide = metadata.style_guide

    // 没有章节内容时无法执行评分
    if (!designDoc) {
      return null
    }

    return {
      chapters: {}, // 空对象，后续步骤会降级处理
      designDoc,
      styleGuide,
      chapterStart,
      chapterEnd,
    }
  }

  /**
   * 构建幂等性 key。
   */
  private buildIdempotencyKey(problem: AssignedProblem, input: { chapterStart: number; chapterEnd: number; designDoc: string }): string {
    const docHash = input.designDoc.slice(0, 100).replace(/\s+/g, '')
    return `songge_${input.chapterStart}-${input.chapterEnd}_${docHash.length}`
  }

  // ═══════════════════════════════════════════════════════════════════
  //  推理链生成
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 根据 Problem 内容和输入生成推理链。
   * 步骤分解基于章节范围、设计文档长度和既有问题模式。
   */
  private generateReasoningChain(
    problem: AssignedProblem,
    input: { chapters: Record<number, string>; designDoc: string; styleGuide?: string; chapterStart: number; chapterEnd: number },
  ): ReasoningChain {
    const timestamp = Date.now()
    const steps: ReasoningStep[] = []
    let stepIndex = 0
    const designDocHint = input.designDoc.slice(0, 60) + (input.designDoc.length > 60 ? '...' : '')

    // Step 0: 分析设计文档需求
    steps.push(
      this.makeStep(
        stepIndex++,
        timestamp,
        '分析设计文档需求',
        input.designDoc ? `从设计文档中提取修正标准：${designDocHint}` : '未提供设计文档，使用默认修正标准',
      ),
    )

    // Step 1: 逐章评分评估
    const chapterCount = Object.keys(input.chapters).length || input.chapterEnd - input.chapterStart + 1
    steps.push(
      this.makeStep(
        stepIndex++,
        timestamp,
        `逐章评分评估（第${input.chapterStart}-${input.chapterEnd}章）`,
        `对 ${chapterCount} 个章节执行多维度评分（设计文档符合度/风格一致性/结构准确性/内容质量/情节连续性）`,
      ),
    )

    // Step 2: 生成逐章修正方案
    steps.push(this.makeStep(stepIndex++, timestamp, '生成逐章修正方案', '基于评分结果，为每个需要修正的章节生成具体修正问题和建议'))

    // Step 3: 验证修正兼容性
    steps.push(this.makeStep(stepIndex++, timestamp, '验证修正兼容性', '检查跨章节修正是否一致，以及修正方案与风格指南的兼容性'))

    // Step 4: 执行章节修正
    steps.push(this.makeStep(stepIndex++, timestamp, '执行章节修正', `批量应用修正结果到第${input.chapterStart}-${input.chapterEnd}章`))

    // Step 5: 创建评估快照
    steps.push(this.makeStep(stepIndex++, timestamp, '创建修正评估快照', '记录修正后的评分基线，标记需要后续关注的问题'))

    // 根据问题严重度裁剪步骤
    const trimmed =
      problem.severity === 'info'
        ? steps.slice(0, Math.min(steps.length, MIN_REASONING_STEPS + 1))
        : steps.slice(0, Math.min(steps.length, MAX_REASONING_STEPS))

    return {
      problemId: problem.id,
      title: `修正工业颂歌第${input.chapterStart}-${input.chapterEnd}章（按设计文档）`,
      steps: trimmed,
      createdAt: Date.now(),
      allSucceeded: false,
    }
  }

  /**
   * 创建单个推理步骤。
   */
  private makeStep(index: number, timestamp: number, description: string, detail: string): ReasoningStep {
    return {
      id: `ss_${index}_${timestamp}`,
      index,
      description,
      detail,
      status: 'pending',
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  步骤执行
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 执行推理链中的单一步骤。
   */
  private async executeStep(
    step: ReasoningStep,
    chain: ReasoningChain,
    input: { chapters: Record<number, string>; designDoc: string; styleGuide?: string; chapterStart: number; chapterEnd: number },
    startedAt: number,
  ): Promise<{ success: boolean; summary: string; output?: string }> {
    switch (step.index) {
      case 0:
        return this.stepAnalyzeDesignDoc(input)
      case 1:
        return this.stepEvaluateChapters(input)
      case 2:
        return this.stepGenerateCorrections(input)
      case 3:
        return this.stepValidateCompatibility(input)
      case 4:
        return this.stepExecuteCorrections(input)
      case 5:
        return this.stepEvaluateSnapshot(input)
      default:
        return { success: true, summary: `步骤 ${step.index} 无操作，已跳过` }
    }
  }

  /**
   * 步骤0：分析设计文档 — 提取修正标准和维度权重。
   */
  private stepAnalyzeDesignDoc(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): { success: boolean; summary: string; output?: string } {
    const { designDoc, styleGuide } = input

    if (!designDoc) {
      return { success: false, summary: '缺少设计文档，无法提取修正标准' }
    }

    // 分析设计文档结构
    const docLength = designDoc.length
    const hasSections = designDoc.includes('##') || designDoc.includes('一、') || designDoc.includes('1.')
    const hasKeywords = this.extractKeywords(designDoc)
    const dimensionHints = this.detectDimensionHints(designDoc)

    const summary = [
      '【设计文档分析结果】',
      `- 文档长度: ${docLength} 字`,
      `- 包含章节结构: ${hasSections ? '是' : '否'}`,
      `- 提取关键维度: ${dimensionHints.length > 0 ? dimensionHints.join(', ') : '使用默认维度'}`,
      `- 关键主题词: ${hasKeywords.slice(0, 8).join(', ')}`,
      `- 风格指南: ${styleGuide || '未提供，使用默认工业颂歌风格'}`,
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        docLength,
        hasSections,
        keywords: hasKeywords.slice(0, 8),
        dimensionHints,
      }),
    }
  }

  /**
   * 步骤1：逐章评分评估 — 对第19-27章执行多维度评分。
   */
  private async stepEvaluateChapters(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): Promise<{ success: boolean; summary: string; output?: string }> {
    const { chapters, designDoc, styleGuide, chapterStart, chapterEnd } = input

    if (Object.keys(chapters).length === 0) {
      return { success: false, summary: '缺少章节内容，无法执行评分评估' }
    }

    // 使用 SonggeCorrectionAdapter 执行多维度评分
    const result = songgeCorrectionAdapter.evaluateChapters({
      chapters,
      designDoc,
      styleGuide,
    })

    if (!result || result.snapshots.length === 0) {
      return { success: false, summary: '章节评分失败：SonggeCorrectionAdapter 返回空结果' }
    }

    // 运行 IssuePatternAnalyzer 进行跨章节模式分析
    const patternAnalysis = issuePatternAnalyzer.analyze(result)

    // 构建可读摘要
    const chapterSummaries = result.snapshots
      .map((snap) => {
        const status = snap.needsCorrection ? '⚠️' : '✅'
        return `  ${status} 第${snap.chapterIndex}章: ${(snap.compositeScore * 100).toFixed(1)}% (${snap.issues.length} 个问题)`
      })
      .join('\n')

    const summary = [
      '【逐章评分评估结果】',
      `- 评估章节: ${chapterStart}-${chapterEnd}（共 ${result.snapshots.length} 章）`,
      `- 整体复合评分: ${(result.compositeScore * 100).toFixed(1)}%`,
      `- 综合严重程度: ${result.severity}`,
      `- 总问题数: ${result.totalIssues}`,
      `- 需修正章节: ${result.chaptersNeedingFix}/${result.snapshots.length}`,
      ``,
      chapterSummaries,
      ``,
      patternAnalysis.summary,
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        compositeScore: result.compositeScore,
        severity: result.severity,
        totalIssues: result.totalIssues,
        chaptersNeedingFix: result.chaptersNeedingFix,
        snapshots: result.snapshots.map((s) => ({
          chapterIndex: s.chapterIndex,
          score: s.compositeScore,
          issues: s.issues.length,
          needsCorrection: s.needsCorrection,
        })),
        patterns: {
          trend: patternAnalysis.severityTrend.direction,
          topCategories: patternAnalysis.categoryFrequencies.slice(0, 3).map((c) => c.category),
          highDensity: patternAnalysis.density.highDensity.length,
        },
      }),
    }
  }

  /**
   * 步骤2：生成逐章修正方案 — 基于评分结果为每章生成修正问题列表。
   */
  private stepGenerateCorrections(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): { success: boolean; summary: string; output?: string } {
    const { chapters, designDoc, chapterStart, chapterEnd } = input

    if (Object.keys(chapters).length === 0) {
      return { success: false, summary: '缺少章节内容，无法生成修正方案' }
    }

    // 重新评估以获取最新的问题列表
    const result = songgeCorrectionAdapter.evaluateChapters({
      chapters,
      designDoc,
    })

    if (!result || result.snapshots.length === 0) {
      return { success: false, summary: '评估失败，无法生成修正方案' }
    }

    // 按严重程度分组
    const criticalIssues: CorrectionIssue[] = []
    const majorIssues: CorrectionIssue[] = []
    const minorIssues: CorrectionIssue[] = []

    for (const snap of result.snapshots) {
      for (const issue of snap.issues) {
        switch (issue.severity) {
          case 'critical':
            criticalIssues.push(issue)
            break
          case 'major':
            majorIssues.push(issue)
            break
          default:
            minorIssues.push(issue)
        }
      }
    }

    // 生成优先级排序的修正方案
    const priorityPlan = [
      '【修正优先级方案】',
      '',
      criticalIssues.length > 0
        ? `🔴 紧急修正（${criticalIssues.length} 项）：\n${criticalIssues.map((i) => `  · 第${i.chapterIndex}章: ${i.description}`).join('\n')}`
        : '',
      majorIssues.length > 0
        ? `\n🟡 重要修正（${majorIssues.length} 项）：\n${majorIssues.map((i) => `  · 第${i.chapterIndex}章: ${i.description}`).join('\n')}`
        : '',
      minorIssues.length > 0
        ? `\n🟢 建议修正（${minorIssues.length} 项）：\n${minorIssues.map((i) => `  · 第${i.chapterIndex}章: ${i.description}`).join('\n')}`
        : '',
      '',
      `总修正计划: ${result.totalIssues} 项`,
      `其中紧急 ${criticalIssues.length} 项、重要 ${majorIssues.length} 项、建议 ${minorIssues.length} 项`,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary: priorityPlan,
      output: JSON.stringify({
        totalIssues: result.totalIssues,
        criticalCount: criticalIssues.length,
        majorCount: majorIssues.length,
        minorCount: minorIssues.length,
        priority: criticalIssues.length > 0 ? 'critical_first' : majorIssues.length > 0 ? 'major_first' : 'minor_first',
        estimatedCorrectionChars: result.totalIssues * 200,
      }),
    }
  }

  /**
   * 步骤3：验证修正兼容性 — 检查跨章节修正是否冲突。
   */
  private stepValidateCompatibility(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): { success: boolean; summary: string; output?: string } {
    const { chapters, designDoc, styleGuide, chapterStart, chapterEnd } = input

    if (Object.keys(chapters).length === 0) {
      return { success: true, summary: '无章节内容，跳过兼容性验证' }
    }

    // 验证各章节修正建议的一致性
    const result = songgeCorrectionAdapter.evaluateChapters({
      chapters,
      designDoc,
      styleGuide,
    })

    if (!result || result.snapshots.length === 0) {
      return { success: true, summary: '评估失败，跳过兼容性验证' }
    }

    // 检查跨章节问题类别分布（是否存在集中爆发的模式）
    const categoryCount = new Map<string, number>()
    for (const snap of result.snapshots) {
      for (const issue of snap.issues) {
        categoryCount.set(issue.category, (categoryCount.get(issue.category) || 0) + 1)
      }
    }

    // 检测主导问题类别
    const topCategory = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

    // 检查风格指南兼容性
    const styleIssues = styleGuide ? result.snapshots.filter((s) => s.scores.styleConsistency < 0.5).length : 0

    // 检查结构问题分布
    const structuralIssues = result.snapshots.filter((s) => s.scores.structuralAccuracy < 0.5).length

    const hasConflicts = topCategory.some(([, count]) => count >= 4)
    const warnings: string[] = []

    if (hasConflicts) {
      warnings.push(`注意：问题类别 "${topCategory[0][0]}" 在多个章节集中出现（${topCategory[0][1]} 次），可能表明系统性偏差`)
    }
    if (styleIssues >= 3) {
      warnings.push(`警告：${styleIssues} 个章节存在风格一致性问题，建议统一检查风格指南应用`)
    }
    if (structuralIssues >= 3) {
      warnings.push(`注意：${structuralIssues} 个章节存在结构性问题，建议检查章节模板一致性`)
    }

    const summary = [
      '【兼容性验证结果】',
      warnings.length > 0 ? warnings.join('\n') : '未发现严重兼容性问题，修正方案可安全执行',
      '',
      `章节范围: ${chapterStart}-${chapterEnd}`,
      `主导问题类别: ${topCategory.map(([c, n]) => `${c}(${n})`).join(', ') || '无'}`,
      `风格问题章节: ${styleIssues}/${result.snapshots.length}`,
      `结构问题章节: ${structuralIssues}/${result.snapshots.length}`,
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        hasConflicts,
        styleIssues,
        structuralIssues,
        topCategories: topCategory.map(([c, n]) => ({ category: c, count: n })),
        totalChapters: result.snapshots.length,
      }),
    }
  }

  /**
   * 步骤4：执行章节修正 — 批量应用修正结果。
   * 注意：此步骤是标记修正计划，实际修正需要外部调用 PlanFirstCorrectionPipeline。
   */
  private stepExecuteCorrections(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): { success: boolean; summary: string; output?: string } {
    const { chapters, designDoc, styleGuide, chapterStart, chapterEnd } = input

    if (Object.keys(chapters).length === 0) {
      return { success: true, summary: '无章节内容，跳过修正执行' }
    }

    // 生成修正执行清单
    const result = songgeCorrectionAdapter.evaluateChapters({
      chapters,
      designDoc,
      styleGuide,
    })

    if (!result) {
      return { success: false, summary: '评估失败，无法生成修正执行清单' }
    }

    // 构建章节修正执行清单
    const executionPlan = result.snapshots
      .filter((s) => s.needsCorrection)
      .map((s) => {
        const issueItems = s.issues.map((i) => `    - [${i.severity}] ${i.suggestion}`).join('\n')
        return `  📄 第${s.chapterIndex}章（当前评分: ${(s.compositeScore * 100).toFixed(1)}%）\n${issueItems || '    无需单项修正'}`
      })

    const summary = [
      '【章节修正执行清单】',
      '',
      executionPlan.length > 0 ? executionPlan.join('\n\n') : '  所有章节评分合格，无需执行修正',
      '',
      result.chaptersNeedingFix > 0
        ? `共 ${result.chaptersNeedingFix} 个章节需要修正，建议通过 PlanFirstCorrectionPipeline 执行`
        : '所有章节已达到修正标准。',
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        chaptersToFix: result.chaptersNeedingFix,
        totalChapters: result.snapshots.length,
        fixRate: `${result.chaptersNeedingFix}/${result.snapshots.length}`,
        preCorrectionScores: result.snapshots.map((s) => ({
          chapter: s.chapterIndex,
          score: s.compositeScore,
        })),
      }),
    }
  }

  /**
   * 步骤5：创建评估快照 — 记录修正前后的评分基线。
   */
  private stepEvaluateSnapshot(input: {
    chapters: Record<number, string>
    designDoc: string
    styleGuide?: string
    chapterStart: number
    chapterEnd: number
  }): { success: boolean; summary: string; output?: string } {
    const { chapters, designDoc, chapterStart, chapterEnd } = input

    // 若没有章节内容，生成评估计划
    if (Object.keys(chapters).length === 0) {
      const summary = [
        '【评估计划（预估）】',
        `- 目标章节: 第${chapterStart}-${chapterEnd}章`,
        `- 设计文档: ${designDoc ? '已提供' : '未提供'}`,
        `- 评估指标: 设计文档符合度、风格一致性、结构准确性、内容质量、情节连续性`,
        `- 评估周期: 下一轮自进化周期`,
        '- 回滚条件: 如果修正后评分恶化超过基线 20% 则自动回滚',
      ].join('\n')
      return { success: true, summary }
    }

    // 创建修正前基线
    const baselineResult = songgeCorrectionAdapter.evaluateChapters({
      chapters,
      designDoc,
    })

    if (!baselineResult) {
      return { success: false, summary: '评估失败，无法创建修正基线' }
    }

    const scoreSummary = baselineResult.snapshots
      .map((s) => {
        return `  - 第${s.chapterIndex}章: ${(s.compositeScore * 100).toFixed(1)}% (${s.severity})`
      })
      .join('\n')

    const summary = [
      '【修正评估基线】',
      '',
      `修正前整体评分: ${(baselineResult.compositeScore * 100).toFixed(1)}%`,
      `严重程度: ${baselineResult.severity}`,
      `总问题数: ${baselineResult.totalIssues}`,
      '',
      scoreSummary,
      '',
      '【评估计划】',
      '- 下一轮进化周期将对比修正后的评分变化',
      '- 如果修正后评分提高 ≥ 10% 视为有效修正',
      '- 如果评分下降 ≥ 20% 触发自动回滚',
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        baselineScore: baselineResult.compositeScore,
        severity: baselineResult.severity,
        totalIssues: baselineResult.totalIssues,
        chaptersNeedingFix: baselineResult.chaptersNeedingFix,
        timestamp: Date.now(),
      }),
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  辅助方法
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 判断某步骤是否为关键步骤（失败后应停止执行）。
   * 分析设计文档（step 0）、逐章评分（step 1）、执行修正（step 4）为关键步骤。
   */
  private isCriticalStep(step: ReasoningStep): boolean {
    return step.index === 0 || step.index === 1 || step.index === 4
  }

  /**
   * 构建推理链摘要。
   */
  private buildReasoningSummary(
    chain: ReasoningChain,
    stepResults: Array<{ index: number; success: boolean; summary: string; output?: string }>,
  ): string {
    const totalSteps = chain.steps.length
    const succeeded = stepResults.filter((r) => r.success).length
    const icon = chain.allSucceeded ? '✅' : '⚠️'

    const stepLines = chain.steps.map((s) => {
      const result = stepResults.find((r) => r.index === s.index)
      const mark = result?.success ? '[✓]' : s.status === 'skipped' ? '[-]' : '[✗]'
      const dur = s.durationMs ? `(${(s.durationMs / 1000).toFixed(1)}s)` : ''
      return `${mark} ${s.description} ${dur}`
    })

    return [
      `【ASR 引导 Plan:修正工业颂歌19-27章 — ${icon}】`,
      '',
      `标题: ${chain.title}`,
      `进度: ${succeeded}/${totalSteps} 步骤完成`,
      '',
      ...stepLines,
      '',
      chain.allSucceeded ? '推理链全部完成，章节修正方案已就绪。' : `推理链部分完成（${succeeded}/${totalSteps}），请检查失败步骤。`,
      chain.conclusion ? `\n结论: ${chain.conclusion}` : '',
    ].join('\n')
  }

  /**
   * 构建最终结论。
   */
  private buildConclusion(
    chain: ReasoningChain,
    stepResults: Array<{ index: number; success: boolean; summary: string; output?: string }>,
  ): string {
    const succeeded = stepResults.filter((r) => r.success).length
    const total = chain.steps.length

    if (chain.allSucceeded) {
      return `ASR 推理链全部 ${total} 步成功完成。章节修正方案可供 Plan:修正工业颂歌19-27章 执行。评估将在下个周期进行。`
    }

    const failedSteps = stepResults.map((r, i) => ({ ...r, desc: chain.steps[i]?.description || `步骤${i}` })).filter((r) => !r.success)

    const failList = failedSteps.map((f) => `  - ${f.desc}`).join('\n')
    return `推理链 ${succeeded}/${total} 步完成。失败步骤：\n${failList}\n\n建议检查上述步骤的日志以排查原因。`
  }

  /**
   * 从 stepResults 中提取 CorrectionResult。
   */
  private extractCorrectionResult(
    stepResults: Array<{ index: number; success: boolean; summary: string; output?: string }>,
  ): CorrectionResult | undefined {
    const evalStep = stepResults.find((r) => r.index === 1 && r.output)
    if (!evalStep) return undefined

    try {
      const parsed = JSON.parse(evalStep.output!)
      return {
        snapshots: (parsed.snapshots || []).map((s: any) => ({
          chapterIndex: s.chapterIndex,
          scores: s.scores || { designDocMatch: 0, styleConsistency: 0, structuralAccuracy: 0, contentQuality: 0, continuityScore: 0 },
          compositeScore: s.score,
          issues: [],
          severity:
            s.score < 0.4
              ? ('critical' as CorrectionSeverity)
              : s.score < 0.6
                ? ('major' as CorrectionSeverity)
                : s.score < 0.8
                  ? ('minor' as CorrectionSeverity)
                  : ('info' as CorrectionSeverity),
          needsCorrection: s.needsCorrection,
          timestamp: Date.now(),
        })),
        compositeScore: parsed.compositeScore,
        totalIssues: parsed.totalIssues,
        chaptersNeedingFix: parsed.chaptersNeedingFix,
        severity: parsed.severity,
        timestamp: Date.now(),
      }
    } catch {
      return undefined
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  文本分析工具
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 从设计文档中提取关键词。
   */
  private extractKeywords(text: string): string[] {
    const words = text.split(/[\s,，。；;：:、！!？?…—\n()（）【】《》""'']+/).filter((w) => w.length >= 2 && w.length <= 10)
    const unique = [...new Set(words)]
    // 按词频排序取 Top 20
    const freq = new Map<string, number>()
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1)
    }
    return unique.sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0)).slice(0, 20)
  }

  /**
   * 检测设计文档中提示的评分维度。
   */
  private detectDimensionHints(text: string): string[] {
    const hints: string[] = []
    if (/风格|排版|格式|样式/.test(text)) hints.push('风格一致性')
    if (/结构|章节|段落|框架/.test(text)) hints.push('结构准确性')
    if (/内容|质量|文笔|深度/.test(text)) hints.push('内容质量')
    if (/情节|连续|衔接|过渡/.test(text)) hints.push('情节连续性')
    if (/设计|文档|需求|规范/.test(text)) hints.push('设计文档符合度')
    return hints
  }
}

// =============================================================================
// 单例
// =============================================================================

export const songgeReasoningChainExecutor = new SonggeReasoningChainExecutor()
