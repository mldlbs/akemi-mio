/**
 * 形态运行时 —— 渲染进程侧的形态感知层。
 *
 * 职责：
 * 1. 识别当前窗口承载的是哪个形态（优先读 preload 注入的标记，回退到 URL 文件名）。
 * 2. 提供跨形态广播/订阅（经主进程中继）。
 * 3. 在 preload 缺失（如纯浏览器调试）时优雅降级为 no-op，绝不让页面炸掉。
 *
 * 降级原则：形态页面必须能在没有 Electron 桥接的环境下渲染出静态样子，
 * 这样 vite devserver 直接访问 pet.html 也能预览，而不是白屏。
 */

import {
  FORM_REGISTRY,
  isFormKind,
  type AgentActivity,
  type BroadcastSource,
  type FormBroadcast,
  type FormBridge,
  type FormKind,
} from './types'

/** 从全局对象上找到 preload 注入的形态桥接。 */
function readBridge(): FormBridge | null {
  const w = window as unknown as { akemiForms?: FormBridge }
  const bridge = w.akemiForms
  if (!bridge || typeof bridge !== 'object') return null
  return bridge
}

/**
 * 推断当前形态。
 *
 * 顺序很关键：先信 preload 的显式声明（主进程最清楚），
 * 再退到 URL 文件名（dev 直连时没有 preload，但文件名仍然是可靠信号）。
 */
/**
 * 推断当前窗口身份：`'shell'`（主壳）或某个形态。
 *
 * 必须**先判主壳**：主壳的 URL（index.html / 根路径 / agent.html）不匹配任何
 * 形态 htmlFile，若让流程继续往下掉，会命中末尾的 `return 'pet'` 兜底 ——
 * 主壳于是谎报自己是宠物。后果是主壳发出的广播被标记为 from:'pet'，
 * 宠物会把主壳的对话状态当成自己的回声，语义彻底错乱。
 */
function detectIdentity(): BroadcastSource {
  const bridge = readBridge()
  if (bridge && isFormKind(bridge.kind)) return bridge.kind

  const path = window.location.pathname

  // 主壳判定：根路径、index.html、agent.html 都算主壳
  if (path.endsWith('/index.html') || path.endsWith('/agent.html') || path === '/' || path === '') {
    return 'shell'
  }

  // 形态判定：从 URL 末段匹配 htmlFile
  for (const kind of Object.keys(FORM_REGISTRY) as FormKind[]) {
    const file = FORM_REGISTRY[kind].htmlFile
    if (path.endsWith(`/${file}`) || path === `/${file}`) return kind
  }

  // 查询串兜底，便于手工调试（?form=pet）
  const query = new URLSearchParams(window.location.search).get('form')
  if (isFormKind(query)) return query
  if (query === 'shell') return 'shell'

  // 最终兜底：宠物形态最小、依赖最少，最容易安全渲染
  return 'pet'
}

const currentIdentity: BroadcastSource = detectIdentity()

/**
 * 当前窗口的形态标识。
 * 主壳返回 'pet' —— 它不渲染形态 UI，这里只是为了满足返回类型，
 * 且兜底到最小形态可保证即使误用也不会崩。需区分主壳请用 isShell()。
 */
export function getFormKind(): FormKind {
  return currentIdentity === 'shell' ? 'pet' : currentIdentity
}

/** 当前窗口是否为主壳。 */
export function isShell(): boolean {
  return currentIdentity === 'shell'
}

/** 广播来源标识（主壳为 'shell'，形态为自身 kind）。 */
export function getBroadcastSource(): BroadcastSource {
  return currentIdentity
}

/**
 * 当前形态的元数据。
 * 主壳返回 pet 的元数据 —— 与 getFormKind() 的兜底策略保持一致
 * （主壳不渲染形态 UI，这里只需保证调用方拿到结构完整的数据而非 undefined）。
 */
export function getFormDescriptor() {
  return FORM_REGISTRY[getFormKind()]
}

/** 当前环境是否具备 Electron 形态桥接。 */
export function hasFormBridge(): boolean {
  return readBridge() !== null
}

/** 切到某形态窗口的显隐；无桥接时返回 false 表示"未生效"。 */
export async function toggleForm(kind: FormKind): Promise<boolean> {
  const bridge = readBridge()
  if (!bridge) return false
  try {
    return await bridge.toggleForm(kind)
  } catch {
    return false
  }
}

