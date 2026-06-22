/**
 * SleepCycle — 低负载维护循环
 *
 * 职责：
 * - 低负载时触发后台任务（记忆固化、模式挖掘）
 * - 委托 MetaController.backgroundOptimization() 做 P1→P2 提纯
 * - 保留 FailureAnalyzer 模式持久化（与 MetaController 互补）
 *
 * v2 改动：consolidation/memory merge 委托给 MetaController，
 * SleepCycle 保持轻量调度入口角色。
 */

import { log } from '../logger/Logger'
import { MemoryService } from '../memory/MemoryService'
import type { MetaController } from '../memory/MetaController'
import { FailureAnalyzer } from './FailureAnalyzer'

export class SleepCycle {
  private memoryService: MemoryService | null = null
  private failureAnalyzer: FailureAnalyzer | null = null
  private metaController: MetaController | null = null

  setDeps(memory: MemoryService, failureAnalyzer: FailureAnalyzer): void {
    this.memoryService = memory
    this.failureAnalyzer = failureAnalyzer
  }

  setMetaController(mc: MetaController): void {
    this.metaController = mc
  }

  async run(isBusy: () => boolean): Promise<void> {
    if (isBusy()) {
      log('INFO', 'sleep_cycle_skipped_busy')
      return
    }

    log('INFO', 'sleep_cycle_start')
    const t0 = Date.now()

    const metaTask = this.metaController?.backgroundOptimization() || Promise.resolve()

    const results = await Promise.allSettled([metaTask, this.consolidateMemory(), this.mineFailurePatterns()])

    const ok = results.filter((r) => r.status === 'fulfilled').length
    log('INFO', 'sleep_cycle_done', { elapsed: Date.now() - t0, ok, total: results.length })
  }

  private async consolidateMemory(): Promise<void> {
    if (!this.memoryService) return

    const entries = this.memoryService.getEntries()
    if (entries.length === 0) return

    const seen = new Map<string, string[]>()
    for (const e of entries) {
      const key = `${e.type}|${e.content}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push(e.id)
    }

    let merged = 0
    for (const [, ids] of seen) {
      if (ids.length > 1) {
        const keep = entries.find((e) => e.id === ids[0])
        const rest = ids.slice(1)
        if (keep) {
          for (const id of rest) {
            const idx = entries.findIndex((e) => e.id === id)
            if (idx >= 0) entries.splice(idx, 1)
          }
          keep.reinforceCount += rest.length
          merged += rest.length
        }
      }
    }

    const beforeClean = entries.length
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].confidence < 0.3 && entries[i].tier !== 'permanent') {
        entries.splice(i, 1)
      }
    }

    for (const e of entries) {
      this.memoryService['tryPromote']?.(e)
    }

    this.memoryService.flush()

    log('INFO', 'memory_consolidated', {
      merged,
      cleaned: beforeClean - entries.length,
      remaining: entries.length,
    })
  }

  private async mineFailurePatterns(): Promise<void> {
    if (!this.failureAnalyzer) return
    const saved = this.failureAnalyzer.persistHotPatterns()
    if (saved > 0) {
      log('INFO', 'sleep_cycle_failures_persisted', { patterns: saved })
    }
  }
}
