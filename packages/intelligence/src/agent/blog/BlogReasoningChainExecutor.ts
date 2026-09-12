/**
 * BlogReasoningChainExecutor — PiperTTS 引导 Plan:推理链: 博客写作到发布工作流
 *
 * ── 设计哲学 ──
 *
 * 本执行器将 PiperTTS 模式（推理链规划 → 分步执行 → 聚合结果）应用到
 *「为项目的技术博客内容设计一套从写作到发布的完整工作流」这一场景。
 *
 * 职责分配（PiperTTS 模式）：
 * - PiperTTS 分析层：博客任务分解、优先级排序（本类中的 generateReasoningChain）
 * - Plan 执行层：步骤执行、中间结果追踪（PlanManager + BlogAgentService）
 * - 结果汇总：最终博客内容由 Plan 汇总返回
 *
 * ── 与其他推理链执行器的关系 ──
 *
 * 现有推理链执行器：
 *   AsrReasoningChainExecutor    — ASR 识别错误修复
 *   SonggeReasoningChainExecutor — 工业颂歌章节修正
 *   PiperReasoningChainExecutor  — TTS 合成故障恢复
 *
 * 本执行器（BlogReasoningChainExecutor）扩展同一模式到博客写作领域：
 *   步骤由 BlogStage 枚举定义：
 *     0. 主题与意图分析 (Intent Analysis)
 *     1. 素材收集 (Material Collection)
 *     2. 大纲生成 (Outline)
 *     3. 初稿生成 (Draft Writing)
 *     4. 质量审核与安全审查 (Quality Review + Security Review)
 *     5. 终稿润色 (Final Polish)
 *     6. 发布规划 (Publishing Plan)
 *
 * ── 中断恢复支持 ──
 *
 * - 通过 PlanManager 创建持久化 Plan，支持中断后恢复
 * - 步骤状态持久化（pending → in_progress → completed/failed/skipped）
 * - 幂等性缓存：同一会话不重复生成推理链
 * - 关键步骤失败自动停止后续执行
 * - 累积误差检测：多轮润色中跟踪评分偏移
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getPlanManager } from '@akemi-mio/capabilities/tool/deps'
import { planBlogWritingAdapter } from './PlanBlogWritingAdapter'
import { blogSecurityReviewer } from './BlogSecurityReviewer'
import { blogAgentService } from './BlogAgentService'
import { evolutionConsumerBridge } from '@akemi-mio/evolution-consumer'
import { BlogStage, BLOG_STAGE_LABELS, BLOG_STAGE_ORDER, type SecurityReviewReport } from './types'
import type { BlogAssessmentInput, BlogAssessmentResult } from './PlanBlogWritingAdapter'
import type { ReasoningStepStatus } from '@akemi-mio/evolution/automation/types'

// =============================================================================
// 博客推理链专用类型
// =============================================================================

/** 博客推理链执行上下文 */
export interface BlogReasoningContext {
  /** 会话 ID（关联 BlogAgentService 的会话） */
  sessionId: string
  /** 博客主题 / 标题 */
  topic: string
  /** 目标发布平台 */
  targetPlatform?: string
  /** 目标受众描述 */
  targetAudience?: string
  /** 文章风格偏好 */
  style?: string
  /** 用户提供的初始内容 / 笔记 */
  initialContent?: string
  /** 用户提供的额外上下文 */
  userContext?: string
  /** 需要从某个阶段开始（默认从第 0 步） */
  startFromStep?: number
  /** 是否启用安全审查 */
  enableSecurityReview?: boolean
  /** 是否启用发布后数据分析 */
  enablePostAnalytics?: boolean
  /** 附加元数据 */
  metadata?: Record<string, string>
}

/** 博客推理链 */
export interface BlogReasoningChain {
  /** 关联的会话 ID */
  sessionId: string
  /** 推理链标题 */
  title: string
  /** 博客主题 */
  topic: string
  /** 目标平台 */
  targetPlatform?: string
  /** 步骤列表（按 BlogStage 顺序） */
  steps: BlogReasoningStep[]
  /** 创建时间戳 */
  createdAt: number
  /** 完成时间戳 */
  completedAt?: number
  /** 是否所有步骤成功 */
  allSucceeded: boolean
  /** 最终输出内容（博客正文） */
  finalContent?: string
  /** 最终结论摘要 */
  conclusion?: string
  /** 关联的 Plan ID */
  planId?: string
}

/** 博客推理链中的单个步骤 */
export interface BlogReasoningStep {
  /** 步骤标识 (格式: brs_{index}_{timestamp}) */
  id: string
  /** 步骤序号（从 0 开始） */
  index: number
  /** 对应的 BlogStage */
  stage: BlogStage
  /** 步骤的中文标签 */
  label: string
  /** 步骤描述 */
  description: string
  /** 步骤详细说明 */
  detail?: string
  /** 当前状态 */
  status: ReasoningStepStatus
  /** 执行结果文本 */
  result?: string
  /** 执行耗时（毫秒） */
  durationMs?: number
  /** 该步骤的输出产物 */
  output?: string
  /** 是否关键步骤（失败后停止后续执行） */
  critical: boolean
  /** 该步骤的质量评估结果 */
  assessment?: BlogAssessmentResult
  /** 该步骤的安全审查报告 */
  securityReport?: SecurityReviewReport
}

/** 单步执行结果 */
export interface BlogStepResult {
  success: boolean
  summary: string
  output?: string
  assessment?: BlogAssessmentResult
  securityReport?: SecurityReviewReport
}

/** 推理链执行结果摘要 */
export interface BlogChainSummary {
  totalSteps: number
  succeeded: number
  allSucceeded: boolean
  planId?: string
  durationMs: number
  finalContent?: string
  publishPlan?: {
    platform: string
    scheduledPublish: boolean
    tags: string[]
    summary: string
  }
  stepResults: Array<{
    index: number
    stage: BlogStage
    description: string
    success: boolean
    durationMs: number
  }>
}

// =============================================================================
// 配置常量
// =============================================================================

/** 推理链计划的标题模板 */
const PLAN_TITLE_PREFIX = 'PiperTTS 引导 Plan:博客写作到发布工作流'

