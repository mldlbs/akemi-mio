import { getRawDb, markDirty } from '../db/connection'
import type { ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog } from './types'

function parseHypothesis(obj: any): Hypothesis {
  return {
    id: obj.id,
    title: obj.title,
    idea: obj.idea,
    expectedBenefit: obj.expected_benefit,
    risk: obj.risk,
    sourceLabels: JSON.parse(obj.source_labels || '[]'),
    novelty: obj.novelty,
    feasibility: obj.feasibility,
    impact: obj.impact,
    status: obj.status,
    createdAt: obj.created_at,
  }
}

function parseCombo(obj: any): ConceptCombo {
  return {
    id: obj.id,
    sources: JSON.parse(obj.sources || '["",""]'),
    description: obj.description,
    createdAt: obj.created_at,
  }
}

function parseExperiment(obj: any): ExperimentPlan {
  return {
    hypothesisId: obj.hypothesis_id,
    title: obj.title,
    steps: JSON.parse(obj.steps || '[]'),
    successCriteria: JSON.parse(obj.success_criteria || '[]'),
    estimatedDuration: obj.estimated_duration,
    createdAt: obj.created_at,
  }
}

function parseDreamCycle(obj: any): DreamCycleLog {
  return {
    timestamp: obj.timestamp,
    sourcesExamined: obj.sources_examined,
    combosGenerated: obj.combos_generated,
    hypothesesGenerated: obj.hypotheses_generated,
    topIdea: obj.top_idea ?? null,
  }
}

function rowsToObjects(columns: string[], values: any[][]): any[] {
  return values.map((v) => {
    const obj: any = {}
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
    return obj
  })
}

export class DrizzleIdeaStore {
  addCombo(combo: ConceptCombo): void {
    const db = getRawDb()
    db.run('INSERT OR IGNORE INTO concept_combos (id, sources, description, created_at) VALUES (?, ?, ?, ?)', [
      combo.id,
      JSON.stringify(combo.sources),
      combo.description,
      combo.createdAt,
    ])
    markDirty()
  }

  addHypothesis(h: Hypothesis): void {
    const db = getRawDb()
    this.insertHypothesis(db, h)
    markDirty()
  }

  addManyHypotheses(hs: Hypothesis[]): void {
    if (hs.length === 0) return
    const db = getRawDb()
    for (const h of hs) this.insertHypothesis(db, h)
    markDirty()
  }

  addExperiment(exp: ExperimentPlan): void {
    const db = getRawDb()
    db.run(
      'INSERT OR REPLACE INTO experiments (hypothesis_id, title, steps, success_criteria, estimated_duration, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [exp.hypothesisId, exp.title, JSON.stringify(exp.steps), JSON.stringify(exp.successCriteria), exp.estimatedDuration, exp.createdAt],
    )
    markDirty()
  }

  logDreamCycle(entry: DreamCycleLog): void {
    const db = getRawDb()
    db.run(
      'INSERT OR IGNORE INTO dream_cycles (timestamp, sources_examined, combos_generated, hypotheses_generated, top_idea) VALUES (?, ?, ?, ?, ?)',
      [entry.timestamp, entry.sourcesExamined, entry.combosGenerated, entry.hypothesesGenerated, entry.topIdea],
    )
    markDirty()
  }

  getHypotheses(options?: { status?: string; limit?: number }): Hypothesis[] {
    const db = getRawDb()
    let sql = 'SELECT * FROM hypotheses'
    const clauses: string[] = []
    if (options?.status) {
      const escaped = options.status.replace(/'/g, "''")
      clauses.push(`status = '${escaped}'`)
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ')
    sql += ' ORDER BY created_at DESC'
    if (options?.limit) sql += ` LIMIT ${options.limit}`

    const result = db.exec(sql)
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseHypothesis)
  }

  getNovelHypotheses(threshold = 70, limit = 5): Hypothesis[] {
    const db = getRawDb()
    const result = db.exec(
      `SELECT * FROM hypotheses WHERE novelty >= ${threshold} AND status != 'rejected' ORDER BY novelty DESC LIMIT ${limit}`,
    )
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseHypothesis)
  }

