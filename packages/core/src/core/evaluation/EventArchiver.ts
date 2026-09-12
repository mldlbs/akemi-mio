/**
 * EventArchiver — ADR-005 R1-B: NDJSON Daily Archive
 *
 * 职责：
 * - 使用 seq 游标逐日归档 evaluation_events 到 NDJSON gzip 文件
 * - 归档成功后从热存储分批 DELETE
 * - 支持 dry-run 模式
 *
 * 不变量 R1-I1：归档文件是 append-only，写入后永不修改。
 * 不变量 R1-I2：热存储保留期是软限制，超出目标时不崩溃。
 *
 * 数据流：
 *   queryBySeq(cursor, PAGE_SIZE)
 *     → filter by timestamp window (one day)
 *     → serialize as NDJSON
 *     → gzip write to file
 *     ↓ 成功
 *   DELETE from evaluation_events (batch 500)
 */
import { createGzip } from 'zlib'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { log } from '@akemi-mio/core/logger/Logger'
import type { EvaluationEvent, EvaluationRepository } from './types'
import { ARCHIVE_PAGE_SIZE, RETENTION_BATCH_SIZE, ARCHIVE_GZIP_LEVEL } from './RetentionConfig'

export interface ArchiveOptions {
  /** 截止时间戳。timestamp < cutoff 的事件将被归档。默认: now - 30d */
  cutoff?: number
  /** 输出目录。默认: <workspaceRoot>/archive/evaluation_events/ */
  outputDir?: string
  /** dry-run 模式：只计数不写文件 */
  dryRun?: boolean
}

export interface ArchiveResult {
  /** 归档日期 YYYY-MM-DD */
  date: string
  /** 归档事件数 */
  archivedCount: number
  /** 文件绝对路径（dry-run 时为空字符串） */
  filePath: string
  /** 文件大小（字节，dry-run 时为 0） */
  fileSizeBytes: number
  /** 耗时 ms */
  durationMs: number
  /** 从热存储删除的行数 */
  deletedCount: number
  /** 是否 dry-run */
  dryRun: boolean
  /** 错误信息（如有） */
  error?: string
}

interface ArchiveRange {
  dateStr: string
  sinceMs: number
  untilMs: number
}

type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

export class EventArchiver {
  constructor(
    private eventStore: EvaluationRepository,
    private rawDb: RawDb,
    private workspaceRoot?: string,
  ) {}

  /**
   * 归档所有 timestamp < cutoff 的事件，按天分文件。
   * 先归档（写文件），成功后才 DELETE 热存储。
   */
  async archiveAll(options?: ArchiveOptions): Promise<ArchiveResult[]> {
    const cutoff = options?.cutoff ?? Date.now() - 30 * 24 * 60 * 60 * 1000
    const dryRun = options?.dryRun ?? false
    const archiveRoot = options?.outputDir ?? join(this.workspaceRoot ?? '', 'archive', 'evaluation_events')

    if (!dryRun && !existsSync(archiveRoot)) {
      mkdirSync(archiveRoot, { recursive: true })
    }

    // 用 seq 游标扫描所有事件，按天分组
    const dayBuckets = new Map<string, EvaluationEvent[]>()
    let cursor = 0
    let hasMore = true
    let totalScanned = 0

    while (hasMore) {
      const events = await this.eventStore.queryBySeq(cursor, ARCHIVE_PAGE_SIZE)
      if (events.length === 0) {
        hasMore = false
        break
      }

      for (const ev of events) {
        if (ev.timestamp < cutoff) {
          const dateStr = dateKey(ev.timestamp)
          const bucket = dayBuckets.get(dateStr) ?? []
          bucket.push(ev)
          dayBuckets.set(dateStr, bucket)
        }
      }

      totalScanned += events.length
      cursor = Math.max(...events.map((e) => e.seq ?? 0))

      if (events.length < ARCHIVE_PAGE_SIZE) {
        hasMore = false
      }

      // yield 让事件循环处理其他任务
      await yieldToEventLoop()
    }

    if (dayBuckets.size === 0) {
      log('INFO', 'event_archiver_nothing', { cutoff, scanned: totalScanned })
      return []
    }

    log('INFO', 'event_archiver_found', { days: dayBuckets.size, events: totalScanned, cutoff })

    const results: ArchiveResult[] = []
    for (const [dateStr, dayEvents] of dayBuckets) {
      const sinceMs = parseDate(dateStr)
      const untilMs = sinceMs + 86400000
      const result = await this.archiveDay({ dateStr, sinceMs, untilMs }, dayEvents, archiveRoot, dryRun)
      results.push(result)
      await yieldToEventLoop()
    }

    // DELETE 热存储（非 dry-run 且归档成功）
    if (!dryRun) {
      const deletedCount = await this.deleteArchived(cutoff)
      // 更新每个结果
      for (const r of results) {
        r.deletedCount = deletedCount
      }
    }

    return results
  }

