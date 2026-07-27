/**
 * VoiceConfirmationSession — 语音确认多轮会话管理器
 *
 * 为语音工具编排提供多轮语音确认能力，替代阻塞的 window.confirm() 弹窗。
 * 用户可以通过语音确认、修改参数或取消操作，无需鼠标/键盘交互。
 *
 * 生命周期：
 *   IDLE → AWAITING_CONFIRM → (用户确认 → CONFIRMED)
 *                           → (用户取消 → REJECTED → IDLE)
 *                           → (用户想修改 → MODIFYING → AWAITING_CONFIRM)
 *                           → (超时 → TIMEOUT → IDLE)
 *
 * 设计模式：参考 VoiceOdeSession，但泛化为任意工具链的确认场景。
 *
 * 集成方式：
 *   - 在 VoiceToolOrchestrator.match() 匹配到需要确认的意图后激活此会话
 *   - 每次 ASR 转写文本通过 feed() 输入
 *   - 会话自动判断用户意图（确认/取消/修改/问题）
 *   - 需要 TTS 播报的场景由事件回调处理
 */

import { log, createRequestId } from '../logger/Logger'

// ════════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════════

/** 会话状态 */
export type ConfirmSessionState =
  | 'idle'
  | 'awaiting_confirm'
  | 'modifying'
  | 'confirmed'
  | 'rejected'
  | 'timeout'
  | 'error'

/** 用户在确认环节的响应 */
export type ConfirmResponse =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'modify'; text: string; changes?: Record<string, string> }
  | { type: 'question'; text: string }
  | { type: 'unclear'; text: string }

/** 会话事件 */
export type ConfirmSessionEvent =
  | { type: 'state_change'; from: ConfirmSessionState; to: ConfirmSessionState }
  | { type: 'confirm_requested'; intentName: string; confirmMessage: string; slots: Record<string, string>; tools: Array<{ tool: string; args: Record<string, string> }> }
  | { type: 'confirm_received'; response: ConfirmResponse; responseText: string }
  | { type: 'modify_received'; modifiedSlots: Record<string, string>; modifyText: string }
  | { type: 'question_received'; question: string }
  | { type: 'session_complete'; result: 'confirmed' | 'rejected' | 'timeout'; intentName: string }
  | { type: 'session_error'; error: string }

/** 会话事件监听器 */
export type ConfirmSessionListener = (event: ConfirmSessionEvent) => void

/** 会话配置 */
export interface ConfirmSessionConfig {
  /** 最大等待确认时长（毫秒） */
  timeoutMs: number
  /** 最大修改轮数（超过则视为超时） */
  maxModifyRounds: number
  /** 是否需要用户明确说"确认"才能执行，还是默认确认 */
  requireExplicitConfirm: boolean
  /** 重试提示文案 */
  retryPrompt: string
  /** 超时提示文案 */
  timeoutPrompt: string
}

const DEFAULT_CONFIG: ConfirmSessionConfig = {
  timeoutMs: 30000,
  maxModifyRounds: 2,
  requireExplicitConfirm: true,
  retryPrompt: '抱歉没有听清，请问是否执行这个操作？请说"确认"或"取消"。',
  timeoutPrompt: '确认超时，操作已取消。如需执行请重新说一遍。',
}

// ════════════════════════════════════════════════════════════════════
//  确认短语匹配（本地关键词，无需 LLM）
// ════════════════════════════════════════════════════════════════════

/** 确认短语 */
const CONFIRM_PHRASES = [
  '确认', '是的', '对的', '没错', '确定', '执行',
  '是', '好', '行', '可以', '没问题', '好的',
  '确认执行', '是的执行', '开始', '开始吧', '搞',
  'confirm', 'yes', 'ok', 'sure', 'go ahead', 'do it', 'yeah',
  '执行吧', '可以执行', '就这样', '可以了',
  '来吧', '开始弄', '开始搞',
]

