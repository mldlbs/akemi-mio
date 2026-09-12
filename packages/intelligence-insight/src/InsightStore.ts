import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Insight, InsightStoreData } from '@akemi-mio/intelligence-insight/types'
import { STORE_VERSION } from '@akemi-mio/intelligence-insight/types'
import { log } from '@akemi-mio/core/logger/Logger'

export class InsightStore {
  private data: InsightStoreData
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = this.load()
  }

  private load(): InsightStoreData {
    try {
      if (!existsSync(this.filePath)) {
        return { version: STORE_VERSION, insights: [], reportedIds: [] }
      }
      return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch {
      return { version: STORE_VERSION, insights: [], reportedIds: [] }
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'insight_store_save_failed', { error: String(err) })
    }
  }

  addMany(insights: Insight[]): void {
    if (insights.length === 0) return
    this.data.insights.push(...insights)
    this.save()
    log('INFO', 'insight_stored_batch', { count: insights.length })
  }

  getUnreported(): Insight[] {
    return this.data.insights.filter((i) => !this.data.reportedIds.includes(i.id)).sort((a, b) => b.score - a.score)
  }

  getHighValueUnreported(scoreThreshold = 50, confidenceThreshold = 0.7): Insight[] {
    return this.data.insights
      .filter((i) => !this.data.reportedIds.includes(i.id) && i.score >= scoreThreshold && i.confidence >= confidenceThreshold)
      .sort((a, b) => b.score - a.score)
  }

  markReported(id: string): void {
    if (!this.data.reportedIds.includes(id)) {
      this.data.reportedIds.push(id)
      this.save()
    }
  }

  markAllReported(): void {
    const unreported = this.data.insights.filter((i) => !this.data.reportedIds.includes(i.id))
    for (const i of unreported) {
      this.data.reportedIds.push(i.id)
    }
    this.save()
  }

  getAll(): Insight[] {
    return [...this.data.insights].sort((a, b) => b.createdAt - a.createdAt)
  }

  prune(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const unreportedKeep = this.data.insights.filter((i) => !this.data.reportedIds.includes(i.id) && i.createdAt > cutoff)
    const before = this.data.insights.length
    this.data.insights = this.data.insights.filter((i) => i.createdAt > cutoff || !this.data.reportedIds.includes(i.id))
    const removed = before - this.data.insights.length
    if (removed > 0) {
      this.save()
      log('INFO', 'insight_pruned', { removed })
    }
    return removed
  }

  count(): number {
    return this.data.insights.length
  }
}