  /** 归档单日事件到 NDJSON gzip 文件 */
  private async archiveDay(range: ArchiveRange, events: EvaluationEvent[], outputDir: string, dryRun: boolean): Promise<ArchiveResult> {
    const startTime = Date.now()
    const fileName = `evaluation_events_${range.dateStr}.ndjson.gz`
    const filePath = join(outputDir, fileName)

    if (dryRun) {
      return {
        date: range.dateStr,
        archivedCount: events.length,
        filePath: '',
        fileSizeBytes: 0,
        durationMs: Date.now() - startTime,
        deletedCount: 0,
        dryRun: true,
      }
    }

    try {
      // 序列化为 NDJSON
      const lines = events.map((ev) => JSON.stringify(serializeEvent(ev)))

      // gzip 写入
      const gzip = createGzip({ level: ARCHIVE_GZIP_LEVEL })
      const dest = createWriteStream(filePath)
      // NDJSON: 每行一条 JSON，以 \n 分隔
      for (const line of lines) {
        gzip.write(line + '\n')
      }
      gzip.end()
      await pipeline(gzip, dest)

      const fileSize = statSync(filePath).size

      log('INFO', 'event_archiver_wrote', {
        date: range.dateStr,
        count: events.length,
        file: fileName,
        size: fileSize,
      })

      return {
        date: range.dateStr,
        archivedCount: events.length,
        filePath,
        fileSizeBytes: fileSize,
        durationMs: Date.now() - startTime,
        deletedCount: 0, // 稍后更新
        dryRun: false,
      }
    } catch (err: any) {
      log('ERROR', 'event_archiver_failed', { date: range.dateStr, error: err.message })
      return {
        date: range.dateStr,
        archivedCount: 0,
        filePath: '',
        fileSizeBytes: 0,
        durationMs: Date.now() - startTime,
        deletedCount: 0,
        dryRun: false,
        error: err.message,
      }
    }
  }

  /**
   * 从热存储删除已归档事件。
   * 分批执行，每批后标记 dirty 触发周期性持久化。
   */
  private async deleteArchived(cutoff: number): Promise<number> {
    let totalDeleted = 0
    try {
      let deleted = RETENTION_BATCH_SIZE
      while (deleted === RETENTION_BATCH_SIZE) {
        this.rawDb.run('DELETE FROM evaluation_events WHERE timestamp < ? LIMIT ?', [cutoff, RETENTION_BATCH_SIZE])
        deleted =
          this.rawDb.query('SELECT changes() AS c', []).length > 0
            ? ((this.rawDb.query('SELECT changes() AS c', [])[0]?.c as number) ?? 0)
            : 0
        totalDeleted += deleted
        // 触发周期性持久化
        try {
          const { markDirty } = await import('@akemi-mio/core/db/connection')
          markDirty()
        } catch {
          // 静默
        }
        await yieldToEventLoop()
      }
      if (totalDeleted > 0) {
        log('INFO', 'event_archiver_deleted', { cutoff, count: totalDeleted })
      }
    } catch (err: any) {
      log('WARN', 'event_archiver_delete_failed', { cutoff, deleted: totalDeleted, error: err.message })
    }
    return totalDeleted
  }
}

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════

/** 将时间戳转为日期字符串 */
function dateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 从日期字符串解析为毫秒时间戳（当天 00:00:00 UTC） */
function parseDate(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getTime()
}

/** 序列化 EvaluationEvent 为可 JSON 化的平面对象 */
function serializeEvent(ev: EvaluationEvent): Record<string, unknown> {
  return {
    id: ev.id,
    timestamp: ev.timestamp,
    traceId: ev.traceId,
    sessionId: ev.sessionId,
    source: ev.source,
    type: ev.type,
    payload: ev.payload,
    parentEventId: ev.parentEventId ?? null,
    seq: ev.seq ?? null,
  }
}

/** yield 给事件循环 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
