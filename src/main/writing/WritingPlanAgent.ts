/**
 * WritingPlanAgent — 写作计划智能编排 Agent
 *
 * 职责：
 * 1. 解析设计文档提取"齿轮三角"关键要素
 * 2. 对比现有章节与设计文档差异，生成问题清单
 * 3. 将重写工作分解为分层子任务（调整大纲→重写章节→质量校验）
 * 4. 子任务完成后自动触发下一阶段，记录进度到 Memory
 *
 * 使用方式：
 * - tools/WritingPlanTools 代理对外暴露能力
 * - 内部使用 chatJsonWithCode() 进行结构化分析
 * - 进度持久化依赖 MemoryService
 * - 初始化：WritingPlanAgent.init(chatJsonWithCodeFn)
 *
 * 风险注意：
 * - LLM 对设计文档的理解可能偏差，需保留人工审查环节
 * - 章节对比依赖 LLM 分析，长文本可能存在 Token 限制
 */
import { log, createRequestId } from '../logger/Logger'
import { getMemoryService, getPlanManager } from '../tool/deps'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import type {
  DesignDocAnalysis,
  GearTriangleElements,
  ChapterGuideline,
  ChapterDiff,
  DiffIssue,
  ChapterCompareResult,
  RewriteTask,
  RewritePlan,
  RewritePhase,
  QualityReport,
  ProgressRecord,
  UserConstraint,
} from './types'

// ===== 类型 =====

/** chatJsonWithCode 方法签名（与 LlmService 的 chatJsonWithCode 兼容） */
export type ChatJsonFn = (
  userText: string,
  options?: {
    system?: string
    temperature?: number
    timeoutMs?: number
    requestId?: string
  },
) => Promise<{ data?: any; error?: string }>

// ===== 常量 =====

const MEMORY_KEY_PREFIX = 'writing_plan_progress:'
const MEMORY_CONSTRAINTS_PREFIX = 'writing_plan_constraints:'
const MEMORY_PLAN_PREFIX = 'writing_plan_state:'
const DEFAULT_THRESHOLD = 70 // 质量校验默认通过阈值

// ===== 辅助 =====

function parseChapterRange(paths: string[]): { start: number; end: number } {
  const numbers = paths
    .map((p) => {
      const match = p.match(/(\d+)/)
      return match ? parseInt(match[1], 10) : null
    })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
  if (numbers.length === 0) return { start: 19, end: 27 }
  return { start: numbers[0], end: numbers[numbers.length - 1] }
}

