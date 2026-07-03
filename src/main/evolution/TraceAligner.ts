/**
 * TraceAligner — 双层 trace 对齐压缩器（Phase 2）
 *
 * 将 IntentTrace（用户意图）与 ExecutionTrace（系统执行）通过
 * sessionId/requestId 匹配后对齐，产出"对齐后的意图链路"，
 * 供 Phase 3 CapabilityCompiler 压缩成可执行能力。
 *
 * 对齐方式：
 * - IntentTrace.sessionId ↔ ExecutionTrace.sessionId
 * - ExecutionTrace.intentHint 由 IntentTrace.abstractGoal 补充
 */

export interface IntentTrace {
  traceId: string
  sessionId: string
  timestamp: number
  abstractGoal: string
}

export interface ExecutionTrace {
  traceId: string
  sessionId: string
  timestamp: number
  intentHint: string
  nodes: unknown[]
}

export interface AlignedTrace {
  intent: IntentTrace
  execution: ExecutionTrace
  alignmentScore: number
  gaps: string[] // 意图中未覆盖的部分
}

/**
 * 将一条 IntentTrace 与一条 ExecutionTrace 对齐
 *
 * 对齐逻辑：
 * 1. requestId/sessionId 精确匹配
 * 2. 时间窗口匹配（intent 开始后 10s 内的 execution）
 * 3. intent abstractGoal + execution intentHint 关键字匹配（兜底）
 */
export function alignTraces(intent: IntentTrace, execution: ExecutionTrace): AlignedTrace | null {
  // 方法 1：精确匹配 sessionId
  if (intent.sessionId === execution.sessionId) {
    return buildAlignedTrace(intent, execution, 0.9, [])
  }

  // 方法 2：时间窗口匹配
  const timeDelta = Math.abs(execution.timestamp - intent.timestamp)
  if (timeDelta < 10000) {
    return buildAlignedTrace(intent, execution, 0.7, ['time_window_match'])
  }

  // 方法 3：关键字匹配（intent goal 包含在 execution intentHint 中或反过来）
  if (execution.intentHint && intent.abstractGoal) {
    const goalNorm = intent.abstractGoal.toLowerCase()
    const hintNorm = execution.intentHint.toLowerCase()
    if (goalNorm.includes(hintNorm) || hintNorm.includes(goalNorm)) {
      return buildAlignedTrace(intent, execution, 0.6, ['keyword_fuzzy_match'])
    }
  }

  return null
}

function buildAlignedTrace(intent: IntentTrace, execution: ExecutionTrace, baseScore: number, gaps: string[]): AlignedTrace {
  // 根据执行节点数调整置信度
  const nodeBonus = Math.min(execution.nodes.length * 0.05, 0.2)
  return {
    intent,
    execution,
    alignmentScore: Math.min(baseScore + nodeBonus, 1.0),
    gaps,
  }
}

/**
 * 批量对齐：找出所有匹配的 trace 对
 */
export function alignAll(intentTraces: IntentTrace[], executionTraces: ExecutionTrace[]): AlignedTrace[] {
  const aligned: AlignedTrace[] = []
  const usedExecutions = new Set<string>()
  const usedIntents = new Set<string>()

  // 优先高置信度匹配
  for (const intent of intentTraces) {
    if (usedIntents.has(intent.traceId)) continue

    let best: AlignedTrace | null = null
    for (const execution of executionTraces) {
      if (usedExecutions.has(execution.traceId)) continue

      const result = alignTraces(intent, execution)
      if (result && (!best || result.alignmentScore > best.alignmentScore)) {
        best = result
      }
    }

    if (best) {
      aligned.push(best)
      usedExecutions.add(best.execution.traceId)
      usedIntents.add(best.intent.traceId)
    }
  }

  return aligned
}
