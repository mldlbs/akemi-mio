export type IntentRoute = 'chat_only' | 'observe_first' | 'tool_first' | 'tool_required'

export interface IntentRouteDecision {
  route: IntentRoute
  confidence: number
  reason: string
  /** Advisory only. Execution must still validate tool names against available schemas. */
  suggestedTools?: string[]
  /** M6.2 可选：LLM 抽取的完成标准（仅 tool_first/tool_required 有意义），由 GoalEngine 使用 */
  successCriteria?: string[]
}

export interface RouteInput {
  userText: string
  scene: string
  hasProjectContext: boolean
  recentToolNames: string[]
}

export interface RouteIntentClassifier {
  classifyRouteIntent(input: RouteInput, requestId?: string): Promise<{ reply?: string; error?: string }>
}