export async function setFormVisible(kind: FormKind, visible: boolean): Promise<void> {
  const bridge = readBridge()
  if (!bridge) return
  try {
    await bridge.setFormVisible(kind, visible)
  } catch {
    /* 静默：显隐失败不应打断渲染 */
  }
}

export async function isFormVisible(kind: FormKind): Promise<boolean> {
  const bridge = readBridge()
  if (!bridge) return false
  try {
    return await bridge.isFormVisible(kind)
  } catch {
    return false
  }
}

/** 广播事件到其他形态。无桥接时静默丢弃。 */
export function broadcast(type: string, payload: unknown): void {
  const bridge = readBridge()
  if (!bridge) return
  try {
    // 用 getBroadcastSource() 而非 currentKind 的兜底值：
    // 主壳发出的广播必须标为 'shell'，否则接收方会误判为形态自身回声。
    bridge.broadcast({ from: getBroadcastSource(), type, payload })
  } catch {
    /* 静默 */
  }
}

/**
 * 订阅其他形态的广播。
 * 永远返回一个可调用的取消订阅函数，即便是在降级环境下 —— 调用方无需判空。
 */
export function onBroadcast(handler: (message: FormBroadcast) => void): () => void {
  const bridge = readBridge()
  if (!bridge) return () => {}
  try {
    return bridge.onBroadcast(handler)
  } catch {
    return () => {}
  }
}

/** 设置当前窗口鼠标穿透。 */
export async function setIgnoreMouseEvents(ignore: boolean): Promise<void> {
  const bridge = readBridge()
  if (!bridge) return
  try {
    await bridge.setIgnoreMouseEvents(ignore)
  } catch {
    /* 静默 */
  }
}

/** 触发无边框窗口拖拽。 */
export async function startWindowDrag(): Promise<void> {
  const bridge = readBridge()
  if (!bridge) return
  try {
    await bridge.startWindowDrag()
  } catch {
    /* 静默 */
  }
}

// ════════════════════════════════════════════════════════════════
// 真实数据源订阅（壁纸信息层用）
//
// 这两个数据源都已存在于主壳的 preload 里（electronAPI），
// 壁纸形态直接复用而不是另造 —— 数据本就该只有一份真相。
// 但访问需防御：形态窗口的 preload 与主壳共用，字段仍可能缺失（版本错配、
// 后端未启用），因此一律做形状校验后再交给 UI。
// ════════════════════════════════════════════════════════════════

/** 对话语境：摘要 + 活跃任务进度。壁纸信息卡的主要来源。 */
export interface ConversationContext {
  summary: string
  summaryConfidence: number
  activeTasks: {
    taskId: string
    title: string
    status: string
    progressPercent: number
    completedSteps: number
    totalSteps: number
  }[]
  completedTasks: number
  totalTasks: number
  progressPercent: number
  hasData: boolean
  error?: string
}

/** 记忆卡片：桌面记忆浮窗的数据。 */
export interface MemoryCard {
  id: string
  content: string
  type: string
  confidence: number
  isPinned: boolean
  topics: string[]
  updatedAt: number
}

interface LooseDataBridge {
  onConversationContextData?: (cb: (data: unknown) => void) => (() => void) | void
  onMemoryContextData?: (cb: (data: unknown) => void) => (() => void) | void
}

function readDataBridge(): LooseDataBridge | null {
  const w = window as unknown as { electronAPI?: LooseDataBridge }
  return w.electronAPI ?? null
}

/**
 * 把上游载荷归一为 ConversationContext。载荷形状无编译期保障，逐字段校验。
 * 认不出结构时返回 null，宁可信息卡不显示，也不显示 undefined。
 */
export function parseConversationContext(raw: unknown): ConversationContext | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (d.hasData !== true) return null

  const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)

  const rawTasks = Array.isArray(d.activeTasks) ? d.activeTasks : []
  const activeTasks = rawTasks
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      taskId: str(t.taskId),
      title: str(t.title),
      status: str(t.status),
      progressPercent: num(t.progressPercent),
      completedSteps: num(t.completedSteps),
      totalSteps: num(t.totalSteps),
    }))
    // 没有标题的任务无法展示，直接丢弃而不是渲染空行
    .filter((t) => t.title.length > 0)

  return {
    summary: str(d.summary),
    summaryConfidence: num(d.summaryConfidence),
    activeTasks,
    completedTasks: num(d.completedTasks),
    totalTasks: num(d.totalTasks),
    progressPercent: num(d.progressPercent),
    hasData: true,
    error: typeof d.error === 'string' ? d.error : undefined,
  }
}

