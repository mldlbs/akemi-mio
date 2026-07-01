/**
 * PatternMiner — 从 execution traces 中挖掘高频/高成本模式（Phase 3）
 *
 * 输入：persisted ExecutionTraces
 * 输出：PatternCandidate[] — 可被 CapabilityCompiler 编译的能力候选
 *
 * v0 只做 workflow compression：
 * - 高频 tool call 链检测（n-gram over tool names）
 * - 高成本链检测（latency/token 异常）
 * - 失败恢复路径检测
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../config'
import { log } from '../logger/Logger'
import type { ExecutionTrace } from './ExecutionTracer'

const TRACES_DIR = join(WORKSPACE.evolution, 'traces')

// ─── Pattern Types ─────────────────────────────────────────────────

export interface PatternCandidate {
  id: string
  type: 'frequent_chain' | 'high_cost_chain' | 'failure_recovery' | 'compound_workflow'
  toolChain: string[] // 工具名称序列 e.g. ['read_file', 'grep', 'read_file']
  frequency: number
  avgLatency: number
  avgTokenCost: number
  sampleTraceIds: string[]
  confidence: number // 0-1
  description: string
}

// ─── PatternMiner ──────────────────────────────────────────────────

export class PatternMiner {
  /** 从 traces/ 目录加载所有 trace 并挖掘模式 */
  mine(): PatternCandidate[] {
    const traces = this.loadTraces()
    if (traces.length === 0) {
      log('INFO', 'pattern_miner_no_traces')
      return []
    }

    const candidates: PatternCandidate[] = []

    // 1. 高频 tool chain 检测
    candidates.push(...this.detectFrequentChains(traces))

    // 2. 高成本链检测
    candidates.push(...this.detectHighCostChains(traces))

    // 3. 失败恢复模式检测
    candidates.push(...this.detectFailureRecovery(traces))

    log('INFO', 'pattern_miner_complete', {
      traces: traces.length,
      candidates: candidates.length,
    })

    return candidates
  }

  /** 加载 traces/ 目录中的 execution trace */
  private loadTraces(): ExecutionTrace[] {
    if (!existsSync(TRACES_DIR)) return []
    const files = readdirSync(TRACES_DIR).filter((f) => f.endsWith('.json'))
    const traces: ExecutionTrace[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(TRACES_DIR, file), 'utf-8')
        traces.push(JSON.parse(raw))
      } catch {
        // skip corrupted files
      }
    }
    return traces
  }

  /** 从 trace 中提取 tool 序列 */
  private extractToolSequence(trace: ExecutionTrace): string[] {
    return trace.nodes.filter((n) => n.type === 'tool').map((n) => n.name)
  }

  /**
   * n-gram 检测：寻找跨 trace 重复出现的 tool 序列
   * n=2 (pair)、n=3 (triple)
   */
  private detectFrequentChains(traces: ExecutionTrace[]): PatternCandidate[] {
    const pairCounts = new Map<string, { count: number; traces: string[]; latency: number[] }>()
    const tripleCounts = new Map<string, { count: number; traces: string[]; latency: number[] }>()

    for (const trace of traces) {
      const tools = this.extractToolSequence(trace)
      const toolNodes = trace.nodes.filter((n) => n.type === 'tool')

      // Pair: A→B
      for (let i = 0; i < tools.length - 1; i++) {
        const key = `${tools[i]}→${tools[i + 1]}`
        const entry = pairCounts.get(key) || { count: 0, traces: [], latency: [] }
        entry.count++
        if (!entry.traces.includes(trace.traceId)) entry.traces.push(trace.traceId)
        const lat = (toolNodes[i]?.cost.latency || 0) + (toolNodes[i + 1]?.cost.latency || 0)
        entry.latency.push(lat)
        pairCounts.set(key, entry)
      }

      // Triple: A→B→C
      for (let i = 0; i < tools.length - 2; i++) {
        const key = `${tools[i]}→${tools[i + 1]}→${tools[i + 2]}`
        const entry = tripleCounts.get(key) || { count: 0, traces: [], latency: [] }
        entry.count++
        if (!entry.traces.includes(trace.traceId)) entry.traces.push(trace.traceId)
        const lat = (toolNodes[i]?.cost.latency || 0) + (toolNodes[i + 1]?.cost.latency || 0) + (toolNodes[i + 2]?.cost.latency || 0)
        entry.latency.push(lat)
        tripleCounts.set(key, entry)
      }
    }

    const candidates: PatternCandidate[] = []

    // 筛选高频 pair
    for (const [key, entry] of pairCounts) {
      if (entry.count >= 2 && entry.traces.length >= 2) {
        const tools = key.split('→')
        const avgLat = entry.latency.reduce((s, v) => s + v, 0) / entry.latency.length
        candidates.push({
          id: `freq_pair_${tools[0]}_${tools[1]}`,
          type: 'frequent_chain',
          toolChain: tools,
          frequency: entry.count,
          avgLatency: Math.round(avgLat),
          avgTokenCost: 0,
          sampleTraceIds: entry.traces.slice(0, 5),
          confidence: Math.min(0.9, 0.4 + entry.traces.length * 0.1),
          description: `高频调用链: ${tools[0]} → ${tools[1]} (出现 ${entry.count} 次，${entry.traces.length} 条 trace)`,
        })
      }
    }

    // 筛选高频 triple
    for (const [key, entry] of tripleCounts) {
      if (entry.count >= 2 && entry.traces.length >= 2) {
        const tools = key.split('→')
        const avgLat = entry.latency.reduce((s, v) => s + v, 0) / entry.latency.length
        candidates.push({
          id: `freq_triple_${tools[0]}_${tools[1]}_${tools[2]}`,
          type: 'frequent_chain',
          toolChain: tools,
          frequency: entry.count,
          avgLatency: Math.round(avgLat),
          avgTokenCost: 0,
          sampleTraceIds: entry.traces.slice(0, 5),
          confidence: Math.min(0.95, 0.5 + entry.traces.length * 0.1),
          description: `高频三步链: ${tools.join(' → ')} (出现 ${entry.count} 次，${entry.traces.length} 条 trace)`,
        })
      }
    }

    return candidates
  }

  /** 检测高成本链：latency 或 token 显著高于平均的 tool 序列 */
  private detectHighCostChains(traces: ExecutionTrace[]): PatternCandidate[] {
    const candidates: PatternCandidate[] = []

    for (const trace of traces) {
      const toolNodes = trace.nodes.filter((n) => n.type === 'tool')
      if (toolNodes.length === 0) continue

      const totalLatency = toolNodes.reduce((s, n) => s + n.cost.latency, 0)
      const avgLat = totalLatency / toolNodes.length

      // 找 latency > 平均值 3 倍的单个 tool
      for (const node of toolNodes) {
        if (node.cost.latency > avgLat * 3 && node.cost.latency > 1000) {
          candidates.push({
            id: `high_cost_${node.name}_${trace.traceId}`,
            type: 'high_cost_chain',
            toolChain: [node.name],
            frequency: 1,
            avgLatency: node.cost.latency,
            avgTokenCost: node.cost.token || 0,
            sampleTraceIds: [trace.traceId],
            confidence: 0.6,
            description: `高成本调用: ${node.name} (${node.cost.latency}ms，平均 ${Math.round(avgLat)}ms)`,
          })
        }
      }
    }

    return candidates
  }

  /** 检测失败恢复模式：tool fail → retry → eventually success */
  private detectFailureRecovery(traces: ExecutionTrace[]): PatternCandidate[] {
    // v0: 查找包含 plan 决策节点后的 tool 序列（表明是计划驱动的工作流）
    const candidates: PatternCandidate[] = []

    for (const trace of traces) {
      const planNodes = trace.nodes.filter((n) => n.type === 'plan')
      if (planNodes.length > 0) {
        const tools = this.extractToolSequence(trace)
        if (tools.length >= 2) {
          candidates.push({
            id: `planned_workflow_${trace.traceId}`,
            type: 'compound_workflow',
            toolChain: tools,
            frequency: 1,
            avgLatency: Math.round(
              trace.nodes.filter((n) => n.type === 'tool').reduce((s, n) => s + n.cost.latency, 0) /
                Math.max(1, trace.nodes.filter((n) => n.type === 'tool').length),
            ),
            avgTokenCost: 0,
            sampleTraceIds: [trace.traceId],
            confidence: 0.7,
            description: `计划驱动工作流: ${tools.join(' → ')}`,
          })
        }
      }
    }

    return candidates
  }
}
