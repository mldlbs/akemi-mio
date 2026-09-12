/**
 * GoalGuardrail — 目标守卫：双级确定性 + 启发式拦截器
 *
 * 在 ChatExecutor.toolLoop() 中，位于 LLM 返回 ToolCall[] 之后、
 * toolScheduler.executeAll() 与 tokenAccount.spend() 之前。
 *
 * 架构：
 *   LLM → parseToolCalls → [GoalGuardrail] → spend + executeAll
 *                              │
 *                    ┌─────────┴──────────┐
 *                    │ 硬守卫 (O(1))       │  ConstitutionEngine 桥接，确定性拒绝
 *                    │ 软守卫 (O(n))       │  目标一致性评分，每轮必检（规则匹配，非模型调用）
 *                    │ 熔断检查            │  RejectionTracker 阈值 → 终止 task flow
 *                    └────────────────────┘
 *
 * ⚠ 设计约束：
 * - 硬守卫永不向 messages 注入上下文（防消息栈污染）
 * - 软守卫注入的前缀为 【目标对齐】，熔断时由 ChatExecutor 清理
 */
import { log } from '@akemi-mio/core/logger/Logger'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { Message } from '@akemi-mio/intelligence/agent/context'
import type { RunContext } from '@akemi-mio/intelligence/agent/runstate'
import type { ConstitutionEngine } from '@akemi-mio/evolution-constitution'
import type { GoalEngine, Goal } from '@akemi-mio/intelligence/cognitive/GoalEngine'
import { RejectionTracker, type RejectionReason, type RejectionTrackerConfig } from './RejectionTracker'
import type { SystemBus } from '@akemi-mio/core/core/SystemBus'
import { eventBus } from '@akemi-mio/core/core/EventBus'

// ───── 类型导出 ─────

export interface GoalGuardrailConfig {
  /** 硬守卫规则（启动时从 ConstitutionEngine 加载） */
  hardGuardPaths: string[]
  /** 软守卫评估间隔（第 1 轮每轮必检，预留未来降频扩展） */
  softCheckInterval: number
  /** 熔断阈值配置，透传 RejectionTracker */
  rejection: Partial<RejectionTrackerConfig>
}

export type GuardDecision =
  | { status: 'approved'; toolCalls: ToolCallInfo[] }
  | {
      status: 'denied'
      reason: RejectionReason
      /** 是否允许 LLM 重试（硬拒绝=false，软拒绝=true） */
      canRetry: boolean
      /** 注入给 LLM 的消息内容 */
      message: string
      /** 此拒绝是否已注入到 messages（硬拒绝不注入，调用方需清理软注入） */
      injected: boolean
    }

/**
 * 写操作工具名集合（用于 ConstitutionEngine 路径检查）
 */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'exec_command',
  'create_dev_plan',
  'update_plan_progress',
  'set_credential',
  'enable_skill',
  'disable_skill',
  'remove_mcp_server',
])

// ───── GoalGuardrail ─────

export class GoalGuardrail {
  private goalEngine: GoalEngine | null
  private constitutionEngine: ConstitutionEngine | null
  private rejectionTracker: RejectionTracker
  private config: Required<GoalGuardrailConfig>
  private systemBus: SystemBus | null = null
  /** 上一轮是否拒绝了（用于状态驱动的高频检测窗口） */
  private previousTurnDenied = false

  constructor(goalEngine: GoalEngine | null, constitutionEngine: ConstitutionEngine | null, config?: Partial<GoalGuardrailConfig>) {
    this.goalEngine = goalEngine
    this.constitutionEngine = constitutionEngine
    this.config = {
      hardGuardPaths: config?.hardGuardPaths ?? [],
      softCheckInterval: config?.softCheckInterval ?? 1, // 第 1 轮每轮必检
      rejection: config?.rejection ?? {},
    }
    this.rejectionTracker = new RejectionTracker(this.config.rejection)
  }

  // ───── 主入口 ─────

