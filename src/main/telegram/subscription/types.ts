/**
 * 订阅迁移器 — 类型定义
 *
 * 定义 radar-bot 用户订阅数据模型、Memory 存储格式、迁移状态。
 * 遵循现有 TelegramMemoryService 和 MemoryService 的类型风格。
 *
 * ## 数据流
 *
 *   Radar系统配置/数据
 *       ↓ (1) RadarSubscriptionExtractor.extract()
 *   RadarSubscription[]        ← 标准化订阅列表
 *       ↓ (2) MemorySubscriptionMigrator.migrate()
 *   Memory条目 (type=user_profile, structuredData=RadarSubscription)
 *       ↓ (3) TelegramSubscriptionManager.getSubscriptions()
 *   Telegram Bot 读取/管理订阅
 */

import type { SignalSource } from '../../startup-radar/types'

// ════════════════════════════════════════════════════════════════
// 雷达订阅数据模型
// ════════════════════════════════════════════════════════════════

/**
 * 雷达扫描频率
 * - realtime: 实时推送（每次扫描结果立刻推送）
 * - hourly: 每小时汇总推送
 * - daily: 每日摘要推送
 * - manual: 仅手动触发
 */
export type RadarScanFrequency = 'realtime' | 'hourly' | 'daily' | 'manual'

/**
 * 雷达订阅条目。
 * 代表用户在 radar-bot 中设置的一条订阅配置。
 * 迁移到 Memory 后以 structuredData 形式存储。
 */
export interface RadarSubscription {
  /** 订阅唯一标识 */
  id: string
  /** 订阅名称（用户自定义标签，如"AI 创业监控"） */
  name: string
  /** 要扫描的信息源列表 */
  sources: SignalSource[]
  /** 关键词过滤（OR 匹配，可选） */
  keywords?: string[]
  /** 创业方向/领域（用于计算相关性） */
  focusArea?: string
  /** 最小复合评分阈值 0-1（默认 0.3） */
  minScore: number
  /** 扫描频率 */
  frequency: RadarScanFrequency
  /** 是否启用 */
  enabled: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 最后修改时间戳 */
  updatedAt: number
  /** 扩展元数据（自定义参数等） */
  metadata?: Record<string, string>
}

// ════════════════════════════════════════════════════════════════
// Memory 存储相关
// ════════════════════════════════════════════════════════════════

/** Memory 中订阅条目的 key 前缀 */
export const SUBSCRIPTION_MEMORY_KEY_PREFIX = 'radar_subscription'

/** Memory 订阅条目 key 生成 */
export function subscriptionMemoryKey(subscriptionId: string): string {
  return `${SUBSCRIPTION_MEMORY_KEY_PREFIX}:${subscriptionId}`
}

/**
 * Memory 中存储的订阅条目结构。
 * 序列化为 JSON 后存入 MemoryEntry.structuredData。
 */
export interface SubscriptionMemoryEntry {
  key: string
  subscription: RadarSubscription
  /** 迁移来源标记 */
  migratedFrom: 'radar-bot-poc' | 'radar-bot-db' | 'manual' | 'default'
  /** 迁移时间戳 */
  migratedAt: number
  /** 版本号，用于未来格式升级 */
  version: number
}

// ════════════════════════════════════════════════════════════════
// 迁移报告
// ════════════════════════════════════════════════════════════════

/** 单条订阅的迁移结果 */
export interface MigrationItemResult {
  subscriptionId: string
  subscriptionName: string
  success: boolean
  error?: string
}

/** 迁移报告 */
export interface MigrationReport {
  /** 迁移执行时间 */
  timestamp: number
  /** 数据来源（memory_preferences | radar_poc_config | default） */
  source: string
  /** 总处理条数 */
  totalProcessed: number
  /** 成功迁移数 */
  successCount: number
  /** 失败数 */
  failedCount: number
  /** 跳过数（已存在/无变更） */
  skippedCount: number
  /** 详情 */
  items: MigrationItemResult[]
  /** 是否已有历史订阅（首次运行标记） */
  isFirstTimeUser: boolean
  /** 摘要文本 */
  summary: string
}

// ════════════════════════════════════════════════════════════════
// 订阅管理器
// ════════════════════════════════════════════════════════════════

/** 订阅管理操作结果 */
export interface SubscriptionOperationResult<T = void> {
  success: boolean
  error?: string
  data?: T
}

/** 订阅查询过滤器 */
export interface SubscriptionFilter {
  enabled?: boolean
  sources?: SignalSource[]
  frequency?: RadarScanFrequency
  searchText?: string
}
