/**
 * shared/types.ts — 跨 agent/memory/llm 的共享纯类型
 *
 * 这些类型被多个模块使用，提取到这里消除循环依赖。
 */

// ── From agent/ProceduralMemory.ts ──
export interface Procedure {
  id: string
  name: string
  description: string
  steps: string[]
  triggerKeywords: string[]
  successCount: number
  failCount: number
  embedding?: number[]
  createdAt: number
  updatedAt: number
}

// ── From agent/ToolScheduler.ts ──
export interface ToolResult {
  id: string
  name: string
  success: boolean
  content: string
  error?: string
  latencyMs: number
}

// ── From agent/WorkingMemory.ts ──
export interface AttentionEntity {
  name: string
  type: 'user_preference' | 'file' | 'project' | 'concept' | 'task'
  relevance: number
  lastMentioned: number
}

// ── From llm/LlmService.ts ──
export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, any>
}

export type ToolChoiceMode = 'auto' | 'required'

// ── From llm/types.ts ──
export interface ChatResult {
  reply?: string
  error?: string
}
export type ChunkCallback = (text: string) => void

// ── From agent/context.ts ──
export interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
  result?: string
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
  reasoning_content?: string | null
}

// ── From agent/routing/types.ts ──
export type IntentRoute = 'chat_only' | 'observe_first' | 'tool_first' | 'tool_required'

export interface IntentRouteDecision {
  route: IntentRoute
  confidence: number
  reason: string
  suggestedTools?: string[]
  successCriteria?: string[]
}

export interface RouteInput {
  userText: string
  scene: string
  hasProjectContext: boolean
  recentToolNames: string[]
}

// ── From agent/intent/types.ts ──
export interface IntentResult {
  intent: string
  slots: Record<string, string>
}

export interface IntentHandler {
  intent: string
  description: string
  execute: (slots: Record<string, string>) => string | Promise<string>
}

// ── From agent/ContextIntegrityChecker.ts ──
export interface IntegrityIssue {
  type: 'ORPHANED_TOOL_CALL' | 'MISSING_TOOL_RESPONSE' | 'EMPTY_TOOL_CALL_ID' | 'INTERLEAVED_USER_MESSAGE'
  index: number
  description: string
}