/** 最小推理链步骤数 */
const MIN_CHAIN_STEPS = 4

/** 最大推理链步骤数 */
const MAX_CHAIN_STEPS = BLOG_STAGE_ORDER.length // 7 个阶段

/** 幂等缓存 TTL（毫秒），同一会话在 1h 内不重复生成 */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000

/** 单步执行超时（毫秒） */
const STEP_TIMEOUT_MS = 60_000

/** 累积误差检测阈值：连续两步内容评分差异超过此值视为异常 */
const ACCUMULATED_ERROR_THRESHOLD = 0.2

/** 发布就绪评分阈值 */
const PUBLISH_READY_SCORE = 0.72

// =============================================================================
// BlogReasoningChainExecutor
// =============================================================================

export class BlogReasoningChainExecutor {
  readonly name = 'BlogReasoningChainExecutor'

  /** 当前是否正在执行 */
  private isExecuting = false

  /** 幂等缓存 — 最近已生成推理链的会话 key */
  private recentChains = new Set<string>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  /**
   * 生成并执行博客写作推理链。
   *
   * @param context 博客推理链执行上下文
   * @returns 推理链执行摘要
   */
  async execute(context: BlogReasoningContext): Promise<BlogChainSummary> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // ── 幂等性检查 ──
      if (this.recentChains.has(context.sessionId)) {
        return {
          totalSteps: 0,
          succeeded: 0,
          allSucceeded: true,
          durationMs: Date.now() - startedAt,
          stepResults: [],
        }
      }

      // ── 1. 生成推理链 ──
      const chain = this.generateReasoningChain(context)