/** 取消短语 */
const REJECT_PHRASES = [
  '取消', '取消操作', '不要', '不', '不行', '错了',
  '算了', '撤回', '停止', '停下', '别', '不用',
  'cancel', 'no', 'stop', 'abort', 'never mind', 'nope',
  '不要了', '不用了', '不需要', '取消吧', '算了算了',
  '不执行', '别弄', '算了不要了',
]

/** 修改短语 */
const MODIFY_PHRASES = [
  '改', '修改', '换个', '换个方式', '换一个',
  '不是这个', '不对', '不是',
  'change', 'modify', 'different', 'instead',
  '换', '替换', '重新', '换一下',
  '我要', '我想', '我的意思是',
]

/**
 * 从用户文本判断确认响应。
 * 纯本地关键词匹配，不依赖 LLM。
 */
export function classifyConfirmResponse(text: string): ConfirmResponse {
  const lower = text.trim().toLowerCase()
  if (!lower) return { type: 'unclear', text }

  // 先检查修改意图（避免"不"触发取消但实际是"不是这个，我要修改"）
  const isModify = MODIFY_PHRASES.some((p) => lower.includes(p))
  // 再检查确认/取消
  const isConfirm = CONFIRM_PHRASES.some((p) => lower.includes(p))
  const isReject = REJECT_PHRASES.some((p) => lower.includes(p))

  // 修改优先：如果既包含修改又包含确认，视为修改
  if (isModify && !isConfirm && !isReject) {
    return { type: 'modify', text }
  }

  if (isConfirm && !isReject) {
    return { type: 'confirm' }
  }

  if (isReject) {
    return { type: 'reject' }
  }

  // 检查是否在提问
  if (lower.includes('什么') || lower.includes('？') || lower.includes('?') ||
      lower.includes('怎么') || lower.includes('为什么') || lower.includes('哪些') ||
      lower.includes('哪里') || lower.includes('谁') || lower.includes('吗')) {
    return { type: 'question', text }
  }

  // 如果包含修改词但同时也包含了确认/取消词，按确认/取消处理
  if (isModify) {
    return { type: 'modify', text }
  }

  return { type: 'unclear', text }
}

// ════════════════════════════════════════════════════════════════════
//  会话管理器
// ════════════════════════════════════════════════════════════════════

export class VoiceConfirmationSession {
  private _state: ConfirmSessionState = 'idle'
  private _sessionId = ''
  private _intentName = ''
  private _confirmMessage = ''
  private _slots: Record<string, string> = {}
  private _tools: Array<{ tool: string; args: Record<string, string> }> = []
  private _modifyRound = 0
  private _listeners: Set<ConfirmSessionListener> = new Set()
  private _config: ConfirmSessionConfig
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private _startTime = 0

