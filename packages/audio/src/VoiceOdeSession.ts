/**
 * VoiceOdeSession — 语音交互 ODE 求解会话管理器
 *
 * 多轮对话会话，管理从 "用户语音 → 参数提取 → 追问补全 → 求解执行 → TTS 播报" 的完整流程。
 *
 * 生命周期：
 *   IDLE → PARSING → (参数完整 → SOLVING → RESULT → IDLE)
 *                    → (参数不完整 → AWAITING → 用户补充 → PARSING → ...)
 *
 * 集成方式：
 *   - VoiceToolOrchestrator.match() 匹配到 ODE 意图后，激活此会话
 *   - 每次新的 ASR 转写文本通过 feed() 输入
 *   - 会话自动判断是否需追问，或直接执行求解
 *   - solve() 调用 solve_ode MCP 工具，结果通过 TTS 播报
 */

import { log, createRequestId } from '@akemi-mio/core/logger/Logger'
import { odeNluParser, type OdeParseResult, type OdeParseDiagnostic } from './OdeNLUParser'

// ════════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════════

/** 会话状态 */
export type OdeSessionState = 'idle' | 'parsing' | 'awaiting' | 'solving' | 'result' | 'error'

/** 会话事件 */
export type OdeSessionEvent =
  | { type: 'state_change'; from: OdeSessionState; to: OdeSessionState }
  | { type: 'parse_result'; parsed: OdeParseResult; diagnostic: OdeParseDiagnostic }
  | { type: 'clarify_needed'; prompts: string[]; missingFields: string[] }
  | { type: 'solve_start' }
  | { type: 'solve_complete'; result: string; yFinal: number; xFinal: number }
  | { type: 'solve_error'; error: string }
  | { type: 'session_end'; reason: string }

/** 会话事件监听器 */
export type OdeSessionListener = (event: OdeSessionEvent) => void

/** 求解结果摘要（供 TTS 使用） */
export interface OdeTtsSummary {
  /** 完整播报文本 */
  fullText: string
  /** 简短播报文本（默认取值） */
  briefText: string
  /** 关键数值 */
  keyValues: Array<{ x: number; y: number; label?: string }>
  /** 结果文件路径 */
  plotPath?: string
}

/** 会话配置 */
export interface OdeSessionConfig {
  /** 默认方法 */
  defaultMethod: 'euler' | 'rk4'
  /** 默认步长 */
  defaultStepSize: number
  /** 最大追问轮数（超过则放弃） */
  maxClarifyRounds: number
  /** 求解超时（ms） */
  solveTimeoutMs: number
}

const DEFAULT_CONFIG: OdeSessionConfig = {
  defaultMethod: 'rk4',
  defaultStepSize: 0.1,
  maxClarifyRounds: 3,
  solveTimeoutMs: 60_000,
}

/** 求解器调用接口（注入模式，方便测试和替换） */
export interface OdeSolverInvoker {
  solve(params: {
    equation: string
    method: string
    initialCondition: string
    interval: [number, number]
    stepSize: number
  }): Promise<{ success: boolean; result?: OdeSolverOutput; error?: string }>
}

/** 求解器输出结构 */
export interface OdeSolverOutput {
  table: string
  plotPath?: string
  method: string
  stepSize: number
  steps: number
  x0: number
  y0: number
  xFinal: number
  yFinal: number
  analyticalNote?: string | null
}

// ════════════════════════════════════════════════════════════════════
//  会话管理器
// ════════════════════════════════════════════════════════════════════

export class VoiceOdeSession {
  /** 当前会话状态 */
  private _state: OdeSessionState = 'idle'
  /** 会话 ID */
  private _sessionId: string = ''
  /** 累积的解析结果 */
  private _parsed: OdeParseResult = { rawText: '' }
  /** 追问轮数 */
  private _clarifyRound = 0
  /** 最后一次解析诊断 */
  private _lastDiagnostic: OdeParseDiagnostic | null = null
  /** 事件监听器 */
  private _listeners: Set<OdeSessionListener> = new Set()
  /** 配置 */
  private _config: OdeSessionConfig
  /** 求解器调用器 */
  private _solver: OdeSolverInvoker | null = null
  /** 最近一次求解输出 */
  private _lastSolution: OdeSolverOutput | null = null

