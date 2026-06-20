import { log } from '../logger/Logger'
import { getRawDb } from '../db/connection'
import { LLMKnowledgeExtractor } from './extractors/LLMKnowledgeExtractor'

let idCounter = 0

/**
 * 简单实体提取：从事实文本中提取 entity→attribute→value 三元组。
 * 当前只做关键词匹配，未来可升级为 LLM 提取。
 */
function extractTriples(content: string): Array<{ entity: string; attribute: string; value: string }> {
  const triples: Array<{ entity: string; attribute: string; value: string }> = []

  // 模式1: "用户喜欢/偏好/使用 X"
  const prefMatch = content.match(/用户(?:喜欢|偏好|使用|用|做)['']?(.+?)(?:['']?$|[，。])/)
  if (prefMatch) {
    triples.push({ entity: '用户', attribute: '偏好', value: prefMatch[1] })
  }

  // 模式2: "用户是/在/从事 X"
  const isMatch = content.match(/用户(?:是|在|从事)['']?(.+?)(?:['']?$|[，。])/)
  if (isMatch) {
    triples.push({ entity: '用户', attribute: '属性', value: isMatch[1] })
  }

  // 模式3: "项目使用/基于/用了 X"
  const projMatch = content.match(/(?:项目|这个项目|当前项目)(?:使用|基于|用了)['']?(.+?)(?:['']?$|[，。])/)
  if (projMatch) {
    triples.push({ entity: '项目', attribute: '技术栈', value: projMatch[1] })
  }

  return triples
}

export class KnowledgeGraph {
  private llmExtractor: LLMKnowledgeExtractor | null = null

  setLLMExtractor(extractor: LLMKnowledgeExtractor): void {
    this.llmExtractor = extractor
  }

  /** 从事实中提取实体关系并存储 */
  ingest(content: string, confidence: number): void {
    const triples = extractTriples(content)
    if (triples.length === 0) return

    const db = getRawDb()
    const now = Date.now()
    for (const t of triples) {
      const existing = db.prepare('SELECT id, confidence FROM knowledge_graph WHERE entity = ? AND attribute = ? AND value = ?')
      existing.bind([t.entity, t.attribute, t.value])
      if (existing.step()) {
        const row = existing.getAsObject() as any
        existing.free()
        // 更新置信度（取 max）和时间
        const newConf = Math.max(row.confidence, confidence)
        db.run('UPDATE knowledge_graph SET confidence = ?, updated_at = ? WHERE id = ?', [newConf, now, row.id])
      } else {
        existing.free()
        const id = `kg_${now}_${++idCounter}`
        db.run('INSERT INTO knowledge_graph (id, entity, attribute, value, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          id,
          t.entity,
          t.attribute,
          t.value,
          confidence,
          now,
        ])
      }
    }
    log('INFO', 'kg_ingested', { content: content.slice(0, 50), triples: triples.length })

    // LLM 增强提取（补充而非替代 regex）
    if (this.llmExtractor && content.length > 20) {
      this.llmExtractor
        .extract(content)
        .then((llmTriples) => {
          if (llmTriples.length === 0) return
          const db = getRawDb()
          const now = Date.now()
          for (const t of llmTriples) {
            const existing = db.prepare('SELECT id, confidence FROM knowledge_graph WHERE entity = ? AND attribute = ? AND value = ?')
            existing.bind([t.entity, t.attribute, t.value])
            if (existing.step()) {
              const row = existing.getAsObject() as any
              existing.free()
              const newConf = Math.max(row.confidence, t.confidence)
              db.run('UPDATE knowledge_graph SET confidence = ?, updated_at = ? WHERE id = ?', [newConf, now, row.id])
            } else {
              existing.free()
              const id = `kg_llm_${now}_${++idCounter}`
              db.run('INSERT INTO knowledge_graph (id, entity, attribute, value, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
                id,
                t.entity,
                t.attribute,
                t.value,
                t.confidence,
                now,
              ])
            }
          }
          log('INFO', 'kg_llm_ingested', { llmTriples: llmTriples.length })
        })
        .catch(() => {})
    }
  }

  /** 查询指定实体的所有属性 */
  query(entity: string): Array<{ attribute: string; value: string; confidence: number }> {
    const db = getRawDb()
    const rows: Array<{ attribute: string; value: string; confidence: number }> = []
    const stmt = db.prepare('SELECT attribute, value, confidence FROM knowledge_graph WHERE entity = ? ORDER BY confidence DESC')
    stmt.bind([entity])
    while (stmt.step()) {
      const r = stmt.getAsObject() as any
      rows.push({ attribute: r.attribute, value: r.value, confidence: r.confidence })
    }
    stmt.free()
    return rows
  }

  /** 构建可注入 prompt 的知识图谱上下文 */
  getFormattedContext(): string {
    const entities = this.listEntities()
    if (entities.length === 0) return ''

    const parts: string[] = ['【知识图谱】']
    for (const entity of entities) {
      const attrs = this.query(entity)
      const attrStr = attrs.map((a) => `  ${a.attribute}: ${a.value}`).join('\n')
      parts.push(`实体「${entity}」:`)
      parts.push(attrStr)
    }
    return parts.join('\n')
  }

  private listEntities(): string[] {
    const db = getRawDb()
    const stmt = db.prepare('SELECT DISTINCT entity FROM knowledge_graph ORDER BY entity')
    const entities: string[] = []
    while (stmt.step()) {
      entities.push(String(stmt.get()[0]))
    }
    stmt.free()
    return entities
  }

  /** 清除所有数据 */
  clear(): void {
    const db = getRawDb()
    db.run('DELETE FROM knowledge_graph')
  }
}