      // ★ Evolution 消费者上下文注入
      // 从 EvolutionConsumerBridge 获取博客消费者上下文，
      // 在推理链中注入已知问题列表和管道状态，
      // 使博客写作流程能感知当前系统的健康度和改进方向。
      this.enrichChainWithEvolutionContext(chain, context)

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
            chain.steps.map((s) => `${s.label}: ${s.detail}`).join('\n'),
            chain.steps.map((s) => s.description),
            2, // 高优先级 — 博客写作涉及内容产出
          )
          planId = plan.id
          chain.planId = planId
          log('INFO', 'blog_reasoning_chain_plan_created', {
            planId,
            sessionId: context.sessionId,
            topic: context.topic.slice(0, 40),
            steps: chain.steps.length,
          })
        } catch (err: any) {
          log('WARN', 'blog_reasoning_chain_plan_failed', {
            sessionId: context.sessionId,
            error: err.message,
          })
        }
      }

      // ── 3. 逐步执行推理链 ──
      const stepResults: Array<{
        index: number
        stage: BlogStage
        description: string
        success: boolean
        durationMs: number
        summary?: string
        output?: string
        assessment?: BlogAssessmentResult
        securityReport?: SecurityReviewReport
      }> = []

      let allSucceeded = true
      let executionStoppedEarly = false
      let prevContentScore = -1 // 累积误差检测
      let accumulatedContent = context.initialContent || ''

      for (let i = 0; i < chain.steps.length; i++) {
        const step = chain.steps[i]
        const stepStartedAt = Date.now()

        // 如果指定了 startFromStep，跳过之前的步骤
        if (context.startFromStep !== undefined && step.index < context.startFromStep) {
          step.status = 'skipped'
          step.result = `用户指定从步骤 ${context.startFromStep} 开始，跳过前序步骤`
          stepResults.push({
            index: step.index,
            stage: step.stage,
            description: step.description,
            success: true,
            durationMs: 0,
            summary: '用户指定跳过此步骤',
          })
          if (planId && pm) {
            pm.updateStep(planId, i, 'pending', '用户指定跳过')
          }
          continue
        }

        // 更新 Plan 步骤状态
        if (planId && pm) {
          pm.updateStep(planId, i, 'in_progress')
        }

        // 执行当前步骤（传入累积的内容）
        const stepResult = await this.executeStep(step, context, accumulatedContent, stepStartedAt)
        const stepDurationMs = Date.now() - stepStartedAt

        step.durationMs = stepDurationMs
        step.status = stepResult.success ? 'completed' : 'failed'
        step.result = stepResult.summary
        if (stepResult.output) {
          step.output = stepResult.output
        }
        if (stepResult.assessment) {
          step.assessment = stepResult.assessment
        }
        if (stepResult.securityReport) {
          step.securityReport = stepResult.securityReport
        }

        // 累积内容（初稿和润色阶段的输出）
        if (stepResult.output && (step.stage === BlogStage.DraftWriting || step.stage === BlogStage.FinalPolish)) {
          accumulatedContent = stepResult.output
        }

        stepResults.push({
          index: step.index,
          stage: step.stage,
          description: step.description,
          success: stepResult.success,
          durationMs: stepDurationMs,
          summary: stepResult.summary,
          output: stepResult.output,
          assessment: stepResult.assessment,
          securityReport: stepResult.securityReport,
        })

        // 累积误差检测：检查内容质量评分是否有异常偏移
        if (stepResult.assessment) {
          const currentScore = stepResult.assessment.compositeScore
          if (prevContentScore >= 0 && Math.abs(currentScore - prevContentScore) > ACCUMULATED_ERROR_THRESHOLD) {
            log('WARN', 'blog_reasoning_chain_accumulated_error', {
              step: step.index,
              stage: step.stage,
              prevContentScore,
              currentScore,
              threshold: ACCUMULATED_ERROR_THRESHOLD,
            })
          }
          prevContentScore = currentScore
        }

        // 更新 Plan 步骤完成状态
        if (planId && pm) {
          pm.updateStep(planId, i, stepResult.success ? 'done' : 'failed', stepResult.summary)
        }

        log('INFO', 'blog_reasoning_step_completed', {
          sessionId: context.sessionId,
          step: step.index,
          stage: step.stage,
          stepLabel: step.label,
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
                stage: chain.steps[j].stage,
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
      chain.finalContent = accumulatedContent
      const conclusion = this.buildConclusion(chain, stepResults)
      chain.conclusion = conclusion

      if (planId && pm) {
        if (allSucceeded) {
          pm.completePlan(planId, conclusion)
        } else if (executionStoppedEarly) {
          pm.freezePlan(
            planId,
            `博客推理链中断于步骤 ${stepResults.filter((r) => !r.success).length + 1}/${chain.steps.length}: ${conclusion}`,
          )
        }
      }

      // ── 5. 记录幂等缓存 ──
      this.recentChains.add(context.sessionId)
      setTimeout(() => this.recentChains.delete(context.sessionId), IDEMPOTENCY_TTL_MS)

      // ── 6. 提取发布规划（来自最后一步的输出） ──
      const publishStep = stepResults.find((r) => r.stage === BlogStage.PublishingPlan && r.output)
      let publishPlan: BlogChainSummary['publishPlan']
      if (publishStep?.output) {
        try {
          const parsed = JSON.parse(publishStep.output)
          publishPlan = {
            platform: parsed.platform || context.targetPlatform || 'unknown',
            scheduledPublish: parsed.scheduledPublish || false,
            tags: parsed.tags || [],
            summary: parsed.summary || '',
          }
        } catch {
          publishPlan = undefined
        }
      }

      // ── 7. 返回结果 ──
      const durationMs = Date.now() - startedAt
      log('INFO', 'blog_reasoning_chain_completed', {
        sessionId: context.sessionId,
        planId,
        topic: context.topic.slice(0, 40),
        steps: chain.steps.length,
        succeeded: stepResults.filter((r) => r.success).length,
        allSucceeded,
        finalContentLength: accumulatedContent.length,
        durationMs,
      })

      return {
        totalSteps: chain.steps.length,
        succeeded: stepResults.filter((r) => r.success).length,
        allSucceeded,
        planId,
        durationMs,
        finalContent: accumulatedContent || undefined,
        publishPlan,
        stepResults: stepResults.map((r) => ({
          index: r.index,
          stage: r.stage,
          description: r.description,
          success: r.success,
          durationMs: r.durationMs,
        })),
      }
    } catch (err: any) {
      log('ERROR', 'blog_reasoning_chain_error', {
        sessionId: context.sessionId,
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

  // ═══════════════════════════════════════════
  //  推理链构建
  // ═══════════════════════════════════════════

  /**
   * 构建博客写作推理链。
   * 将 BlogStage 枚举的 7 个阶段映射为推理步骤。
   */
  private generateReasoningChain(context: BlogReasoningContext): BlogReasoningChain {
    const timestamp = Date.now()
    const steps: BlogReasoningStep[] = []
    const stages = BLOG_STAGE_ORDER // 按定义顺序取全部 7 个阶段

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]
      const { description, detail, critical } = this.getStageInfo(stage, context)
      steps.push(this.makeStep(i, timestamp, stage, description, detail, critical))
    }

    // 根据安全审查设置微调
    if (!context.enableSecurityReview) {
      // 安全审查是步骤 4（QualityReview）中的子步骤，标记为非关键
      const qualityReviewStep = steps.find((s) => s.stage === BlogStage.QualityReview)
      if (qualityReviewStep) {
        qualityReviewStep.detail += '（安全审查已禁用）'
      }
    }

    const trimmed = steps.slice(0, Math.min(steps.length, MAX_CHAIN_STEPS))

    return {
      sessionId: context.sessionId,
      title: context.topic.slice(0, 60),
      topic: context.topic,
      targetPlatform: context.targetPlatform,
      steps: trimmed,
      createdAt: Date.now(),
      allSucceeded: false,
    }
  }

  /**
   * 获取 BlogStage 对应的步骤描述、详细说明和关键性标记。
   */
  private getStageInfo(stage: BlogStage, context: BlogReasoningContext): { description: string; detail: string; critical: boolean } {
    switch (stage) {
      case BlogStage.IntentAnalysis:
        return {
          description: '主题与意图分析',
          detail:
            `理解用户意图和目标：主题="${context.topic}"` +
            (context.targetPlatform ? `，目标平台="${context.targetPlatform}"` : '') +
            (context.targetAudience ? `，受众="${context.targetAudience}"` : '') +
            (context.style ? `，风格="${context.style}"` : ''),
          critical: true, // 意图分析是关键前提
        }

      case BlogStage.MaterialCollection:
        return {
          description: '素材收集',
          detail:
            '围绕主题收集技术资料、代码示例、参考文献和相关数据' +
            (context.userContext ? `，用户提供的上下文="${context.userContext.slice(0, 100)}"` : ''),
          critical: false,
        }

      case BlogStage.Outline:
        return {
          description: '文章大纲生成',
          detail: '基于主题和素材生成文章结构大纲，包含章节标题、核心要点和代码示例规划',
          critical: true, // 大纲决定文章结构，是关键
        }

      case BlogStage.DraftWriting:
        return {
          description: '初稿生成',
          detail:
            '根据大纲写完整初稿，注重内容深度和技术准确度' +
            (context.initialContent ? `（已有初始内容 ${context.initialContent.length} 字）` : ''),
          critical: true, // 初稿是核心产出
        }

      case BlogStage.QualityReview:
        return {
          description: '质量审核与安全审查',
          detail:
            '对初稿进行多维质量评估和内容安全审查' + (context.enableSecurityReview !== false ? '（含安全审查）' : '（安全审查已禁用）'),
          critical: false,
        }

      case BlogStage.FinalPolish:
        return {
          description: '终稿润色',
          detail: '根据审核反馈进行修订，提升可读性和发布就绪度',
          critical: false,
        }

      case BlogStage.PublishingPlan:
        return {
          description: '发布规划',
          detail: '规划发布平台、标签、元数据和发布时程' + (context.targetPlatform ? `（目标平台: ${context.targetPlatform}）` : ''),
          critical: false,
        }

      default:
        return {
          description: BLOG_STAGE_LABELS[stage] || stage,
          detail: '执行博客写作步骤',
          critical: false,
        }
    }
  }

  /**
   * 创建单个博客推理步骤。
   */
  private makeStep(
    index: number,
    timestamp: number,
    stage: BlogStage,
    description: string,
    detail: string,
    critical: boolean,
  ): BlogReasoningStep {
    return {
      id: `brs_${index}_${timestamp}`,
      index,
      stage,
      label: BLOG_STAGE_LABELS[stage] || stage,
      description,
      detail,
      status: 'pending',
      critical,
    }
  }

  // ═══════════════════════════════════════════
  //  步骤执行
  // ═══════════════════════════════════════════

  /**
   * 执行推理链中的单一步骤。
   */
  private async executeStep(
    step: BlogReasoningStep,
    context: BlogReasoningContext,
    currentContent: string,
    _startedAt: number,
  ): Promise<BlogStepResult> {
    switch (step.stage) {
      case BlogStage.IntentAnalysis:
        return this.stepIntentAnalysis(context)
      case BlogStage.MaterialCollection:
        return this.stepMaterialCollection(context)
      case BlogStage.Outline:
        return this.stepOutline(context)
      case BlogStage.DraftWriting:
        return this.stepDraftWriting(context, currentContent)
      case BlogStage.QualityReview:
        return this.stepQualityReview(context, currentContent)
      case BlogStage.FinalPolish:
        return this.stepFinalPolish(context, currentContent)
      case BlogStage.PublishingPlan:
        return this.stepPublishingPlan(context)
      default:
        return { success: true, summary: `步骤 ${step.index}（${step.label}）无操作，已跳过` }
    }
  }

  /**
   * Step 0: 主题与意图分析 — 分析用户主题、目标和受众。
   */
  private stepIntentAnalysis(context: BlogReasoningContext): BlogStepResult {
    const { topic, targetPlatform, targetAudience, style } = context

    // 从 BlogAgentService 获取会话状态
    const exists = blogAgentService.getSession(context.sessionId)
    if (!exists) {
      // 自动创建会话
      blogAgentService.startSession(topic, targetPlatform)
    }

    // 主题复杂度评估
    const complexityScore = this.evaluateTopicComplexity(topic)

    // 分析结果
    const summary = [
      '【主题与意图分析结果】',
      '',
      `📌 主题: ${topic}`,
      targetPlatform ? `🎯 目标平台: ${targetPlatform}` : '🎯 目标平台: 未指定',
      targetAudience ? `👥 目标受众: ${targetAudience}` : '',
      style ? `✏️ 风格偏好: ${style}` : '',
      '',
      `📊 主题复杂度评分: ${(complexityScore * 100).toFixed(0)}%` +
        (complexityScore >= 0.7 ? '（深度技术文章）' : complexityScore >= 0.4 ? '（中等复杂度）' : '（入门/轻量内容）'),
      '',
      '📋 建议重点关注:',
      complexityScore >= 0.7
        ? '  - 深入技术原理分析\n  - 丰富的代码示例和基准测试\n  - 架构图和性能对比'
        : complexityScore >= 0.4
          ? '  - 清晰的概念解释\n  - 可运行的代码片段\n  - 实际使用场景'
          : '  - 简洁易懂的入门指引\n  - 避开过于前沿的技术术语\n  - 提供充分的背景知识',
      '',
      '📐 工作流规划:',
      `  - 推理链步骤: ${BLOG_STAGE_ORDER.length} 个阶段`,
      `  - 安全审查: ${context.enableSecurityReview !== false ? '已启用' : '已禁用'}`,
      context.enablePostAnalytics ? '  - 发布后分析: 已启用' : '',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        topic,
        complexityScore,
        platform: targetPlatform || 'unspecified',
        audience: targetAudience || 'general',
        securityReview: context.enableSecurityReview !== false,
      }),
    }
  }

  /**
   * Step 1: 素材收集 — 收集技术资料、代码示例。
   */
  private stepMaterialCollection(context: BlogReasoningContext): BlogStepResult {
    const { topic, userContext } = context

    // 从用户上下文提取素材线索
    const materialClues: string[] = []
    if (userContext) {
      // 检测用户是否提供了代码或链接
      const codeBlocks = userContext.match(/```[\s\S]*?```/g) || []
      if (codeBlocks.length > 0) {
        materialClues.push(`用户提供了 ${codeBlocks.length} 个代码块`)
      }
      const links = userContext.match(/https?:\/\/[^\s，。、；：)）]+/g) || []
      if (links.length > 0) {
        materialClues.push(`用户提供了 ${links.length} 个参考链接`)
      }
    }

    // 主题关键词提取
    const keywords = topic.split(/[\s,，。、/]+/).filter((w) => w.length >= 2)

    const summary = [
      '【素材收集结果】',
      '',
      `📚 主题相关关键词: ${keywords.join(', ') || '（基于主题自动提取）'}`,
      '',
      '📎 素材收集清单:',
      '  - [ ] 技术文档和 API 参考',
      '  - [ ] 相关源代码和示例',
      '  - [ ] 性能基准测试数据（如适用）',
      '  - [ ] 最佳实践和设计模式参考',
      '  - [ ] 同类技术对比资料',
      '',
      materialClues.length > 0 ? `💡 用户提供的素材线索:\n${materialClues.map((c) => `  - ${c}`).join('\n')}\n` : '',
      '⏩ 提示: 收集到的素材将在大纲和初稿阶段使用。如需更多特定资料，可在后续步骤中补充。',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        keywordCount: keywords.length,
        userProvidedCode: materialClues.filter((c) => c.includes('代码')).length,
        userProvidedLinks: materialClues.filter((c) => c.includes('链接')).length,
      }),
    }
  }

  /**
   * Step 2: 大纲生成 — 生成文章结构大纲。
   */
  private stepOutline(context: BlogReasoningContext): BlogStepResult {
    const { topic, targetPlatform, style } = context
    const platform = targetPlatform || '通用博客平台'

    // 根据平台和主题风格推荐大纲结构
    const isTechnical = this.evaluateTopicComplexity(topic) >= 0.5

    // 生成大纲建议
    const outlineSections: Array<{ title: string; description: string }> = []

    // 引言
    outlineSections.push({
      title: '引言 / 背景',
      description: '介绍问题背景、为什么这个话题重要、读者将从中学到什么',
    })

    // 核心内容（根据复杂度调整）
    if (isTechnical) {
      outlineSections.push({
        title: '技术原理分析',
        description: '深入讲解核心技术概念、原理和设计思想',
      })
      outlineSections.push({
        title: '实践与代码示例',
        description: '提供可运行的代码示例、配置说明和关键实现细节',
      })
      outlineSections.push({
        title: '性能与对比分析',
        description: '基准测试、性能数据、与其他方案的对比',
      })
    } else {
      outlineSections.push({
        title: '核心概念介绍',
        description: '用通俗语言介绍核心概念，配合简单示例',
      })
      outlineSections.push({
        title: '快速上手实践',
        description: '提供简洁的上手指南和代码片段',
      })
    }

    // 进阶/最佳实践
    outlineSections.push({
      title: '最佳实践与注意事项',
      description: '实际开发中的常见误区、性能优化建议和注意事项',
    })

    // 总结
    outlineSections.push({
      title: '总结与展望',
      description: '回顾关键要点、未来发展方向、延伸阅读资源',
    })

    // 风格调整
    if (style === '教程') {
      outlineSections.splice(1, 0, {
        title: '环境准备与前置条件',
        description: '需要的工具、库和环境配置',
      })
    }

    // 平台适配
    const platformNotes: string[] = []
    if (platform.includes('公众号') || platform.includes('微信')) {
      platformNotes.push('• 公众号建议 1500-3000 字，配图 3-5 张')
      platformNotes.push('• 开头需要导语/摘要（显示在前台）')
    } else if (platform.includes('知乎')) {
      platformNotes.push('• 知乎文章建议 2000-5000 字')
      platformNotes.push('• 开头要有抓眼球的开场')
    }

    const sectionLines = outlineSections.map((s, i) => `  ${i + 1}. **${s.title}**\n     ${s.description}`)

    const summary = [
      '【文章大纲生成】',
      '',
      `📑 主题: ${topic}`,
      `🎯 平台: ${platform}`,
      `📐 风格: ${style || '通用技术博客'}`,
      `📊 深度级别: ${isTechnical ? '深度技术分析' : '入门/介绍'}`,
      '',
      '📋 推荐大纲结构:',
      ...sectionLines,
      '',
      platformNotes.length > 0 ? `📌 平台注意事项:\n${platformNotes.join('\n')}\n` : '',
      '⏩ 提示: 大纲结构已生成，下一步将基于此大纲撰写初稿。如需调整结构，可在初稿生成前修改。',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        sections: outlineSections.length,
        isTechnical,
        platform,
        sectionTitles: outlineSections.map((s) => s.title),
      }),
    }
  }

  /**
   * Step 3: 初稿生成 — 生成博客初稿内容。
   * 注意：本步骤生成内容规划建议，实际内容生成由 BlogAgentService 或外部 LLM 完成。
   */
  private stepDraftWriting(context: BlogReasoningContext, currentContent: string): BlogStepResult {
    const { topic, targetPlatform, style, initialContent } = context

    // 检测是否有初始内容
    const hasInitialContent = !!(initialContent || currentContent)

    const summary = [
      '【初稿生成结果】',
      '',
      hasInitialContent ? `📄 现有内容长度: ${(initialContent || currentContent).length} 字` : '📄 无初始内容，需要从头撰写',
      '',
      '✍️ 初稿写作要点:',
      '  - 保持技术准确性：所有代码示例应经过验证',
      '  - 注意行文流畅：避免 AI 套话和空洞表达',
      '  - 结构清晰：按大纲章节顺序展开',
      '  - 突出实践价值：每个技术点都应配有实际意义说明',
      '',
      style ? `🎨 风格指南: "${style}" — 整篇文章保持风格一致` : '',
      targetPlatform ? `📌 ${targetPlatform} 格式适配: 确保 Markdown 格式兼容` : '',
      '',
      '📏 建议篇幅:',
      this.evaluateTopicComplexity(topic) >= 0.7
        ? '  3000-6000 字（深度技术文章）'
        : this.evaluateTopicComplexity(topic) >= 0.4
          ? '  1500-4000 字（中等篇幅）'
          : '  800-2000 字（入门文章）',
      '',
      '⏩ 初稿生成完成后将进入质量审核阶段。',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary,
      output: hasInitialContent ? initialContent || currentContent : undefined,
    }
  }

  /**
   * Step 4: 质量审核与安全审查 — 对内容进行多维评估和安全检查。
   */
  private async stepQualityReview(context: BlogReasoningContext, currentContent: string): Promise<BlogStepResult> {
    if (!currentContent || currentContent.length < 50) {
      return {
        success: true,
        summary: '【质量审核】内容为空或过短（不足 50 字），跳过质量评估',
      }
    }

    // 1. 内容质量评估（使用 PlanBlogWritingAdapter）
    const assessInput: BlogAssessmentInput = {
      content: currentContent,
      topic: context.topic,
      platform: context.targetPlatform,
      targetAudience: context.targetAudience,
      currentStage: BlogStage.QualityReview,
      style: context.style,
    }

    const assessment = planBlogWritingAdapter.assessContent(assessInput)

    // 2. 安全审查（如果启用）
    let securityReport: SecurityReviewReport | undefined
    if (context.enableSecurityReview !== false) {
      try {
        securityReport = blogSecurityReviewer.review(currentContent, { skipCodeBlocks: true })
      } catch (err: any) {
        log('WARN', 'blog_security_review_failed', {
          sessionId: context.sessionId,
          error: String(err),
        })
      }
    }

    // 3. 汇总质量报告
    const assessmentLines: string[] = ['【质量审核报告】', '']

    if (assessment) {
      assessmentLines.push(`📊 综合质量评分: ${(assessment.compositeScore * 100).toFixed(0)}/100`)

      // 维度评分摘要
      const dimLines: string[] = []
      const dimLabels: Record<string, string> = {
        contentDepth: '内容深度',
        codeQuality: '代码质量',
        readability: '可读性',
        structuralQuality: '结构质量',
        seoRelevance: 'SEO 相关性',
        publishReadiness: '发布就绪度',
      }
      for (const [key, label] of Object.entries(dimLabels)) {
        const score = (assessment.assessments[0]?.scores as any)?.[key]
        if (typeof score === 'number') {
          const mark = score >= 0.7 ? '✅' : score >= 0.5 ? '⚠️' : '❌'
          dimLines.push(`  ${mark} ${label}: ${(score * 100).toFixed(0)}分`)
        }
      }
      assessmentLines.push(...dimLines)
      assessmentLines.push('')

      // 问题列表
      const allIssues = assessment.assessments.flatMap((a) => a.issues)
      if (allIssues.length > 0) {
        assessmentLines.push(`🔍 发现 ${allIssues.length} 个可改进项:`)
        for (const issue of allIssues) {
          const severityLabel =
            issue.severity === 'critical' ? '🔴' : issue.severity === 'major' ? '🟡' : issue.severity === 'minor' ? '🟢' : '🔵'
          assessmentLines.push(`  ${severityLabel} [${issue.dimension}] ${issue.description}`)
          assessmentLines.push(`     → ${issue.suggestion}`)
        }
        assessmentLines.push('')
      }

      assessmentLines.push(
        assessment.publishReady
          ? '✅ 内容已达到发布就绪标准'
          : `⚠️ 内容尚未达到发布就绪标准（阈值 ${(PUBLISH_READY_SCORE * 100).toFixed(0)}分）`,
      )
    } else {
      assessmentLines.push('⚠️ 质量评估未能完成（内容可能不完整）')
    }

    // 安全审查结果
    if (securityReport) {
      assessmentLines.push('', '---', '', '【安全审查报告】')
      assessmentLines.push(`风险等级: ${securityReport.overallRiskLevel}`)
      assessmentLines.push(`通过: ${securityReport.passed ? '✅ 是' : '❌ 否'}`)

      if (securityReport.findings.length > 0) {
        assessmentLines.push(`发现 ${securityReport.totalFindings} 项:`)
        for (const finding of securityReport.findings) {
          const riskIcon = finding.riskLevel === 'critical' ? '🔴' : finding.riskLevel === 'high' ? '🟠' : '🟡'
          assessmentLines.push(`  ${riskIcon} [${finding.category}] ${finding.description}`)
          assessmentLines.push(`    建议: ${finding.suggestion}`)
        }
      } else {
        assessmentLines.push('  ✅ 无安全风险')
      }

      assessmentLines.push('')
      assessmentLines.push(
        `建议动作: ${
          securityReport.recommendedAction === 'block'
            ? '❌ 禁止发布'
            : securityReport.recommendedAction === 'fix_before_publish'
              ? '⚠️ 修复后发布'
              : '✅ 可以发布'
        }`,
      )
    }

    return {
      success: true,
      summary: assessmentLines.join('\n'),
      assessment: assessment ?? undefined,
      securityReport,
      output: JSON.stringify({
        compositeScore: assessment?.compositeScore ?? 0,
        totalIssues: assessment?.totalIssues ?? 0,
        publishReady: assessment?.publishReady ?? false,
        securityPassed: securityReport?.passed ?? true,
        securityRisk: securityReport?.overallRiskLevel ?? 'info',
      }),
    }
  }

  /**
   * Step 5: 终稿润色 — 根据审核反馈进行修订。
   */
  private stepFinalPolish(context: BlogReasoningContext, currentContent: string): BlogStepResult {
    if (!currentContent || currentContent.length < 50) {
      return {
        success: true,
        summary: '【终稿润色】内容为空或过短，跳过润色',
      }
    }

    // 使用 PlanBlogWritingAdapter 评估当前内容的发布就绪度
    const assessInput: BlogAssessmentInput = {
      content: currentContent,
      topic: context.topic,
      platform: context.targetPlatform,
      currentStage: BlogStage.FinalPolish,
    }
    const assessment = planBlogWritingAdapter.assessContent(assessInput)

    // 润色建议列表
    const polishingSuggestions: string[] = []

    if (assessment) {
      const scores = assessment.assessments[0]?.scores
      if (scores) {
        if (scores.readability < 0.7) {
          polishingSuggestions.push('• 优化句式多样性，交替长短句以改善阅读节奏')
          polishingSuggestions.push('• 检查并去除 AI 套话（"值得注意的是""显而易见"等）')
        }
        if (scores.structuralQuality < 0.7) {
          polishingSuggestions.push('• 确保各章节过渡自然，增强段落之间的逻辑衔接')
          polishingSuggestions.push('• 检查标题层级是否合理（h2/h3 递进）')
        }
        if (scores.publishReadiness < 0.7) {
          polishingSuggestions.push('• 清理 TODO/FIXME 占位符，补全空链接')
          polishingSuggestions.push('• 添加版权声明和原创标识')
        }
        if (scores.codeQuality < 0.7) {
          polishingSuggestions.push('• 为代码块添加语言标识（如 ```typescript）')
          polishingSuggestions.push('• 在代码前后添加解释性文字')
        }
      }
    }

    // 内容统计
    const chineseChars = (currentContent.match(/[一-鿿]/g) || []).length
    const codeBlocks = currentContent.match(/```[\s\S]*?```/g) || []
    const headings = currentContent.match(/^#{1,4}\s+.+/gm) || []

    const summary = [
      '【终稿润色结果】',
      '',
      `📄 内容长度: ${currentContent.length} 字符（中文 ${chineseChars} 字）`,
      `📐 代码块: ${codeBlocks.length} 个`,
      `📑 章节: ${headings.length} 个`,
      '',
      `📊 发布就绪评分: ${assessment ? `${(assessment.compositeScore * 100).toFixed(0)}/100` : '未评估'}`,
      '',
      polishingSuggestions.length > 0 ? ['✏️ 润色建议:', ...polishingSuggestions, ''].join('\n') : '✅ 内容质量良好，无需额外润色\n',
      assessment?.publishReady
        ? '✅ 内容已准备就绪，可以进入发布规划阶段。'
        : `⚠️ 内容发布就绪度不足（< ${(PUBLISH_READY_SCORE * 100).toFixed(0)}分），建议根据上述建议进一步完善。`,
    ].join('\n')

    return {
      success: true,
      summary,
      output: currentContent,
      assessment: assessment ?? undefined,
    }
  }

  /**
   * Step 6: 发布规划 — 规划发布平台、标签、元数据。
   */
  private stepPublishingPlan(context: BlogReasoningContext): BlogStepResult {
    const { topic, targetPlatform } = context
    const platform = targetPlatform || '通用博客平台'

    // 提取标签
    const tags = this.generateTags(topic)

    // 平台特定建议
    const platformAdvice: Array<{ platform: string; advice: string[] }> = [
      {
        platform: '博客园',
        advice: ['支持完整 Markdown，代码高亮效果好', '建议添加 "原创" 标签提高推荐权重', '注意首段要有足够文字（200字以上）作为摘要'],
      },
      {
        platform: 'CSDN',
        advice: ['支持 Markdown，代码块需标注语言', '标题长度控制在 30 字以内', '添加合适的技术分类标签'],
      },
      {
        platform: '知乎',
        advice: ['开头 2-3 句决定读者是否继续阅读', '建议配图 3-5 张提升阅读体验', '注意格式转换：知乎有部分 Markdown 语法差异'],
      },
      {
        platform: '掘金',
        advice: ['技术深度是推荐算法的核心指标', '代码质量要求高，确保代码可运行', '注意添加"前端/后端/AI"等一级标签'],
      },
      {
        platform: '公众号',
        advice: ['需要单独排版工具（如 Markdown Here）', '配图需自行上传，不支持外链图片', '导语会在消息列表中展示，需精心设计'],
      },
    ]

    const platformSpecific = platformAdvice.find((p) => platform.includes(p.platform) || p.platform.includes(platform))

    const summary = [
      '【发布规划】',
      '',
      `🎯 目标平台: ${platform}`,
      '',
      '🏷️ 推荐标签:',
      ...tags.map((t) => `  #${t}`),
      '',
      platformSpecific
        ? [`📌 ${platformSpecific.platform} 发布注意事项:`, ...platformSpecific.advice.map((a) => `  • ${a}`), ''].join('\n')
        : '',
      '📅 发布时程建议:',
      '  • 工作日上午 9:00-11:00 发布效果最佳',
      '  • 避免周末和节假日发布（阅读量偏低）',
      '  • 如为系列文章，建议固定发布日（如每周三）',
      '',
      '📈 发布后关注指标:',
      '  • 阅读量（前 24 小时最关键）',
      '  • 互动率（点赞+评论+收藏）/ 阅读量',
      '  • 外部引流效果（如果跨平台发布）',
      '',
      context.enablePostAnalytics
        ? '📊 发布后数据分析已就绪，BlogAnalyticsTracker 将自动追踪效果。'
        : '💡 可启用发布后数据分析来追踪文章效果。',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      success: true,
      summary,
      output: JSON.stringify({
        platform,
        tags,
        scheduledPublish: false,
        summary: `博客「${topic}」发布规划已完成，目标平台 ${platform}，共 ${tags.length} 个标签`,
      }),
    }
  }

  // ═══════════════════════════════════════════
  //  辅助方法
  // ═══════════════════════════════════════════

  /**
   * 评估博客主题的复杂度（0-1）。
   */
  private evaluateTopicComplexity(topic: string): number {
    if (!topic || !topic.trim()) return 0.3

    const lower = topic.toLowerCase()

    // 高复杂度信号
    const highSignals = [
      '架构',
      '设计模式',
      '分布式',
      '微服务',
      '性能优化',
      '源码分析',
      '算法',
      '编译器',
      '内核',
      '数据库',
      'architecture',
      'design pattern',
      'distributed',
      'microservice',
      'deep dive',
      'under the hood',
      'internals',
      'optimization',
      '系统设计',
      '高并发',
      '高可用',
      '容错',
      '一致性',
      '原理',
      '机制',
      '实现',
      '底层',
      '框架设计',
    ]

    // 低复杂度信号
    const lowSignals = [
      '入门',
      '介绍',
      '初探',
      '笔记',
      '心得',
      '教程',
      '指南',
      '快速',
      '简单',
      'hello world',
      'introduction',
      'getting started',
      'beginner',
      'tutorial',
      'guide',
      'quick',
      'simple',
      'basic',
    ]

    let complexity = 0.5
    const highCount = highSignals.filter((kw) => lower.includes(kw)).length
    complexity += highCount * 0.08
    const lowCount = lowSignals.filter((kw) => lower.includes(kw)).length
    complexity -= lowCount * 0.06
    if (topic.length > 30) complexity += 0.1
    if (topic.length > 60) complexity += 0.1

    return Math.max(0, Math.min(1, complexity))
  }

  /**
   * 基于主题生成推荐标签。
   */
  private generateTags(topic: string): string[] {
    const tags: string[] = []
    const lower = topic.toLowerCase()

    // 技术栈标签
    const techStack: Record<string, string[]> = {
      typescript: ['TypeScript', '前端'],
      javascript: ['JavaScript', '前端'],
      react: ['React', '前端'],
      vue: ['Vue.js', '前端'],
      angular: ['Angular', '前端'],
      node: ['Node.js', '后端'],
      python: ['Python', '后端'],
      rust: ['Rust', '系统编程'],
      go: ['Go', '后端'],
      java: ['Java', '后端'],
      docker: ['Docker', 'DevOps'],
      kubernetes: ['Kubernetes', 'DevOps', '容器'],
      ai: ['AI', '人工智能', '机器学习'],
      ml: ['机器学习', 'AI'],
      database: ['数据库', '后端'],
      api: ['API', '后端', '架构'],
    }

    for (const [keyword, tagSet] of Object.entries(techStack)) {
      if (lower.includes(keyword)) {
        tags.push(...tagSet)
      }
    }

    // 主题类型标签
    if (/教程|指南|入门|上手|getting started|tutorial/i.test(lower)) {
      tags.push('教程')
    }
    if (/源码|分析|源码分析|under the hood|deep dive|internals/i.test(lower)) {
      tags.push('源码分析', '深度')
    }
    if (/性能|优化|benchmark|performance/i.test(lower)) {
      tags.push('性能优化')
    }
    if (/架构|设计|architecture|design pattern/i.test(lower)) {
      tags.push('架构', '设计模式')
    }
    if (/最佳实践|best practice/i.test(lower)) {
      tags.push('最佳实践')
    }

    // 去重并限制数量
    const unique = [...new Set(tags)]
    return unique.slice(0, 6)
  }

  /**
   * 构建推理链最终结论。
   */
  private buildConclusion(
    chain: BlogReasoningChain,
    stepResults: Array<{ index: number; description: string; success: boolean; durationMs: number }>,
  ): string {
    const succeeded = stepResults.filter((r) => r.success).length
    const total = chain.steps.length

    if (chain.allSucceeded) {
      const totalDuration = stepResults.reduce((s, r) => s + r.durationMs, 0)
      return (
        `博客推理链全部 ${total} 步成功完成（总耗时 ${(totalDuration / 1000).toFixed(1)}s）。` +
        `博客「${chain.topic}」从主题分析到发布规划的全流程已完成。` +
        (chain.finalContent ? `最终内容 ${chain.finalContent.length} 字符。` : '')
      )
    }

    const failedSteps = stepResults
      .filter((r) => !r.success)
      .map((r) => `  - ${r.description}`)
      .join('\n')

    return `博客推理链 ${succeeded}/${total} 步完成。失败步骤:\n${failedSteps}\n\n建议检查失败步骤对应的阶段，或从指定步骤重新启动推理链。`
  }

  /**
   * Evolution 上下文注入 — 将 Evolution 系统状态注入博客推理链各步骤。
   *
   * 从 EvolutionConsumerBridge 获取 plan_blog 消费者的上下文，
   * 在推理链的步骤 detail 中追加系统状态信息，使每个步骤都能感知：
   * - 已知问题分布 → 影响博客主题选择和节奏建议
   * - 管道健康度 → 影响发布紧迫度判断
   * - 调度器状态 → 判断是否应等待系统稳定
   *
   * 注入策略：
   * - IntentAnalysis 步骤（索引 0）：注入已知问题和管道摘要，影响主题复杂度评估
   * - QualityReview 步骤（索引 4）：注入管道健康度，影响质量审核标准
   * - PublishingPlan 步骤（索引 6）：注入系统状态摘要，影响发布时间建议
   */
  private enrichChainWithEvolutionContext(chain: BlogReasoningChain, context: BlogReasoningContext): void {
    try {
      const evoCtx = evolutionConsumerBridge.getContext('plan_blog')
      if (!evoCtx) {
        log('INFO', 'blog_evolution_context_unavailable', {
          sessionId: context.sessionId,
          topic: context.topic.slice(0, 40),
        })
        return
      }

      const evolutionSummary = evoCtx.pipeline
        ? [
            `系统状态: ${evoCtx.pipeline.healthStatus}`,
            `已采集 ${evoCtx.pipeline.totalCollected} 个问题`,
            `已修复 ${evoCtx.pipeline.totalFixed} 个`,
            `队列 ${evoCtx.pipeline.queueSize} 个待处理`,
          ].join('，')
        : ''

      // 注入 IntentAnalysis 步骤
      const intentStep = chain.steps.find((s) => s.index === 0)
      if (intentStep && evoCtx.knownIssues.length > 0) {
        const issueSummary = evoCtx.knownIssues
          .slice(0, 3)
          .map((i) => `[${i.severity}] ${i.title}`)
          .join('\n')
        intentStep.detail +=
          `\n\n【Evolution 系统状态】\n` + (evolutionSummary ? `  ${evolutionSummary}\n` : '') + `  最近问题:\n  ${issueSummary}`
        log('INFO', 'blog_evolution_context_injected_intent', {
          sessionId: context.sessionId,
          issues: evoCtx.knownIssues.length,
          healthStatus: evoCtx.pipeline?.healthStatus ?? 'unknown',
        })
      } else if (intentStep && evolutionSummary) {
        intentStep.detail += `\n\n【Evolution 系统状态】\n  ${evolutionSummary}`
      }

      // 注入 QualityReview 步骤
      const qualityStep = chain.steps.find((s) => s.index === 4)
      if (qualityStep && evoCtx.pipeline) {
        qualityStep.detail +=
          `\n\n【Evolution 管道健康度】\n  ` +
          `健康状态: ${evoCtx.pipeline.healthStatus}\n  ` +
          `系统问题密度: ${evoCtx.pipeline.totalCollected} 个已知问题\n  ` +
          (evoCtx.pipeline.healthStatus === 'stalled' || evoCtx.pipeline.healthStatus === 'degraded'
            ? '  提示: 系统有较多待处理问题，博客内容可适当融入相关改进说明'
            : '  提示: 系统状态良好，可正常推进博客发布')
      }

      // 注入 PublishingPlan 步骤
      const publishStep = chain.steps.find((s) => s.index === 6)
      if (publishStep && evoCtx.scheduler) {
        publishStep.detail +=
          `\n\n【Evolution 调度器状态】\n  ` +
          `状态: ${evoCtx.scheduler.state}\n  ` +
          `上次运行: ${evoCtx.scheduler.lastRun ? new Date(evoCtx.scheduler.lastRun).toLocaleString('zh-CN') : '从未'}\n  ` +
          `健康: ${evoCtx.scheduler.isHealthy ? '是' : '否'}\n  ` +
          (evoCtx.scheduler.isHealthy ? '  提示: Evolution 运行正常，可按计划发布' : '  提示: Evolution 出现故障，建议等待系统恢复后再发布')
      }

      log('INFO', 'blog_evolution_context_injected', {
        sessionId: context.sessionId,
        stepsInjected: [intentStep, qualityStep, publishStep].filter(Boolean).length,
        hasIssues: evoCtx.knownIssues.length > 0,
        hasPipeline: !!evoCtx.pipeline,
      })
    } catch (err: any) {
      //  Evolution 上下文注入不应阻塞博客推理链
      log('WARN', 'blog_evolution_context_injection_failed', {
        sessionId: context.sessionId,
        error: String(err),
      })
    }
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

/** 全局单例 */
export const blogReasoningChainExecutor = new BlogReasoningChainExecutor()
