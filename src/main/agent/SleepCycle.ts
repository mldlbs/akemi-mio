import { log } from '../logger/Logger'
import { MemoryService } from '../memory/MemoryService'
import { FailureAnalyzer } from './FailureAnalyzer'

/**
 * SleepCycle — 低负载时执行记忆固化、模式挖掘、垃圾回收。
 *
 * 安排在用户离线或系统空闲时运行。当前实现：
 * - 使用 Scheduler 以固定低频间隔执行
 * - 仅当 agent 不繁忙时运行
 *
 * Phase 3 方向：
 * - 可引入"梦境"阶段（类似 CreativityService 的 dream mode）
 * - 跨 session 的模式挖掘
 */
export class SleepCycle {
  private memoryService: MemoryService | null = null
  private failureAnalyzer: FailureAnalyzer | null = null

  setDeps(memory: MemoryService, failureAnalyzer: FailureAnalyzer): void {
    this.memoryService = memory
    this.failureAnalyzer = failureAnalyzer
  }

  async run(isBusy: () => boolean): Promise<void> {
    if (isBusy()) {
      log('INFO', 'sleep_cycle_skipped_busy')
      return
    }

    log('INFO', 'sleep_cycle_start')
    const t0 = Date.now()

    const results = await Promise.allSettled([this.consolidateMemory(), this.mineFailurePatterns()])

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

    // 持久化：将内存中的去重/清理/晋升写回 DB
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