/** 归一记忆卡片列表。同一套防御策略。 */
export function parseMemoryCards(raw: unknown): MemoryCard[] {
  if (!raw || typeof raw !== 'object') return []
  const d = raw as Record<string, unknown>
  if (d.hasData !== true) return []
  const cards = Array.isArray(d.cards) ? d.cards : []
  return cards
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      id: typeof c.id === 'string' ? c.id : '',
      content: typeof c.content === 'string' ? c.content : '',
      type: typeof c.type === 'string' ? c.type : '',
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      isPinned: c.isPinned === true,
      topics: Array.isArray(c.topics) ? c.topics.filter((t): t is string => typeof t === 'string') : [],
      updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
    }))
    .filter((c) => c.content.length > 0)
}

/** 订阅对话语境更新。无桥接时返回 no-op 取消函数。 */
export function onConversationContext(handler: (ctx: ConversationContext) => void): () => void {
  const bridge = readDataBridge()
  const subscribe = bridge?.onConversationContextData
  if (typeof subscribe !== 'function') return () => {}
  try {
    const off = subscribe((raw) => {
      const parsed = parseConversationContext(raw)
      if (parsed) handler(parsed)
    })
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/** 订阅记忆卡片更新。 */
export function onMemoryCards(handler: (cards: MemoryCard[]) => void): () => void {
  const bridge = readDataBridge()
  const subscribe = bridge?.onMemoryContextData
  if (typeof subscribe !== 'function') return () => {}
  try {
    const off = subscribe((raw) => {
      const parsed = parseMemoryCards(raw)
      if (parsed.length > 0) handler(parsed)
    })
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/**
 * 订阅镜像过来的 agent 事件（已归一为 AgentActivity）。
 *
 * 形态窗口不在 AgentService 的发送列表里，靠主进程的镜像转发拿到事件。
 * 这里承担两件事：解析脆弱的跨进程载荷 + 归一成语义化的活动描述，
 * 让每个形态都只需处理 `{kind, text}`，而不是各自猜字段。
 */
export function onAgentActivity(handler: (activity: AgentActivity) => void): () => void {
  const bridge = readBridge()
  if (!bridge || typeof bridge.onAgentMirror !== 'function') return () => {}

  try {
    return bridge.onAgentMirror(({ channel, args }) => {
      const activity = normalizeAgentEvent(channel, args)
      if (activity) handler(activity)
    })
  } catch {
    return () => {}
  }
}

/**
 * 把原始镜像事件转成语义化的活动描述。无法理解的事件返回 null（静默忽略）。
 *
 * 载荷形状来自 AgentService / ChatExecutor 的实际发送点：
 *   ai:chunk      → (text: string)
 *   tool:status   → ({ type, tool, message })
 *   agent:state   → ({ state: 'thinking' | 'idle' | ... })
 * 这些形状没有类型保障（跨进程传的是裸值），所以每个分支都做防御性检查。
 */
export function normalizeAgentEvent(channel: string, args: unknown[]): AgentActivity | null {
  if (channel === 'ai:chunk') {
    const text = args[0]
    if (typeof text !== 'string' || text.length === 0) return null
    return { kind: 'speaking', text }
  }

  if (channel === 'tool:status') {
    const payload = args[0] as { type?: unknown; tool?: unknown; message?: unknown } | null
    if (!payload || typeof payload !== 'object') return null
    const tool = typeof payload.tool === 'string' ? payload.tool : ''
    const message = typeof payload.message === 'string' ? payload.message : ''
    // 工具状态既可能表示开始也可能表示结束，用 type 区分；
    // 拿不到 type 时按"正在工作"处理（比误报 done 更安全）。
    if (payload.type === 'end' || payload.type === 'done' || payload.type === 'complete') {
      return { kind: 'done', text: message }
    }
    return { kind: 'tool', text: tool || message }
  }

  if (channel === 'agent:state') {
    const payload = args[0] as { state?: unknown; message?: unknown } | null
    if (!payload || typeof payload !== 'object') return null
    const state = typeof payload.state === 'string' ? payload.state : ''
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (state === 'thinking' || state === 'running') return { kind: 'thinking', text: message }
    if (state === 'error') return { kind: 'error', text: message }
    if (state === 'idle' || state === 'done') return { kind: 'done', text: message }
    return null
  }

  return null
}