function createPlanId(): string {
  return `wp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// ===== 系统提示 =====

const SYSTEM_PROMPT_DESIGN_ANALYSIS = `你是一个专业的小说设计文档分析助手。
你的任务是分析小说设计文档，提取"齿轮三角"关键要素。

齿轮三角是工业题材小说的核心叙事框架，包含：
1. 核心主题（故事的核心思想与主旨）
2. 主要角色（每个角色的定位与成长弧线）
3. 核心冲突（人与机械、传统与现代、个体与集体等）
4. 工业美学要素（蒸汽、齿轮、钢铁、灯火、车间等视觉与感官元素）
5. 叙事视角与风格（叙述视角、语言风格、节奏）
6. 时代背景（具体的历史或架空时代设定）

对于每个章节，提取：
- 章节号与标题
- 关键情节点
- 必须包含的要素
- 在齿轮三角中的定位

输出严格的 JSON 格式，不要包含任何额外文字。`

const SYSTEM_PROMPT_CHAPTER_COMPARISON = `你是一个专业的小说质量审核助手。
你的任务是比较小说章节与设计文档的要求，找出差异和问题。

对于每个章节，你需要检查：
1. 角色偏差：角色行为是否符合设计文档中的人物定位和成长弧线
2. 情节一致性：情节发展是否符合设计文档的规划
3. 风格匹配：文风是否与设计文档要求的风格一致
4. 要素缺失：设计文档要求的要素是否在本章中出现
5. 结构问题：章节结构是否合理

输出严格的 JSON 格式，包含逐章差异和汇总统计。`

const SYSTEM_PROMPT_TASK_DECOMPOSITION = `你是一个专业的写作项目管理助手。
你的任务是根据章节对比结果，将重写工作分解为可执行的分层子任务。

任务分三个层级：
1. 调整大纲（outline）：修改章节结构、情节框架
2. 重写章节（rewrite）：实际修改章节内容
3. 质量校验（quality_check）：检查重写后的章节是否符合要求

为每个任务指定：
- 所属阶段
- 任务描述
- 涉及章节编号
- 依赖的其他任务 ID
- 关联的设计文档要求

注意任务之间的依赖关系：必须先调整大纲再重写，重写完成后才能校验。
输出严格的 JSON 格式。`

const SYSTEM_PROMPT_QUALITY_CHECK = `你是一个专业的小说质量校验助手。
你的任务是对重写后的章节进行质量检查。

检查维度：
1. style_consistency（风格一致性）：文风是否与设计文档要求的一致
2. character_completeness（角色完整性）：所有角色是否在章节中得到充分展现
3. plot_coherence（情节连贯性）：情节是否合理连贯
4. atmosphere（氛围营造）：工业美学氛围是否到位
5. dialogue（对话质量）：对话是否符合人物身份和情境

为每个维度打分（0-100），列出问题点和改进建议。
输出严格的 JSON 格式。`

// ===== WritingPlanAgent =====

export class WritingPlanAgent {
  private chatJsonWithCode: ChatJsonFn | null = null

  /**
   * 初始化 WritingPlanAgent（注入 chatJsonWithCode 函数）。
   * 在 AgentService 启动时调用。
   */
  init(chatJsonWithCode: ChatJsonFn): void {
    this.chatJsonWithCode = chatJsonWithCode
    log('INFO', 'writing_plan_agent_initialized')
  }

  /** 检查是否已初始化 */
  isReady(): boolean {
    return this.chatJsonWithCode !== null
  }

  // ─────────────────────────────────────────────
  //  1. 设计文档分析
  // ─────────────────────────────────────────────

  /**
   * 读取并分析设计文档，提取齿轮三角关键要素。
   *
   * @param designDocPath - 设计文档的文件路径（相对于项目根目录）
   * @returns 结构化分析结果
   */
  async analyzeDesignDocument(designDocPath: string): Promise<{ data?: DesignDocAnalysis; error?: string }> {
    if (!this.chatJsonWithCode) return { error: 'WritingPlanAgent 未初始化' }

    const requestId = createRequestId()
    log('INFO', 'writing_plan_analyze_design_start', { path: designDocPath, request_id: requestId })

    try {
      const docContent = this.readFileContent(designDocPath)
      if (!docContent) {
        return { error: `设计文档不存在: ${designDocPath}` }
      }

      const result = await this.chatJsonWithCode(docContent, {
        system: SYSTEM_PROMPT_DESIGN_ANALYSIS,
        temperature: 0.2,
        timeoutMs: 120000,
        requestId,
      })

      if (result.error) {
        log('ERROR', 'writing_plan_analyze_design_llm_error', { request_id: requestId, error: result.error })
        return { error: `LLM 分析失败: ${result.error}` }
      }

      if (!result.data) {
        return { error: 'LLM 返回空结果' }
      }

      const analysis = this.normalizeDesignAnalysis(result.data, designDocPath)
      log('INFO', 'writing_plan_analyze_design_done', {
        request_id: requestId,
        storyName: analysis.storyName,
        characters: analysis.gearTriangle.characters.length,
        chapterGuidelines: analysis.chapterGuidelines.length,
      })

      return { data: analysis }
    } catch (err: any) {
      log('ERROR', 'writing_plan_analyze_design_failed', { path: designDocPath, error: err.message })
      return { error: `设计文档分析异常: ${err.message}` }
    }
  }

  // ─────────────────────────────────────────────
  //  2. 章节对比
  // ─────────────────────────────────────────────

  /**
   * 对比现有章节与设计文档，生成问题清单。
   */
  async compareChapters(
    designAnalysis: DesignDocAnalysis,
    chapterPaths: string[],
  ): Promise<{ data?: ChapterCompareResult; error?: string }> {
    if (!this.chatJsonWithCode) return { error: 'WritingPlanAgent 未初始化' }

    const requestId = createRequestId()
    log('INFO', 'writing_plan_compare_start', { chapters: chapterPaths.length, request_id: requestId })

    try {
      if (chapterPaths.length === 0) return { error: '章节路径列表为空' }

      const chapters: Array<{ path: string; number: number; content: string }> = []
      for (const path of chapterPaths) {
        const content = this.readFileContent(path)
        if (content) {
          const match = path.match(/(\d+)/)
          const number = match ? parseInt(match[1], 10) : 0
          chapters.push({ path, number, content })
        }
      }

      if (chapters.length === 0) return { error: '未能读取任何章节文件' }

      const designSummary = this.buildDesignSummary(designAnalysis)
      const chaptersText = chapters
        .map((c) => `=== 第${c.number}章 ===\n${c.content.slice(0, 3000)}`)
        .join('\n\n')

      const prompt = `【设计文档要求】\n${designSummary}\n\n【现有章节】\n${chaptersText}\n\n请逐章对比，找出每章与设计文档的差异。`

      const result = await this.chatJsonWithCode(prompt, {
        system: SYSTEM_PROMPT_CHAPTER_COMPARISON,
        temperature: 0.2,
        timeoutMs: 180000,
        requestId,
      })

      if (result.error) return { error: `章节对比 LLM 调用失败: ${result.error}` }
      if (!result.data) return { error: '章节对比返回空结果' }

      const compareResult = this.normalizeCompareResult(result.data, designAnalysis.storyName, chapters)
      log('INFO', 'writing_plan_compare_done', {
        request_id: requestId,
        chapters: compareResult.chapterDiffs.length,
        totalIssues: compareResult.summary.totalIssues,
      })

      return { data: compareResult }
    } catch (err: any) {
      log('ERROR', 'writing_plan_compare_failed', { error: err.message })
      return { error: `章节对比异常: ${err.message}` }
    }
  }

  // ─────────────────────────────────────────────
  //  3. 重写任务分解
  // ─────────────────────────────────────────────

  /**
   * 根据对比结果，将重写工作分解为分层子任务。
   */
  async decomposeRewrite(
    compareResult: ChapterCompareResult,
    designAnalysis: DesignDocAnalysis,
    planId?: string,
  ): Promise<{ data?: RewritePlan; error?: string }> {
    if (!this.chatJsonWithCode) return { error: 'WritingPlanAgent 未初始化' }

    const requestId = createRequestId()
    log('INFO', 'writing_plan_decompose_start', { request_id: requestId })

    try {
      const prompt = `【章节对比结果】\n${JSON.stringify(compareResult, null, 2)}\n\n【设计文档核心要求】\n${JSON.stringify(designAnalysis.gearTriangle, null, 2)}\n\n请将上述重写工作分解为分层子任务。`

      const result = await this.chatJsonWithCode(prompt, {
        system: SYSTEM_PROMPT_TASK_DECOMPOSITION,
        temperature: 0.3,
        timeoutMs: 120000,
        requestId,
      })

      if (result.error) return { error: `任务分解 LLM 调用失败: ${result.error}` }
      if (!result.data) return { error: '任务分解返回空结果' }

      const plan = this.buildRewritePlan(result.data, compareResult, planId)
      this.savePlanToMemory(plan)

      log('INFO', 'writing_plan_decompose_done', {
        request_id: requestId,
        planId: plan.planId,
        tasks: plan.tasks.length,
      })

      return { data: plan }
    } catch (err: any) {
      log('ERROR', 'writing_plan_decompose_failed', { error: err.message })
      return { error: `任务分解异常: ${err.message}` }
    }
  }

  // ─────────────────────────────────────────────
  //  4. 质量校验
  // ─────────────────────────────────────────────

  /**
   * 对单章进行质量校验。
   */
  async qualityCheck(
    chapterPath: string,
    chapterNumber: number,
    designAnalysis: DesignDocAnalysis,
    threshold: number = DEFAULT_THRESHOLD,
  ): Promise<{ data?: QualityReport; error?: string }> {
    if (!this.chatJsonWithCode) return { error: 'WritingPlanAgent 未初始化' }

    const requestId = createRequestId()
    log('INFO', 'writing_plan_quality_check_start', { chapter: chapterNumber, path: chapterPath, request_id: requestId })

    try {
      const content = this.readFileContent(chapterPath)
      if (!content) return { error: `章节文件不存在: ${chapterPath}` }

      const designSummary = this.buildDesignSummary(designAnalysis)
      const prompt = `【第${chapterNumber}章内容】\n${content.slice(0, 4000)}\n\n【设计文档要求】\n${designSummary}\n\n请对本章进行质量校验。`

      const result = await this.chatJsonWithCode(prompt, {
        system: SYSTEM_PROMPT_QUALITY_CHECK,
        temperature: 0.2,
        timeoutMs: 120000,
        requestId,
      })

      if (result.error) return { error: `质量校验 LLM 调用失败: ${result.error}` }
      if (!result.data) return { error: '质量校验返回空结果' }

      const report = this.normalizeQualityReport(result.data, chapterNumber, threshold)
      log('INFO', 'writing_plan_quality_check_done', {
        request_id: requestId,
        chapter: chapterNumber,
        overallScore: report.overallScore,
        passed: report.passed,
      })

      return { data: report }
    } catch (err: any) {
      log('ERROR', 'writing_plan_quality_check_failed', { chapter: chapterNumber, error: err.message })
      return { error: `质量校验异常: ${err.message}` }
    }
  }

  // ─────────────────────────────────────────────
  //  5. 进度管理
  // ─────────────────────────────────────────────

  /** 记录任务进度到 Memory */
  recordProgress(planId: string, taskId: string, status: string, summary: string, details?: string): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'writing_plan_record_progress_no_memory', { planId, taskId })
      return
    }

    const record: ProgressRecord = { planId, taskId, timestamp: Date.now(), status, summary, details }
    ms.addEntry('writing_feedback', JSON.stringify(record), 0.8, { tier: 'semi' })

    log('INFO', 'writing_plan_progress_recorded', { planId, taskId, status })
  }

  /** 查询计划的所有进度记录 */
  getProgressRecords(planId: string): ProgressRecord[] {
    const ms = getMemoryService()
    if (!ms) return []

    const allEntries = ms.getEntries()
    const records: ProgressRecord[] = []

    for (const entry of allEntries) {
      if (entry.type !== 'writing_feedback') continue
      try {
        const parsed = JSON.parse(entry.content) as ProgressRecord
        if (parsed.planId === planId) records.push(parsed)
      } catch {
        // skip non-JSON entries
      }
    }

    return records.sort((a, b) => b.timestamp - a.timestamp)
  }

  /** 保存用户约束到 Memory */
  saveConstraint(planId: string, constraint: UserConstraint): void {
    const ms = getMemoryService()
    if (!ms) return

    ms.addEntry('user_fact', `${MEMORY_CONSTRAINTS_PREFIX}${planId}: ${JSON.stringify(constraint)}`, 0.9, { tier: 'semi' })
    log('INFO', 'writing_plan_constraint_saved', { planId, type: constraint.type })
  }

  /** 查询某个计划的所有用户约束 */
  getConstraints(planId: string): UserConstraint[] {
    const ms = getMemoryService()
    if (!ms) return []

    const allEntries = ms.getEntries()
    const prefix = MEMORY_CONSTRAINTS_PREFIX + planId
    const constraints: UserConstraint[] = []

    for (const entry of allEntries) {
      if (entry.type !== 'user_fact') continue
      if (!entry.content.startsWith(prefix)) continue
      try {
        const jsonStr = entry.content.slice(prefix.length + 2) // skip ": "
        constraints.push(JSON.parse(jsonStr) as UserConstraint)
      } catch {
        // skip parse errors
      }
    }

    return constraints.sort((a, b) => b.createdAt - a.createdAt)
  }

  // ─────────────────────────────────────────────
  //  6. 计划持久化
  // ─────────────────────────────────────────────

  /** 保存重写计划到 Memory */
  private savePlanToMemory(plan: RewritePlan): void {
    const ms = getMemoryService()
    if (!ms) return

    ms.addEntry('writing_feedback', `${MEMORY_PLAN_PREFIX}${plan.planId}: ${JSON.stringify(plan)}`, 0.9, { tier: 'permanent' })
    log('INFO', 'writing_plan_saved_to_memory', { planId: plan.planId, tasks: plan.tasks.length })
  }

  /** 从 Memory 加载重写计划 */
  loadPlanFromMemory(planId: string): RewritePlan | null {
    const ms = getMemoryService()
    if (!ms) return null

    const allEntries = ms.getEntries()
    const prefix = `${MEMORY_PLAN_PREFIX}${planId}: `

    for (const entry of allEntries) {
      if (entry.type !== 'writing_feedback') continue
      if (!entry.content.startsWith(prefix)) continue
      try {
        return JSON.parse(entry.content.slice(prefix.length)) as RewritePlan
      } catch {
        return null
      }
    }

    return null
  }

  /** 更新重写计划的总体进度 */
  updatePlanProgress(planId: string, plan: RewritePlan): void {
    const completedCount = plan.tasks.filter((t) => t.status === 'completed').length
    const totalCount = plan.tasks.length
    plan.overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
    plan.updatedAt = Date.now()

    const currentTasks = plan.tasks.filter((t) => t.status === 'in_progress' || t.status === 'pending')
    if (currentTasks.length === 0) {
      plan.status = 'completed'
    } else {
      const pendingPhases: RewritePhase[] = ['outline', 'rewrite', 'quality_check']
      for (const phase of pendingPhases) {
        const phaseTasks = plan.tasks.filter((t) => t.phase === phase)
        const allDone = phaseTasks.every((t) => t.status === 'completed')
        if (!allDone) {
          plan.currentPhase = phase
          break
        }
      }
    }

    this.savePlanToMemory(plan)
    log('INFO', 'writing_plan_progress_updated', { planId, progress: plan.overallProgress, currentPhase: plan.currentPhase })
  }

  /** 获取下一步待执行的任务 */
  getNextPendingTask(plan: RewritePlan): RewriteTask | null {
    const completedIds = new Set(plan.tasks.filter((t) => t.status === 'completed').map((t) => t.id))

    for (const task of plan.tasks) {
      if (task.status !== 'pending') continue
      const depsMet = task.dependencies.every((depId) => completedIds.has(depId))
      if (depsMet) return task
    }

    return null
  }

  /** 更新单个任务状态 */
  updateTaskStatus(planId: string, taskId: string, status: RewriteTask['status']): RewritePlan | null {
    const plan = this.loadPlanFromMemory(planId)
    if (!plan) return null

    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) return null

    task.status = status
    this.updatePlanProgress(planId, plan)

    // 如果任务完成，记录进度并检查是否可自动触发下一任务
    if (status === 'completed') {
      this.recordProgress(planId, taskId, 'completed', `任务完成: ${task.title}`)

      // 自动查找下一个可执行任务
      const nextTask = this.getNextPendingTask(plan)
      if (nextTask) {
        this.recordProgress(planId, nextTask.id, 'ready', `下一任务就绪: ${nextTask.title} (第${nextTask.chapterNumbers.join('、')}章)`)
        log('INFO', 'writing_plan_next_task_ready', {
          planId,
          nextTaskId: nextTask.id,
          nextTaskTitle: nextTask.title,
        })
      }
    }

    return plan
  }

  // ─────────────────────────────────────────────
  //  Plan Manager 集成
  // ─────────────────────────────────────────────

  /** 在 Plan Manager 中创建开发计划步骤 */
  createPlanSteps(rewritePlan: RewritePlan): string | null {
    const pm = getPlanManager()
    if (!pm) {
      log('WARN', 'writing_plan_no_plan_manager')
      return null
    }

    const phaseLabels: Record<RewritePhase, string> = {
      outline: '📐 调整大纲',
      rewrite: '✍️ 重写章节',
      quality_check: '✅ 质量校验',
    }

    const steps: string[] = []
    const phases: RewritePhase[] = ['outline', 'rewrite', 'quality_check']
    for (const phase of phases) {
      const phaseTasks = rewritePlan.tasks.filter((t) => t.phase === phase)
      if (phaseTasks.length > 0) {
        steps.push(`【${phaseLabels[phase]}】`)
        for (const task of phaseTasks) {
          steps.push(`  - ${task.title} (第${task.chapterNumbers.join(', ')}章)`)
        }
      }
    }

    const plan = pm.createPlan(
      `写作计划: ${rewritePlan.storyName}`,
      `写作计划智能编排 — ${rewritePlan.storyName}，共 ${rewritePlan.tasks.length} 个子任务`,
      steps,
    )

    log('INFO', 'writing_plan_manager_plan_created', { planId: plan.id, title: plan.title, steps: steps.length })
    return plan.id
  }

  // ─────────────────────────────────────────────
  //  辅助方法
  // ─────────────────────────────────────────────

  /** 读取文件内容（支持相对项目根目录或 docs/ 目录） */
  private readFileContent(path: string): string | null {
    try {
      const fullPath = resolve(process.cwd(), path)
      if (!existsSync(fullPath)) {
        const docsPath = resolve(process.cwd(), 'docs', path.replace(/^docs[/\\]/, ''))
        if (existsSync(docsPath)) return readFileSync(docsPath, 'utf-8')
        return null
      }
      if (statSync(fullPath).isDirectory()) return null
      return readFileSync(fullPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** 将设计文档分析结果构建为文本摘要 */
  private buildDesignSummary(analysis: DesignDocAnalysis): string {
    const parts: string[] = []
    parts.push(`故事名称: ${analysis.storyName}`)
    parts.push('')
    parts.push('【齿轮三角核心要素】')
    parts.push(`主题: ${analysis.gearTriangle.theme}`)
    parts.push(`角色: ${analysis.gearTriangle.characters.map((c) => `${c.name}(${c.role}: ${c.arc})`).join(', ')}`)
    parts.push(`冲突: ${analysis.gearTriangle.conflicts.join(', ')}`)
    parts.push(`工业美学: ${analysis.gearTriangle.industrialAesthetics.join(', ')}`)
    parts.push(`叙事风格: ${analysis.gearTriangle.narrativeStyle}`)
    parts.push(`背景设定: ${analysis.gearTriangle.setting}`)
    parts.push('')
    parts.push('【章节指南】')
    for (const g of analysis.chapterGuidelines) {
      parts.push(`第${g.chapterNumber}章 "${g.title}":`)
      parts.push(`  关键点: ${g.keyPoints.join(', ')}`)
      parts.push(`  必需要素: ${g.requiredElements.join(', ')}`)
    }
    parts.push('')
    parts.push('【风格要求】')
    parts.push(analysis.styleRequirements.join('\n'))
    return parts.join('\n')
  }

  /** 标准化 LLM 返回的设计文档分析结果 */
  private normalizeDesignAnalysis(rawData: any, docPath: string): DesignDocAnalysis {
    const gearTriangle: GearTriangleElements = {
      theme: rawData.gearTriangle?.theme || rawData.theme || rawData.coreTheme || '',
      characters: rawData.gearTriangle?.characters || rawData.characters || [],
      conflicts: rawData.gearTriangle?.conflicts || rawData.conflicts || [],
      industrialAesthetics: rawData.gearTriangle?.industrialAesthetics || rawData.industrialAesthetics || [],
      narrativeStyle: rawData.gearTriangle?.narrativeStyle || rawData.narrativeStyle || '',
      setting: rawData.gearTriangle?.setting || rawData.setting || rawData.background || '',
    }

    const chapterGuidelines: ChapterGuideline[] = (
      rawData.chapterGuidelines || rawData.chapters || rawData.chapterGuide || []
    ).map((g: any) => ({
      chapterNumber: g.chapterNumber || g.chapter_number || g.number || 0,
      title: g.title || g.name || '',
      keyPoints: g.keyPoints || g.key_points || g.keyPoints || [],
      requiredElements: g.requiredElements || g.required_elements || g.requiredElements || [],
      trianglePosition: g.trianglePosition || g.triangle_position,
    }))

    return {
      storyName: rawData.storyName || rawData.story_name || rawData.name || rawData.title || '未知',
      gearTriangle,
      chapterGuidelines,
      styleRequirements: rawData.styleRequirements || rawData.style_requirements || rawData.style || [],
      confidence: typeof rawData.confidence === 'number' ? rawData.confidence : 0.7,
    }
  }

  /** 标准化 LLM 返回的章节对比结果 */
  private normalizeCompareResult(
    rawData: any,
    storyName: string,
    chapters: Array<{ path: string; number: number; content: string }>,
  ): ChapterCompareResult {
    const rawDiffs = rawData.chapterDiffs || rawData.chapters || rawData.diffs || []
    const chapterDiffs: ChapterDiff[] = rawDiffs.map((d: any) => ({
      chapterNumber: d.chapterNumber || d.chapter_number || d.number || 0,
      chapterTitle: d.chapterTitle || d.title || '',
      deviationScore: typeof d.deviationScore === 'number' ? d.deviationScore : typeof d.score === 'number' ? d.score : 50,
      issues: (d.issues || d.problems || []).map((issue: any) => ({
        severity: issue.severity || 'minor',
        category: issue.category || 'general',
        description: issue.description || issue.desc || issue.issue || '',
        guideline: issue.guideline || '',
        suggestion: issue.suggestion || issue.suggest || '',
        relatedElement: issue.relatedElement || issue.element,
      })),
    }))

    if (chapterDiffs.length === 0) {
      for (const ch of chapters) {
        chapterDiffs.push({ chapterNumber: ch.number, chapterTitle: `第${ch.number}章`, deviationScore: 0, issues: [] })
      }
    }

    const allIssues = chapterDiffs.flatMap((d) => d.issues)
    const severityOrder = { critical: 0, major: 1, minor: 2 }
    const topIssues = [...allIssues]
      .sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9))
      .slice(0, 5)
      .map((i) => i.description)

    return {
      storyName,
      chapterRange: parseChapterRange(chapters.map((c) => c.path)),
      chapterDiffs,
      summary: {
        totalIssues: allIssues.length,
        criticalCount: allIssues.filter((i) => i.severity === 'critical').length,
        majorCount: allIssues.filter((i) => i.severity === 'major').length,
        minorCount: allIssues.filter((i) => i.severity === 'minor').length,
        topIssues,
      },
    }
  }

  /** 构建重写计划对象 */
  private buildRewritePlan(rawData: any, compareResult: ChapterCompareResult, planId?: string): RewritePlan {
    const rawTasks = rawData.tasks || rawData.subtasks || []
    const tasks: RewriteTask[] = rawTasks.map((t: any, i: number) => ({
      id: t.id || `task_${i + 1}_${Date.now()}`,
      phase: t.phase || 'rewrite',
      title: t.title || t.name || `任务 ${i + 1}`,
      description: t.description || t.desc || '',
      chapterNumbers: t.chapterNumbers || t.chapters || t.chapter_numbers || [],
      dependencies: t.dependencies || t.dependsOn || [],
      status: t.status || 'pending',
      relatedGuidelines: t.relatedGuidelines || t.guidelines || [],
    }))

    // 空结果时基于章节对比自动生成
    if (tasks.length === 0) {
      const criticalChapters = compareResult.chapterDiffs
        .filter((d) => d.issues.some((i) => i.severity === 'critical'))
        .map((d) => d.chapterNumber)

      if (criticalChapters.length > 0) {
        const outlineId = `task_outline_${Date.now()}`
        const rewriteId = `task_rewrite_${Date.now()}`
        const qualityId = `task_quality_${Date.now()}`

        tasks.push({
          id: outlineId, phase: 'outline',
          title: '调整关键章节大纲',
          description: `针对第${criticalChapters.join('、')}章的关键问题调整大纲结构`,
          chapterNumbers: criticalChapters, dependencies: [], status: 'pending', relatedGuidelines: [],
        })
        tasks.push({
          id: rewriteId, phase: 'rewrite',
          title: '重写关键章节',
          description: `根据调整后的大纲重写第${criticalChapters.join('、')}章`,
          chapterNumbers: criticalChapters, dependencies: [outlineId], status: 'pending', relatedGuidelines: [],
        })
        tasks.push({
          id: qualityId, phase: 'quality_check',
          title: '关键章节质量校验',
          description: `校验第${criticalChapters.join('、')}章的重写质量`,
          chapterNumbers: criticalChapters, dependencies: [rewriteId], status: 'pending', relatedGuidelines: [],
        })
      }
    }

    return {
      planId: planId || createPlanId(),
      storyName: compareResult.storyName,
      tasks,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      overallProgress: 0,
      currentPhase: 'outline',
      status: 'active',
    }
  }

  /** 标准化质量校验报告 */
  private normalizeQualityReport(rawData: any, chapterNumber: number, threshold: number): QualityReport {
    const rawScores = rawData.scores || rawData.dimensions || rawData.dimensions || []
    const scores = rawScores.map((s: any) => ({
      dimension: s.dimension || s.name || 'general',
      score: typeof s.score === 'number' ? s.score : 0,
      issues: s.issues || s.problems || [],
      suggestions: s.suggestions || s.suggest || [],
    }))

    const allScores = scores.map((s) => s.score)
    const overallScore = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0
    const criticalIssues = scores.flatMap((s) => s.issues).filter((i) => i.length > 0)

    return {
      chapterNumber,
      chapterTitle: rawData.chapterTitle || `第${chapterNumber}章`,
      scores,
      overallScore,
      passed: overallScore >= threshold,
      criticalIssues: criticalIssues.slice(0, 5),
      threshold,
    }
  }
}

// ===== 单例模块导出 =====

export let writingPlanAgent: WritingPlanAgent | null = null

export function initWritingPlanAgent(chatJsonWithCode: ChatJsonFn): WritingPlanAgent {
  if (!writingPlanAgent) {
    writingPlanAgent = new WritingPlanAgent()
    writingPlanAgent.init(chatJsonWithCode)
  }
  return writingPlanAgent
}
