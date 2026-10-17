/**
 * JsonlFeedbackEventStore — CLI/MCP 侧证据事件追加存储（P0）
 *
 * 落盘：`<dataDir>/feedback-events.jsonl`（append-only）。
 * 幂等：加载时建 idempotencyKey 集合，同键追加直接跳过（不抛错、不重复生效）。
 * 这是交换/重放格式，不是权威真相源——主进程 ingest 单向导入 SQLite。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  normalizeFeedbackEvent,
  type HypothesisFeedbackEvent,
  type HypothesisFeedbackEventInput,
  type NormalizeQuarantineReason,
} from './FeedbackEvents'

export interface JsonlAppendResult {
  /** 事件已追加并生效 */
  appended: boolean
  /** 因 idempotencyKey 已存在而跳过 */
  deduped: boolean
  event?: HypothesisFeedbackEvent
  /** 规范化失败（进隔离队列由调用方处理） */
  quarantine?: { reason: NormalizeQuarantineReason; raw: unknown }
}

export class JsonlFeedbackEventStore {
  readonly eventsPath: string
  private seenKeys: Set<string> | null = null

  constructor(dataDir: string) {
    this.eventsPath = join(dataDir, 'feedback-events.jsonl')
  }

  /** 重读文件（长活 MCP 进程需看到外部追加；幂等键集合整体重建，成本可接受）。 */
  private ensureLoaded(): Set<string> {
    if (this.seenKeys) return this.seenKeys
    this.seenKeys = new Set()
    if (existsSync(this.eventsPath)) {
      const lines = readFileSync(this.eventsPath, 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const row = JSON.parse(line)
          if (row && typeof row.idempotencyKey === 'string') this.seenKeys.add(row.idempotencyKey)
        } catch {
          // 损坏行不参与幂等集合；ingest 时会进隔离
        }
      }
    }
    return this.seenKeys
  }

  /** 供长活进程在外部写入后强制重读。 */
  invalidate(): void {
    this.seenKeys = null
  }

  append(input: HypothesisFeedbackEventInput, now: number = Date.now()): JsonlAppendResult {
    const normalized = normalizeFeedbackEvent(input, now)
    if (!normalized.ok) {
      return { appended: false, deduped: false, quarantine: { reason: normalized.reason, raw: normalized.raw } }
    }
    const event = normalized.event
    const keys = this.ensureLoaded()
    if (keys.has(event.idempotencyKey)) {
      return { appended: false, deduped: true, event }
    }
    const dir = dirname(this.eventsPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', 'utf-8')
    keys.add(event.idempotencyKey)
    return { appended: true, deduped: false, event }
  }

  /** 读取全部可解析事件（损坏行跳过，供 ingest/回放使用）。 */
  list(): HypothesisFeedbackEvent[] {
    if (!existsSync(this.eventsPath)) return []
    const out: HypothesisFeedbackEvent[] = []
    for (const line of readFileSync(this.eventsPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip corrupt
      }
    }
    return out
  }
}
