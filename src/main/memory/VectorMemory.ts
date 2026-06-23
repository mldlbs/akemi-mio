import { log } from '../logger/Logger'
import type { VectorEntry } from './types'
import { getRawDb, markDirty } from '../db/connection'
import { cosineSimilarity, fallbackEmbed, getEmbedding } from './embedding'

let idCounter = 0

const MAX_ENTRIES = 200

export class VectorMemory {
  private entries: VectorEntry[] = []
  private dirty = false

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      const db = getRawDb()
      const result = db.exec('SELECT * FROM memory_vectors ORDER BY created_at ASC')
      if (result && result.length > 0) {
        const columns = result[0].columns
        this.entries = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            content: obj.content,
            embedding: JSON.parse(obj.embedding || '[]'),
            confidence: obj.confidence,
            source: obj.source,
            createdAt: obj.created_at,
            updatedAt: obj.updated_at,
          } as VectorEntry
        })
      }
      log('INFO', 'vector_loaded', { count: this.entries.length })
    } catch (err) {
      log('WARN', 'vector_load_failed', { error: String(err) })
    }
  }

  async store(content: string, confidence: number, source: VectorEntry['source']): Promise<void> {
    const existing = this.entries.find((e) => e.content === content)
    if (existing) {
      existing.updatedAt = Date.now()
      existing.confidence = Math.max(existing.confidence, confidence)
      this.dirty = true
      this.updateInDb(existing)
      return
    }

    const embedding = await getEmbedding(content)
    if (embedding.length === 0) {
      log('WARN', 'vector_store_skip_no_embedding', { content })
      return
    }

    const id = `vec_${Date.now()}_${++idCounter}`
    const entry: VectorEntry = { id, content, embedding, confidence, source, createdAt: Date.now(), updatedAt: Date.now() }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.prune()
    this.dirty = true
    this.saveToDb(entry)
    log('INFO', 'vector_stored', { content, source })
  }

  async query(query: string, topK = 3): Promise<string[]> {
    const queryEmb = await getEmbedding(query)
    if (queryEmb.length === 0) return []

    const scored = this.entries
      .map((e) => ({ content: e.content, score: cosineSimilarity(queryEmb, e.embedding) }))
      .filter((e) => e.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    return scored.map((e) => e.content)
  }

  /** 同步版本：使用 fallback 嵌入，用于 getFormattedContext 等同步调用路径 */
  querySync(query: string, topK = 3): string[] {
    const queryEmb = fallbackEmbed(query)
    if (queryEmb.length === 0) return []

    const scored = this.entries
      .map((e) => ({ content: e.content, score: cosineSimilarity(queryEmb, e.embedding) }))
      .filter((e) => e.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    return scored.map((e) => e.content)
  }

  private prune(): void {
    this.entries.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    this.entries = this.entries.slice(0, MAX_ENTRIES)
  }

  flush(): void {
    if (!this.dirty) return
    this.flushToDb()
    this.dirty = false
  }

  private saveToDb(e: VectorEntry): void {
    try {
      const db = getRawDb()
      db.run(
        'INSERT OR IGNORE INTO memory_vectors (id, content, embedding, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [e.id, e.content, JSON.stringify(e.embedding), e.confidence, e.source, e.createdAt, e.updatedAt],
      )
      markDirty()
    } catch (err) {
      log('WARN', 'vector_db_write_failed', { error: String(err) })
    }
  }

  private updateInDb(e: VectorEntry): void {
    try {
      const db = getRawDb()
      db.run('UPDATE memory_vectors SET confidence = ?, updated_at = ? WHERE id = ?', [e.confidence, e.updatedAt, e.id])
      markDirty()
    } catch (err) {
      log('WARN', 'vector_db_update_failed', { error: String(err) })
    }
  }

  private flushToDb(): void {
    // 写穿透：saveToDb/updateInDb 已在个体写入时即时持久化
    // flush 无需重复写入，仅保留用于重置 dirty 标记
    log('INFO', 'vector_flush_skipped_wt', { count: this.entries.length })
  }
}
