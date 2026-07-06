/**
 * GuardrailProgressAnalyzer — 从 EvaluationEvent 流计算 Trace 级别进展状态
 *
 * 职责：
 * - 一次性扫描 EvaluationEvent[]，分组为 Turn，计算 3 个 Progress Signal
 * - compute() 是无副作用的纯函数，可直接传入伪造事件测试
 * - analyze() 通过 TraceEventSource 加载事件后委托给 compute()
 *
 * 不包含任何决策逻辑。不引用 GuardrailPolicy。
 */

import type { EvaluationEvent } from './types'
import type {
  ProgressAnalyzer,
  ProgressSnapshot,
  StateChangeSignal,
  InformationGainSignal,
  GoalProgressSignal,
  TraceEventSource,
} from './GuardrailTypes'

// ══════════════════════════════════════════════
// Turn 分组
// ══════════════════════════════════════════════

interface TurnGroup {
  index: number
  events: EvaluationEvent[]
  /** 该轮是否有 tool.completed */
  hasToolResult: boolean
  /** 该轮是否有 agent.response */
  hasAgentResponse: boolean
  /** 该轮是否有 workflow/task progress 事件 */
  hasProgressEvent: boolean
  /** 该轮模型输出长度（取自 model.completed.responseLength） */
  modelOutputLength: number
  /** 该轮模型输出预览（用于重复检测） */
  modelOutputPreview: string
  /** 该轮所有 tool result 的指纹 {toolName, fingerprint} */
  toolResultFingerprints: Array<{ toolName: string; fingerprint: string }>
}

/** 内容指纹：取前 64 字符作为相等性判断依据 */
function contentFingerprint(text: string | undefined): string {
  if (!text || text.length === 0) return ''
  return text.slice(0, 64)
}

/** 低输出阈值 */
const LOW_OUTPUT_THRESHOLD = 20

/**
 * 将 EvaluationEvent[] 按 model.invoked 边界分组为 Turn。
 * 每个 model.invoked 标记一个新 Turn 的开始。
 */
function groupByTurns(events: EvaluationEvent[]): TurnGroup[] {
  // 按时间排序
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const turns: TurnGroup[] = []
  let currentTurn: EvaluationEvent[] = []

  for (const ev of sorted) {
    if (ev.type === 'model.invoked' && currentTurn.length > 0) {
      turns.push(buildTurn(turns.length, currentTurn))
      currentTurn = [ev]
    } else {
      currentTurn.push(ev)
    }
  }
  if (currentTurn.length > 0) {
    turns.push(buildTurn(turns.length, currentTurn))
  }

  return turns
}

function buildTurn(index: number, events: EvaluationEvent[]): TurnGroup {
  const fingerprints: Array<{ toolName: string; fingerprint: string }> = []
  let hasToolResult = false
  let hasAgentResponse = false
  let hasProgressEvent = false
  let modelOutputLength = 0
  let modelOutputPreview = ''

  for (const ev of events) {
    if (ev.type === 'tool.completed') {
      hasToolResult = true
      const p = ev.payload as { toolName: string; output?: string }
      fingerprints.push({ toolName: p.toolName, fingerprint: contentFingerprint(p.output) })
    } else if (ev.type === 'agent.response') {
      hasAgentResponse = true
    } else if (ev.type === 'model.completed') {
      const p = ev.payload as { responseLength: number; responsePreview?: string }
      modelOutputLength = p.responseLength ?? 0
      modelOutputPreview = p.responsePreview ?? ''
    } else if (
      ev.type === 'task.completed' ||
      ev.type === 'task.started' ||
      ev.type === 'workflow.started' ||
      ev.type === 'workflow.completed'
    ) {
      hasProgressEvent = true
    }
  }

  return {
    index,
    events,
    hasToolResult,
    hasAgentResponse,
    hasProgressEvent,
    modelOutputLength,
    modelOutputPreview,
    toolResultFingerprints: fingerprints,
  }
}

// ══════════════════════════════════════════════
// Signal 1: State Change
// ══════════════════════════════════════════════

function computeStateChange(turns: TurnGroup[]): StateChangeSignal {
  // 从最新轮次开始，找到是否有状态变化
  let stagnantTurnCount = 0
  let lastChangeTurn = -1

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const hasChange = turn.hasToolResult || turn.hasAgentResponse || turn.hasProgressEvent

    if (hasChange) {
      if (lastChangeTurn === -1) {
        // 最新轮次有变化，stagnant = 0
        lastChangeTurn = i
      }
      break
    } else {
      if (lastChangeTurn === -1) {
        // 只有最新轮次开始计数
        stagnantTurnCount++
      }
    }
  }

  // 如果最后一轮没有变化，stagnantTurnCount > 0
  // 但如果从来没有过变化，lastChangeTurn 保持 -1
  if (lastChangeTurn === -1) {
    stagnantTurnCount = turns.length // 全部轮次都在空转
  }

  const latestTurn = turns[turns.length - 1]

  return {
    hasNewToolResult: latestTurn?.hasToolResult ?? false,
    hasNewAssistantContent: latestTurn?.hasAgentResponse ?? false,
    hasPlanningStateChange: latestTurn?.hasProgressEvent ?? false,
    stagnantTurnCount,
    lastChangeTurn,
    summary:
      lastChangeTurn === -1
        ? `从未发生状态变化（${turns.length} 轮）`
        : `最后状态变化在 Turn ${lastChangeTurn}，已停滞 ${stagnantTurnCount} 轮`,
  }
}

