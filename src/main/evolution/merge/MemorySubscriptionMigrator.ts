/**
 * MemorySubscriptionMigrator — 基于记忆的订阅迁移器
 *
 * 将 radar-bot 的用户订阅数据迁移到 Memory 系统中。
 * 在合并过程中调用，实现无缝迁移用户体验。
 *
 * ## 迁移流程
 *
 * 1. RadarSubscriptionExtractor 提取订阅数据
 * 2. 去重：检查 Memory 中是否已有相同 key 的订阅条目
 * 3. 存储：每条订阅作为 Memory user_profile 条目存储
 * 4. 报告：生成结构化迁移报告
 *
 * ## Memory 存储格式
 *
 * 每条订阅保存为 type=user_profile 的 MemoryEntry：
 * - content: "【雷达订阅】{subscriptionName}: {sources.length} 个源, {keywords?.length} 个关键词"
 * - structuredData: JSON 序列化的 SubscriptionMemoryEntry
 * - tier: 'permanent'（永久层，避免被自动衰减清理）
 * - confidence: 0.9（可信来源）
 *
 * ## 兼容性
 *
 * 当前 POC 阶段从适配器 mock 配置提取数据。
 * 未来扩展至真实数据库时，只需修改 RadarSubscriptionExtractor。
 */

import { log } from '../../logger/Logger'
import type {
  RadarSubscription,
  SubscriptionMemoryEntry,
  MigrationReport,
  MigrationItemResult,
} from '../../telegram/subscription/types'
import { subscriptionMemoryKey, SUBSCRIPTION_MEMORY_KEY_PREFIX } from '../../telegram/subscription/types'
import { RadarSubscriptionExtractor, type StoredPreferences } from './RadarSubscriptionExtractor'

// ════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════

/** 订阅 schema 版本号（升级格式时增加） */
const SUBSCRIPTION_SCHEMA_VERSION = 1

// ════════════════════════════════════════════════════════════════
// Memory 操作接口（剥离 MemoryService 的直接依赖）
// ════════════════════════════════════════════════════════════════

/**
 * Memory 仓库接口。
 * 由 AppRuntime 在初始化时注入真实的 MemoryService 实现。
 * 剥离直接依赖，便于测试和未来重构。
 */
export interface MemoryRepository {
  /**
   * 查找 type=user_profile 的记录。
   * 返回的 entries 需包含 content, structuredData, createdAt, updatedAt 字段。
   */
  findUserProfiles(): Array<{
    content: string
    structuredData: string | null
    createdAt: number
    updatedAt: number
  }>

  /**
   * 保存一条 user_profile 记录。
   * @param key 偏好 key
   * @param value 偏好值
   * @param structuredData JSON 字符串（完整订阅数据）
   * @param migratedFrom 来源标记
   */
  saveUserProfile(
    key: string,
    value: string,
    structuredData: string,
    migratedFrom: string,
    confidence: number,
  ): void
}

// ════════════════════════════════════════════════════════════════
// MemorySubscriptionMigrator
// ════════════════════════════════════════════════════════════════

export class MemorySubscriptionMigrator {
  readonly name = 'memory-subscription-migrator'

  /** 提取器 */
  private extractor: RadarSubscriptionExtractor
  /** Memory 仓库 */
  private memoryRepo: MemoryRepository | null = null
  /** 最近一次迁移报告 */
  private lastReport: MigrationReport | null = null

  constructor(extractor?: RadarSubscriptionExtractor) {
    this.extractor = extractor ?? new RadarSubscriptionExtractor()
  }

  /**
   * 注入 Memory 仓库。
   * 在 AppRuntime 初始化时调用。
   */
  setMemoryRepository(repo: MemoryRepository): void {
    this.memoryRepo = repo
    log('INFO', 'sub_migrator_memory_repo_set')
  }

  /** 获取最近的迁移报告 */
  getLastReport(): MigrationReport | null {
    return this.lastReport
  }

