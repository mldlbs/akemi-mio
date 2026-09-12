/**
 * PiperReasoningChainExecutor — 反 PiperTTS：Piper 推理链执行器
 *
 * ── 反转思路 ──
 *
 * 原架构假设：
 *   a) PiperTTS 是被动故障对象，Evolution 是主动管理器
 *   b) Evolution 拥有复杂的 Plan 状态机 + 中断恢复（实验43）
 *   c) PiperTTS 只有简单的 reset/switch 修复函数
 *   d) Evolution 先决策，PiperTTS 后执行
 *
 * 反转后：
 *   a) PiperTTS 拥有自身的推理链恢复机制
 *   b) 故障恢复是一个可中断 / 可恢复的 Plan-based 过程
 *   c) Evolution 的 fix() 降级为推理链的叶节点操作
 *   d) PiperTTS 自己决定恢复策略，Evolution 提供执行能力
 *
 * ── 架构角色 ──
 *
 * 将 Experiment 43 (AsrReasoningChainExecutor) 的中断恢复流程模式
 * 应用到 PiperTTS 的故障恢复中，使 PiperTTS 也具备：
 *   1. 分步推理链恢复（诊断 → 根因 → 方案 → 验证 → 执行 → 验证）
 *   2. 通过 PlanManager 实现中断可恢复（Plan 持久化）
 *   3. 步骤级幂等性（同一问题不重复执行）
 *   4. 关键步骤失败自动停止
 *
 * ── 与 PiperEvolutionPlugin 的关系 ──
 *
 * PiperEvolutionPlugin.fix() 调用本执行器生成推理链，
 * 而非直接执行 switchModel / reset。本执行器通过 PlanManager
 * 创建持久化 Plan，支持中断恢复。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { piperOrchestrator } from '../PiperOrchestrator'
import { ttsPiperBridge } from '../TtsPiperBridge'
import { evolutionPiperBridge } from '@akemi-mio/evolution-piper-evolution'
import { getPlanManager } from '@akemi-mio/capabilities/tool/deps'
import type {
  PiperReasoningChain,
  PiperReasoningStep,
  PiperReasoningContext,
  PiperStepResult,
  PiperFailureCategory,
  PiperFailureSeverity,
  PiperRecoveryOption,
  PiperChainSummary,
} from './types'

// ═══════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════

/** 推理链计划的标题模板 */
const PLAN_TITLE_PREFIX = '反 PiperTTS: Piper 推理链恢复'

/** 最小推理链步骤数 */
const MIN_CHAIN_STEPS = 4

/** 最大推理链步骤数 */
const MAX_CHAIN_STEPS = 7

/** 幂等缓存 TTL（毫秒），同一问题在 30min 内不重复生成 */
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000

/** 单步执行超时（毫秒） */
const STEP_TIMEOUT_MS = 15_000

/** 默认回退模型 */
const DEFAULT_FALLBACK_MODEL = 'zh_CN-huayan-medium'

/** 轻量模型 */
const LIGHTWEIGHT_MODEL = 'zh_CN-huayan-medium'

// ═══════════════════════════════════════════
//  PiperReasoningChainExecutor
// ═══════════════════════════════════════════

export class PiperReasoningChainExecutor {
  readonly name = 'PiperReasoningChainExecutor'

  /** 当前是否正在执行 */
  private isExecuting = false

  /** 幂等缓存 — 最近已生成推理链的 problem key */
  private recentChains = new Set<string>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  /**
   * 生成并执行 Piper 故障恢复推理链。
   *
   * @param context 推理链执行上下文（由 PiperEvolutionPlugin 传入）
   * @returns 推理链执行摘要
   */
  async execute(context: PiperReasoningContext): Promise<PiperChainSummary> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // ── 幂等性检查 ──
      if (this.recentChains.has(context.problemId)) {
        return {
          totalSteps: 0,
          succeeded: 0,
          allSucceeded: true,
          durationMs: Date.now() - startedAt,
          stepResults: [],
        }
      }

      // ── 1. 生成推理链 ──
      const chain = this.buildReasoningChain(context)