  constructor(config?: Partial<ConfirmSessionConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── 公开属性 ──

  get state(): ConfirmSessionState {
    return this._state
  }

  get sessionId(): string {
    return this._sessionId
  }

  get intentName(): string {
    return this._intentName
  }

  get confirmMessage(): string {
    return this._confirmMessage
  }

  get slots(): Record<string, string> {
    return { ...this._slots }
  }

  get tools(): Array<{ tool: string; args: Record<string, string> }> {
    return [...this._tools]
  }

  get isActive(): boolean {
    return this._state === 'awaiting_confirm' || this._state === 'modifying'
  }

  get modifyRound(): number {
    return this._modifyRound
  }

  /** 已耗时（毫秒） */
  get elapsedMs(): number {
    if (this._startTime === 0) return 0
    return Date.now() - this._startTime
  }

  // ── 配置 ──

  /** 更新配置 */
  updateConfig(partial: Partial<ConfirmSessionConfig>): void {
    Object.assign(this._config, partial)
  }

  /** 注册事件监听 */
  on(listener: ConfirmSessionListener): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  // ── 会话生命周期 ──

  /**
   * 开始新的确认会话。
   * 在 VoiceToolOrchestrator.match() 匹配到需要确认的意图后调用。
   */
  start(params: {
    intentName: string
    confirmMessage: string
    slots: Record<string, string>
    tools: Array<{ tool: string; args: Record<string, string> }>
  }): void {
    if (this.isActive) {
      this.cancelTimeout()
      this.resetState()
    }

    this._sessionId = `vconf_${createRequestId()}`
    this._intentName = params.intentName
    this._confirmMessage = params.confirmMessage
    this._slots = { ...params.slots }
    this._tools = [...params.tools]
    this._modifyRound = 0
    this._startTime = Date.now()

    this.setState('awaiting_confirm')

    this.emit({
      type: 'confirm_requested',
      intentName: this._intentName,
      confirmMessage: this._confirmMessage,
      slots: this._slots,
      tools: this._tools,
    })

    // 启动超时定时器
    this.startTimeout()

    log('INFO', 'voice_confirm_session_start', {
      session_id: this._sessionId,
      intent: this._intentName,
      slotCount: Object.keys(this._slots).length,
      toolCount: this._tools.length,
      timeoutMs: this._config.timeoutMs,
    })
  }

  /**
   * 输入用户的语音响应文本。
   * 在 AWAITING_CONFIRM 或 MODIFYING 状态时调用。
   */
  feed(text: string): void {
    if (!this.isActive) return

    const trimmed = text.trim()
    if (!trimmed) {
      this.handleUnclear('')
      return
    }

    // 检查退出意图
    if (this.isExitIntent(trimmed)) {
      this.reject('user_exit')
      return
    }

    const response = classifyConfirmResponse(trimmed)

    this.emit({
      type: 'confirm_received',
      response,
      responseText: trimmed,
    })

    switch (response.type) {
      case 'confirm':
        this.confirm()
        break
      case 'reject':
        this.reject('user_rejected')
        break
      case 'modify':
        this.handleModify(response.text)
        break
      case 'question':
        this.handleQuestion(response.text)
        break
      case 'unclear':
        this.handleUnclear(trimmed)
        break
    }
  }

  /**
   * 手动确认操作（由外部逻辑触发，如 UI 按钮点击）。
   */
  confirm(): void {
    if (!this.isActive) return
    this.cancelTimeout()

    this.setState('confirmed')
    this.emit({
      type: 'session_complete',
      result: 'confirmed',
      intentName: this._intentName,
    })

    log('INFO', 'voice_confirm_session_confirmed', {
      session_id: this._sessionId,
      intent: this._intentName,
      elapsed_ms: this.elapsedMs,
    })
  }

  /**
   * 手动拒绝操作。
   */
  reject(reason: 'user_rejected' | 'user_exit' | 'timeout' = 'user_rejected'): void {
    if (!this.isActive && this._state === 'idle') return
    this.cancelTimeout()

    this.setState(reason === 'timeout' ? 'timeout' : 'rejected')
    this.emit({
      type: 'session_complete',
      result: reason === 'timeout' ? 'timeout' : 'rejected',
      intentName: this._intentName,
    })

    log('INFO', 'voice_confirm_session_rejected', {
      session_id: this._sessionId,
      intent: this._intentName,
      reason,
      elapsed_ms: this.elapsedMs,
    })
  }

  /**
   * 重置会话到 IDLE 状态。
   */
  reset(): void {
    this.cancelTimeout()
    this.resetState()

    log('INFO', 'voice_confirm_session_reset', {
      previous_state: this._state,
    })
  }

  // ── 私有方法 ──

  private setState(state: ConfirmSessionState): void {
    const prev = this._state
    this._state = state
    this.emit({ type: 'state_change', from: prev, to: state })
  }

  private emit(event: ConfirmSessionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch (err) {
        log('ERROR', 'voice_confirm_listener_error', {
          event_type: event.type,
          error: String(err),
        })
      }
    }
  }

  private startTimeout(): void {
    this.cancelTimeout()
    this._timeoutTimer = setTimeout(() => {
      log('INFO', 'voice_confirm_timeout', {
        session_id: this._sessionId,
        intent: this._intentName,
        timeout_ms: this._config.timeoutMs,
      })
      // 超时前发出语音提示
      this.emit({
        type: 'session_error',
        error: this._config.timeoutPrompt,
      })
      this.reject('timeout')
    }, this._config.timeoutMs)
  }

