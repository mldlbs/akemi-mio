/**
 * 雷达推送规则 — 类型定义
 *
 * 用户通过自然语言设置的定时推送规则，存储在 SQLite 中。
 * Scheduler 每分钟检查一次匹配规则，触发雷达扫描。
 *
 * ## 数据流
 *
 *   用户消息 → RadarNaturalLanguageParser → RadarPushRule
 *       ↓
 *   RadarPushRuleStore (SQLite CRUD)
 *       ↓
 *   RadarPushScheduler (每分钟检查匹配)
 *       ↓
 *   startupRadarAdapter.scan() → enqueueReply()
 */

// ════════════════════════════════════════════════════════════════
// 推送规则
// ════════════════════════════════════════════════════════════════

/** 推送频率类型 */
export type PushFrequency = 'daily' | 'weekday' | 'weekend' | 'weekly' | 'custom'

/** 推送时段 — 上午/下午/晚上 */
export type PushPeriod = 'morning' | 'afternoon' | 'evening' | 'night'

/** 雷达推送规则 */
export interface RadarPushRule {
  /** 规则唯一 ID */
  id: string
  /** 用户自定义名称（自动生成） */
  name: string
  /** 是否启用 */
  enabled: boolean

  // ── 时间配置 ──
  /** 推送频率 */
  frequency: PushFrequency
  /** 具体分钟 (0-59) */
  minute: number
  /** 具体小时 (0-23) */
  hour: number
  /** 星期几 (0=周日, 1-6=周一到周六)，frequency=weekly 时使用 */
  dayOfWeek?: number

  // ── 内容过滤 ──
  /** 地点/位置关键词（如 '北京'、'硅谷'），作为额外关键词 */
  location?: string
  /** 雷达扫描关键词 */
  keywords: string[]
  /** 信息源列表（空数组表示全部） */
  sources: string[]

  // ── 元数据 ──
  /** 用户原文 */
  rawText: string
  /** 创建时间戳 */
  createdAt: number
  /** 最后修改时间戳 */
  updatedAt: number
  /** 上次推送时间戳（用于去重） */
  lastPushedAt?: number
  /** 总推送次数 */
  pushCount: number
  /** 用户备注 */
  notes?: string
}

// ════════════════════════════════════════════════════════════════
// 自然语言解析结果
// ════════════════════════════════════════════════════════════════

/** 自然语言解析的中间结果 */
export interface ParsedRuleIntent {
  /** 解析出的频率 */
  frequency: PushFrequency
  /** 解析出的小时 (0-23)，解析失败为 undefined */
  hour?: number
  /** 解析出的分钟 (0-59)，默认 0 */
  minute: number
  /** 解析出的星期几 */
  dayOfWeek?: number
  /** 解析出的地点 */
  location?: string
  /** 解析出的关键词列表 */
  keywords: string[]
  /** 解析出的信息源 */
  sources: string[]
  /** 原始文本 */
  rawText: string
  /** 解析置信度 0-1 */
  confidence: number
  /** 解析说明（用于用户确认） */
  description: string
}

// ════════════════════════════════════════════════════════════════
// 操作结果
// ════════════════════════════════════════════════════════════════

export interface PushRuleOperationResult {
  success: boolean
  error?: string
  rule?: RadarPushRule
}

export interface PushRuleListResult {
  rules: RadarPushRule[]
  total: number
}

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** 最大规则数量 */
export const MAX_PUSH_RULES = 20

/** SQLite 表名 */
export const PUSH_RULES_TABLE = 'radar_push_rules'

/** 表创建 SQL */
export const CREATE_PUSH_RULES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${PUSH_RULES_TABLE} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    frequency TEXT NOT NULL DEFAULT 'daily',
    minute INTEGER NOT NULL DEFAULT 0,
    hour INTEGER NOT NULL DEFAULT 8,
    day_of_week INTEGER,
    location TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    raw_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_pushed_at INTEGER,
    push_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  )
`
