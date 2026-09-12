/**
 * BlogAgentService — 博客智能协作工作流 引擎
 *
 * 职责：
 * 1. 管理博客写作会话生命周期
 * 2. 解析自然语言指令（跳过、修改、回退、覆盖）
 * 3. 通过 WorkflowScheduler 派发工作流
 * 4. 分析用户写作习惯，提供个性化建议
 *
 * 与 AgentService 的关系：
 * - AgentService 是通用对话引擎，BlogAgentService 是其上层的领域服务
 * - BlogAgentService 管理会话状态，AgentService 通过 Blog MCP Tools 与它交互
 * - 工作流执行由 WorkflowSchedulerV2 承担
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import {
  type BlogSessionState,
  type ParsedBlogCommand,
  type WritingHabitProfile,
  type BlogCommandType,
  BlogStage,
  BLOG_STAGE_LABELS,
  BLOG_STAGE_ORDER,
  COMMAND_PATTERNS,
  DEFAULT_HABIT_PROFILE,
  BLOG_WORKFLOW_ID,
} from './types'
import { getMemoryService, getBlogModeService } from '@akemi-mio/capabilities/tool/deps'
import { experienceMemoryService } from '@akemi-mio/intelligence-memory/plan-memory-blog/ExperienceMemoryService'
import { blogModeMonitor } from './BlogModeMonitor'
import { BLOG_MODE_LABELS } from './BlogExecutionMode'

// =============================================================================
// 常量
// =============================================================================

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 小时会话过期

// =============================================================================
// BlogAgentService
// =============================================================================

export class BlogAgentService {
  /** 活跃会话 Map<sessionId, state> */
  private sessions = new Map<string, BlogSessionState>()
  /** 写作习惯画像（跨会话持久化） */
  private habitProfile: WritingHabitProfile = { ...DEFAULT_HABIT_PROFILE }

  constructor() {
    this.loadHabitProfile()
    // 定期清理过期会话
    setInterval(() => this.cleanExpiredSessions(), 30 * 60 * 1000)
    log('INFO', 'blog_agent_init', { msg: 'BlogAgentService 已初始化' })
  }

  // ===========================================================================
  // 会话管理
  // ===========================================================================

  /** 开始新的博客写作会话 */
  startSession(topic: string, platform?: string, userInput?: string): BlogSessionState {
    const sessionId = `blog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const state: BlogSessionState = {
      sessionId,
      currentStage: BlogStage.IntentAnalysis,
      previousStage: null,
      skippedStages: [],
      stageStatuses: Object.fromEntries(BLOG_STAGE_ORDER.map((s) => [s, 'pending'])) as Record<
        BlogStage,
        'pending' | 'running' | 'completed' | 'skipped' | 'failed'
      >,
      topic,
      targetPlatform: platform || '',
      targetAudience: '',
      style: '',
      stageOutputs: {},
      userFeedback: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      completed: false,
    }
    state.stageStatuses[BlogStage.IntentAnalysis] = 'running'
    this.sessions.set(sessionId, state)

    // 通知经验记忆引擎：新的博客会话开始
    try {
      if (experienceMemoryService) {
        const result = experienceMemoryService.startBlogSession(topic, sessionId)
        state.experienceReferences = result.references.map((r) => ({
          content: r.memoryEntry.content.slice(0, 200),
          category: r.data.category,
          score: r.score,
          stepDescription: r.data.stepDescription,
        }))
      }
    } catch {
      // 经验引擎不可用不影响核心功能
    }

    // 双模式切换引擎：自动推荐并注册执行模式
    try {
      const modeSvc = getBlogModeService()
      if (modeSvc) {
        const recommendation = modeSvc.startWithModeRecommendation(topic, userInput || topic, this.habitProfile)
        modeSvc.registerSession(sessionId, recommendation.recommendedMode)
        // 更新 monitor 的负载计数
        blogModeMonitor.setActiveSessionCount(this.sessions.size)
        log('INFO', 'blog_session_mode_registered', {
          sessionId,
          mode: recommendation.recommendedMode,
          confidence: recommendation.confidence.toFixed(2),
          reasons: recommendation.reasons.slice(0, 2),
        })
      }
    } catch {
      // 模式引擎不可用不影响核心功能
    }

    log('INFO', 'blog_session_started', { sessionId, topic })
    return state
  }

  /** 获取会话状态 */
  getSession(sessionId: string): BlogSessionState | undefined {
    const s = this.sessions.get(sessionId)
    if (s) s.lastActivityAt = Date.now()
    return s
  }

  /** 获取所有活跃会话 */
  listActiveSessions(): BlogSessionState[] {
    return Array.from(this.sessions.values()).filter((s) => !s.completed)
  }

  /** 更新会话中的阶段输出 */
  updateStageOutput(sessionId: string, stage: BlogStage, output: string, status: 'completed' | 'failed' = 'completed'): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.stageOutputs[stage] = output
    s.stageStatuses[stage] = status
    s.lastActivityAt = Date.now()
  }

  /** 推进到下一阶段 */
  advanceStage(sessionId: string): BlogSessionState | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null

    const currentIdx = BLOG_STAGE_ORDER.indexOf(s.currentStage)
    if (currentIdx < 0) return null

    // 标记当前为完成
    if (s.stageStatuses[s.currentStage] === 'running') {
      s.stageStatuses[s.currentStage] = 'completed'
    }

    // 找下一个未跳过的阶段
    let nextIdx = currentIdx + 1
    while (nextIdx < BLOG_STAGE_ORDER.length) {
      const nextStage = BLOG_STAGE_ORDER[nextIdx]
      if (!s.skippedStages.includes(nextStage)) {
        s.previousStage = s.currentStage
        s.currentStage = nextStage
        s.stageStatuses[nextStage] = 'running'
        s.lastActivityAt = Date.now()
        log('INFO', 'blog_stage_advance', {
          sessionId,
          from: BLOG_STAGE_LABELS[BLOG_STAGE_ORDER[currentIdx]],
          to: BLOG_STAGE_LABELS[nextStage],
        })
        return s
      }
      nextIdx++
    }

    // 所有阶段完成
    s.completed = true
    s.lastActivityAt = Date.now()
    this.recordSessionCompletion(s)
    log('INFO', 'blog_session_completed', { sessionId })
    return s
  }

  /** 标记会话完成 */
  completeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.completed = true
    s.lastActivityAt = Date.now()
    this.recordSessionCompletion(s)
    eventBus.emit('blog.session.completed', { sessionId })
  }

  // ===========================================================================
  // 自然语言指令解析与处理
  // ===========================================================================

  /**
   * 解析用户自然语言指令
   */
  parseCommand(userInput: string): ParsedBlogCommand {
    if (!userInput || !userInput.trim()) {
      return { type: 'unknown', raw: userInput }
    }

    const input = userInput.trim()

    // 按优先级匹配指令类型
    for (const { type, patterns } of COMMAND_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(input)) {
          return this.extractCommandParams(type, input)
        }
      }
    }

    // 如果只是简短肯定响应（好、可以、行），归类为 approve
    if (/^(好|可以|行|嗯|ok|yes|y|go|继续|通过|批准)$/i.test(input.trim())) {
      return { type: 'approve', raw: input }
    }

    return { type: 'unknown', raw: input }
  }

  /**
   * 执行解析后的指令，返回处理结果描述
   */
  executeCommand(sessionId: string, command: ParsedBlogCommand): string {
    const s = this.sessions.get(sessionId)
    if (!s) return '错误：找不到该博客写作会话。请先使用 blog_start_session 开始新的写作。'

    // 记录用户输入到模式 monitor（用于检测交互偏好变化）
    blogModeMonitor.recordUserInput(command.raw)

    // 自动检查是否需要切换模式（异步触发，不阻塞响应）
    if (command.type !== 'status') {
      this.autoCheckModeSwitch(sessionId, command.raw).catch(() => {})
    }

    switch (command.type) {
      case 'skip':
        return this.handleSkip(s, command)
      case 'override':
        return this.handleOverride(s, command)
      case 'modify':
        return this.handleModify(s, command)
      case 'restart':
        return this.handleRestart(s, command)
      case 'approve':
        return this.handleApprove(s, command)
      case 'feedback':
        return this.handleFeedback(s, command)
      case 'status':
        return this.getStatusText(s)
      default:
        // 对未知指令尝试模糊匹配阶段名
        const matchedStage = this.fuzzyMatchStage(command.raw)
        if (matchedStage) {
          return `你提到了「${BLOG_STAGE_LABELS[matchedStage]}」，是否要跳转到该阶段？如是，请说「跳转到${BLOG_STAGE_LABELS[matchedStage]}」。`
        }
        return `我不太理解你的指令。你可以：\n- 说「继续/好」推进到下一步\n- 说「跳过」跳过当前步骤\n- 说「改成XX」修改方向\n- 说「进度」查看当前状态`
    }
  }

  /** 获取当前状态的文字描述 */
  getStatusText(s?: BlogSessionState): string {
    const session = s || (this.listActiveSessions()[0] ?? null)
    if (!session) return '当前没有活跃的博客写作会话。使用「开始写博客」来创建新的。'

    const stageLabel = BLOG_STAGE_LABELS[session.currentStage]
    const completedCount = BLOG_STAGE_ORDER.filter((st) => session.stageStatuses[st] === 'completed').length
    const totalCount = BLOG_STAGE_ORDER.length - session.skippedStages.length
    const progress = Math.round((completedCount / totalCount) * 100)

    // 获取当前执行模式
    const modeSvc = getBlogModeService()
    const currentMode = modeSvc?.getSessionMode(session.sessionId) ?? 'mcp'
    const modeLabel = BLOG_MODE_LABELS[currentMode]

    return [
      `📝 博客写作进度: ${progress}%`,
      `当前阶段: ${stageLabel}`,
      `当前模式: ${modeLabel}`,
      `主题: ${session.topic}`,
      `已完成 ${completedCount}/${totalCount} 个阶段`,
      session.targetPlatform ? `目标平台: ${session.targetPlatform}` : '',
      session.completed ? '✅ 文章已完成！' : '🔵 进行中...',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ===========================================================================
  // 写作习惯分析
  // ===========================================================================

  /** 获取写作习惯画像 */
  getHabitProfile(): WritingHabitProfile {
    return { ...this.habitProfile }
  }

  /** 更新写作习惯画像（基于当前会话） */
  updateHabits(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return

    const profile = this.habitProfile

    // 累计主题
    if (s.topic && !profile.commonTopics.includes(s.topic)) {
      profile.commonTopics.push(s.topic)
      if (profile.commonTopics.length > 20) profile.commonTopics.shift()
    }

    // 累计平台
    if (s.targetPlatform && !profile.commonPlatforms.includes(s.targetPlatform)) {
      profile.commonPlatforms.push(s.targetPlatform)
    }

    // 累计风格
    if (s.style && !profile.stylePreferences.includes(s.style)) {
      profile.stylePreferences.push(s.style)
    }

    // 更新时段偏好
    const hour = new Date().getHours()
    if (profile.preferredHour === null) {
      profile.preferredHour = hour
    }

    profile.totalSessions++
    profile.lastUpdated = Date.now()

    this.saveHabitProfile()
  }

  /** 生成写作建议 */
  generateSuggestions(): string[] {
    const profile = this.habitProfile
    const suggestions: string[] = []

    if (profile.totalSessions > 2) {
      // 习惯分析充足时才给出建议
      if (profile.commonTopics.length > 3) {
        suggestions.push(`你常写的主题有：${profile.commonTopics.slice(0, 3).join('、')}。是否需要围绕这些主题规划系列博客？`)
      }

      if (profile.commonPlatforms.length > 0) {
        suggestions.push(`你常用的发布平台是 ${profile.commonPlatforms[0]}，我已在工作流中优先适配该平台格式。`)
      }

      if (!profile.prefersOutline) {
        suggestions.push('根据历史习惯，你通常直接写初稿而非先出大纲，我已调整流程。')
      }

      if (profile.hasFixedSchedule && profile.preferredPublishDay) {
        const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        suggestions.push(`你通常在 ${days[profile.preferredPublishDay - 1]} 发布文章，是否按此规划发布时间？`)
      }
    }

    return suggestions
  }

  // ===========================================================================
  // 双模式切换辅助
  // ===========================================================================

  /**
   * 自动检查是否需要切换执行模式（异步调用）
   */
  private async autoCheckModeSwitch(sessionId: string, userInput: string): Promise<void> {
    try {
      const modeSvc = getBlogModeService()
      const s = this.sessions.get(sessionId)
      if (!modeSvc || !s) return

      const { switched, recommendation } = await modeSvc.checkAndAutoSwitch(sessionId, s, userInput)
      if (switched && recommendation) {
        log('INFO', 'blog_auto_mode_switched', {
          sessionId,
          to: recommendation.recommendedMode,
          confidence: recommendation.confidence,
        })
        // 如果切换到 plan_chain 模式，标记当前 stage 为自动化执行
        if (recommendation.recommendedMode === 'plan_chain') {
          s.userFeedback.push('[自动切换] 进入 Plan:推理链模式，后续步骤将自动化执行')
        } else {
          s.userFeedback.push('[自动切换] 进入 MCP 交互模式，恢复逐步骤确认')
        }
      }
    } catch (err) {
      // 模式切换失败不影响核心功能
      log('WARN', 'blog_auto_mode_check_failed', { error: String(err) })
    }
  }

  // ===========================================================================
  // 私有辅助方法
  // ===========================================================================

  private handleSkip(s: BlogSessionState, command: ParsedBlogCommand): string {
    // 如果指定了目标阶段
    const targetStage = command.targetStage ? this.fuzzyMatchStage(command.targetStage as string) : s.currentStage

    if (targetStage && BLOG_STAGE_ORDER.includes(targetStage)) {
      if (s.stageStatuses[targetStage] === 'running' || s.stageStatuses[targetStage] === 'pending') {
        s.skippedStages.push(targetStage)
        s.stageStatuses[targetStage] = 'skipped'
        log('INFO', 'blog_skip_stage', { sessionId: s.sessionId, stage: targetStage })
        return `已跳过「${BLOG_STAGE_LABELS[targetStage]}」。${this.nextStepHint(s)}`
      }
      return `「${BLOG_STAGE_LABELS[targetStage]}」已完成或已跳过，无法重复跳过。`
    }

    // 默认跳过当前阶段
    if (!s.skippedStages.includes(s.currentStage)) {
      s.skippedStages.push(s.currentStage)
      s.stageStatuses[s.currentStage] = 'skipped'
      log('INFO', 'blog_skip_stage', { sessionId: s.sessionId, stage: s.currentStage })
      return `已跳过当前步骤「${BLOG_STAGE_LABELS[s.currentStage]}」。${this.nextStepHint(s)}`
    }

    return '当前步骤已被跳过。'
  }

  private handleOverride(s: BlogSessionState, command: ParsedBlogCommand): string {
    if (command.content) {
      s.userFeedback.push(`[覆盖] ${command.content}`)
      log('INFO', 'blog_override', { sessionId: s.sessionId, content: command.content })
      return `已记录你的指示：${command.content}。我会按此方向调整。${this.nextStepHint(s)}`
    }
    return '请告诉我你想改成什么方向。'
  }

  private handleModify(s: BlogSessionState, command: ParsedBlogCommand): string {
    if (command.content) {
      s.userFeedback.push(`[修改] ${command.content}`)
      log('INFO', 'blog_modify', { sessionId: s.sessionId, content: command.content })
      return `已记录修改意见：${command.content}。将在下一步中处理。${this.nextStepHint(s)}`
    }
    return '请告诉我需要修改什么。'
  }

  private handleRestart(s: BlogSessionState, command: ParsedBlogCommand): string {
    const targetStage = command.targetStage ? this.fuzzyMatchStage(command.targetStage as string) : BLOG_STAGE_ORDER[0]

    if (targetStage && BLOG_STAGE_ORDER.includes(targetStage)) {
      const targetIdx = BLOG_STAGE_ORDER.indexOf(targetStage)
      // 重置目标阶段及之后的所有阶段
      for (let i = targetIdx; i < BLOG_STAGE_ORDER.length; i++) {
        const st = BLOG_STAGE_ORDER[i]
        s.stageStatuses[st] = 'pending'
        delete s.stageOutputs[st]
      }
      s.skippedStages = s.skippedStages.filter((st) => BLOG_STAGE_ORDER.indexOf(st) < targetIdx)
      s.previousStage = s.currentStage
      s.currentStage = targetStage
      s.stageStatuses[targetStage] = 'running'
      s.completed = false
      log('INFO', 'blog_restart', { sessionId: s.sessionId, stage: targetStage })
      return `已回退到「${BLOG_STAGE_LABELS[targetStage]}」。请确认是否继续。`
    }

    return `未找到阶段「${command.targetStage}」。可选阶段：${BLOG_STAGE_ORDER.map((st) => BLOG_STAGE_LABELS[st]).join('、')}`
  }

  private handleApprove(s: BlogSessionState, _command: ParsedBlogCommand): string {
    if (s.completed) return '文章已完成！如有新的博客想法，随时告诉我。'
    return `已确认。${this.nextStepHint(s)}`
  }

  private handleFeedback(s: BlogSessionState, command: ParsedBlogCommand): string {
    if (command.content) {
      s.userFeedback.push(`[反馈] ${command.content}`)
      log('INFO', 'blog_feedback', { sessionId: s.sessionId, content: command.content })
      return `已收到反馈：${command.content}。我会在后续步骤中考虑。`
    }
    return '请分享你的想法，我会据此调整。'
  }

  /** 模糊匹配阶段名 */
  private fuzzyMatchStage(text: string): BlogStage | null {
    const lower = text.toLowerCase()
    for (const stage of BLOG_STAGE_ORDER) {
      const label = BLOG_STAGE_LABELS[stage].toLowerCase()
      // 检查用户输入是否包含阶段标签中的关键词
      const keywords = label.replace(/与/g, ' ').replace(/和/g, ' ').split(/\s+/)
      for (const kw of keywords) {
        if (kw.length >= 2 && lower.includes(kw)) return stage
      }
    }
    return null
  }

  /** 从指令文本中提取参数 */
  private extractCommandParams(type: BlogCommandType, input: string): ParsedBlogCommand {
    const result: ParsedBlogCommand = { type, raw: input }

    // 提取内容：跳过/修改/覆盖 后面的具体内容
    const contentMatch = input.match(/(?:跳过|修改|改成|改为|调整为|调整|补充|加(?:一)?个|删掉|减少|不要)\s*(.+)/i)
    if (contentMatch) {
      result.content = contentMatch[1].trim()
    }

    // 提取目标阶段
    const stageMatch = input.match(/(?:回到|回退到|从|跳转到|跳过)\s*(.+?)(?:步骤|阶段|开始|$)/)
    if (stageMatch) {
      result.targetStage = stageMatch[1].trim()
    }

    return result
  }

  /** 下一步提示 */
  private nextStepHint(s: BlogSessionState): string {
    if (s.completed) return '文章已完成！'
    const currentLabel = BLOG_STAGE_LABELS[s.currentStage]
    return `当前处于「${currentLabel}」阶段。说「继续」推进到下一步。`
  }

  /** 记录会话完成到记忆系统 */
  private recordSessionCompletion(s: BlogSessionState): void {
    this.updateHabits(s.sessionId)

    // 持久化到 MemoryService
    try {
      const ms = getMemoryService()
      if (ms) {
        const summary = {
          topic: s.topic,
          platform: s.targetPlatform,
          completedStages: BLOG_STAGE_ORDER.filter((st) => s.stageStatuses[st] === 'completed').map((st) => BLOG_STAGE_LABELS[st]),
          skippedStages: s.skippedStages.map((st) => BLOG_STAGE_LABELS[st]),
          feedbackCount: s.userFeedback.length,
          completedAt: Date.now(),
        }
        ms.saveUserPreference({
          key: `blog_session_${s.sessionId}`,
          value: JSON.stringify(summary),
          confidence: 1.0,
          category: 'preference',
          source: 'BlogAgent',
          updatedAt: Date.now(),
        })
        log('INFO', 'blog_session_saved', { sessionId: s.sessionId, topic: s.topic })
      }
    } catch {
      // 记忆不可用不影响核心功能
    }
  }

  /** 清理过期会话 */
  private cleanExpiredSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivityAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
        // 同时清理模式服务中的会话记录
        try {
          const modeSvc = getBlogModeService()
          modeSvc?.unregisterSession(id)
        } catch {
          // 模式服务不可用不影响
        }
        blogModeMonitor.setActiveSessionCount(this.sessions.size)
        log('INFO', 'blog_session_expired', { sessionId: id })
      }
    }
  }

  /** 从 MemoryService 加载习惯画像 */
  private loadHabitProfile(): void {
    try {
      const ms = getMemoryService()
      if (ms) {
        const prefs = ms.getUserPreferences()
        const habitPref = prefs.find((p) => p.key === 'blog_habit_profile')
        if (habitPref) {
          try {
            const parsed = JSON.parse(habitPref.value) as WritingHabitProfile
            this.habitProfile = { ...DEFAULT_HABIT_PROFILE, ...parsed }
            log('INFO', 'blog_habit_loaded', { totalSessions: this.habitProfile.totalSessions })
          } catch {
            // 解析失败使用默认
          }
        }
      }
    } catch {
      // 记忆不可用时使用默认画像
    }
  }

  /** 保存习惯画像到 MemoryService */
  private saveHabitProfile(): void {
    try {
      const ms = getMemoryService()
      if (ms) {
        ms.saveUserPreference({
          key: 'blog_habit_profile',
          value: JSON.stringify(this.habitProfile),
          confidence: 0.9,
          category: 'preference',
          source: 'BlogAgent',
          updatedAt: Date.now(),
        })
      }
    } catch {
      // 非关键路径
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局 BlogAgentService 单例 */
export const blogAgentService = new BlogAgentService()
