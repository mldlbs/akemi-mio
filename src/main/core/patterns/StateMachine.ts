/**
 * StateMachine — 通用有限状态机
 *
 * 核心抽象：将状态转移矩阵标准化，提供安全的状态转换与守卫机制。
 * 替代 RunState / AgentRuntimeState / PlanStep.status / Plan.status
 * 中重复的 TRANSITIONS const + transition() 方法模式。
 *
 * 用法：
 *   enum MyState { READY, RUNNING, DONE }
 *   const fsm = new StateMachine<MyState>({
 *     [MyState.READY]: [MyState.RUNNING],
 *     [MyState.RUNNING]: [MyState.DONE],
 *     [MyState.DONE]: [MyState.READY],
 *   })
 *   fsm.current                                   // MyState.READY
 *   fsm.canTransition(MyState.RUNNING)            // true
 *   fsm.transition(MyState.RUNNING)               // MyState.RUNNING
 *   fsm.canTransition(MyState.DONE)               // false (跳过 RUNNING)
 *
 * 设计原则：
 * - 无偏见：不关心状态的具体含义，只管理转移规则
 * - 不可变：当前状态通过 current 只读访问，变更通过 transition() 返回新状态
 * - 可扩展：支持 onBefore / onAfter 钩子，支持守卫函数
 * - 安全：非法转移返回 false 而非抛出异常（静默失败模式）
 *   或抛出明确错误（严格模式），由调用方选择
 *
 * 来源分析（从以下模块提取的共性）：
 * - RunContext.transition() — Agent toolLoop 状态转移矩阵 + 安全校验
 * - AgentState — 3D 状态向量中的生命周期维度转移
 * - AgentRuntimeState — Supervisor Worker 状态转移
 * - DevPlan.status / PlanStep.status — 进化计划步骤的状态生命周期
 */
import { log } from '../../logger/Logger'

// ── 类型 ──

/** 转移守卫：返回 true 允许转移，返回 false 阻止 */
export type TransitionGuard<TState extends string> = (
  from: TState,
  to: TState,
) => boolean | Promise<boolean>

/** 转移钩子：转移前/后调用 */
export type TransitionHook<TState extends string> = (
  from: TState,
  to: TState,
) => void | Promise<void>

/** StateMachine 配置 */
export interface StateMachineOptions<TState extends string> {
  /** 日志分类名前缀（默认 'state_machine'） */
  loggerName?: string
  /** 严格模式：非法转移抛出 Error 而非静默失败（默认 false） */
  strict?: boolean
  /** 转移前钩子（在守卫之后、状态变更之前调用） */
  onBefore?: TransitionHook<TState>
  /** 转移后钩子（在状态变更之后调用） */
  onAfter?: TransitionHook<TState>
}

// ── 核心类 ──

export class StateMachine<TState extends string> {
  private readonly transitions: Record<TState, readonly TState[]>
  private readonly loggerName: string
  private readonly strict: boolean
  private readonly onBefore?: TransitionHook<TState>
  private readonly onAfter?: TransitionHook<TState>
  private _current: TState

  /**
   * @param transitions 状态转移矩阵：from → to[]
   * @param initialState 初始状态
   * @param options 可选配置
   */
  constructor(
    transitions: Record<TState, readonly TState[]>,
    initialState: TState,
    options?: StateMachineOptions<TState>,
  ) {
    this.transitions = transitions
    this._current = initialState
    this.loggerName = options?.loggerName ?? 'state_machine'
    this.strict = options?.strict ?? false
    this.onBefore = options?.onBefore
    this.onAfter = options?.onAfter
  }

  // ── 只读访问 ──

  /** 当前状态 */
  get current(): TState {
    return this._current
  }

  /** 获取所有允许的目标状态（从当前状态出发） */
  getAllowedTargets(): readonly TState[] {
    return this.transitions[this._current] ?? []
  }

  /** 从指定状态出发，获取所有允许的目标状态 */
  getAllowedTargetsFrom(state: TState): readonly TState[] {
    return this.transitions[state] ?? []
  }

  /** 获取完整的转移矩阵副本 */
  getTransitionMatrix(): Record<TState, readonly TState[]> {
    return { ...this.transitions }
  }

  // ── 转移判断 ──

  /**
   * 检查从当前状态是否可以转移到目标状态。
   * 不执行守卫和钩子。
   */
  canTransition(to: TState): boolean {
    const allowed = this.transitions[this._current]
    if (!allowed) return false
    return allowed.includes(to)
  }

  /**
   * 检查从指定状态是否可以转移到目标状态。
   * 不执行守卫和钩子。
   */
  canTransitionFrom(from: TState, to: TState): boolean {
    const allowed = this.transitions[from]
    if (!allowed) return false
    return allowed.includes(to)
  }

  // ── 状态转移 ──

  /**
   * 尝试转移到目标状态。
   *
   * @param to 目标状态
   * @param guards 可选守卫列表，全部通过才允许转移
   * @returns true 表示转移成功，false 表示转移被拒绝
   * @throws 严格模式下非法转移抛出 Error
   */
  async transition(to: TState, guards?: TransitionGuard<TState>[]): Promise<boolean> {
    const from = this._current

    // 1. 检查转移矩阵
    if (!this.canTransition(to)) {
      if (this.strict) {
        throw new Error(
          `状态机[${this.loggerName}] 非法转移: ${from} → ${to}`,
        )
      }
      log('WARN', `${this.loggerName}_invalid_transition`, {
        from,
        to,
        allowed: this.transitions[from],
      })
      return false
    }

    // 2. 执行守卫
    if (guards && guards.length > 0) {
      for (const guard of guards) {
        const allowed = await guard(from, to)
        if (!allowed) {
          log('INFO', `${this.loggerName}_guard_blocked`, { from, to })
          return false
        }
      }
    }

    // 3. 执行转移前钩子
    if (this.onBefore) {
      await this.onBefore(from, to)
    }

    // 4. 执行转移
    this._current = to

    log('INFO', `${this.loggerName}_transition`, { from, to })

    // 5. 执行转移后钩子
    if (this.onAfter) {
      await this.onAfter(from, to)
    }

    return true
  }

  /**
   * 同步版 transition。不支持守卫（守卫可以是异步的）。
   * 非法转移时：非严格模式返回 false，严格模式抛出 Error。
   */
  transitionSync(to: TState): boolean {
    const from = this._current

    if (!this.canTransition(to)) {
      if (this.strict) {
        throw new Error(
          `状态机[${this.loggerName}] 非法转移: ${from} → ${to}`,
        )
      }
      return false
    }

    this.onBefore?.(from, to)
    this._current = to
    this.onAfter?.(from, to)

    log('INFO', `${this.loggerName}_transition`, { from, to })
    return true
  }

  /**
   * 重置到初始状态（跳过转移矩阵，直接设置）。
   */
  reset(state: TState): void {
    const from = this._current
    this._current = state
    log('INFO', `${this.loggerName}_reset`, { from, to: state })
  }

  // ── 便捷工厂 ──

  /**
   * 从转移矩阵表创建状态机实例。
   *
   * @example
   * const fsm = StateMachine.create(STATE_TRANSITIONS, 'ready', { loggerName: 'run' })
   */
  static create<TState extends string>(
    transitions: Record<TState, readonly TState[]>,
    initialState: TState,
    options?: StateMachineOptions<TState>,
  ): StateMachine<TState> {
    return new StateMachine(transitions, initialState, options)
  }
}
