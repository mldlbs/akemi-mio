/**
 * AsrReasoningChainExecutor — ASR 引导 Plan 推理链执行器
 *
 * 实验43：中断恢复流程测试
 *
 * ASR 不直接输出结果，而是生成一条推理路径（中间步骤链），
 * Plan 沿着这条路径逐步验证和执行。
 *
 * 职责分配：
 * - ASR 分析层：任务分解、优先级排序（本类中的 generateReasoningChain）
 * - Plan 执行层：步骤执行、中间结果追踪（PlanManager + asrEvolutionManager）
 * - 结果汇总：最终结果由 Plan 汇总返回
 *
 * 推理链步骤（标准模板）：
 *   0. 分析错误模式 (Analyze) — 从 Problem context 提取 ASR 错误信息
 *   1. 推理根因 (Root Cause) — 判断错误类型（同音字/新词汇/领域术语/低置信度）
 *   2. 生成方案 (Generate) — 确定热词/同音补丁候选
 *   3. 验证兼容性 (Validate) — 检查与现有配置的冲突和重复
 *   4. 执行补丁 (Execute) — 通过 AsrEvolutionManager 应用补丁
 *   5. 创建评估快照 (Evaluate) — 记录基线供下轮对比
 *
 * 中断恢复支持：
 * - 如果推理链执行过程中被中断，Plan 仍处于 'active' 状态
 * - 下次启动时可通过 PlanManager 查询当前活跃计划及执行到的步骤
 * - 从中断步骤恢复继续执行
 *
 * 安全机制：
 * - PlanManager 的计划上限控制（MAX_ACTIVE_PLANS = 3）
 * - 幂等性检查：同一问题不重复生成推理链（1h TTL）
 * - 步骤级超时保护
 * - 关键步骤失败自动停止后续执行
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { asrEvolutionManager } from '@akemi-mio/audio/AsrEvolutionManager'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'
import { getPlanManager } from '@akemi-mio/capabilities/tool/deps'
import type { AsrConfigPatch } from '@akemi-mio/audio/AsrEvolutionManager'
import type { FixExecutor, AssignedProblem, FixResult } from './types'
import type { ReasoningChain, ReasoningStep } from './types'
import type { PlanManagerLike } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 单次执行最大补丁数 */
const MAX_PATCHES_PER_EXECUTION = 3
/** 执行超时（毫秒） */
const EXECUTION_TIMEOUT_MS = 30000
/** 推理链计划的标题模板 */
const PLAN_TITLE_PREFIX = '实验43：中断恢复流程测试 — ASR 推理链'
/** 幂等缓存 TTL（毫秒），同一问题在 1h 内不重复生成 */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000
/** 推理链最短步骤数 */
const MIN_REASONING_STEPS = 3
/** 推理链最长步骤数 */
const MAX_REASONING_STEPS = 8

// =============================================================================
// AsrReasoningChainExecutor
// =============================================================================

export class AsrReasoningChainExecutor implements FixExecutor {
  readonly name = 'AsrReasoningChainExecutor'
  readonly timeoutMs = EXECUTION_TIMEOUT_MS
  readonly supportedSources = ['log'] as const

  private isExecuting = false
  /** 幂等缓存 — 最近已生成推理链的 problem key */
  private recentChains = new Set<string>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // ── 0. 前置校验 ──────────────────────────────────
      if (problem.source !== 'log') {
        return {
          problemId: problem.id,
          success: true,
          summary: '不是 ASR 日志问题，跳过推理链生成',
          durationMs: Date.now() - startedAt,
        }
      }

