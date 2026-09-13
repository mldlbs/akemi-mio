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

import { FORM_REGISTRY, isFormKind, type FormBroadcast, type FormBridge, type FormKind } from './types'

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
function detectKind(): FormKind {
  const bridge = readBridge()
  if (bridge && isFormKind(bridge.kind)) return bridge.kind

  // 回退：从 URL 路径末段推断，例如 /src/renderer/pet.html 或 /pet.html
  const path = window.location.pathname
  for (const kind of Object.keys(FORM_REGISTRY) as FormKind[]) {
    const file = FORM_REGISTRY[kind].htmlFile
    if (path.endsWith(`/${file}`) || path === `/${file}`) return kind
  }
  // 再回退：查询串 ?form=pet（便于手工调试）
  const query = new URLSearchParams(window.location.search).get('form')
  if (isFormKind(query)) return query

  // 最终兜底：宠物形态最小、依赖最少，最容易安全渲染
  return 'pet'
}

const currentKind: FormKind = detectKind()

/** 当前窗口的形态标识。模块加载时即确定，运行期不变。 */
export function getFormKind(): FormKind {
  return currentKind
}

/** 当前形态的元数据。 */
export function getFormDescriptor() {
  return FORM_REGISTRY[currentKind]
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
    bridge.broadcast({ from: currentKind, type, payload })
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
