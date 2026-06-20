import { getRawDb, markDirty } from '../db/connection'
import { log } from '../logger/Logger'
import type { Insight } from './types'

function rowToInsight(obj: any): Insight {
  return {
    id: obj.id,
    detector: obj.detector,
    title: obj.title,
    description: obj.description,
    evidence: JSON.parse(obj.evidence || '[]'),
    score: obj.score,
    confidence: obj.confidence,
    createdAt: obj.created_at,
  }
}

export class DrizzleInsightStore {
  getAll(): Insight[] {
    const db = getRawDb()
    const result = db.exec('SELECT * FROM insights ORDER BY created_at DESC')
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return this.rowsToInsights(result[0].columns, result[0].values)
  }

  addMany(items: Insight[]): void {
    if (items.length === 0) return
    const db = getRawDb()
    for (const item of items) {
      db.run(
        'INSERT OR IGNORE INTO insights (id, detector, title, description, evidence, score, confidence, reported, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [item.id, item.detector, item.title, item.description, JSON.stringify(item.evidence), item.score, item.confidence, item.createdAt],
      )
    }
    markDirty()
    log('INFO', 'insight_stored_batch', { count: items.length })
  }

  getUnreported(): Insight[] {
    const db = getRawDb()
    const result = db.exec('SELECT * FROM insights WHERE reported = 0 ORDER BY score DESC')
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return this.rowsToInsights(result[0].columns, result[0].values)
  }

  getHighValueUnreported(scoreThreshold = 50, confidenceThreshold = 0.7): Insight[] {
    const db = getRawDb()
    const result = db.exec(
      `SELECT * FROM insights WHERE reported = 0 AND score >= ${scoreThreshold} AND confidence >= ${confidenceThreshold} ORDER BY score DESC`,
    )
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return this.rowsToInsights(result[0].columns, result[0].values)
  }

  markReported(id: string): void {
    const db = getRawDb()
    db.run(`UPDATE insights SET reported = 1 WHERE id = '${id.replace(/'/g, "''")}'`)
    markDirty()
  }

  markAllReported(): void {
    const db = getRawDb()
    db.run('UPDATE insights SET reported = 1 WHERE reported = 0')
    markDirty()
  }

  prune(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const db = getRawDb()
    const result = db.exec(`SELECT COUNT(*) as cnt FROM insights WHERE reported = 1 AND created_at < ${cutoff}`)
    const before = result && result.length > 0 && result[0].values.length > 0 ? Number(result[0].values[0][0]) : 0
    db.run(`DELETE FROM insights WHERE reported = 1 AND created_at < ${cutoff}`)
    if (before > 0) {
      markDirty()
      log('INFO', 'insight_pruned', { removed: before })
    }
    return before
  }

  count(): number {
    const db = getRawDb()
    const result = db.exec('SELECT COUNT(*) as cnt FROM insights')
    return result && result.length > 0 && result[0].values.length > 0 ? Number(result[0].values[0][0]) : 0
  }

  private rowsToInsights(columns: string[], values: any[][]): Insight[] {
    return values.map((v) => {
      const obj: any = {}
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
      return rowToInsight(obj)
    })
  }
}
