import type { ProposedRelation } from './types'

/**
 * Mechanism Graph v0 — traces.jsonl 派生读模型（非独立图存储）。
 *
 * 定案 A6：confidence 由边的推断来源映射——identity=verified → high，
 * inferred → low。聚合键为 (agent, capabilityId, outcome)。
 * 持久化图后置到 P3 验证有产出之后。
 */

export interface TraceEventLike {
  event_type?: string
  outcome?: string
  agent?: string
  payload?: Record<string, unknown>
}

export interface MechanismEdge {
  agent: string
  capabilityId: string
  outcome: string
  count: number
  /** A6: identity=verified→high / inferred→low */
  confidence: 'high' | 'low'
  /** 聚合中出现过的 inference 种类（identity 优先） */
  inferences: Array<'identity' | 'inferred'>
}

export interface MechanismGraph {
  edges: MechanismEdge[]
  /** 参与聚合的事件总数（仅计入含 agent+capabilityId 的 tool_call/task 类事件） */
  eventCount: number
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

/**
 * 从 traces.jsonl 行事件聚合机制边。
 *
 * 规则：
 * - 仅计入 payload.capabilityId 存在的事件（能力绑定相关）。
 * - 每条边键 = `${agent}|${capabilityId}|${outcome}`，count 累加。
 * - inference：payload.inference === 'identity' 或 event_type 含 identity
 *   时记 identity；否则记 inferred。
 * - confidence：边内出现过任一 identity → high，否则 low。
 */
export function deriveMechanismGraph(events: readonly TraceEventLike[]): MechanismGraph {
  const edgeMap = new Map<string, MechanismEdge>()
  let eventCount = 0

  for (const ev of events) {
    const capabilityId = asString(ev.payload?.capabilityId)
    if (!capabilityId) continue
    const agent = asString(ev.agent, 'unknown')
    const outcome = asString(ev.outcome, 'unknown')
    eventCount++

    const key = `${agent}|${capabilityId}|${outcome}`
    let edge = edgeMap.get(key)
    if (!edge) {
      edge = {
        agent,
        capabilityId,
        outcome,
        count: 0,
        confidence: 'low',
        inferences: [],
      }
      edgeMap.set(key, edge)
    }
    edge.count++

    const rawInference = ev.payload?.inference
    const inference: 'identity' | 'inferred' =
      rawInference === 'identity' || (typeof ev.event_type === 'string' && ev.event_type.includes('identity')) ? 'identity' : 'inferred'
    if (!edge.inferences.includes(inference)) edge.inferences.push(inference)
    if (inference === 'identity') edge.confidence = 'high'
  }

  const edges = [...edgeMap.values()].sort((a, b) => {
    const c = b.count - a.count
    if (c !== 0) return c
    const k = `${a.agent}|${a.capabilityId}|${a.outcome}`.localeCompare(`${b.agent}|${b.capabilityId}|${b.outcome}`)
    return k
  })
  return { edges, eventCount }
}

/** 把机制假设的 proposedRelations 投影为与派生图同形状的边（供对照，confidence 走 inference 字段）。 */
export function relationsToEdges(agent: string, relations: readonly ProposedRelation[]): MechanismEdge[] {
  return relations.map((r) => {
    const inference = r.inference ?? 'inferred'
    return {
      agent,
      capabilityId: r.from,
      outcome: r.to,
      count: 1,
      confidence: inference === 'identity' ? 'high' : 'low',
      inferences: [inference] as Array<'identity' | 'inferred'>,
    }
  })
}

/** 是否为机制假设：带非空 proposedRelations 即机制假设，否则普通创意（一个 store 两种粒度）。 */
export function isMechanismHypothesis(h: { proposedRelations?: ProposedRelation[] }): boolean {
  return Array.isArray(h.proposedRelations) && h.proposedRelations.length > 0
}
