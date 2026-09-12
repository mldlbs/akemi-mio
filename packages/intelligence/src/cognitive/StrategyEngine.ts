import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb } from '@akemi-mio/core/db/connection'

export interface Strategy {
  id: string
  name: string
  description: string
  promptTemplate: string
  applicableContext: string
  priority: number
  active: number
  version: number
  createdAt: number
  updatedAt: number
}

export type StrategyInput = Omit<Strategy, 'id' | 'createdAt' | 'updatedAt' | 'active' | 'version'>

let idCounter = 0

export class StrategyEngine {
  getActive(contextKeywords: string[]): Strategy[] {
    const db = getRawDb()
    const rows = db.exec('SELECT * FROM strategies WHERE active = 1 ORDER BY priority DESC, created_at DESC')[0]
    if (!rows) return []
    const all: Strategy[] = rows.values.map((v: any[]) => this.rowToStrategy(rows.columns, v))
    return all.filter((s) => this.matchesContext(s, contextKeywords))
  }

  create(input: StrategyInput): Strategy {
    const db = getRawDb()
    const id = `strat_${Date.now()}_${++idCounter}`
    const now = Date.now()
    db.run(
      `INSERT INTO strategies (id, name, description, prompt_template, applicable_context, priority, active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [id, input.name, input.description, input.promptTemplate, input.applicableContext, input.priority, now, now],
    )
    log('INFO', 'strategy_created', { id, name: input.name })
    return { ...input, id, active: 1, version: 1, createdAt: now, updatedAt: now }
  }

  analyzeFailures(failureLogs: Array<{ task: string; error: string; timestamp: number }>): string[] {
    const recommendations: string[] = []
    const recent = failureLogs.slice(-10)
    const errorGroups = new Map<string, number>()
    for (const f of recent) {
      const key = f.error.slice(0, 60)
      errorGroups.set(key, (errorGroups.get(key) || 0) + 1)
    }
    for (const [error, count] of errorGroups) {
      if (count >= 3) {
        recommendations.push(`consecutive_failures: "${error.slice(0, 40)}" occurred ${count}x — consider pausing affected goal`)
      }
    }
    return recommendations
  }

  private matchesContext(strategy: Strategy, keywords: string[]): boolean {
    if (keywords.length === 0) return true
    const ctx = strategy.applicableContext.toLowerCase()
    return keywords.some((k) => ctx.includes(k.toLowerCase()))
  }

  getFormattedContext(keywords?: string[]): string {
    const active = keywords ? this.getActive(keywords) : this.getActive([])
    if (active.length === 0) return ''
    const parts = ['---', '【当前可用策略】']
    for (const s of active) {
      parts.push(`- [${s.name}] ${s.description}`)
      parts.push(`  适用场景: ${s.applicableContext}`)
    }
    parts.push('---')
    return parts.join('\n')
  }

  private rowToStrategy(columns: string[], values: any[]): Strategy {
    const obj: any = {}
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
    return {
      id: obj.id,
      name: obj.name,
      description: obj.description,
      promptTemplate: obj.prompt_template,
      applicableContext: obj.applicable_context,
      priority: obj.priority,
      active: obj.active,
      version: obj.version,
      createdAt: obj.created_at,
      updatedAt: obj.updated_at,
    }
  }
}