  getActiveExperiments(): ExperimentPlan[] {
    const db = getRawDb()
    const result = db.exec(
      "SELECT e.* FROM experiments e INNER JOIN hypotheses h ON e.hypothesis_id = h.id WHERE h.status = 'experimenting'",
    )
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseExperiment)
  }

  getRecentCombos(limit = 20): ConceptCombo[] {
    const db = getRawDb()
    const result = db.exec(`SELECT * FROM concept_combos ORDER BY created_at DESC LIMIT ${limit}`)
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseCombo)
  }

  getRecentDreamCycles(limit = 10): DreamCycleLog[] {
    const db = getRawDb()
    const result = db.exec(`SELECT * FROM dream_cycles ORDER BY timestamp DESC LIMIT ${limit}`)
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseDreamCycle)
  }

  updateHypothesisStatus(id: string, status: Hypothesis['status']): boolean {
    const db = getRawDb()
    const escapedStatus = status.replace(/'/g, "''")
    db.run(`UPDATE hypotheses SET status = '${escapedStatus}' WHERE id = '${id.replace(/'/g, "''")}'`)
    markDirty()
    return true
  }

  count(): { combos: number; hypotheses: number; experiments: number; dreamCycles: number } {
    const db = getRawDb()
    const c = (sql: string) => {
      const r = db.exec(sql)
      return r && r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0
    }
    return {
      combos: c('SELECT COUNT(*) FROM concept_combos'),
      hypotheses: c('SELECT COUNT(*) FROM hypotheses'),
      experiments: c('SELECT COUNT(*) FROM experiments'),
      dreamCycles: c('SELECT COUNT(*) FROM dream_cycles'),
    }
  }

  templateAdoptionStats(): Record<string, { total: number; active: number; rejected: number; adopted: number }> {
    const all = this.getHypotheses()
    const stats: Record<string, { total: number; active: number; rejected: number; adopted: number }> = {}
    for (const h of all) {
      const key = h.sourceLabels.join('|')
      if (!stats[key]) stats[key] = { total: 0, active: 0, rejected: 0, adopted: 0 }
      stats[key].total++
      if (h.status === 'active' || h.status === 'experimenting') stats[key].active++
      if (h.status === 'rejected') stats[key].rejected++
      if (h.status === 'validated') stats[key].adopted++
    }
    return stats
  }

  adoptionReport(limit = 10): string {
    const stats = this.templateAdoptionStats()
    const entries = Object.entries(stats).sort((a, b) => a[1].adopted / Math.max(a[1].total, 1) - b[1].adopted / Math.max(b[1].total, 1))
    const all = this.count()
    let report = `=== 模板采纳率报告 (共 ${all.hypotheses} 条假设) ===\n`
    report += '来源对 | 总数 | 进行中 | 已拒绝 | 已采纳 | 采纳率\n'
    for (const [key, s] of entries.slice(0, limit)) {
      const rate = ((s.adopted / Math.max(s.total, 1)) * 100).toFixed(0)
      report += `${key} | ${s.total} | ${s.active} | ${s.rejected} | ${s.adopted} | ${rate}%\n`
    }
    return report
  }

  private insertHypothesis(db: any, h: Hypothesis): void {
    db.run(
      'INSERT OR IGNORE INTO hypotheses (id, title, idea, expected_benefit, risk, source_labels, novelty, feasibility, impact, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        h.id,
        h.title,
        h.idea,
        h.expectedBenefit,
        h.risk,
        JSON.stringify(h.sourceLabels),
        h.novelty,
        h.feasibility,
        h.impact,
        h.status,
        h.createdAt,
      ],
    )
  }
}
