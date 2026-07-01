/**
 * CapabilityCompiler v0 — 从 aligned trace 编译为可执行能力（Phase 3）
 *
 * v0 只做 workflow compression：
 * PatternCandidate → 新 Capability 注册到 CapabilityRegistry
 *
 * 编译产出：
 * - executor.type = 'toolchain'（v0 只产出工具链包装）
 * - evaluator.type = 'heuristic'（基于已有 metrics 验证）
 */

import { log } from '../logger/Logger'
import type { PatternCandidate } from './PatternMiner'
import { CapabilityRegistry, type Capability } from './CapabilityRegistry'

export class CapabilityCompiler {
  private registry: CapabilityRegistry

  constructor(registry: CapabilityRegistry) {
    this.registry = registry
  }

  /** 获取底层 registry（供外部读取能力列表） */
  getRegistry(): CapabilityRegistry {
    return this.registry
  }

  /** 将 pattern candidate 编译为 capability 并注册 */
  compile(candidate: PatternCandidate): Capability | null {
    // 去重：已有相同 tool chain 的能力则跳过
    const existing = this.registry.findByIntent(candidate.description)
    if (existing.some((c) => arraysEqual(c.executor.body.split('→'), candidate.toolChain))) {
      log('INFO', 'capability_compile_skip_duplicate', { id: candidate.id })
      return null
    }

    const cap: Capability = {
      id: candidate.id,
      intent: candidate.description,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
      executor: {
        type: 'toolchain',
        body: candidate.toolChain.join('→'),
      },
      dependencies: candidate.toolChain,
      preconditions: [],
      evaluator: {
        type: 'heuristic',
        spec: `verify each tool ${candidate.toolChain.length > 1 ? `chain step` : 'call'} succeeds`,
      },
      metrics: {
        successRate: candidate.confidence,
        latency: candidate.avgLatency,
        cost: candidate.avgTokenCost,
      },
      tier: 'experimental', // 新能力默认 experimental
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usageCount: 0,
      lastUsedAt: 0,
    }

    this.registry.register(cap)
    log('INFO', 'capability_compiled', {
      id: cap.id,
      chain: cap.executor.body,
      confidence: candidate.confidence,
      tier: cap.tier,
    })
    return cap
  }

  /** 批量编译多个 candidates */
  compileAll(candidates: PatternCandidate[]): Capability[] {
    const compiled: Capability[] = []
    for (const c of candidates) {
      const cap = this.compile(c)
      if (cap) compiled.push(cap)
    }
    log('INFO', 'capability_compile_batch', {
      candidates: candidates.length,
      compiled: compiled.length,
    })
    return compiled
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