  /**
   * 对 LLM 返回的一批工具调用进行守卫检查。
   * 调用时机：toolLoop 中 LLM 返回 toolCalls 后、spend + executeAll 之前。
   *
   * 执行顺序：
   *   1. 熔断检查 → 硬拒绝（不可重试，不注入消息）
   *   2. 硬守卫 → 宪法路径拦截（不可重试，不注入消息）
   *   3. 软守卫 → 目标一致性评分（可重试，注入 【目标对齐】消息）
   */
  async checkBatch(toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): Promise<GuardDecision> {
    if (!toolCalls.length) {
      return { status: 'approved', toolCalls }
    }

    const step = ctx?.step ?? -1

    // ── 1. 熔断检查 ──
    if (this.rejectionTracker.shouldTrip()) {
      this.previousTurnDenied = true
      log('WARN', 'goal_guardrail_tripped', {
        count: this.rejectionTracker.getStats().count,
        threshold: this.config.rejection.threshold ?? 3,
      })
      eventBus.emit('goal.guardrail.tripped', {
        count: this.rejectionTracker.getStats().count,
        threshold: this.config.rejection.threshold ?? 3,
      })
      // 硬拒绝：不 inject 到 messages，由 ChatExecutor 处理终止
      return {
        status: 'denied',
        reason: 'MAX_REJECTION_EXCEEDED',
        canRetry: false,
        message: '',
        injected: false,
      }
    }

    // ── 2. 硬守卫：宪法路径 + 不可变操作（O(1)，无 LLM 参与） ──
    for (const tc of toolCalls) {
      const hardBlocked = this.checkHardBlock(tc)
      if (hardBlocked) {
        this.rejectionTracker.record('HARD_BLOCK', tc.name)
        this.previousTurnDenied = true
        log('WARN', 'goal_guardrail_hard_block', { tool: tc.name, args: tc.arguments })
        eventBus.emit('goal.guardrail.rejection', { reason: 'HARD_BLOCK', toolName: tc.name, step })
        // 硬拒绝：不 inject 到 messages，通过 AuditTrail 落地
        return {
          status: 'denied',
          reason: 'CONSTITUTION_VIOLATION' as RejectionReason,
          canRetry: false,
          message: '',
          injected: false,
        }
      }
    }

    // ── 3. 软守卫：目标一致性评估（每轮必检，规则匹配 O(n)） ──
    const softScore = await this.evaluateConsistency(toolCalls)
    if (softScore < 0.5) {
      this.rejectionTracker.record('GOAL_DRIFT', toolCalls.map((t) => t.name).join(','))
      this.previousTurnDenied = true
      eventBus.emit('goal.guardrail.rejection', { reason: 'GOAL_DRIFT', toolName: toolCalls.map((t) => t.name).join(','), step })
      const denial = this.buildGoalDriftDecision(softScore)
      // 软拒绝：注入到 messages，供 LLM 调整策略
      messages.push({ role: 'user' as const, content: (denial as Extract<GuardDecision, { status: 'denied' }>).message })
      return denial
    }

    // ── 守卫通过 ──
    this.previousTurnDenied = false
    return { status: 'approved', toolCalls }
  }

  /** 在工具成功执行后调用（信用恢复 & 重置上一轮拒绝状态） */
  onToolSuccess(): void {
    this.rejectionTracker.onToolSuccess()
    this.previousTurnDenied = false
  }

  /** 获取熔断统计 */
  getRejectionStats(): ReturnType<RejectionTracker['getStats']> {
    return this.rejectionTracker.getStats()
  }

  /** 重置拒绝记录（跨会话/跨 toolLoop 时调用） */
  resetRejectionTracking(): void {
    this.rejectionTracker.reset()
    this.previousTurnDenied = false
  }

  /** 获取上游组件引用（用于 ChatExecutor 构建 AuditTrail 消息） */
  getConstitutionEngine(): ConstitutionEngine | null {
    return this.constitutionEngine
  }

  /**
   * 延迟绑定：在 AppRuntime 初始化 CognitiveService 后注入 GoalEngine。
   * 匹配 AgentService 的 9 阶段启动模式。
   */
  setGoalEngine(engine: GoalEngine | null): void {
    this.goalEngine = engine
    log('INFO', 'goal_guardrail_goal_engine_bound', { hasEngine: engine !== null })
  }

  /**
   * 延迟绑定：在 AppRuntime 初始化 ConstitutionEngine 后注入。
   */
  setConstitutionEngine(engine: ConstitutionEngine | null): void {
    this.constitutionEngine = engine
    log('INFO', 'goal_guardrail_constitution_engine_bound', { hasEngine: engine !== null })
  }

  /**
   * 延迟绑定 SystemBus（由 AppRuntime Phase 6 注入）。
   * 注入后软守卫将从 SystemBus 查询多因子 utility-score。
   */
  setSystemBus(bus: SystemBus | null): void {
    this.systemBus = bus
    log('INFO', 'goal_guardrail_systembus_bound', { hasBus: bus !== null })
  }