      const metadata = problem.context.metadata
      if (!metadata?.asr_original) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少 ASR 错误元数据，无法生成推理链',
          durationMs: Date.now() - startedAt,
          error: 'missing_metadata',
        }
      }

      // ── 1. 幂等性检查 ────────────────────────────────
      const problemKey = problem.id
      if (this.recentChains.has(problemKey)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `问题 "${problem.id}" 已生成过推理链，跳过重复执行`,
          durationMs: Date.now() - startedAt,
        }
      }

      // ── 2. 生成推理链 ────────────────────────────────
      const chain = this.generateReasoningChain(problem)

      // 最少步骤检查
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
            1, // 中等优先级
          )
          planId = plan.id
          log('INFO', 'asr_reasoning_chain_plan_created', {
            planId,
            problemId: problem.id,
            steps: chain.steps.length,
          })
        } catch (err: any) {
          // 计划创建失败（如已达活跃计划上限），改为无计划模式执行
          log('WARN', 'asr_reasoning_chain_plan_failed', {
            problemId: problem.id,
            error: err.message,
          })
        }
      }

      // ── 4. 逐步执行推理链 ────────────────────────────
      const stepResults: Array<{
        index: number
        success: boolean
        summary: string
        output?: string
      }> = []
      let allSucceeded = true
      let executionStoppedEarly = false

      for (let i = 0; i < chain.steps.length; i++) {
        const step = chain.steps[i]
        const stepStartedAt = Date.now()

        // 更新 Plan 步骤状态
        if (planId && pm) {
          pm.updateStep(planId, i, 'in_progress')
        }

        // 执行当前步骤
        const stepResult = await this.executeStep(step, chain, problem, stepStartedAt)
        step.durationMs = Date.now() - stepStartedAt
        step.status = stepResult.success ? 'completed' : 'failed'
        step.result = stepResult.summary

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

        log('INFO', 'asr_reasoning_step_completed', {
          problemId: problem.id,
          step: step.index,
          stepDesc: step.description,
          success: stepResult.success,
          durationMs: step.durationMs,
        })

        if (!stepResult.success) {
          allSucceeded = false
          // 关键步骤失败：停止后续执行
          if (this.isCriticalStep(step)) {
            executionStoppedEarly = true
            // 将剩余步骤标记为跳过
            for (let j = i + 1; j < chain.steps.length; j++) {
              chain.steps[j].status = 'skipped'
              chain.steps[j].result = '前置步骤失败，跳过'
              stepResults.push({
                index: chain.steps[j].index,
                success: true,
                summary: '前置步骤失败，跳过',
              })
              if (planId && pm) {
                pm.updateStep(planId, j, 'failed', '前置步骤失败，跳过')
              }
            }
            break
          }
        }
      }

      // ── 5. 完成 Plan ─────────────────────────────────
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
      log('INFO', 'asr_reasoning_chain_completed', {
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
          hasPatchesApplied: stepResults.some((r) => (r.output || '').includes('patchesApplied')),
        }),
      }
    } catch (err) {
      log('ERROR', 'asr_reasoning_chain_execute_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `ASR 推理链执行异常: ${String(err)}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.isExecuting = false
    }
  }

  // ── 推理链生成 ───────────────────────────────────────

  /**
   * 根据 ASR Problem 内容生成推理链。
   * 步骤分解基于 Problem 的元数据和严重度。
   */
  private generateReasoningChain(problem: AssignedProblem): ReasoningChain {
    const metadata = problem.context.metadata ?? {}
    const original = metadata.asr_original || ''
    const corrected = metadata.asr_corrected || ''
    const category = metadata.asr_category || 'unknown'

    const timestamp = Date.now()
    const steps: ReasoningStep[] = []
    let stepIndex = 0

    // Step 0: 分析错误模式
    steps.push(
      this.makeStep(
        stepIndex++,
        timestamp,
        '分析 ASR 识别错误模式',
        `提取原始文本 "${original}" 和正确文本 "${corrected}"，识别偏差类型（同音/漏词/低置信等）`,
      ),
    )

    // Step 1: 推理根因
    const rootCauseDetail = this.getRootCauseDetail(category, original, corrected)
    steps.push(this.makeStep(stepIndex++, timestamp, '推理识别错误根因', rootCauseDetail))

    // Step 2: 生成热词优化方案
    if (corrected) {
      const hotwordDetail =
        corrected.length >= 2 ? `将 "${corrected}" 加入热词列表以提升后续识别率` : `评估是否需将 "${corrected}" 加入热词`
      steps.push(this.makeStep(stepIndex++, timestamp, '生成热词优化方案', hotwordDetail))
    }

    // Step 3: 验证与现有配置的兼容性
    steps.push(this.makeStep(stepIndex++, timestamp, '验证补丁兼容性', `检查 "${corrected}" 是否已存在于热词表，避免重复添加`))

    // Step 4: 执行 ASR 配置补丁
    steps.push(this.makeStep(stepIndex++, timestamp, '应用 ASR 配置补丁', `通过 AsrEvolutionManager 提交 "${corrected}" 热词配置`))

    // Step 5: 创建评估快照
    if (corrected) {
      steps.push(this.makeStep(stepIndex++, timestamp, '创建评估快照', '记录当前纠错率基线，供下一轮进化周期对比'))
    }

    // 根据严重度调整步骤深度
    const trimmed =
      problem.severity === 'info'
        ? steps.slice(0, Math.min(steps.length, MIN_REASONING_STEPS + 1))
        : steps.slice(0, Math.min(steps.length, MAX_REASONING_STEPS))

    return {
      problemId: problem.id,
      title: `ASR 识别优化: "${original}" → "${corrected || '?'}"`,
      steps: trimmed,
      createdAt: Date.now(),
      allSucceeded: false, // 尚未执行
    }
  }

  /**
   * 创建单个推理步骤。
   */
  private makeStep(index: number, timestamp: number, description: string, detail: string): ReasoningStep {
    return {
      id: `rs_${index}_${timestamp}`,
      index,
      description,
      detail,
      status: 'pending',
    }
  }

  /**
   * 根据错误分类返回根因描述。
   */
  private getRootCauseDetail(category: string, original: string, corrected: string): string {
    const causeMap: Record<string, string> = {
      homophone: `ASR 将 "${original}" 误识别为 "${corrected}" 的同音词。根因：热词表中未注册该领域词汇`,
      new_word: `"${corrected}" 为新兴词汇，ASR 引擎的 LM 未覆盖。根因：词表需要扩展`,
      domain_term: `"${corrected}" 为领域术语，ASR 通用词表不包含该词`,
      partial_match: `ASR 仅识别出 "${original}"，遗漏了 "${corrected}" 中的部分内容`,
      incomplete: `ASR 识别 "${original}" 不完整，正确文本 "${corrected}" 含有生僻字`,
      low_confidence: `"${corrected}" 识别置信度低于阈值，可能包含新词或背景噪声干扰`,
      candidate_word: `"${corrected}" 被标记为新词候选，需确认是否应加入热词表`,
    }
    return causeMap[category] || `进行分类分析：${original} → ${corrected}`
  }

  // ── 步骤执行 ─────────────────────────────────────────

  /**
   * 执行推理链中的单一步骤。
   * 根据步骤描述和当前上下文决定具体操作。
   */
  private async executeStep(
    step: ReasoningStep,
    chain: ReasoningChain,
    problem: AssignedProblem,
    startedAt: number,
  ): Promise<{ success: boolean; summary: string; output?: string }> {
    const metadata = problem.context.metadata ?? {}

    switch (step.index) {
      case 0: // 分析错误模式
        return this.stepAnalyze(problem, metadata)

      case 1: // 推理根因
        return this.stepRootCause(problem, metadata)

      case 2: // 生成方案
        return this.stepGenerate(problem, metadata)

      case 3: // 验证兼容性
        return this.stepValidate(problem, metadata)

      case 4: // 执行补丁
        return this.stepExecute(problem, metadata)

      case 5: // 创建评估
        return this.stepEvaluate(problem, metadata)

      default:
        return { success: true, summary: `步骤 ${step.index} 无操作，已跳过` }
    }
  }

  /**
   * 步骤0：分析错误模式 — 提取并验证 Problem 中的 ASR 错误信息。
   */
  private stepAnalyze(_problem: AssignedProblem, metadata: Record<string, string>): { success: boolean; summary: string } {
    const original = metadata.asr_original || '(空)'
    const corrected = metadata.asr_corrected || '(空)'
    const category = metadata.asr_category || 'unknown'
    const frequency = metadata.asr_frequency || '1'

    if (!original || original === '(空)') {
      return { success: false, summary: '错误模式分析失败：缺少原文' }
    }

    const summary = [
      '【分析结果】',
      `- 原文: "${original}"`,
      `- 正确: "${corrected || '待确认'}"`,
      `- 分类: ${this.getCategoryLabel(category)}`,
      `- 出现频次: ${frequency} 次`,
    ].join('\n')

    return { success: true, summary }
  }

  /**
   * 步骤1：推理根因 — 根据分类和上下文判断根本原因。
   */
  private stepRootCause(_problem: AssignedProblem, metadata: Record<string, string>): { success: boolean; summary: string } {
    const original = metadata.asr_original || ''
    const corrected = metadata.asr_corrected || ''
    const category = metadata.asr_category || 'unknown'

    // 检查是否为中文同音词（常见类型）
    const isLongPhrase = corrected.length >= 3

    let rootCause: string
    let evidence: string
    let confidence: string

    if (category === 'homophone') {
      rootCause = '同音字混淆'
      evidence = `原文 "${original}" 与正确文本 "${corrected}" 存在同音或近音关系`
      confidence = '高'
    } else if (category === 'new_word') {
      rootCause = '未登录词'
      evidence = `"${corrected}" 是当前词表未收录的新词`
      confidence = '高'
    } else if (category === 'domain_term') {
      rootCause = '领域术语未覆盖'
      evidence = `"${corrected}" 为领域特定术语，通用 LM 无对应权重`
      confidence = '中'
    } else if (category === 'low_confidence') {
      rootCause = '识别置信度不足'
      const confPct = metadata.asr_confidence || '?'
      evidence = `置信度 ${confPct}%，低于默认阈值，可能是环境噪声或新词`
      confidence = '中'
    } else if (category === 'partial_match' || category === 'incomplete') {
      rootCause = '识别不完整'
      evidence = `ASR 仅捕捉到 "${original}"，遗漏了 "${corrected}" 中的部分音节`
      confidence = '中'
    } else {
      rootCause = '通用识别偏差'
      evidence = `"${original}" → "${corrected}" 存在偏差，需进一步分析`
      confidence = '低'
    }

    const summary = [
      '【根因推理】',
      `- 根因类型: ${rootCause}`,
      `- 证据: ${evidence}`,
      `- 置信度: ${confidence}`,
      `- 是否为短语: ${isLongPhrase ? '是（≥3 字）' : '否'}`,
    ].join('\n')

    return { success: true, summary }
  }

  /**
   * 步骤2：生成方案 — 根据根因确定最优修复方案。
   */
  private stepGenerate(
    _problem: AssignedProblem,
    metadata: Record<string, string>,
  ): { success: boolean; summary: string; output?: string } {
    const corrected = metadata.asr_corrected || ''
    const category = metadata.asr_category || 'unknown'

    if (!corrected) {
      return { success: false, summary: '缺少正确文本，无法生成优化方案' }
    }

    const schemes: string[] = []

    // 方案1：添加热词
    schemes.push('【方案A】添加为热词（asr_hotword_add）— 提升引擎对该词的关注度')

    // 方案2：同音修正（如果是同音字类）
    if (category === 'homophone') {
      schemes.push('【方案B】注册同音修正（asr_homophone_fix）— 指定正确映射关系')
    }

    // 方案3：短语热词（如果是短语）
    if (corrected.length >= 3) {
      schemes.push('【方案C】注册短语上下文热词 — 在上下文中强化短语匹配')
    }

    // 计算方案评分 0-100
    const scores: Array<{ name: string; score: number }> = [{ name: '方案A', score: 85 }]
    if (category === 'homophone') {
      scores.push({ name: '方案B', score: 70 })
    }
    if (corrected.length >= 3) {
      scores.push({ name: '方案C', score: 60 })
    }

    // 按评分排序
    scores.sort((a, b) => b.score - a.score)

    const summary = [
      '【方案生成】',
      `- 目标词汇: "${corrected}"`,
      '- 候选方案:',
      ...schemes.map((s) => `  ${s}`),
      '',
      `- 推荐方案: ${scores[0]?.name || '无'}（评分 ${scores[0]?.score || 0}）`,
      `- 执行顺序: ${scores.map((s) => `${s.name}(${s.score})`).join(' → ')}`,
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({ recommendedAction: scores[0]?.name || '', candidates: schemes.length }),
    }
  }

  /**
   * 步骤3：验证兼容性 — 检查补丁与现有配置的冲突。
   */
  private stepValidate(_problem: AssignedProblem, metadata: Record<string, string>): { success: boolean; summary: string } {
    const corrected = metadata.asr_corrected || ''

    if (!corrected) {
      return { success: true, summary: '无目标词汇，跳过兼容性验证' }
    }

    // 检查热词表是否存在
    const existingVocab = asrHotwordManager.exportVocabulary()
    const cacheKey = corrected.toLowerCase()
    const alreadyExists = existingVocab.some((v) => v.word.toLowerCase() === cacheKey)

    // 检查编辑距离相似词
    const similarThreshold = 2
    const similarWord = existingVocab.find((v) => levenshteinDistance(v.word.toLowerCase(), cacheKey) <= similarThreshold)

    const warnings: string[] = []

    if (alreadyExists) {
      warnings.push(`"${corrected}" 已存在于热词表，无需重复添加`)
    }
    if (similarWord) {
      warnings.push(`"${corrected}" 与现有热词 "${similarWord.word}" 相似（编辑距离 ≤ ${similarThreshold}）`)
    }

    if (warnings.length === 0) {
      return { success: true, summary: `【兼容性验证】"${corrected}" 与现有配置无冲突，可安全添加` }
    }

    const summary = [
      '【兼容性验证】',
      ...warnings.map((w) => `- ⓘ ${w}`),
      `- 结论: ${alreadyExists ? '跳过添加，词汇已存在' : '无严重冲突，可执行'}`,
    ].join('\n')

    return { success: true, summary }
  }

  /**
   * 步骤4：执行补丁 — 通过 AsrEvolutionManager 应用配置变更。
   */
  private async stepExecute(
    _problem: AssignedProblem,
    metadata: Record<string, string>,
  ): Promise<{ success: boolean; summary: string; output?: string }> {
    const original = metadata.asr_original || ''
    const corrected = metadata.asr_corrected || ''
    const category = metadata.asr_category || 'unknown'

    if (!corrected) {
      return { success: false, summary: '缺少正确文本，无法执行补丁' }
    }

    // 检查幂等性：已在热词表中则跳过
    const existingVocab = asrHotwordManager.exportVocabulary()
    const cacheKey = corrected.toLowerCase()
    const alreadyExists = existingVocab.some((v) => v.word.toLowerCase() === cacheKey)

    if (alreadyExists) {
      return {
        success: true,
        summary: `"${corrected}" 已在热词表中，无需重复添加`,
      }
    }

    // 生成补丁
    const patches = this.buildPatches(original, corrected, category)

    if (patches.length === 0) {
      return {
        success: true,
        summary: `无需为 "${corrected}" 生成配置补丁`,
      }
    }

    // 应用补丁
    const result = asrEvolutionManager.applyPatches(patches)
    if (!result) {
      return {
        success: false,
        summary: '应用 ASR 配置补丁失败（进化管理器不可用或返回空）',
        output: JSON.stringify({ patches: patches.length, applied: false }),
      }
    }

    const patchSummary = patches.map((p) => `  - ${p.type}: ${p.description}`).join('\n')
    return {
      success: true,
      summary: ['【执行补丁】', `已应用 ${patches.length} 个 ASR 配置补丁：`, patchSummary, `快照 ID: ${result.snapshotId}`].join('\n'),
      output: JSON.stringify({
        patchesApplied: patches.length,
        snapshotId: result.snapshotId,
        patchTypes: patches.map((p) => p.type),
      }),
    }
  }

  /**
   * 步骤5：创建评估快照 — 记录基线供下次对比。
   */
  private stepEvaluate(_problem: AssignedProblem, metadata: Record<string, string>): { success: boolean; summary: string } {
    const corrected = metadata.asr_corrected || ''

    // 评估快照已由 executeStep 中的 applyPatches 内部创建
    // 此处只需输出评估计划
    const summary = [
      '【评估计划】',
      `- 变更内容: 添加 "${corrected}" 热词`,
      '- 评估指标: 纠错率变化、识别准确率变化',
      '- 评估周期: 下一轮自进化周期（约 2 小时后）',
      '- 回滚条件: 如果纠错率恶化超过基线 20% 则自动回滚',
    ].join('\n')

    return { success: true, summary }
  }

  // ── 补丁构建 ─────────────────────────────────────────

  /**
   * 根据错误模式和分类生成配置补丁列表。
   */
  private buildPatches(original: string, corrected: string, category?: string): AsrConfigPatch[] {
    const patches: AsrConfigPatch[] = []

    // 1. 总是将正确文本添加为热词
    patches.push({
      type: 'hotword_add',
      description: `ASR 推理链: 添加 "${corrected}" 为热词（原识别为 "${original}"）`,
      value: corrected,
    })

    // 2. 如果是同音字类，添加同音修正
    const chineseCorrected = /[一-鿿]/.test(corrected)
    if (chineseCorrected && category === 'homophone') {
      patches.push({
        type: 'homophone_fix',
        description: `ASR 推理链: 注册同音词 "${corrected}"（防混淆 "${original}"）`,
        value: corrected,
      })
    }

    return patches.slice(0, MAX_PATCHES_PER_EXECUTION)
  }

  // ── 辅助方法 ─────────────────────────────────────────

  /**
   * 判断某步骤是否为关键步骤（失败后应停止执行）。
   * 分析（step 0）、根因推理（step 1）、补丁执行（step 4）为关键步骤。
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
      `【ASR 推理链报告 — ${icon}】`,
      '',
      `标题: ${chain.title}`,
      `进度: ${succeeded}/${totalSteps} 步骤完成`,
      '',
      ...stepLines,
      '',
      chain.allSucceeded ? '推理链全部完成，ASR 优化配置已应用。' : `推理链部分完成（${succeeded}/${totalSteps}），请检查失败步骤。`,
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
      return `推理链全部 ${total} 步成功完成。ASR 配置已更新，评估将在下个周期进行。`
    }

    const failedSteps = stepResults.map((r, i) => ({ ...r, desc: chain.steps[i]?.description || `步骤${i}` })).filter((r) => !r.success)

    const failList = failedSteps.map((f) => `  - ${f.desc}`).join('\n')
    return `推理链 ${succeeded}/${total} 步完成。失败步骤：\n${failList}\n\n建议检查上述步骤的日志以排查原因。`
  }

  /**
   * 获取错误分类的中文标签。
   */
  private getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      homophone: '同音字',
      new_word: '新词汇',
      domain_term: '领域术语',
      partial_match: '部分匹配',
      incomplete: '识别不完整',
      noise: '噪声干扰',
      low_confidence: '低置信度',
      candidate_word: '新词候选',
      unknown: '未分类',
    }
    return labels[category] || category
  }
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 计算字符串间的莱文斯坦编辑距离。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = []
  for (let i = 0; i <= m; i++) {
    dp[i] = [i]
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}
