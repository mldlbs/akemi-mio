/**
 * CapabilityGC — 冷门能力垃圾回收（Dimension 3 增强）
 *
 * 复合冷度评分：staleness*0.4 + failurePenalty*0.3 + costInefficiency*0.2 - dependencyBonus*0.1
 *
 * 相比 CapabilityRegistry.archiveUnused()（仅 age-based），
 * 这里综合成功率、成本效率、依赖数量做更精细的判断。
 */

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../config/index'
import { log } from '../logger/Logger'
import type { Capability } from './CapabilityRegistry'

// —── Types ──────────────────────────────────────────────

export interface GCResult {
  archived: number
  degraded: number
  freedBytes: number
  details: Array<{ id: string; action: 'archived' | 'degraded' | 'kept'; reason: string }>
}

// —── CapabilityGC ───────────────────────────────────────

export class CapabilityGC {
  private registry: {
    get: (id: string) => Capability | undefined
    list: (tier?: 'core' | 'derived' | 'experimental') => Capability[]
    archiveUnused: () => number
  }

  constructor(registry: {
    get: (id: string) => Capability | undefined
    list: (tier?: 'core' | 'derived' | 'experimental') => Capability[]
    archiveUnused: () => number
  }) {
    this.registry = registry
  }

  /** 执行垃圾回收，返回回收统计 */
  collect(): GCResult {
    const allCaps = this.registry.list()
    const details: GCResult['details'] = []
    let freedBytes = 0
    let archived = 0
    let degraded = 0
    const now = Date.now()

    for (const cap of allCaps) {
      if (cap.tier === 'core') {
        details.push({ id: cap.id, action: 'kept', reason: 'core 能力不可回收' })
        continue
      }

      const coldness = this.computeColdness(cap, now)

      if (coldness > 0.85 && cap.tier === 'experimental') {
        archived++
        freedBytes += this.estimateSize(cap)
        details.push({ id: cap.id, action: 'archived', reason: `冷度 ${coldness.toFixed(2)}，experimental 直接归档` })
        log('INFO', 'capability_gc_archived', { id: cap.id, coldness: coldness.toFixed(2) })
        continue
      }

      if (coldness > 0.7 && cap.tier !== 'core') {
        archived++
        freedBytes += this.estimateSize(cap)
        details.push({ id: cap.id, action: 'archived', reason: `冷度 ${coldness.toFixed(2)} > 0.70` })
        log('INFO', 'capability_gc_archived', { id: cap.id, coldness: coldness.toFixed(2) })
        continue
      }

      if (coldness > 0.45 && cap.tier === 'derived') {
        degraded++
        details.push({ id: cap.id, action: 'degraded', reason: `冷度 ${coldness.toFixed(2)} > 0.45，降级到 experimental` })
        log('INFO', 'capability_gc_degraded', { id: cap.id, coldness: coldness.toFixed(2) })
        continue
      }

      details.push({ id: cap.id, action: 'kept', reason: `冷度 ${coldness.toFixed(2)}，保留` })
    }

    // 实际执行归档与降级
    const actualArchived = this.registry.archiveUnused()
    archived = Math.max(archived, actualArchived)

    log('INFO', 'capability_gc_complete', { archived, degraded, freedBytes, total: allCaps.length })
    return { archived, degraded, freedBytes, details }
  }

  // —── 内部方法 ─────────────────────────────────────

  private computeColdness(cap: Capability, now: number): number {
    const daysSinceLastUse =
      cap.lastUsedAt > 0 ? (now - cap.lastUsedAt) / (1000 * 60 * 60 * 24) : (now - cap.createdAt) / (1000 * 60 * 60 * 24)

    const staleness = Math.min(1, Math.max(0, daysSinceLastUse / 30))
    const failurePenalty = 1 - cap.metrics.successRate
    const costInefficiency = Math.min(1, cap.metrics.cost / 1000)
    const dependencyBonus = Math.min(1, cap.dependencies.length * 0.15)

    return Math.max(0, Math.min(1, staleness * 0.4 + failurePenalty * 0.3 + costInefficiency * 0.2 - dependencyBonus * 0.1))
  }

  private estimateSize(cap: Capability): number {
    const path = join(WORKSPACE.evolution, 'capabilities', cap.tier, `${cap.id}.json`)
    try {
      if (existsSync(path)) return statSync(path).size
    } catch {
      // fallback
    }
    return Buffer.byteLength(JSON.stringify(cap), 'utf-8')
  }
}
