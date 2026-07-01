/**
 * ExecutionTracer — 进化执行链路追踪器
 *
 * 插桩在 ActionRegistry/ActionPlanner/SelfEvolutionService 三个边界，
 * 产出 DAG 结构的 execution trace，作为 Capability Compiler 的 IR（中间表示）。
 *
 * 核心约束：trace ≠ log。trace 必须是可编译的——
 * 能从 trace 重建 workflow graph 并重放。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../config'
import { log } from '../logger/Logger'

// ─── Trace 数据结构 ────────────────────────────────────────────────

export interface TraceNode {
  id: string
  type: 'tool' | 'plan' | 'state'
  name: string
  input: any
  output: any
  cost: {
    token: number
    latency: number
  }
  parentIds: string[]
}

export interface TraceEdge {
  from: string
  to: string
  type: 'data' | 'control'
}

export interface ExecutionTrace {
  traceId: string
  sessionId: string
  timestamp: number
  intentHint?: string

  nodes: TraceNode[]
  edges: TraceEdge[]
}

// ─── 路径 ──────────────────────────────────────────────────────────

const TRACES_DIR = join(WORKSPACE.evolution, 'traces')

function ensureTracesDir(): void {
  if (!existsSync(TRACES_DIR)) {
    mkdirSync(TRACES_DIR, { recursive: true })
  }
}

// ─── Tracer 类 ─────────────────────────────────────────────────────

export class ExecutionTracer {
  private trace: ExecutionTrace
  private nodeSeq = 0
  private lastNodeId: string | null = null

  constructor(sessionId: string) {
    this.trace = {
      traceId: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      timestamp: Date.now(),
      nodes: [],
      edges: [],
    }
  }

  /** 开始一个新阶段（重置 lastNodeId 以断开链路） */
  startPhase(): void {
    this.lastNodeId = null
  }

  /** 记录一个 tool call 节点 */
  recordTool(name: string, input: any, output: any, cost: { token: number; latency: number }): string {
    const id = `tool_${this.nodeSeq++}`
    this.trace.nodes.push({ id, type: 'tool', name, input, output, cost, parentIds: [] })
    if (this.lastNodeId) {
      this.trace.edges.push({ from: this.lastNodeId, to: id, type: 'data' })
    }
    this.lastNodeId = id
    return id
  }

  /** 记录一个 plan 决策节点 */
  recordPlan(name: string, input: any, output: any, cost: { token: number; latency: number }): string {
    const id = `plan_${this.nodeSeq++}`
    this.trace.nodes.push({ id, type: 'plan', name, input, output, cost, parentIds: [] })
    if (this.lastNodeId) {
      this.trace.edges.push({ from: this.lastNodeId, to: id, type: 'control' })
    }
    this.lastNodeId = id
    return id
  }

  /** 记录一个 state transition 节点 */
  recordState(name: string, input: any, output: any): string {
    const id = `state_${this.nodeSeq++}`
    this.trace.nodes.push({
      id,
      type: 'state',
      name,
      input,
      output,
      cost: { token: 0, latency: 0 },
      parentIds: [],
    })
    if (this.lastNodeId) {
      this.trace.edges.push({ from: this.lastNodeId, to: id, type: 'data' })
    }
    this.lastNodeId = id
    return id
  }

  /** 在两节点之间添加一条边（不自动连接 lastNodeId） */
  addEdge(from: string, to: string, type: 'data' | 'control' = 'data'): void {
    this.trace.edges.push({ from, to, type })
  }

  /** 获取当前 trace 的完整 DAG */
  getTrace(): Readonly<ExecutionTrace> {
    return this.trace
  }

  /** 设置 intent hint（Phase 2 调用） */
  setIntentHint(hint: string): void {
    this.trace.intentHint = hint
  }

  /** 将 trace 持久化到 evolution_workspace/traces/ */
  persist(): string {
    ensureTracesDir()
    const filePath = join(TRACES_DIR, `${this.trace.traceId}.json`)
    writeFileSync(filePath, JSON.stringify(this.trace, null, 2), 'utf-8')
    log('INFO', 'trace_persisted', { traceId: this.trace.traceId, nodes: this.trace.nodes.length, path: filePath })
    return filePath
  }

  /** 获取 trace ID */
  getTraceId(): string {
    return this.trace.traceId
  }

  /** 列出所有已持久化的 trace 文件 */
  static listTraces(): string[] {
    if (!existsSync(TRACES_DIR)) return []
    return readdirSync(TRACES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
  }
}
