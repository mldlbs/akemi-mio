/**
 * EventAuditor — EventBus 事件审计模块
 *
 * 订阅 agent 生命周期事件（tool.invoked/completed/failed, error, input.received, response.generated），
 * 批量写入 agent_events 表。纯本地逻辑，批量缓冲区防热路径加锁。
 *
 * 与 plugin/AuditTrail 的区别：
 * - plugin/AuditTrail 面向 plugin tool_call 权限审计
 * - EventAuditor 面向 agent 生命周期事件（EventBus 驱动）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { EventBus, eventBus as defaultEventBus } from '@akemi-mio/core/core/EventBus'
import { getRawDb } from '@akemi-mio/core/db/connection'
import type { EventName, EventPayload } from '@akemi-mio/core/core/EventBus'

export type AuditEventType = 'tool_invoked' | 'tool_completed' | 'tool_failed' | 'error' | 'input_received' | 'response_generated'

export interface AuditRecord {
  id: string
  timestamp: number
  eventType: AuditEventType
  agentId: string
  source: string
  detail: string
  durationMs?: number
  createdAt: number
}

export interface AuditQuery {
  eventTypes?: AuditEventType[]
  agentId?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export interface EventAuditorConfig {
  retentionHours?: number
  flushIntervalMs?: number
  maxBufferSize?: number
}

const DEFAULT_CONFIG: Required<EventAuditorConfig> = {
  retentionHours: 168, // 7 days
  flushIntervalMs: 5000,
  maxBufferSize: 100,
}

let idCounter = 0

export class EventAuditor {
  private config: Required<EventAuditorConfig>
  private eventBus: EventBus
  private buffer: AuditRecord[] = []
  private unsubscribers: (() => void)[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private retentionTimer: ReturnType<typeof setInterval> | null = null
  private toolInvokedCache = new Map<string, { tool: string; timestamp: number }>()
  private started = false

  constructor(config?: EventAuditorConfig, bus?: EventBus) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.eventBus = bus || defaultEventBus
  }

  get retentionHours(): number {
    return this.config.retentionHours
  }

  /** 开始订阅 EventBus 事件 */
  start(): void {
    if (this.started) return
    this.started = true

    this.unsubscribers.push(this.eventBus.on('agent.tool.invoked', (p) => this.onToolInvoked(p)))
    this.unsubscribers.push(this.eventBus.on('agent.tool.completed', (p) => this.onToolCompleted(p)))
    this.unsubscribers.push(this.eventBus.on('agent.tool.failed', (p) => this.onToolFailed(p)))
    this.unsubscribers.push(this.eventBus.on('agent.error', (p) => this.onError(p)))
    this.unsubscribers.push(this.eventBus.on('agent.input.received', (p) => this.onInputReceived(p)))
    this.unsubscribers.push(this.eventBus.on('agent.response.generated', (p) => this.onResponseGenerated(p)))

    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs)
    this.enforceRetention()

    // 每小时清理一次过期数据
    this.retentionTimer = setInterval(() => this.enforceRetention(), 3600_000)

    log('INFO', 'event_auditor_started', {
      retentionHours: this.config.retentionHours,
      flushIntervalMs: this.config.flushIntervalMs,
    })
  }

  /** 停止订阅，刷出缓冲区 */
  stop(): void {
    if (!this.started) return
    this.started = false

    for (const unsub of this.unsubscribers) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers = []

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }

    this.flush()
    this.toolInvokedCache.clear()
    log('INFO', 'event_auditor_stopped')
  }

  // ══════════════════════════════════════════
  //  事件处理器（O(1)，仅缓冲）
  // ══════════════════════════════════════════

  private onToolInvoked(p: EventPayload['agent.tool.invoked']): void {
    const key = `tool_${p.tool}_${Date.now()}`
    this.toolInvokedCache.set(key, { tool: p.tool, timestamp: Date.now() })
    this.push({
      eventType: 'tool_invoked',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ tool: p.tool, args: this.truncateArgs(p.args) }),
    })
  }

  private onToolCompleted(p: EventPayload['agent.tool.completed']): void {
    // Match by tool name + recent timestamp since the payload has no requestId
    const now = Date.now()
    let key = ''
    let cached: { tool: string; timestamp: number } | undefined
    for (const [k, v] of this.toolInvokedCache) {
      if (v.tool === p.tool && now - v.timestamp < 30_000) {
        key = k
        cached = v
        break
      }
    }
    const durationMs = cached ? Date.now() - cached.timestamp : undefined
    if (cached) this.toolInvokedCache.delete(key)
    this.push({
      eventType: 'tool_completed',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ tool: p.tool, result: 'ok' }),
      durationMs,
    })
  }

  private onToolFailed(p: EventPayload['agent.tool.failed']): void {
    this.push({
      eventType: 'tool_failed',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ tool: p.tool, error: p.error?.slice(0, 200) }),
    })
  }

  private onError(p: EventPayload['agent.error']): void {
    this.push({
      eventType: 'error',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ error: p.error?.slice(0, 200), requestId: p.requestId }),
    })
  }

  private onInputReceived(p: EventPayload['agent.input.received']): void {
    const text = typeof p.text === 'string' ? p.text.slice(0, 200) : ''
    this.push({
      eventType: 'input_received',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ text }),
    })
  }

  private onResponseGenerated(p: EventPayload['agent.response.generated']): void {
    const text = typeof p.text === 'string' ? p.text.slice(0, 200) : ''
    this.push({
      eventType: 'response_generated',
      agentId: '',
      source: 'system',
      detail: JSON.stringify({ text }),
    })
  }

  private truncateArgs(args: Record<string, any> | undefined): Record<string, string> {
    if (!args) return {}
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(args)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      result[k] = s.slice(0, 100)
    }
    return result
  }

  // ══════════════════════════════════════════
  //  缓冲区管理
  // ══════════════════════════════════════════

  private push(partial: Omit<AuditRecord, 'id' | 'timestamp' | 'createdAt'>): void {
    const now = Date.now()
    this.buffer.push({
      id: `aev_${now}_${++idCounter}`,
      timestamp: now,
      createdAt: now,
      ...partial,
    })
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.flush()
    }
  }

  /** 刷出缓冲区到 DB */
  flush(): void {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    this.storeBatch(batch)
  }

  private storeBatch(records: AuditRecord[]): void {
    try {
      const db = getRawDb()
      db.run('BEGIN')
      for (const r of records) {
        db.run(
          `INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.id, r.timestamp, r.eventType, r.agentId, r.source, r.detail, r.durationMs ?? null, r.createdAt],
        )
      }
      db.run('COMMIT')
    } catch {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('WARN', 'event_auditor_flush_failed', { count: records.length })
    }
  }

  // ══════════════════════════════════════════
  //  查询 API
  // ══════════════════════════════════════════

  query(q: AuditQuery = {}): AuditRecord[] {
    try {
      const db = getRawDb()
      const conditions: string[] = []
      const params: any[] = []

      if (q.eventTypes?.length) {
        conditions.push(`event_type IN (${q.eventTypes.map(() => '?').join(',')})`)
        params.push(...q.eventTypes)
      }
      if (q.agentId) {
        conditions.push('agent_id = ?')
        params.push(q.agentId)
      }
      if (q.since !== undefined) {
        conditions.push('timestamp >= ?')
        params.push(q.since)
      }
      if (q.until !== undefined) {
        conditions.push('timestamp <= ?')
        params.push(q.until)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const limit = q.limit || 50
      const offset = q.offset || 0

      const stmt = db.prepare(`SELECT * FROM agent_events ${where} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`)
      stmt.bind(params)
      const results: AuditRecord[] = []
      while (stmt.step()) {
        const r = stmt.getAsObject() as any
        results.push({
          id: r.id,
          timestamp: r.timestamp,
          eventType: r.event_type,
          agentId: r.agent_id,
          source: r.source,
          detail: r.detail,
          durationMs: r.duration_ms || undefined,
          createdAt: r.created_at,
        })
      }
      stmt.free()
      return results
    } catch {
      return []
    }
  }

  /** 统计摘要 */
  getStats(): { total: number; byType: Record<string, number>; oldest: number; newest: number } {
    try {
      const db = getRawDb()
      const total = Number(db.exec('SELECT COUNT(*) AS c FROM agent_events')[0]?.values[0]?.[0] || 0)
      const byType: Record<string, number> = {}
      const typeRows = db.exec('SELECT event_type, COUNT(*) AS c FROM agent_events GROUP BY event_type')
      if (typeRows[0]) for (const row of typeRows[0].values) byType[String(row[0])] = Number(row[1])

      const oldest = Number(db.exec('SELECT MIN(timestamp) AS t FROM agent_events')[0]?.values[0]?.[0] || 0)
      const newest = Number(db.exec('SELECT MAX(timestamp) AS t FROM agent_events')[0]?.values[0]?.[0] || 0)
      return { total, byType, oldest, newest }
    } catch {
      return { total: 0, byType: {}, oldest: 0, newest: 0 }
    }
  }

  /** 清理过期数据 */
  enforceRetention(): void {
    try {
      const cutoff = Date.now() - this.config.retentionHours * 3600_000
      const db = getRawDb()
      db.run('DELETE FROM agent_events WHERE timestamp < ?', [cutoff])
    } catch {
      /* ignore */
    }
  }
}