// ══════════════════════════════════════════════
// Signal 2: Information Gain
// ══════════════════════════════════════════════

function computeInformationGain(turns: TurnGroup[]): InformationGainSignal {
  let consecutiveLowOutputTurns = 0
  let repeatedOutputCount = 0
  let totalToolResults = 0
  let novelToolResults = 0
  const seenFingerprints = new Set<string>()
  let previousPreview = ''

  // 从最新轮次往前扫描 continuous pattern
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]

    // 连续低输出
    if (turn.modelOutputLength <= LOW_OUTPUT_THRESHOLD) {
      consecutiveLowOutputTurns++
    } else {
      // 只在从最新轮次开始未中断时才计数
      if (i === turns.length - 1) {
        // 如果最新轮不是低输出，不计数
      }
      // 一旦遇到非低输出轮次，不再继续累加（但已计数的保留）
      break
    }
  }

  // 修正：从最新轮次连续扫描
  consecutiveLowOutputTurns = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.modelOutputLength <= LOW_OUTPUT_THRESHOLD) {
      consecutiveLowOutputTurns++
    } else {
      break
    }
  }

  // 连续重复内容（从最新往旧扫描）
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (previousPreview && turn.modelOutputPreview === previousPreview && turn.modelOutputPreview.length > 0) {
      repeatedOutputCount++
    }
    if (turn.modelOutputPreview.length > 0) {
      previousPreview = turn.modelOutputPreview
    }
  }

  // 工具结果新颖度
  for (const turn of turns) {
    for (const fp of turn.toolResultFingerprints) {
      totalToolResults++
      const key = `${fp.toolName}::${fp.fingerprint}`
      if (!seenFingerprints.has(key)) {
        seenFingerprints.add(key)
        novelToolResults++
      }
    }
  }

  const toolResultNovelty = totalToolResults > 0 ? novelToolResults / totalToolResults : 1

  // 重复工具结果计数（连续重复）
  let repeatedToolResultCount = 0
  const seenToolFps = new Set<string>()
  for (let i = turns.length - 1; i >= 0; i--) {
    for (const fp of turns[i].toolResultFingerprints) {
      const key = `${fp.toolName}::${fp.fingerprint}`
      if (seenToolFps.has(key)) {
        repeatedToolResultCount++
      }
      seenToolFps.add(key)
    }
  }

  return {
    consecutiveLowOutputTurns,
    repeatedOutputCount,
    repeatedToolResultCount,
    toolResultNovelty: Math.round(toolResultNovelty * 1000) / 1000,
    summary: `低输出 ${consecutiveLowOutputTurns} 轮，工具结果新颖度 ${(toolResultNovelty * 100).toFixed(0)}%`,
  }
}

// ══════════════════════════════════════════════
// Signal 3: Goal Progress
// ══════════════════════════════════════════════

function computeGoalProgress(turns: TurnGroup[]): GoalProgressSignal {
  let completedSubtasks = 0
  let hasPhaseTransition = false
  let lastWorkflowCompleted = false

  // 扫描全部事件
  for (const turn of turns) {
    for (const ev of turn.events) {
      if (ev.type === 'task.completed') {
        completedSubtasks++
      } else if (ev.type === 'workflow.completed') {
        lastWorkflowCompleted = true
      } else if (ev.type === 'workflow.started' && lastWorkflowCompleted) {
        hasPhaseTransition = true
      }
    }
  }

  // 连续无推进轮次（从最新往旧）
  let stagnantTurnCount = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].hasProgressEvent) {
      break
    }
    stagnantTurnCount++
  }

  return {
    completedSubtasks,
    hasPhaseTransition,
    stagnantTurnCount,
    summary: `已完成 ${completedSubtasks} 个子任务${hasPhaseTransition ? '，存在阶段转换' : ''}`,
  }
}

// ══════════════════════════════════════════════
// 导出实现
// ══════════════════════════════════════════════

export class GuardrailProgressAnalyzer implements ProgressAnalyzer {
  constructor(private source: TraceEventSource) {}

  async analyze(traceId: string): Promise<ProgressSnapshot> {
    const events = await this.source.getTrace(traceId)
    return GuardrailProgressAnalyzer.compute(traceId, events)
  }

  /**
   * 纯函数：直接传入 EvaluationEvent[] 计算 ProgressSnapshot。
   * 测试时无需存储，直接构造事件数组传入。
   */
  static compute(traceId: string, events: EvaluationEvent[]): ProgressSnapshot {
    const turns = groupByTurns(events)

    // 确定 sessionId
    const sessionId = events.length > 0 ? events[0].sessionId : ''

    // 时间范围
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
    const elapsedMs = sorted.length >= 2 ? sorted[sorted.length - 1].timestamp - sorted[0].timestamp : 0

    return {
      traceId,
      sessionId,
      totalTurns: turns.length,
      elapsedMs,
      computedAt: Date.now(),
      stateChange: computeStateChange(turns),
      informationGain: computeInformationGain(turns),
      goalProgress: computeGoalProgress(turns),
    }
  }
}
