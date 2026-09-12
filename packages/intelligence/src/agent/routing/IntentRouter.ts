import type { IntentRouteDecision, RouteInput, RouteIntentClassifier, IntentRoute } from './types'

const ROUTES: ReadonlySet<IntentRoute> = new Set(['chat_only', 'observe_first', 'tool_first', 'tool_required'])
const EXECUTION_CUES = [
  'run_command',
  'curl',
  'ping',
  'ssh',
  'git',
  'npm',
  'pnpm',
  'yarn',
  'docker',
  'kubectl',
  '\u6267\u884c',
  '\u8fd0\u884c',
  '\u542f\u52a8',
  '\u91cd\u542f',
  '\u90e8\u7f72',
  '\u6784\u5efa',
  '\u8c03\u8bd5',
  '\u6392\u67e5',
  '\u6d4b',
  '\u6d4b\u8bd5',
  '\u63a2\u6d4b',
  '\u9a8c\u8bc1',
] as const
const DIRECT_EXECUTION_CUES = ['\u542f\u52a8', '\u91cd\u542f', '\u8fd0\u884c', 'start', 'restart', 'run'] as const
const TECHNICAL_TARGET_CUES = [
  '\u670d\u52a1\u5668',
  '\u8fde\u901a\u6027',
  '\u7aef\u53e3',
  '\u7f51\u7edc',
  '\u670d\u52a1',
  '\u4ed3\u5e93',
  '\u4ee3\u7801',
  '\u6587\u4ef6',
  '\u547d\u4ee4',
  'shell',
] as const
/** \u9700\u8981\u8054\u7f51/\u5b9e\u65f6\u4fe1\u606f\u624d\u80fd\u56de\u7b54\u7684\u8bf7\u6c42\uff1a\u5206\u7c7b\u5668\u5373\u4f7f\u8bef\u5224\u4e3a chat_only\uff0c\u4e5f\u5fc5\u987b\u5347\u7ea7\u4e3a tool_required */
const INFO_SEEKING_CUES = [
  '\u65b0\u95fb',
  '\u8d44\u8baf',
  '\u70ed\u70b9',
  '\u641c\u7d22',
  '\u641c\u4e00\u4e0b',
  '\u67e5\u4e00\u4e0b',
  '\u67e5\u67e5',
  '\u67e5\u8be2',
  '\u67e5\u627e',
  '\u627e\u627e',
  '\u5929\u6c14\u9884\u62a5',
  '\u5929\u6c14\u600e\u4e48\u6837',
  '\u5929\u6c14\u5982\u4f55',
  '\u6c47\u7387',
  '\u80a1\u7968',
  '\u6700\u65b0\u6d88\u606f',
  '\u6700\u8fd1\u53d1\u751f',
  '\u62a5\u9053',
] as const

export class IntentRouter {
  constructor(private readonly classifier: RouteIntentClassifier) {}

  async route(input: RouteInput, requestId?: string): Promise<IntentRouteDecision> {
    try {
      const result = await this.classifier.classifyRouteIntent(input, requestId)
      const decision = this.parseDecision(result.reply)
      if (decision) return this.normalizeDecision(decision, input)
    } catch {
      // Routing must remain available when the classifier transport fails.
    }

    return this.fallback(input)
  }

  private parseDecision(reply?: string): IntentRouteDecision | null {
    if (!reply?.trim()) return null

    let value: unknown
    try {
      value = JSON.parse(this.unwrapJson(reply))
    } catch {
      return null
    }

    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    const route = candidate.route
    const confidence = candidate.confidence
    const reason = candidate.reason

    if (
      typeof route !== 'string' ||
      !ROUTES.has(route as IntentRoute) ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return null
    }

    const suggestedTools = candidate.suggestedTools
    const successCriteria = candidate.successCriteria
    return {
      route: route as IntentRoute,
      confidence,
      reason,
      ...(Array.isArray(suggestedTools) && suggestedTools.every((tool) => typeof tool === 'string')
        ? { suggestedTools: suggestedTools as string[] }
        : {}),
      ...(isValidSuccessCriteria(successCriteria) ? { successCriteria: successCriteria as string[] } : {}),
    }
  }

  private normalizeDecision(decision: IntentRouteDecision, input: RouteInput): IntentRouteDecision {
    if (this.requiresWebInformation(input) && decision.route !== 'tool_first' && decision.route !== 'tool_required') {
      return {
        ...decision,
        route: 'tool_required',
        reason: `information request upgraded: ${decision.reason}`,
      }
    }

    if (this.requiresExplicitToolExecution(input) && decision.route !== 'tool_first' && decision.route !== 'tool_required') {
      return {
        ...decision,
        route: 'tool_required',
        reason: `explicit execution request upgraded: ${decision.reason}`,
      }
    }

    if (decision.route === 'chat_only' && (input.hasProjectContext || input.recentToolNames.length > 0)) {
      return {
        ...decision,
        route: 'observe_first',
        reason: `chat_only downgraded: ${decision.reason}`,
      }
    }
    return decision
  }

  private unwrapJson(reply: string): string {
    const trimmed = reply.trim()
    if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed

    const firstLineEnd = trimmed.indexOf('\n')
    if (firstLineEnd === -1) return trimmed.slice(3, -3).trim()
    return trimmed.slice(firstLineEnd + 1, -3).trim()
  }

  private fallback(input: RouteInput): IntentRouteDecision {
    if (this.requiresWebInformation(input)) {
      return { route: 'tool_required', confidence: 0, reason: 'classifier unavailable; information request requires web tools' }
    }
    if (this.requiresExplicitToolExecution(input)) {
      return { route: 'tool_required', confidence: 0, reason: 'classifier unavailable; explicit execution request requires tools' }
    }
    if (input.hasProjectContext || input.recentToolNames.length > 0) {
      return { route: 'observe_first', confidence: 0, reason: 'classifier unavailable; active project context requires observation' }
    }
    return { route: 'observe_first', confidence: 0, reason: 'classifier unavailable; uncertain intent defaults to observation' }
  }

  private requiresExplicitToolExecution(input: RouteInput): boolean {
    const text = input.userText.trim()
    if (!text) return false
    if (text.includes('<||DSML||') || text.includes('<\uFF5CDSML\uFF5C') || text.includes('<\uFF5C\uFF5CDSML\uFF5C\uFF5C')) {
      return true
    }

    const hasExecutionCue = EXECUTION_CUES.some((cue) => text.includes(cue))
    const hasTechnicalTargetCue = TECHNICAL_TARGET_CUES.some((cue) => text.includes(cue))
    const hasDirectExecutionCue = DIRECT_EXECUTION_CUES.some((cue) => text.toLowerCase().includes(cue))
    if (hasDirectExecutionCue && (input.hasProjectContext || input.recentToolNames.length > 0)) {
      return true
    }
    return hasExecutionCue && hasTechnicalTargetCue
  }

  private requiresWebInformation(input: RouteInput): boolean {
    const text = input.userText.trim()
    if (!text) return false
    return INFO_SEEKING_CUES.some((cue) => text.includes(cue))
  }
}

/** successCriteria validation: non-empty string array, up to 4 items */
function isValidSuccessCriteria(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return false
  return value.every((item) => typeof item === 'string' && item.trim().length > 0)
}
