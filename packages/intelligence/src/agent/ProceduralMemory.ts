import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb } from '@akemi-mio/core/db/connection'
import { fallbackEmbed, cosineSimilarity } from '@akemi-mio/intelligence-memory/embedding'

export interface Procedure {
  id: string
  name: string
  description: string
  steps: string[]
  triggerKeywords: string[]
  successCount: number
  failCount: number
  embedding?: number[]
  createdAt: number
  updatedAt: number
}

let idCounter = 0
const MAX_PROCEDURES = 50

/**
 * ProceduralMemory — 记录可复用的成功操作序列。
 *
 * LLM 通过 remember_procedure 工具保存流程，
 * 系统通过触发词在 system prompt 中注入相关流程。
 */
export class ProceduralMemory {
  save(params: { name: string; description: string; steps: string[]; triggerKeywords: string[] }): Procedure {
    const db = getRawDb()
    const id = `proc_${Date.now()}_${++idCounter}`
    const now = Date.now()
    const embedding = this.computeEmbedding(params)

    const existing = this.findByName(params.name)
    if (existing) {
      db.run(`UPDATE procedures SET description = ?, steps = ?, trigger_keywords = ?, embedding = ?, updated_at = ? WHERE id = ?`, [
        params.description,
        JSON.stringify(params.steps),
        JSON.stringify(params.triggerKeywords),
        JSON.stringify(embedding),
        now,
        existing.id,
      ])
      log('INFO', 'procedure_updated', { name: params.name, steps: params.steps.length })
      return {
        ...existing,
        description: params.description,
        steps: params.steps,
        triggerKeywords: params.triggerKeywords,
        embedding,
        updatedAt: now,
      }
    }

    db.run(
      `INSERT INTO procedures (id, name, description, steps, trigger_keywords, embedding, success_count, fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        id,
        params.name,
        params.description,
        JSON.stringify(params.steps),
        JSON.stringify(params.triggerKeywords),
        JSON.stringify(embedding),
        now,
        now,
      ],
    )

    this.prune()
    log('INFO', 'procedure_saved', { name: params.name, steps: params.steps.length })
    return {
      id,
      name: params.name,
      description: params.description,
      steps: params.steps,
      triggerKeywords: params.triggerKeywords,
      embedding,
      successCount: 0,
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    }
  }

  /** 从组合文本生成向量嵌入（同步 fallback） */
  private computeEmbedding(params: { name: string; description: string; steps: string[]; triggerKeywords: string[] }): number[] {
    const text = [params.name, params.description, ...params.steps, ...params.triggerKeywords].join(' ')
    return fallbackEmbed(text)
  }

  /** 按语义向量搜索相关流程 */
  findByEmbedding(query: string, topK = 3): Procedure[] {
    const queryEmb = fallbackEmbed(query)
    const all = this.listAll()
    const scored = all
      .filter((p) => p.embedding && p.embedding.length > 0)
      .map((p) => ({ procedure: p, score: cosineSimilarity(queryEmb, p.embedding!) }))
      .filter((s) => s.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.procedure)
    return scored
  }

  /** 按触发词搜索相关流程 */
  findByKeywords(keywords: string[], topK = 3): Procedure[] {
    const db = getRawDb()
    const all = this.listAll()
    const scored = all.map((p) => {
      let score = 0
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase()
        if (p.name.toLowerCase().includes(kwLower)) score += 3
        if (p.description.toLowerCase().includes(kwLower)) score += 2
        if (p.triggerKeywords.some((t) => t.toLowerCase().includes(kwLower))) score += 2
        if (p.steps.some((s) => s.toLowerCase().includes(kwLower))) score += 1
      }
      return { procedure: p, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.procedure)
  }

  private findByName(name: string): Procedure | null {
    return this.listAll().find((p) => p.name === name) || null
  }

  listAll(): Procedure[] {
    const db = getRawDb()
    const rows = db.exec('SELECT * FROM procedures ORDER BY success_count DESC, updated_at DESC')[0]
    if (!rows) return []
    return rows.values.map((v: any[]) => this.rowToProc(rows.columns, v))
  }

  recordHit(name: string): void {
    const db = getRawDb()
    db.run('UPDATE procedures SET success_count = success_count + 1, updated_at = ? WHERE name = ?', [Date.now(), name])
  }

  recordFail(name: string): void {
    const db = getRawDb()
    db.run('UPDATE procedures SET fail_count = fail_count + 1, updated_at = ? WHERE name = ?', [Date.now(), name])
  }

  /** 格式化上下文注入 */
  getFormattedContext(keywords?: string[]): string {
    const candidates = keywords?.length ? this.findByEmbedding(keywords.join(' '), 3) : this.listAll().slice(0, 3)
    if (candidates.length === 0) return ''

    const parts = ['---', '【可用流程】']
    for (const p of candidates) {
      parts.push(`- ${p.name}: ${p.description.slice(0, 80)}`)
      parts.push(`  步骤: ${p.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}`)
      parts.push(`  触发: ${p.triggerKeywords.join(', ')}`)
    }
    parts.push('提示：遇到匹配场景时可直接调用 remember_procedure 查看完整流程')
    parts.push('---')
    return parts.join('\n')
  }

  private prune(): void {
    const all = this.listAll()
    if (all.length <= MAX_PROCEDURES) return
    const toDelete = all.slice(MAX_PROCEDURES)
    const db = getRawDb()
    for (const p of toDelete) {
      db.run('DELETE FROM procedures WHERE id = ?', [p.id])
    }
  }

  private rowToProc(columns: string[], values: any[]): Procedure {
    const obj: any = {}
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
    return {
      id: obj.id,
      name: obj.name,
      description: obj.description,
      steps: JSON.parse(obj.steps || '[]'),
      triggerKeywords: JSON.parse(obj.trigger_keywords || '[]'),
      embedding: obj.embedding ? JSON.parse(obj.embedding) : undefined,
      successCount: obj.success_count || 0,
      failCount: obj.fail_count || 0,
      createdAt: obj.created_at,
      updatedAt: obj.updated_at,
    }
  }
}
