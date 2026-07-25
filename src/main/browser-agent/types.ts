/**
 * BrowserAgent Runtime 类型定义
 */

export interface BrowserSession {
  id: string
  state: 'idle' | 'starting' | 'ready' | 'busy' | 'stopped' | 'error'
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
  type: 'navigate' | 'click' | 'fill' | 'type' | 'select' | 'scroll' | 'wait' | 'observe' | 'screenshot'
  target?: string
  value?: string
  timeout?: number
}

export interface ActionResult {
  success: boolean
  error?: string
  observation?: PageObservation
  durationMs: number
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
