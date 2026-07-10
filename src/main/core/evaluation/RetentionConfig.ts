/**
 * RetentionConfig — ADR-005 R1 retention policy constants
 *
 * R1-A: Hot storage retention (soft limits, non-binding).
 * R1-B: Archive directory location (under WORKSPACE_ROOT/archive).
 *
 * 不变量 R1-I2: 热存储保留期是软限制。超出目标时不崩溃、不降级。
 */
import { join } from 'path'

/** 毫秒常量 */
export const MS = {
  DAY: 24 * 60 * 60 * 1000,
  HOUR: 60 * 60 * 1000,
} as const

/** 热存储保留目标（毫秒） */
export const HOT_RETENTION = {
  EVALUATION_EVENTS: 30 * MS.DAY,
  GUARDRAIL_DECISIONS: 7 * MS.DAY,
  GUARDRAIL_METRICS: 90 * MS.DAY,
} as const

/** 归档根目录名 */
export const ARCHIVE_DIR = 'archive'

/** 按表的归档子目录 */
export const ARCHIVE_PATHS = {
  EVALUATION_EVENTS: join(ARCHIVE_DIR, 'evaluation_events'),
} as const

/** 批量 DELETE 的事务安全大小 */
export const RETENTION_BATCH_SIZE = 500

/** 归档游标分页大小 */
export const ARCHIVE_PAGE_SIZE = 1000

/** gzip 压缩等级 (1-9) */
export const ARCHIVE_GZIP_LEVEL = 6

/** 每日归档执行小时 (0-23) */
export const ARCHIVE_HOUR = 2