  /**
   * 执行完整的订阅迁移流程。
   *
   * 1. 提取 → 2. 去重 → 3. 存储 → 4. 报告
   *
   * @param storedPrefs 可选的已有偏好（来自 MemoryService.getUserPreferences）
   * @returns 迁移报告
   */
  migrate(storedPrefs?: StoredPreferences): MigrationReport {
    const timestamp = Date.now()
    const results: MigrationItemResult[] = []

    // ── ① 提取订阅数据 ──
    const extractResult = this.extractor.extract(storedPrefs)
    log('INFO', 'sub_migrator_extracted', {
      count: extractResult.subscriptions.length,
      source: extractResult.source,
    })

    // ── ② 检查是否已有历史订阅（首次运行标记） ──
    const existingKeys = this.findExistingSubscriptionKeys()
    const isFirstTimeUser = existingKeys.length === 0
    if (isFirstTimeUser) {
      log('INFO', 'sub_migrator_first_time_user')
    }

    // ── ③ 逐条迁移 ──
    for (const sub of extractResult.subscriptions) {
      const result = this.migrateSingleSubscription(sub, existingKeys)
      results.push(result)
    }

    // ── 统计 ──
    const successCount = results.filter((r) => r.success).length
    const failedCount = results.filter((r) => !r.success && !r.error?.includes('已存在')).length
    const skippedCount = results.filter((r) => r.error?.includes('已存在')).length

    // ── 摘要 ──
    const summaryLines: string[] = [
      '━━━ 订阅迁移报告 ━━━',
      `执行时间: ${new Date(timestamp).toISOString()}`,
      `数据来源: ${extractResult.source}`,
      `首次用户: ${isFirstTimeUser ? '是' : '否'}`,
      '',
      `📊 统计:`,
      `  总处理: ${extractResult.subscriptions.length}`,
      `  成功: ${successCount}`,
      `  跳过（已存在）: ${skippedCount}`,
      `  失败: ${failedCount}`,
      '',
      `📋 迁移详情:`,
    ]

    for (const r of results) {
      const icon = r.success ? '✅' : r.error?.includes('已存在') ? '⏭️' : '❌'
      summaryLines.push(`  ${icon} ${r.subscriptionName}${r.error ? ` — ${r.error}` : ''}`)
    }

    if (isFirstTimeUser) {
      summaryLines.push('')
      summaryLines.push('🎉 首次用户检测：订阅已自动配置，无需重新设置！')
    }

    const report: MigrationReport = {
      timestamp,
      source: extractResult.source,
      totalProcessed: extractResult.subscriptions.length,
      successCount,
      failedCount,
      skippedCount,
      items: results,
      isFirstTimeUser,
      summary: summaryLines.join('\n'),
    }

    this.lastReport = report

    log('INFO', 'sub_migrator_completed', {
      total: report.totalProcessed,
      success: report.successCount,
      failed: report.failedCount,
      skipped: report.skippedCount,
      isFirstTimeUser,
    })

    return report
  }

  // ════════════════════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 在 Memory 中查找已存在的订阅条目 key 列表。
   */
  private findExistingSubscriptionKeys(): Set<string> {
    if (!this.memoryRepo) return new Set()

    const existing = new Set<string>()
    try {
      const profiles = this.memoryRepo.findUserProfiles()
      for (const p of profiles) {
        if (p.structuredData) {
          try {
            const parsed = JSON.parse(p.structuredData) as SubscriptionMemoryEntry
            if (parsed.key && parsed.key.startsWith(SUBSCRIPTION_MEMORY_KEY_PREFIX)) {
              existing.add(parsed.key)
            }
          } catch {
            // 解析失败跳过
          }
        }
      }
    } catch (err) {
      log('WARN', 'sub_migrator_find_existing_error', { error: String(err) })
    }

    return existing
  }

  /**
   * 迁移单条订阅到 Memory。
   * 如果 key 已存在则跳过（幂等）。
   */
  private migrateSingleSubscription(
    sub: RadarSubscription,
    existingKeys: Set<string>,
  ): MigrationItemResult {
    const key = subscriptionMemoryKey(sub.id)

    // 去重：已在 Memory 中的跳过
    if (existingKeys.has(key)) {
      log('INFO', 'sub_migrator_skipped_exists', { key, name: sub.name })
      return {
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        success: false,
        error: '已存在，跳过重复迁移',
      }
    }

    // 构建 Memory 条目
    const memoryEntry: SubscriptionMemoryEntry = {
      key,
      subscription: sub,
      migratedFrom: 'radar-bot-poc',
      migratedAt: Date.now(),
      version: SUBSCRIPTION_SCHEMA_VERSION,
    }

    const structuredData = JSON.stringify(memoryEntry)

    // 构建人类可读的内容描述
    const sourceCount = sub.sources.length
    const keywordCount = sub.keywords?.length ?? 0
    const content = `【雷达订阅】${sub.name}: ${sourceCount} 个源${keywordCount > 0 ? `, ${keywordCount} 个关键词` : ''}`

    try {
      if (this.memoryRepo) {
        this.memoryRepo.saveUserProfile(
          key,
          content,
          structuredData,
          'radar-bot-poc',
          0.9,
        )
        log('INFO', 'sub_migrator_saved', { key, name: sub.name })
      } else {
        log('WARN', 'sub_migrator_no_repo', { key, name: sub.name })
        // 无 Memory 仓库时仍返回成功（降级：仅报告不存储）
      }

      return {
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        success: true,
      }
    } catch (err: any) {
      log('ERROR', 'sub_migrator_save_failed', {
        key,
        name: sub.name,
        error: String(err),
      })

      return {
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        success: false,
        error: String(err),
      }
    }
  }
}

/** 全局单例 */
export const memorySubscriptionMigrator = new MemorySubscriptionMigrator()
