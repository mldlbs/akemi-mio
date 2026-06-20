import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { CreativityStoreData, ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog } from './types'
import { CREATIVITY_STORE_VERSION } from './types'
import { log } from '../logger/Logger'

export class IdeaStore {
  private data: CreativityStoreData
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = this.load()
  }

  private load(): CreativityStoreData {
    try {
      if (!existsSync(this.filePath)) {
        return { version: CREATIVITY_STORE_VERSION, combos: [], hypotheses: [], experiments: [], dreamCycles: [] }
      }
      return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch {
      return { version: CREATIVITY_STORE_VERSION, combos: [], hypotheses: [], experiments: [], dreamCycles: [] }
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'creativity_store_save_failed', { error: String(err) })
    }
  }

  addCombo(combo: ConceptCombo): void {
    this.data.combos.push(combo)
    this.save()
  }

  addHypothesis(h: Hypothesis): void {
    this.data.hypotheses.push(h)
    this.save()
  }

  addManyHypotheses(hs: Hypothesis[]): void {
    if (hs.length === 0) return
    this.data.hypotheses.push(...hs)
    this.save()
  }

  addExperiment(exp: ExperimentPlan): void {
    this.data.experiments.push(exp)
    this.save()
  }

  logDreamCycle(logEntry: DreamCycleLog): void {
    this.data.dreamCycles.push(logEntry)
    this.save()
  }

  getHypotheses(options?: { status?: string; limit?: number }): Hypothesis[] {
    let result = [...this.data.hypotheses].sort((a, b) => b.createdAt - a.createdAt)
    if (options?.status) result = result.filter((h) => h.status === options.status)
    if (options?.limit) result = result.slice(0, options.limit)
    return result
  }

  getNovelHypotheses(threshold = 70, limit = 5): Hypothesis[] {
    return this.data.hypotheses
      .filter((h) => h.novelty >= threshold && h.status !== 'rejected')
      .sort((a, b) => b.novelty - a.novelty)
      .slice(0, limit)
  }

  getActiveExperiments(): ExperimentPlan[] {
    const activeIds = new Set(this.data.hypotheses.filter((h) => h.status === 'experimenting').map((h) => h.id))
    return this.data.experiments.filter((e) => activeIds.has(e.hypothesisId))
  }

  getRecentCombos(limit = 20): ConceptCombo[] {
    return [...this.data.combos].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  getRecentDreamCycles(limit = 10): DreamCycleLog[] {
    return [...this.data.dreamCycles].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
  }

  updateHypothesisStatus(id: string, status: Hypothesis['status']): boolean {
    const h = this.data.hypotheses.find((h) => h.id === id)
    if (!h) return false
    h.status = status
    this.save()
    return true
  }

  count(): { combos: number; hypotheses: number; experiments: number; dreamCycles: number } {
    return {
      combos: this.data.combos.length,
      hypotheses: this.data.hypotheses.length,
      experiments: this.data.experiments.length,
      dreamCycles: this.data.dreamCycles.length,
    }
  }

  /** 按来源对统计每个模板的假设状态分布 */
  templateAdoptionStats(): Record<string, { total: number; active: number; rejected: number; adopted: number }> {
    const stats: Record<string, { total: number; active: number; rejected: number; adopted: number }> = {}
    for (const h of this.data.hypotheses) {
      const key = h.sourceLabels.join('|')
      if (!stats[key]) stats[key] = { total: 0, active: 0, rejected: 0, adopted: 0 }
      stats[key].total++
      if (h.status === 'active' || h.status === 'experimenting') stats[key].active++
      if (h.status === 'rejected') stats[key].rejected++
      if (h.status === 'validated') stats[key].adopted++
    }
    return stats
  }

  /** 报告采纳率最低/最高的来源对 */
  adoptionReport(limit = 10): string {
    const stats = this.templateAdoptionStats()
    const entries = Object.entries(stats).sort((a, b) => a[1].adopted / Math.max(a[1].total, 1) - b[1].adopted / Math.max(b[1].total, 1))
    let report = `=== 模板采纳率报告 (共 ${this.data.hypotheses.length} 条假设) ===\n`
    report += '来源对 | 总数 | 进行中 | 已拒绝 | 已采纳 | 采纳率\n'
    for (const [key, s] of entries.slice(0, limit)) {
      const rate = ((s.adopted / Math.max(s.total, 1)) * 100).toFixed(0)
      report += `${key} | ${s.total} | ${s.active} | ${s.rejected} | ${s.adopted} | ${rate}%\n`
    }
    return report
  }
}
