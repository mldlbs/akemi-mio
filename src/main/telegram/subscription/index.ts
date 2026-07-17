/**
 * 订阅迁移器 — 模块入口
 *
 * 在合并过程中，利用 Memory 模块记录 radar-bot 原有的用户订阅和偏好设置，
 * 自动迁移到 telegram-bot 的内存结构中。
 *
 * ## 使用方式
 *
 * ```typescript
 * // 1. 在 TelegramMemoryService 初始化时执行迁移
 * const report = memorySubscriptionMigrator.migrate()
 *
 * // 2. 在 TelegramService 初始化时加载订阅管理器
 * await telegramSubscriptionManager.initialize()
 *
 * // 3. 获取迁移报告
 * const report = memorySubscriptionMigrator.getLastReport()
 * console.log(report.summary)
 * ```
 *
 * ## 数据流
 *
 *   Radar 系统配置 / POC 数据
 *       ↓ RadarSubscriptionExtractor.extract()
 *   RadarSubscription[]
 *       ↓ MemorySubscriptionMigrator.migrate()
 *   Memory (type=user_profile, structuredData=SubscriptionMemoryEntry)
 *       ↓ TelegramSubscriptionManager.initialize()
 *   内存缓存 → Telegram Bot 命令
 *
 * ## 文件清单
 *
 * - types.ts             — 类型定义（RadarSubscription, MigrationReport 等）
 * - SubscriptionManager.ts — Telegram 订阅管理器
 * - ../../evolution/merge/RadarSubscriptionExtractor.ts  — 雷达订阅提取器
 * - ../../evolution/merge/MemorySubscriptionMigrator.ts  — 记忆迁移器
 */

export { TelegramSubscriptionManager, telegramSubscriptionManager } from './SubscriptionManager'
export type { SubscriptionMemoryRepository } from './SubscriptionManager'

export type {
  RadarSubscription,
  RadarScanFrequency,
  SubscriptionMemoryEntry,
  MigrationReport,
  MigrationItemResult,
  SubscriptionOperationResult,
  SubscriptionFilter,
} from './types'

export {
  SUBSCRIPTION_MEMORY_KEY_PREFIX,
  subscriptionMemoryKey,
} from './types'