      if (chain.steps.length < MIN_CHAIN_STEPS) {
        return {
          totalSteps: chain.steps.length,
          succeeded: 0,
          allSucceeded: false,
          durationMs: Date.now() - startedAt,
          stepResults: [],
        }
      }

      // ── 2. 通过 PlanManager 创建开发计划（支持中断恢复） ──
      const pm = getPlanManager()
      let planId: string | undefined
      if (pm) {
        try {
          const plan = pm.createPlan(
            `${PLAN_TITLE_PREFIX}: ${chain.title}`,
            chain.steps.map((s) => s.detail).join('\n'),
            chain.steps.map((s) => s.description),
            2, // 高优先级 — 音频故障影响用户体验
          )
          planId = plan.id
          chain.planId = planId
          log('INFO', 'piper_reasoning_chain_plan_created', {
            planId,
            problemId: context.problemId,
            steps: chain.steps.length,
          })
        } catch (err: any) {
          // 计划创建失败（如已达活跃计划上限），改为无计划模式执行
          log('WARN', 'piper_reasoning_chain_plan_failed', {
            problemId: context.problemId,
            error: err.message,
          })
        }
      }

      // ── 3. 逐步执行推理链 ──
      const stepResults: Array<{
        index: number
        description: string
        success: boolean
        durationMs: number
        summary?: string
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
        const stepResult = await this.executeStep(step, context, stepStartedAt)
        const stepDurationMs = Date.now() - stepStartedAt

        step.durationMs = stepDurationMs
        step.status = stepResult.success ? 'completed' : 'failed'
        step.result = stepResult.summary

        stepResults.push({
          index: step.index,
          description: step.description,
          success: stepResult.success,
          durationMs: stepDurationMs,
          summary: stepResult.summary,
          output: stepResult.output,
        })

        // 更新 Plan 步骤完成状态
        if (planId && pm) {
          pm.updateStep(planId, i, stepResult.success ? 'done' : 'failed', stepResult.summary)
        }

        log('INFO', 'piper_reasoning_step_completed', {
          problemId: context.problemId,
          step: step.index,
          stepDesc: step.description,
          success: stepResult.success,
          durationMs: stepDurationMs,
        })

        if (!stepResult.success) {
          allSucceeded = false
          if (step.critical) {
            // 关键步骤失败：停止后续执行
            executionStoppedEarly = true
            for (let j = i + 1; j < chain.steps.length; j++) {
              chain.steps[j].status = 'skipped'
              chain.steps[j].result = '前置关键步骤失败，跳过'
              stepResults.push({
                index: chain.steps[j].index,
                description: chain.steps[j].description,
                success: true,
                durationMs: 0,
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

      // ── 4. 完成 Plan ──
      chain.allSucceeded = allSucceeded
      chain.completedAt = Date.now()
      const conclusion = this.buildConclusion(chain, stepResults)
      chain.conclusion = conclusion

      if (planId && pm) {
        if (allSucceeded) {
          pm.completePlan(planId, conclusion)
        } else if (executionStoppedEarly) {
          pm.freezePlan(
            planId,
            `Piper 推理链中断于步骤 ${stepResults.filter((r) => !r.success).length + 1}/${chain.steps.length}: ${conclusion}`,
          )
        }
      }

      // ── 5. 记录幂等缓存 ──
      this.recentChains.add(context.problemId)
      setTimeout(() => this.recentChains.delete(context.problemId), IDEMPOTENCY_TTL_MS)

      // ── 6. 返回结果 ──
      const durationMs = Date.now() - startedAt
      log('INFO', 'piper_reasoning_chain_completed', {
        problemId: context.problemId,
        planId,
        steps: chain.steps.length,
        succeeded: stepResults.filter((r) => r.success).length,
        allSucceeded,
        durationMs,
      })

      return {
        totalSteps: chain.steps.length,
        succeeded: stepResults.filter((r) => r.success).length,
        allSucceeded,
        planId,
        durationMs,
        stepResults: stepResults.map((r) => ({
          index: r.index,
          description: r.description,
          success: r.success,
          durationMs: r.durationMs,
        })),
      }
    } catch (err: any) {
      log('ERROR', 'piper_reasoning_chain_error', {
        problemId: context.problemId,
        error: String(err),
      })
      return {
        totalSteps: 0,
        succeeded: 0,
        allSucceeded: false,
        durationMs: Date.now() - startedAt,
        stepResults: [],
      }
    } finally {
      this.isExecuting = false
    }
  }

  // ══════════════════════════════════════════
  //  推理链构建
  // ══════════════════════════════════════════

  /**
   * 构建 Piper 故障恢复推理链。
   * 根据故障类型和上下文动态生成步骤序列。
   */
  private buildReasoningChain(context: PiperReasoningContext): PiperReasoningChain {
    const timestamp = Date.now()
    let stepIndex = 0

    const steps: PiperReasoningStep[] = []

    // ── Step 0: 诊断故障模式 ──
    steps.push(
      this.makeStep(
        stepIndex++,
        timestamp,
        true,
        '诊断 Piper 合成故障模式',
        `分析故障信号: 类别="${context.failureCategory}", 当前值=${context.currentValue}, 阈值=${context.threshold}${context.model ? `, 模型="${context.model}"` : ''}`,
      ),
    )

    // ── Step 1: 根因分析 ──
    const rootCauseDetail = this.getRootCauseDetail(context)
    steps.push(this.makeStep(stepIndex++, timestamp, true, '推理合成故障根因', rootCauseDetail))

    // ── Step 2: 生成恢复方案 ──
    const recoveryOptions = this.generateRecoveryOptions(context)
    steps.push(
      this.makeStep(
        stepIndex++,
        timestamp,
        false,
        '生成故障恢复方案',
        recoveryOptions.length > 0
          ? `候选方案: ${recoveryOptions.map((o) => `${o.name}(评分${o.score})`).join(', ')}`
          : '无可用恢复方案，建议人工介入',
      ),
    )

    // ── Step 3: 方案兼容性验证 ──
    const bestOption = recoveryOptions[0]
    if (bestOption) {
      const compatibilityDetail = bestOption.compatible
        ? `"${bestOption.name}" 与当前状态兼容。风险: ${bestOption.risks.join(', ') || '无'}`
        : `"${bestOption.name}" 与当前状态冲突: ${bestOption.risks.join(', ')}`
      steps.push(this.makeStep(stepIndex++, timestamp, true, '验证恢复方案兼容性', compatibilityDetail))
    }

    // ── Step 4: 执行恢复 ──
    if (bestOption && bestOption.compatible) {
      steps.push(this.makeStep(stepIndex++, timestamp, true, '应用故障恢复操作', `执行 "${bestOption.name}": ${bestOption.description}`))
    }

    // ── Step 5: 恢复验证 ──
    steps.push(this.makeStep(stepIndex++, timestamp, false, '验证恢复效果', '重新检查 Piper 状态，确认故障已解除或至少改善'))

    // 根据严重度调整步骤深度
    const trimmed =
      context.severity === 'info'
        ? steps.slice(0, Math.min(steps.length, MIN_CHAIN_STEPS + 1))
        : steps.slice(0, Math.min(steps.length, MAX_CHAIN_STEPS))

    return {
      problemId: context.problemId,
      problemTitle: `${context.failureCategory}: ${context.detail}`,
      title: `Piper ${this.failureCategoryLabel(context.failureCategory)}恢复: ${context.model || '(全局)'}`,
      failureCategory: context.failureCategory,
      severity: context.severity,
      steps: trimmed,
      createdAt: Date.now(),
      allSucceeded: false,
    }
  }

  /**
   * 创建单个推理步骤。
   */
  private makeStep(index: number, timestamp: number, critical: boolean, description: string, detail: string): PiperReasoningStep {
    return {
      id: `prs_${index}_${timestamp}`,
      index,
      description,
      detail,
      status: 'pending',
      critical,
    }
  }

  // ══════════════════════════════════════════
  //  根因分析
  // ══════════════════════════════════════════

  /**
   * 根据故障分类返回根因描述。
   */
  private getRootCauseDetail(context: PiperReasoningContext): string {
    const { failureCategory, model, currentValue, threshold } = context

    const causeMap: Record<PiperFailureCategory, string> = {
      model_failure: `Piper 模型${model ? `"${model}"` : ''}失败率 ${(currentValue * 100).toFixed(1)}%（阈值 ${(threshold * 100).toFixed(0)}%）。根因：模型文件可能损坏或 ONNX 推理异常`,
      high_latency: `Piper 合成平均延迟 ${currentValue}ms（阈值 ${threshold}ms）。根因：系统资源不足或当前模型计算量过大`,
      queue_overload: `Piper 合成队列深度 ${currentValue}（阈值 ${threshold}）。根因：请求涌入过快或前序合成阻塞`,
      fallback_chain: `Piper 模型${model ? `"${model}"` : ''}触发回退 ${currentValue} 次。根因：模型文件缺失或加载失败`,
      model_unavailable: `Piper 模型${model ? `"${model}"` : ''}不可用。根因：模型文件未找到或 Piper 进程异常`,
      degradation: `Piper 整体性能退化：成功率 ${(currentValue * 100).toFixed(1)}%（阈值 ${(threshold * 100).toFixed(0)}%）。根因：可能为累积问题`,
      unknown: `无法明确分类的 Piper 故障。当前值=${currentValue}, 阈值=${threshold}`,
    }

    return causeMap[failureCategory] || causeMap.unknown
  }

  /**
   * 获取故障分类的中文标签。
   */
  private failureCategoryLabel(category: PiperFailureCategory): string {
    const labels: Record<PiperFailureCategory, string> = {
      model_failure: '模型失败',
      high_latency: '高延迟',
      queue_overload: '队列过载',
      fallback_chain: '回退链',
      model_unavailable: '模型不可用',
      degradation: '性能退化',
      unknown: '未知故障',
    }
    return labels[category] || category
  }

  // ══════════════════════════════════════════
  //  恢复方案生成
  // ══════════════════════════════════════════

  /**
   * 根据故障上下文生成候选恢复策略并评分。
   */
  private generateRecoveryOptions(context: PiperReasoningContext): PiperRecoveryOption[] {
    const options: PiperRecoveryOption[] = []

    switch (context.failureCategory) {
      case 'model_failure':
        options.push({
          name: '切换默认模型',
          description: `将 Piper 模型切换为 ${DEFAULT_FALLBACK_MODEL}`,
          score: 85,
          risks: ['当前模型偏好的语音特征将丢失'],
          sideEffects: ['TTS 输出音色变化', '用户可能注意到语音变化'],
          compatible: true,
        })
        options.push({
          name: '重置桥接器统计',
          description: '清空 EvolutionPiperBridge 和 TtsPiperBridge 的统计缓存，让数据重新累积',
          score: 50,
          risks: ['短暂丢失历史数据，恢复策略无历史参考'],
          sideEffects: ['无副作用'],
          compatible: true,
        })
        break

      case 'high_latency':
        options.push({
          name: '切换轻量模型',
          description: `将 Piper 模型切换为轻量模型 ${LIGHTWEIGHT_MODEL}`,
          score: 80,
          risks: ['轻量模型音质可能下降'],
          sideEffects: ['延迟降低但语音自然度下降'],
          compatible: true,
        })
        options.push({
          name: '限制队列深度',
          description: '降低最大队列深度，减少并发压力',
          score: 60,
          risks: ['部分合成请求可能被拒绝'],
          sideEffects: ['用户可能需要等待更久'],
          compatible: true,
        })
        break

      case 'queue_overload':
        options.push({
          name: '重置合成队列',
          description: '清空 Piper 待处理的合成请求队列',
          score: 90,
          risks: ['正在排队的语音请求将丢失'],
          sideEffects: ['突发静音期（队列清空后重建）'],
          compatible: true,
        })
        options.push({
          name: '降低合成优先级',
          description: '通过 EvolutionPiperBridge 建议 Piper 降速',
          score: 40,
          risks: ['可能导致用户响应变慢'],
          sideEffects: ['队列积压缓解但不彻底'],
          compatible: true,
        })
        break

      case 'fallback_chain':
        options.push({
          name: '切换默认模型并重置',
          description: `切换到 ${DEFAULT_FALLBACK_MODEL} 并重置所有统计`,
          score: 85,
          risks: ['丢失模型偏好设置和性能统计数据'],
          sideEffects: ['需要重新收集模型性能基线'],
          compatible: true,
        })
        break

      case 'model_unavailable':
        options.push({
          name: '重试加载默认模型',
          description: `尝试重新加载 ${DEFAULT_FALLBACK_MODEL}`,
          score: 70,
          risks: ['如果模型文件损坏，重试同样会失败'],
          sideEffects: ['短暂等待后恢复'],
          compatible: true,
        })
        break

      case 'degradation':
        options.push({
          name: '综合重置',
          description: '切换到默认模型、重置队列、清空桥接器统计',
          score: 75,
          risks: ['全面重置导致所有临时状态丢失'],
          sideEffects: ['系统和语音引擎进入"冷启动"状态'],
          compatible: true,
        })
        break

      case 'unknown':
      default:
        options.push({
          name: '保守重置',
          description: '重置 PiperOrchestrator 和桥接器',
          score: 30,
          risks: ['可能非根本解决方案'],
          sideEffects: ['临时中断 Piper 合成'],
          compatible: true,
        })
        break
    }

    // 按评分降序排列
    options.sort((a, b) => b.score - a.score)
    return options
  }

  // ══════════════════════════════════════════
  //  步骤执行
  // ══════════════════════════════════════════

  /**
   * 执行推理链中的单一步骤。
   * 根据步骤索引和故障上下文决定具体操作。
   */
  private async executeStep(step: PiperReasoningStep, context: PiperReasoningContext, _startedAt: number): Promise<PiperStepResult> {
    switch (step.index) {
      case 0:
        return this.stepDiagnose(context)
      case 1:
        return this.stepRootCause(context)
      case 2:
        return this.stepGenerateOptions(context)
      case 3:
        return this.stepValidate(context)
      case 4:
        return this.stepExecuteRecovery(context)
      case 5:
        return this.stepVerifyRecovery(context)
      default:
        return { success: true, summary: `步骤 ${step.index} 无操作，已跳过` }
    }
  }

  /**
   * Step 0: 诊断故障模式 — 读取当前 Piper 状态，验证故障信号。
   */
  private stepDiagnose(context: PiperReasoningContext): PiperStepResult {
    const stats = piperOrchestrator.getSynthesisStats()
    const queueStatus = piperOrchestrator.getQueueStatus()
    const bridgeFeedback = ttsPiperBridge.getPiperFeedback()

    const summary = [
      '【诊断结果】',
      `- 故障类别: ${this.failureCategoryLabel(context.failureCategory)}`,
      `- 故障指标: 当前值=${context.currentValue}, 阈值=${context.threshold}`,
      context.model ? `- 涉及模型: "${context.model}"` : '',
      `- 当前模型: ${queueStatus.currentModel || '(空闲)'}`,
      `- 队列深度: ${queueStatus.queueSize}`,
      `- 总合成: ${stats.total.requests}, 成功: ${stats.total.success}, 失败: ${stats.total.failure}`,
      `- 桥接器信息: 平均延迟=${bridgeFeedback.recentLatencyMs}ms, 模型失败=${bridgeFeedback.anyModelFailed}`,
    ]
      .filter(Boolean)
      .join('\n')

    // 验证诊断是否有效
    const hasEnoughData = stats.total.requests >= 3
    if (!hasEnoughData) {
      return {
        success: true,
        summary: `${summary}\n\nⓘ 样本数不足（${stats.total.requests}/3），诊断结果置信度有限`,
      }
    }

    return { success: true, summary }
  }

  /**
   * Step 1: 根因分析 — 根据故障类型判断根本原因。
   */
  private stepRootCause(context: PiperReasoningContext): PiperStepResult {
    const { failureCategory, model, currentValue, threshold } = context
    const queueStatus = piperOrchestrator.getQueueStatus()

    let rootCause: string
    let evidence: string
    let confidence: string

    switch (failureCategory) {
      case 'model_failure':
        rootCause = 'ONNX 模型推理异常'
        evidence = `模型${model ? `"${model}"` : ''}失败率 ${(currentValue * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(0)}%`
        confidence = currentValue > threshold * 1.5 ? '高' : '中'
        break
      case 'high_latency':
        rootCause = '系统资源不足或模型计算量过大'
        evidence = `平均延迟 ${currentValue}ms 超过阈值 ${threshold}ms，当前活跃模型="${queueStatus.currentModel}"`
        confidence = '中'
        break
      case 'queue_overload':
        rootCause = '合成请求涌入过快'
        evidence = `队列深度 ${currentValue} 超过阈值 ${threshold}`
        confidence = '高'
        break
      case 'fallback_chain':
        rootCause = '模型文件缺失或加载失败'
        evidence = `模型回退 ${currentValue} 次，当前活跃模型="${queueStatus.currentModel}"`
        confidence = '高'
        break
      case 'model_unavailable':
        rootCause = 'Piper 进程或模型文件异常'
        evidence = `模型${model ? `"${model}"` : ''}不可用`
        confidence = '高'
        break
      case 'degradation':
        rootCause = '累计问题未解决导致性能螺旋下降'
        evidence = `总失败率 ${(currentValue * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(0)}%`
        confidence = '中'
        break
      default:
        rootCause = '无法确定根因，需更多数据'
        evidence = `当前值=${currentValue}, 阈值=${threshold}`
        confidence = '低'
    }

    const summary = [
      '【根因推理】',
      `- 根因类型: ${rootCause}`,
      `- 证据: ${evidence}`,
      `- 置信度: ${confidence}`,
      `- 故障严重度: ${context.severity}`,
    ].join('\n')

    return { success: true, summary }
  }

  /**
   * Step 2: 生成方案 — 列出候选恢复策略。
   */
  private stepGenerateOptions(context: PiperReasoningContext): PiperStepResult {
    const options = this.generateRecoveryOptions(context)

    if (options.length === 0) {
      return {
        success: false,
        summary: '无法生成恢复方案：未知故障类型或无可用策略',
      }
    }

    const optionLines = options.map((o, i) => {
      const rank = ['A', 'B', 'C'][i] || '?'
      const compat = o.compatible ? '✅' : '⚠️'
      return `【方案${rank}】${o.name} (评分${o.score}) ${compat}\n  ${o.description}\n  风险: ${o.risks.join(', ') || '无'}`
    })

    const summary = [
      '【方案生成】',
      `- 故障: ${this.failureCategoryLabel(context.failureCategory)}`,
      `- 共 ${options.length} 个候选方案:`,
      ...optionLines,
      '',
      `- 推荐方案: ${options[0].name} (评分${options[0].score})`,
    ].join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        optionsCount: options.length,
        recommended: options[0]?.name || '',
        allOptions: options.map((o) => o.name),
      }),
    }
  }

  /**
   * Step 3: 验证兼容性 — 检查推荐方案与当前状态的冲突。
   */
  private stepValidate(context: PiperReasoningContext): PiperStepResult {
    const options = this.generateRecoveryOptions(context)
    const bestOption = options[0]
    if (!bestOption) {
      return { success: true, summary: '无候选方案，跳过兼容性验证' }
    }

    // 检查当前状态
    const queueStatus = piperOrchestrator.getQueueStatus()
    const warnings: string[] = []

    // 检查是否已经使用默认模型
    if (bestOption.name.includes('默认模型') || bestOption.name.includes('轻量模型')) {
      if (queueStatus.currentModel === DEFAULT_FALLBACK_MODEL) {
        warnings.push(`当前已在使用 ${DEFAULT_FALLBACK_MODEL}，切换模型可能无实际效果`)
      }
    }

    // 检查队列是否已经是空的
    if (bestOption.name.includes('重置') && queueStatus.queueSize === 0) {
      warnings.push('队列已为空，重置操作可能无实际效果')
    }

    // 汇总兼容性结论
    const compatLines = [
      `- 推荐方案: "${bestOption.name}"`,
      `- 兼容性: ${bestOption.compatible ? '✅ 兼容' : '⚠️ 不兼容'}`,
      `- 风险评估:`,
      ...bestOption.risks.map((r) => `  • ${r}`),
      ...bestOption.sideEffects.map((s) => `  • ${s}`),
      ...warnings.map((w) => `  • ⓘ ${w}`),
    ]

    const summary = [
      '【兼容性验证】',
      ...compatLines,
      '',
      `- 结论: ${bestOption.compatible ? '方案可行，可以执行' : '方案存在冲突，需选择备选'}`,
    ].join('\n')

    return { success: true, summary }
  }

  /**
   * Step 4: 执行恢复 — 应用选定的恢复策略。
   */
  private async stepExecuteRecovery(context: PiperReasoningContext): Promise<PiperStepResult> {
    const options = this.generateRecoveryOptions(context)
    const bestOption = options[0]

    if (!bestOption || !bestOption.compatible) {
      // 尝试备选方案
      const fallback = options.find((o) => o.compatible)
      if (!fallback) {
        return {
          success: false,
          summary: '无可用兼容恢复方案，故障无法自动修复',
        }
      }

      return this.applyRecovery(fallback, context)
    }

    return this.applyRecovery(bestOption, context)
  }

  /**
   * 应用具体的恢复策略。
   */
  private async applyRecovery(option: PiperRecoveryOption, context: PiperReasoningContext): Promise<PiperStepResult> {
    const recoveryName = option.name
    const executed: string[] = []
    const errors: string[] = []

    switch (recoveryName) {
      case '切换默认模型':
      case '切换轻量模型': {
        const targetModel = recoveryName === '切换轻量模型' ? LIGHTWEIGHT_MODEL : DEFAULT_FALLBACK_MODEL
        const result = piperOrchestrator.switchModel(targetModel)
        if (result.success) {
          executed.push(`模型已切换为 ${targetModel}`)
          // 重置桥接器统计
          ttsPiperBridge.resetStats()
        } else {
          errors.push(`模型切换失败: ${result.message}`)
        }
        break
      }

      case '限制队列深度':
        evolutionPiperBridge.updateConfig({ queueDepthThreshold: Math.max(context.threshold * 0.7, 3) })
        executed.push(`队列深度阈值已从 ${context.threshold} 调整为 ${Math.max(context.threshold * 0.7, 3)}`)
        break

      case '重置合成队列':
        piperOrchestrator.reset()
        executed.push('合成队列已清空')
        break

      case '降低合成优先级':
        evolutionPiperBridge.syncEvolutionState({
          schedulerState: 'analyzing',
          safetyMode: 'auto',
          executeFailures: 0,
          inCooldown: false,
          cooldownRemainingMs: 0,
          userActive: false,
          lastRunAt: Date.now(),
          pipelineQueueSize: context.currentValue,
          timestamp: Date.now(),
        })
        executed.push('已通知 Evolution 桥接器降低 Piper 优先级')
        break

      case '切换默认模型并重置': {
        const modelResult = piperOrchestrator.switchModel(DEFAULT_FALLBACK_MODEL)
        piperOrchestrator.reset()
        ttsPiperBridge.resetStats()
        if (modelResult.success) {
          executed.push(`模型已切换为 ${DEFAULT_FALLBACK_MODEL}，队列已重置，统计已清空`)
        } else {
          errors.push(`模型切换失败: ${modelResult.message}，但队列已重置`)
        }
        break
      }

      case '重试加载默认模型': {
        const retryResult = piperOrchestrator.switchModel(DEFAULT_FALLBACK_MODEL)
        if (retryResult.success) {
          executed.push(`默认模型 ${DEFAULT_FALLBACK_MODEL} 重新加载成功`)
        } else {
          errors.push(`默认模型重新加载失败: ${retryResult.message}`)
        }
        break
      }

      case '综合重置': {
        const modelSwitch = piperOrchestrator.switchModel(DEFAULT_FALLBACK_MODEL)
        piperOrchestrator.reset()
        evolutionPiperBridge.reset()
        ttsPiperBridge.resetStats()
        executed.push(`模型重置 (${modelSwitch.success ? '成功' : '失败'})、队列清空、桥接器统计清空`)
        if (!modelSwitch.success) {
          errors.push(`模型切换失败: ${modelSwitch.message}`)
        }
        break
      }

      case '保守重置':
        piperOrchestrator.reset()
        evolutionPiperBridge.reset()
        executed.push('PiperOrchestrator 和桥接器已重置')
        break

      default:
        return {
          success: false,
          summary: `未知恢复方案: ${recoveryName}`,
        }
    }

    const summary = [
      '【执行恢复】',
      `- 方案: ${recoveryName}`,
      ...executed.map((e) => `  ✅ ${e}`),
      ...errors.map((e) => `  ❌ ${e}`),
      errors.length === 0 ? '- 全部操作成功完成' : `- ${errors.length} 个操作失败`,
    ].join('\n')

    return {
      success: errors.length === 0,
      summary,
      output: JSON.stringify({
        recoveryName,
        executedCount: executed.length,
        errorCount: errors.length,
      }),
    }
  }

  /**
   * Step 5: 验证恢复 — 重新检查 Piper 状态，确认恢复效果。
   */
  private stepVerifyRecovery(_context: PiperReasoningContext): PiperStepResult {
    // 恢复后即刻读取状态验证
    const stats = piperOrchestrator.getSynthesisStats()
    const queueStatus = piperOrchestrator.getQueueStatus()
    const bridgeFeedback = ttsPiperBridge.getPiperFeedback()

    // 构建验证报告
    const checks: Array<{ name: string; passed: boolean; detail: string }> = []

    // 检查 1: 队列正常
    checks.push({
      name: '队列状态',
      passed: queueStatus.queueSize < 5,
      detail: `队列深度 ${queueStatus.queueSize}${queueStatus.queueSize < 5 ? '(正常)' : '(偏高)'}`,
    })

    // 检查 2: 模型可用
    checks.push({
      name: '模型可用性',
      passed: !!queueStatus.currentModel,
      detail: `当前模型: "${queueStatus.currentModel || '无'}"`,
    })

    // 检查 3: 无模型失败标记
    checks.push({
      name: '模型失败状态',
      passed: !bridgeFeedback.anyModelFailed,
      detail: bridgeFeedback.anyModelFailed ? '存在模型失败标记' : '无模型失败',
    })

    // 综合判断
    const passedCount = checks.filter((c) => c.passed).length
    const allPassed = passedCount === checks.length

    const summary = [
      '【恢复验证】',
      ...checks.map((c) => `  ${c.passed ? '✅' : '❌'} ${c.name}: ${c.detail}`),
      '',
      `- 通过 ${passedCount}/${checks.length} 项检查`,
      allPassed ? '- ✅ Piper 已恢复正常运行' : '- ⚠️ 部分检查未通过，建议持续监控',
    ].join('\n')

    return { success: allPassed, summary }
  }

  // ══════════════════════════════════════════
  //  辅助方法
  // ══════════════════════════════════════════

  /**
   * 构建推理链最终结论。
   */
  private buildConclusion(
    chain: PiperReasoningChain,
    stepResults: Array<{ index: number; description: string; success: boolean; durationMs: number }>,
  ): string {
    const succeeded = stepResults.filter((r) => r.success).length
    const total = chain.steps.length

    if (chain.allSucceeded) {
      const totalDuration = stepResults.reduce((s, r) => s + r.durationMs, 0)
      return `Piper 推理链全部 ${total} 步成功完成（总耗时 ${(totalDuration / 1000).toFixed(1)}s）。故障恢复已应用，Piper 合成引擎应已恢复正常。`
    }

    const failedSteps = stepResults
      .filter((r) => !r.success)
      .map((r) => `  - ${r.description}`)
      .join('\n')

    return `Piper 推理链 ${succeeded}/${total} 步完成。失败步骤:\n${failedSteps}\n\n建议检查失败步骤对应的系统状态，或手动重启 Piper 引擎。`
  }

  /**
   * 清空幂等缓存（供测试用）。
   */
  clearIdempotencyCache(): void {
    this.recentChains.clear()
  }
}

// ════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════

/** 全局单例，供 PiperEvolutionPlugin 使用 */
export const piperReasoningChainExecutor = new PiperReasoningChainExecutor()