  // ───── 硬守卫 ─────

  /**
   * 硬守卫：确定性规则检查。
   * - 写操作 → 委托 ConstitutionEngine.checkWrite() 检查路径
   * - 不可变工具名 → 直接拦截
   */
  private checkHardBlock(tc: ToolCallInfo): boolean {
    if (!WRITE_TOOLS.has(tc.name)) return false

    if (this.constitutionEngine) {
      const path = this.extractPathArg(tc)
      if (path) {
        const check = this.constitutionEngine.checkWrite(path)
        if (!check.allowed) return true
      }
    }

    return false
  }

  /**
   * 从 ToolCallInfo.arguments 中提取路径参数。
   * 支持多种参数命名（path / file_path）。
   */
  private extractPathArg(tc: ToolCallInfo): string | null {
    try {
      const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
      if (!args || typeof args !== 'object') return null
      return ((args as Record<string, unknown>).path as string) ?? ((args as Record<string, unknown>).file_path as string) ?? null
    } catch {
      return null
    }
  }

  // ───── 软守卫 ─────

  /**
   * 软守卫：目标一致性评分。
   *
   * 第 2 轮实现：如果 SystemBus 在线，优先查询多因子 utility-score；
   * 否则回退到启发式规则匹配。
   *
   * 评分规则：
   * - SystemBus 在线：返回 aggregated UtilityScore（0-1）
   * - SystemBus 离线：同 Week 1——基于活跃目标类别与工具名的规则匹配
   * - 没有活跃目标 → 1.0（不拦截）
   *
   * 状态驱动高频检测：当 previousTurnDenied = true 时，评分额外 -0.2
   */
  private async evaluateConsistency(toolCalls: ToolCallInfo[]): Promise<number> {
    // 如果 SystemBus 在线，使用多因子 utility score
    if (this.systemBus) {
      const result = await this.systemBus.query<number>('utility-score', {
        toolCallName: toolCalls[0]?.name,
        toolCallArgs: toolCalls[0]?.arguments,
      })
      const baseScore = result.composite ?? 0.5
      // 连续偏离惩罚
      const penalty = this.previousTurnDenied ? 0.2 : 0
      return Math.max(0, Math.min(1, baseScore - penalty))
    }

    // 回退到启发式规则
    if (!this.goalEngine) return 1.0

    const activeGoals: Goal[] = this.goalEngine.getActiveGoals()
    if (activeGoals.length === 0) return 1.0

    const toolNames = new Set(toolCalls.map((t) => t.name))
    const goalCategories = new Set(activeGoals.map((g) => g.category))

    if (this.previousTurnDenied) {
      const stillDrifting = this.detectGoalDrift(toolNames, goalCategories)
      if (stillDrifting) return 0.3
    }

    return this.detectGoalDrift(toolNames, goalCategories) ? 0.4 : 0.9
  }

  /**
   * 检测目标漂移。
   *
   * 规则（第 1 轮启发式）：
   * - long_term / mission 目标活跃时，不应被短平快工具打断
   * - short_term / initiative 目标活跃时，许可范围较宽松
   */
  private detectGoalDrift(toolNames: Set<string>, goalCategories: Set<string>): boolean {
    const hasSignificantGoal = goalCategories.has('long_term') || goalCategories.has('mission')
    if (!hasSignificantGoal) return false

    const quickTools = new Set(['run_command', 'list_files', 'list_plans', 'list_skills'])
    const allQuick = [...toolNames].every((t) => quickTools.has(t))

    return allQuick
  }

  /**
   * 构建 GOAL_DRIFT 拒绝决策。
   * 根据偏离分数生成不同强度的对齐提示。
   */
  private buildGoalDriftDecision(score: number): GuardDecision {
    const severity: 'mild' | 'moderate' | 'severe' = score <= 0.3 ? 'severe' : score < 0.5 ? 'moderate' : 'mild'

    const messages: Record<string, string> = {
      mild: '【目标对齐】当前操作与既定目标的关联度较低，请确认你的策略方向是否正确。',
      moderate: '【目标对齐】检测到操作方向偏离活跃目标。请暂停当前工具链，重新评估优先级后再继续。',
      severe: '【目标对齐】连续偏离既定目标。建议立即检查当前计划是否仍然有效，必要时切换回正轨。',
    }

    return {
      status: 'denied',
      reason: 'GOAL_DRIFT',
      canRetry: true,
      message: messages[severity],
      injected: true,
    }
  }
}