  private cancelTimeout(): void {
    if (this._timeoutTimer !== null) {
      clearTimeout(this._timeoutTimer)
      this._timeoutTimer = null
    }
  }

  private resetState(): void {
    this._state = 'idle'
    this._sessionId = ''
    this._intentName = ''
    this._confirmMessage = ''
    this._slots = {}
    this._tools = []
    this._modifyRound = 0
    this._startTime = 0
    this.cancelTimeout()
  }

  /**
   * 处理修改请求。
   * 用户说"改一下"或"不是这个"等，重新进入等待确认。
   */
  private handleModify(text: string): void {
    this._modifyRound++

    if (this._modifyRound > this._config.maxModifyRounds) {
      log('INFO', 'voice_confirm_max_modify', {
        session_id: this._sessionId,
        intent: this._intentName,
        maxRounds: this._config.maxModifyRounds,
      })
      this.reject('user_rejected')
      return
    }

    this.setState('modifying')

    // 从修改文本中尝试提取新参数（简单启发式）
    const extractedChanges = this.extractChangesFromText(text)

    this.emit({
      type: 'modify_received',
      modifiedSlots: extractedChanges,
      modifyText: text,
    })

    // 重置超时定时器
    this.startTimeout()

    log('INFO', 'voice_confirm_modify', {
      session_id: this._sessionId,
      intent: this._intentName,
      round: this._modifyRound,
      maxRounds: this._config.maxModifyRounds,
      extractedChanges: Object.keys(extractedChanges).length,
    })

    // 回到等待确认状态
    this.setState('awaiting_confirm')
  }

  /**
   * 处理用户提问。
   * 用户问"这是什么操作"等，不改变状态，只是通知上层。
   */
  private handleQuestion(text: string): void {
    this.emit({
      type: 'question_received',
      question: text,
    })

    log('INFO', 'voice_confirm_question', {
      session_id: this._sessionId,
      question: text.slice(0, 80),
    })

    // 重置超时定时器（用户还有沟通意愿）
    this.startTimeout()
  }

  /**
   * 处理模糊响应（没听清/不理解）。
   * 发送重试提示。
   */
  private handleUnclear(text: string): void {
    log('INFO', 'voice_confirm_unclear', {
      session_id: this._sessionId,
      text: text.slice(0, 80),
    })

    this.emit({
      type: 'session_error',
      error: this._config.retryPrompt,
    })

    // 更新超时（重新计时）
    this.startTimeout()
  }

  /**
   * 从修改文本中尝试提取参数变更。
   * 简单启发式：提取文件名、路径、数字等。
   */
  private extractChangesFromText(text: string): Record<string, string> {
    const changes: Record<string, string> = {}

    // 尝试提取文件名（带扩展名）
    const fileMatch = text.match(/([\w-]+\.(?:ts|tsx|js|jsx|json|py|md|txt|css|html))/i)
    if (fileMatch) {
      changes.filename = fileMatch[1]
    }

    // 尝试提取路径
    const pathMatch = text.match(/(?:路径|目录|文件夹|path|dir)\s*[：:]\s*([^\s,，]+)/i)
    if (pathMatch) {
      changes.path = pathMatch[1]
    }

    // 尝试提取搜索词
    const searchMatch = text.match(/(?:搜索|查找|搜|search|find)\s*[：:]?\s*[""'']?([^""''\s,，]{2,})[""'']?/i)
    if (searchMatch) {
      changes.pattern = searchMatch[1]
    }

    return changes
  }

  /**
   * 检测退出/取消意图。
   */
  private isExitIntent(text: string): boolean {
    const lower = text.toLowerCase().trim()
    const exitPhrases = [
      '算了', '取消', '不做了', '退出', '结束', '不说了',
      'cancel', 'never mind', 'forget it', 'stop', 'abort',
      '不要了', '不用了', '没事了', '没什么',
    ]
    return exitPhrases.some((p) => lower.includes(p))
  }
}

/** 全局单例 */
export const voiceConfirmationSession = new VoiceConfirmationSession()