  constructor(config?: Partial<OdeSessionConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── 公开属性 ──

  get state(): OdeSessionState {
    return this._state
  }

  get sessionId(): string {
    return this._sessionId
  }

  get parsed(): OdeParseResult {
    return this._parsed
  }

  get lastDiagnostic(): OdeParseDiagnostic | null {
    return this._lastDiagnostic
  }

  get lastSolution(): OdeSolverOutput | null {
    return this._lastSolution
  }

  get isActive(): boolean {
    return this._state !== 'idle' && this._state !== 'result'
  }

  // ── 配置 ──

  /** 设置求解器调用器 */
  setSolver(solver: OdeSolverInvoker): void {
    this._solver = solver
  }

  /** 注册事件监听 */
  on(listener: OdeSessionListener): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  // ── 会话生命周期 ──

  /**
   * 开始新的 ODE 求解会话。
   * 由 VoiceToolOrchestrator 匹配到 ODE 意图后调用。
   */
  start(initialText?: string): void {
    if (this._state !== 'idle') {
      log('WARN', 'ode_session_already_active', {
        session_id: this._sessionId,
        state: this._state,
      })
      // 重置
      this.reset()
    }

    this._sessionId = `ode_${createRequestId()}`
    this._parsed = { rawText: '' }
    this._clarifyRound = 0
    this._lastDiagnostic = null
    this._lastSolution = null

    this.setState('parsing')
    log('INFO', 'ode_session_started', { session_id: this._sessionId })

    if (initialText) {
      this.feed(initialText)
    }
  }

  /**
   * 输入新的 ASR 转写文本。可在任何状态调用。
   * - PARSING: 尝试提取完整参数
   * - AWAITING: 用户补充缺失参数
   * - 其他状态：文本将被缓存，待合适时机处理
   */
  feed(text: string): void {
    if (!text || !text.trim()) return

    log('INFO', 'ode_session_feed', {
      session_id: this._sessionId,
      state: this._state,
      text: text.slice(0, 100),
      clarify_round: this._clarifyRound,
    })

    // 检查是否包含取消/退出意图
    if (this.isExitIntent(text)) {
      this.emit({
        type: 'session_end',
        reason: 'user_cancelled',
      })
      this.reset()
      return
    }

    // 累积解析
    this._parsed = odeNluParser.merge(this._parsed, text)

    const { diagnostic } = odeNluParser.parse(text)
    this._lastDiagnostic = diagnostic
    this.emit({ type: 'parse_result', parsed: this._parsed, diagnostic })

    if (odeNluParser.isComplete(this._parsed)) {
      // 参数完整 → 执行求解
      this.executeSolve()
    } else if (this._clarifyRound >= this._config.maxClarifyRounds) {
      // 超过最大追问轮数，使用默认值补全
      this.completeWithDefaults()
    } else {
      // 参数不完整 → 进入追问模式
      this.setState('awaiting')
      this._clarifyRound++
      const prompts = odeNluParser.getMissingPrompts(this._parsed)
      this.emit({
        type: 'clarify_needed',
        prompts,
        missingFields: this._lastDiagnostic?.missingRequired || [],
      })
    }
  }

  /**
   * 执行求解。从当前解析结果构造参数并调用求解器。
   */
  async executeSolve(): Promise<void> {
    if (!this._solver) {
      this.setState('error')
      this.emit({ type: 'solve_error', error: '求解器未初始化' })
      return
    }

    // 填充默认值
    const params = this.buildSolveParams()
    if (!params) {
      this.setState('error')
      this.emit({ type: 'solve_error', error: '参数不完整，无法求解' })
      return
    }

    this.setState('solving')
    this.emit({ type: 'solve_start' })

    log('INFO', 'ode_session_solve', {
      session_id: this._sessionId,
      params: JSON.stringify(params),
    })

    try {
      const result = await this._solver.solve(params)

      if (result.success && result.result) {
        this._lastSolution = result.result
        this.setState('result')
        this.emit({
          type: 'solve_complete',
          result: result.result.table,
          yFinal: result.result.yFinal,
          xFinal: result.result.xFinal,
        })
      } else {
        this.setState('error')
        this.emit({ type: 'solve_error', error: result.error || '未知求解错误' })
      }
    } catch (err: unknown) {
      this.setState('error')
      const msg = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'solve_error', error: msg })
    }
  }

  /**
   * 构建 TTS 播报摘要
   */
  buildTtsSummary(): OdeTtsSummary {
    const sol = this._lastSolution
    if (!sol) {
      return {
        fullText: '暂无求解结果。',
        briefText: '暂无结果。',
        keyValues: [],
      }
    }

    const eqDisplay = this._parsed.equation || '方程'
    const methodName = sol.method === 'euler' ? '欧拉法' : '龙格-库塔法'

    // 完整播报
    const fullText =
      `求解完成。${methodName}计算结果：` +
      `当 x 等于 ${sol.xFinal} 时，y 约等于 ${sol.yFinal.toFixed(4)}。` +
      `共计算 ${sol.steps} 步，步长 ${sol.stepSize}。`

    // 简短播报（默认）
    const briefText = `结果：x=${sol.xFinal} 时 y≈${sol.yFinal.toFixed(4)}`

    // 关键数值采样（最多 5 个点）
    const keyValues: Array<{ x: number; y: number }> = []
    const lines = sol.table.split('\n')
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2) {
        const x = parseFloat(parts[0])
        const y = parseFloat(parts[1])
        if (!isNaN(x) && !isNaN(y)) {
          keyValues.push({ x, y })
        }
      }
    }

    return {
      fullText,
      briefText,
      keyValues: keyValues.slice(0, 5),
      plotPath: sol.plotPath,
    }
  }

  /**
   * 重置会话到 IDLE 状态。
   */
  reset(): void {
    const prevState = this._state
    this._state = 'idle'
    this._sessionId = ''
    this._parsed = { rawText: '' }
    this._clarifyRound = 0
    this._lastDiagnostic = null
    this._lastSolution = null
    log('INFO', 'ode_session_reset', { previous_state: prevState })
  }

  // ── 私有方法 ──

  private setState(state: OdeSessionState): void {
    const prev = this._state
    this._state = state
    this.emit({ type: 'state_change', from: prev, to: state })
  }

  private emit(event: OdeSessionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch (err) {
        log('ERROR', 'ode_session_listener_error', {
          event_type: event.type,
          error: String(err),
        })
      }
    }
  }

  /**
   * 检测退出/取消意图。
   */
  private isExitIntent(text: string): boolean {
    const lower = text.toLowerCase().trim()
    const exitPhrases = ['算了', '取消', '不做了', '退出', '结束', 'cancel', 'never mind', 'forget it', 'stop', 'abort', '不要了', '不用了']
    return exitPhrases.some((p) => lower.includes(p))
  }

  /**
   * 从当前解析结果构建求解参数。
   * 缺失的必填字段用默认值填充（如果可能）。
   */
  private buildSolveParams(): {
    equation: string
    method: string
    initialCondition: string
    interval: [number, number]
    stepSize: number
  } | null {
    if (!this._parsed.equation) return null
    if (!this._parsed.initialCondition) return null
    if (!this._parsed.interval) return null

    return {
      equation: this._parsed.equation,
      method: this._parsed.method || this._config.defaultMethod,
      initialCondition: this._parsed.initialCondition,
      interval: this._parsed.interval,
      stepSize: this._parsed.stepSize ?? this._config.defaultStepSize,
    }
  }

  /**
   * 用默认值补全缺失参数并求解。
   */
  private completeWithDefaults(): void {
    log('INFO', 'ode_session_complete_with_defaults', {
      session_id: this._sessionId,
      missing: this._lastDiagnostic?.missingRequired,
    })

    // 用默认值补全
    if (!this._parsed.equation) {
      this.emit({
        type: 'solve_error',
        error: '无法识别微分方程，请重新开始并说清楚方程表达式',
      })
      this.reset()
      return
    }

    if (!this._parsed.initialCondition) {
      this._parsed.initialCondition = 'y(0)=0'
    }

    if (!this._parsed.interval) {
      this._parsed.interval = [0, 1]
    }

    this.executeSolve()
  }
}

