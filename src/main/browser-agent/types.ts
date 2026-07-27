/**
 * types — Browser Agent 运行时 核心类型
 *
 * 关注：
 * - BrowserSession — 统一表示"浏览器会话"（新建 Chromium / CDP 接入）
 * - CdpConnectResult — CDP 连接结果
 * - PageObservation — 页面状态摘要
 * - SemanticAction / ActionResult — 语义动作契约
 */

export interface BrowserSession {
  id: string
  /** 会话来源 */
  source: 'local' | 'cdp'
  /** CDP 端口（仅 cdp 模式） */
  cdpPort?: number
  /** CDP 端点 URL */
  cdpEndpoint?: string
  state: 'idle' | 'connecting' | 'ready' | 'busy' | 'stopped' | 'error'
  currentUrl?: string
  currentTitle?: string
  createdAt: number
  lastActiveAt: number
}

export interface PageObservation {
  url: string
  title: string
  keyElements: Array<{
    selector: string
    description: string
    method: string
  }>
  loginState: 'unknown' | 'logged_in' | 'logged_out' | 'login_page'
  observedAt: number
  screenshot?: string
}

export interface SemanticAction {
  type: 'navigate' | 'click' | 'fill' | 'type' | 'select' | 'scroll' | 'wait' | 'observe' | 'screenshot' | 'evaluate'
  target?: string
  value?: string
  timeout?: number
}

export interface ActionResult {
  success: boolean
  error?: string
  observation?: PageObservation
  data?: any
  durationMs: number
}

/** CDP 连接配置 */
export interface CdpEndpoint {
  host?: string
  port?: number
}

/** CDP 连接结果 */
export interface CdpConnectResult {
  connected: boolean
  pages: Array<{ url: string; title: string }>
  sessionId: string
  error?: string
}

export interface BrowserTask {
  id: string
  goal: string
  steps: BrowserTaskStep[]
  currentStep: number
  state: 'running' | 'paused' | 'completed' | 'failed'
  createdAt: number
}

export interface BrowserTaskStep {
  action: SemanticAction
  expectedOutcome?: string
  completed: boolean
  error?: string
  attempts: number
}

export interface SiteKnowledge {
  domain: string
  verifiedSelectors: Map<string, string>
  updatedAt: number
}
