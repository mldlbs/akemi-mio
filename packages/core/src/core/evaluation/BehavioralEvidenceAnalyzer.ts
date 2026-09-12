import type {
  CapabilityCompletedPayload,
  EvaluationEvent,
  GuardrailActionDeliveredPayload,
  GuardrailActionDeliveryFailedPayload,
  TaskCompletedPayload,
  TaskStartedPayload,
  ToolCompletedPayload,
} from './types'

export interface BehavioralTraceAnalysis {
  traceId: string
  sessionId: string
  sampleStatus: 'valid' | 'incomplete_sample'
  observationEligible: boolean
  sequenceStatus: 'derived' | 'insufficient_for_fingerprint'
  decisionImpactStatus: 'derived' | 'insufficient_for_decision_impact'
  divergenceStatus: 'insufficient_for_divergence'
  sequence: string[]
  sequenceEventIds: string[]
  fingerprint: string | null
  decisionIds: string[]
}

export class BehavioralEvidenceAnalyzer {
  static compute(traceId: string, events: EvaluationEvent[]): BehavioralTraceAnalysis {
    const traceEvents = events.filter((event) => event.traceId === traceId).sort(compareEvents)

    const chatStarts = traceEvents.filter(isChatTaskStarted)
    const chatCompletions = traceEvents.filter(isChatTaskCompleted)
    const sessionId = selectSessionId(chatStarts, chatCompletions)
    const closedWindow = findClosedChatWindow(traceEvents, chatStarts, chatCompletions)
    const sampleStatus = closedWindow === null ? 'incomplete_sample' : 'valid'

    const { sequence, sequenceEventIds } = closedWindow === null ? { sequence: [], sequenceEventIds: [] } : deriveSequence(closedWindow)

    const fingerprint = sequence.length > 0 ? sequence.join('>') : null
    const sequenceStatus = fingerprint === null ? 'insufficient_for_fingerprint' : 'derived'

    const matchedDecisionIds = deriveMatchedDecisionIds(traceId, traceEvents)

    return {
      traceId,
      sessionId,
      sampleStatus,
      observationEligible: sampleStatus === 'valid' && fingerprint !== null,
      sequenceStatus,
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence,
      sequenceEventIds,
      fingerprint,
      decisionIds: matchedDecisionIds,
    }
  }
}

function compareEvents(left: EvaluationEvent, right: EvaluationEvent): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp
  }

  if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) {
    return left.seq - right.seq
  }

  return left.id.localeCompare(right.id)
}

function findClosedChatWindow(
  events: EvaluationEvent[],
  chatStarts: EvaluationEvent[],
  chatCompletions: EvaluationEvent[],
): EvaluationEvent[] | null {
  if (chatStarts.length !== 1 || chatCompletions.length !== 1) {
    return null
  }

  const [start] = chatStarts
  const [completion] = chatCompletions

  if (start.sessionId !== completion.sessionId) {
    return null
  }

  const startIndex = events.findIndex((event) => event.id === start.id)
  const completionIndex = events.findIndex((event) => event.id === completion.id)

  if (startIndex < 0 || completionIndex < 0 || completionIndex <= startIndex) {
    return null
  }

  const boundarySessionId = start.sessionId
  const windowEvents = events.slice(startIndex + 1, completionIndex)

  if (windowEvents.some((event) => event.sessionId !== boundarySessionId && !isRuntimeScopedFact(event))) {
    return null
  }

  return windowEvents
}

function isChatTaskStarted(event: EvaluationEvent): boolean {
  return event.type === 'task.started' && (event.payload as TaskStartedPayload).kind === 'chat'
}

function isChatTaskCompleted(event: EvaluationEvent): boolean {
  return event.type === 'task.completed' && (event.payload as TaskCompletedPayload).kind === 'chat'
}

function isRuntimeScopedFact(event: EvaluationEvent): boolean {
  return (
    event.type === 'model.invoked' || event.type === 'model.completed' || event.type === 'tool.invoked' || event.type === 'tool.completed'
  )
}

function deriveSequence(events: EvaluationEvent[]): { sequence: string[]; sequenceEventIds: string[] } {
  const sequence: string[] = []
  const sequenceEventIds: string[] = []

  for (const event of events) {
    if (event.type === 'tool.completed') {
      const payload = event.payload as ToolCompletedPayload
      sequence.push(`tool:${payload.toolName}`)
      sequenceEventIds.push(event.id)
      continue
    }

    if (event.type === 'capability.completed') {
      const payload = event.payload as CapabilityCompletedPayload
      sequence.push(`capability:${payload.capability}`)
      sequenceEventIds.push(event.id)
      continue
    }

    if (event.type === 'agent.response') {
      sequence.push('response')
      sequenceEventIds.push(event.id)
    }
  }

  return { sequence, sequenceEventIds }
}

function deriveMatchedDecisionIds(traceId: string, traceEvents: EvaluationEvent[]): string[] {
  const decisionIds: string[] = []
  const seenDecisionIds = new Set<string>()

  for (const event of traceEvents) {
    if (event.type === 'guardrail.action_delivered') {
      const payload = event.payload as GuardrailActionDeliveredPayload
      if (payload.traceId === traceId && !seenDecisionIds.has(payload.decisionId)) {
        seenDecisionIds.add(payload.decisionId)
        decisionIds.push(payload.decisionId)
      }
      continue
    }

    if (event.type === 'guardrail.action_delivery_failed') {
      const payload = event.payload as GuardrailActionDeliveryFailedPayload
      if (payload.traceId === traceId && !seenDecisionIds.has(payload.decisionId)) {
        seenDecisionIds.add(payload.decisionId)
        decisionIds.push(payload.decisionId)
      }
    }
  }

  return decisionIds
}

function selectSessionId(chatStarts: EvaluationEvent[], chatCompletions: EvaluationEvent[]): string {
  if (chatStarts.length === 1 && chatCompletions.length === 1 && chatStarts[0].sessionId === chatCompletions[0].sessionId) {
    return chatStarts[0].sessionId
  }

  if (chatStarts.length === 1 && chatCompletions.length === 0) {
    return chatStarts[0].sessionId
  }

  if (chatStarts.length === 0 && chatCompletions.length === 1) {
    return chatCompletions[0].sessionId
  }

  return ''
}