// ════════════════════════════════════════════════════════════════════
//  默认求解器调用器（调用 solve_ode MCP 工具）
// ════════════════════════════════════════════════════════════════════

/**
 * 通过 MCP 工具调用 solve_ode 的 Invoker 实现。
 * 从工具 handler 返回的文本中解析求解结果。
 */
export class McpOdeSolverInvoker implements OdeSolverInvoker {
  private toolCaller: { callTool(name: string, args: Record<string, any>): Promise<string> }

  constructor(toolCaller: { callTool(name: string, args: Record<string, any>): Promise<string> }) {
    this.toolCaller = toolCaller
  }

  async solve(params: {
    equation: string
    method: string
    initialCondition: string
    interval: [number, number]
    stepSize: number
  }): Promise<{ success: boolean; result?: OdeSolverOutput; error?: string }> {
    try {
      const output = await this.toolCaller.callTool('solve_ode', {
        equation: params.equation,
        method: params.method,
        initialCondition: params.initialCondition,
        interval: params.interval,
        stepSize: params.stepSize,
      })

      // 从工具输出中提取求解结果
      // 格式：工具返回格式化文本字符串
      const result = this.parseToolOutput(output)
      return { success: true, result }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  /**
   * 从工具输出文本中解析求解结果。
   * 输出格式：
   *   【ODE 数值求解结果】
   *     方程: ...
   *     方法: RK4  (h = 0.1)
   *     步数: 20
   *     初始条件: y(0) = 1
   *     最终值: y(2) = 5.4307
   *     ...
   *     【数值解表】
   *              x                y
   *     ...
   *     【可视化图形】
   *       文件: ...
   */
  private parseToolOutput(output: string): OdeSolverOutput {
    const result: OdeSolverOutput = {
      table: '',
      method: 'rk4',
      stepSize: 0.1,
      steps: 0,
      x0: 0,
      y0: 0,
      xFinal: 0,
      yFinal: 0,
    }

    // 提取方法
    const methodMatch = output.match(/方法:\s*(\S+)\s*\(h\s*=\s*([\d.]+)\)/)
    if (methodMatch) {
      result.method = methodMatch[1].toLowerCase()
      result.stepSize = parseFloat(methodMatch[2])
    }

    // 提取步数
    const stepsMatch = output.match(/步数:\s*(\d+)/)
    if (stepsMatch) {
      result.steps = parseInt(stepsMatch[1], 10)
    }

    // 提取初始条件
    const initMatch = output.match(/初始条件:\s*y\(([\d.]+)\)\s*=\s*([\d.]+)/)
    if (initMatch) {
      result.x0 = parseFloat(initMatch[1])
      result.y0 = parseFloat(initMatch[2])
    }

    // 提取最终值
    const finalMatch = output.match(/最终值:\s*y\(([\d.]+)\)\s*=\s*([\d.]+)/)
    if (finalMatch) {
      result.xFinal = parseFloat(finalMatch[1])
      result.yFinal = parseFloat(finalMatch[2])
    }

    // 提取解析解
    const analyticalMatch = output.match(/解析解:\s*(.+)/)
    if (analyticalMatch) {
      result.analyticalNote = analyticalMatch[1].trim()
    }

    // 提取数值表（【数值解表】和【可视化图形】之间）
    const tableStart = output.indexOf('【数值解表】')
    const plotStart = output.indexOf('【可视化图形】')
    if (tableStart >= 0) {
      const from = tableStart + '【数值解表】'.length
      const to = plotStart >= 0 ? plotStart : output.length
      result.table = output.slice(from, to).trim()
    }

    // 提取绘图路径
    const plotMatch = output.match(/文件:\s*(.+\.png)/)
    if (plotMatch) {
      result.plotPath = plotMatch[1].trim()
    }

    return result
  }
}

/** 全局单例 */
export const voiceOdeSession = new VoiceOdeSession()
