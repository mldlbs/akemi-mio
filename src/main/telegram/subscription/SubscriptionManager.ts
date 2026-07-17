/**
 * TelegramSubscriptionManager — Telegram Bot 订阅管理器
 *
 * 通过查询 Memory 恢复和管理 radar-bot 迁移来的用户订阅。
 * 提供增删改查接口供 Telegram Bot 使用。
 *
 * ## 使用场景
 *
 * 1. Telegram Bot 启动时自动加载已迁移的订阅
 * 2. 用户通过命令修改订阅（添加/删除源、调整关键词等）
 * 3. 雷达扫描时根据已启用的订阅决定扫描参数
 *
 * ## 与 Memory 的集成
 *
 * 所有订阅数据持久化在 Memory 的 user_profile 条目中。
 * 管理器在内存中维护一份缓存，定期与 Memory 同步。
 */

import { log } from '../../logger/Logger'
import type {
  RadarSubscription,
  RadarScanFrequency,
  SubscriptionMemoryEntry,
  SubscriptionOperationResult,
  SubscriptionFilter,
} from './types'
import { subscriptionMemoryKey, SUBSCRIPTION_MEMORY_KEY_PREFIX } from './types'

// ════════════════════════════════════════════════════════════════
// Memory 操作接口（与 MemorySubscriptionMigrator 复用同一接口）
// ════════════════════════════════════════════════════════════════

export interface SubscriptionMemoryRepository {
  findUserProfiles(): Array<{
    content: string
    structuredData: string | null
    createdAt: number
    updatedAt: number
  }>
  saveUserProfile(
    key: string,
    value: string,
    structuredData: string,
    migratedFrom: string,
    confidence: number,
  ): void
}

// ════════════════════════════════════════════════════════════════
// TelegramSubscriptionManager
// ════════════════════════════════════════════════════════════════

export class TelegramSubscriptionManager {
  readonly name = 'telegram-subscription-manager'

  /** Memory 仓库 */
  private memoryRepo: SubscriptionMemoryRepository | null = null
  /** 内存缓存：id → RadarSubscription */
  private cache = new Map<string, RadarSubscription>()
  /** 是否已初始化 */
  private initialized = false
  /** 最后同步时间 */
  private lastSyncTime = 0

  // ════════════════════════════════════════════════════════════════
  // 生命周期
  // ════════════════════════════════════════════════════════════════

  /**
   * 注入 Memory 仓库。
   */
  setMemoryRepository(repo: SubscriptionMemoryRepository): void {
    this.memoryRepo = repo
    log('INFO', 'tg_sub_manager_repo_set')
  }

  /**
   * 初始化：从 Memory 加载订阅并重建缓存。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    log('INFO', 'tg_sub_manager_init_start')

    try {
      this.loadFromMemory()
      this.initialized = true

      log('INFO', 'tg_sub_manager_init_complete', {
        subscriptionCount: this.cache.size,
      })
    } catch (err) {
      log('ERROR', 'tg_sub_manager_init_failed', { error: String(err) })
      // 初始化失败不阻塞：降级为空缓存
      this.initialized = true
    }
  }

  /**
   * 重新加载：从 Memory 刷新缓存。
   * 在外部修改了订阅数据后调用。
   */
  reload(): void {
    this.cache.clear()
    this.loadFromMemory()
    this.lastSyncTime = Date.now()
    log('INFO', 'tg_sub_manager_reloaded', {
      count: this.cache.size,
    })
  }

  /** 是否已初始化 */
  get isInitialized(): boolean {
    return this.initialized
  }

  /** 获取订阅数量 */
  get count(): number {
    return this.cache.size
  }

  // ════════════════════════════════════════════════════════════════
  // 查询接口
  // ════════════════════════════════════════════════════════════════

  /**
   * 获取所有订阅。
   * @param filter 可选筛选条件
   * @returns 匹配的订阅列表
   */
  getSubscriptions(filter?: SubscriptionFilter): RadarSubscription[] {
    let results = Array.from(this.cache.values())

    if (filter) {
      if (filter.enabled !== undefined) {
        results = results.filter((s) => s.enabled === filter.enabled)
      }
      if (filter.sources && filter.sources.length > 0) {
        results = results.filter((s) =>
          filter.sources!.some((src) => s.sources.includes(src)),
        )
      }
      if (filter.frequency) {
        results = results.filter((s) => s.frequency === filter.frequency)
      }
      if (filter.searchText) {
        const lower = filter.searchText.toLowerCase()
        results = results.filter(
          (s) =>
            s.name.toLowerCase().includes(lower) ||
            s.focusArea?.toLowerCase().includes(lower) ||
            s.sources.some((src) => src.includes(lower)),
        )
      }
    }

    // 按创建时间降序排列（最新的在前）
    results.sort((a, b) => b.createdAt - a.createdAt)

    return results
  }

  /**
   * 根据 ID 获取单条订阅。
   */
  getSubscription(id: string): RadarSubscription | undefined {
    return this.cache.get(id)
  }

  /**
   * 获取启用的订阅列表（供雷达扫描使用）。
   * 默认返回第一条启用的订阅，若没有则返回 undefined。
   */
  getActiveSubscription(): RadarSubscription | undefined {
    return this.getSubscriptions({ enabled: true })[0]
  }

  /**
   * 获取所有唯一的源列表（合并所有订阅）。
   */
  getAllSources(): string[] {
    const sources = new Set<string>()
    for (const sub of this.cache.values()) {
      if (sub.enabled) {
        for (const src of sub.sources) {
          sources.add(src)
        }
      }
    }
    return Array.from(sources)
  }

  /**
   * 检测是否为首用户（没有任何订阅记录）。
   */
  isFirstTimeUser(): boolean {
    return this.cache.size === 0
  }

  // ════════════════════════════════════════════════════════════════
  // 修改接口
  // ════════════════════════════════════════════════════════════════

  /**
   * 创建新订阅。
   */
  createSubscription(
    data: Omit<RadarSubscription, 'id' | 'createdAt' | 'updatedAt'>,
  ): SubscriptionOperationResult<RadarSubscription> {
    const id = `sub_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const now = Date.now()

    const subscription: RadarSubscription = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    }

    // 持久化到 Memory
    const saveResult = this.persistSubscription(subscription, 'manual')
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    // 更新缓存
    this.cache.set(id, subscription)

    log('INFO', 'tg_sub_created', { id, name: subscription.name })
    return { success: true, data: subscription }
  }

  /**
   * 更新已有订阅。
   * 只更新提供的字段，未提供的保持不变。
   */
  updateSubscription(
    id: string,
    patch: Partial<Omit<RadarSubscription, 'id' | 'createdAt' | 'updatedAt'>>,
  ): SubscriptionOperationResult<RadarSubscription> {
    const existing = this.cache.get(id)
    if (!existing) {
      return { success: false, error: `订阅 ${id} 不存在` }
    }

    const updated: RadarSubscription = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }

    // 持久化到 Memory
    const saveResult = this.persistSubscription(updated, 'manual')
    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    // 更新缓存
    this.cache.set(id, updated)

    log('INFO', 'tg_sub_updated', { id, patches: Object.keys(patch).join(',') })
    return { success: true, data: updated }
  }

  /**
   * 删除订阅。
   */
  deleteSubscription(id: string): SubscriptionOperationResult<void> {
    const existing = this.cache.get(id)
    if (!existing) {
      return { success: false, error: `订阅 ${id} 不存在` }
    }

    // 从缓存移除
    this.cache.delete(id)

    log('INFO', 'tg_sub_deleted', { id, name: existing.name })
    return { success: true }
  }

  /**
   * 切换订阅启用/禁用状态。
   */
  toggleSubscription(id: string): SubscriptionOperationResult<RadarSubscription> {
    const existing = this.cache.get(id)
    if (!existing) {
      return { success: false, error: `订阅 ${id} 不存在` }
    }

    return this.updateSubscription(id, { enabled: !existing.enabled })
  }

  // ════════════════════════════════════════════════════════════════
  // 查询助手（供 Telegram 命令使用）
  // ════════════════════════════════════════════════════════════════

  /**
   * 格式化订阅列表为 Telegram 消息文本。
   * 适合 /subscriptions 命令的回复。
   */
  formatSubscriptionsForTelegram(): string {
    const subs = this.getSubscriptions()
    if (subs.length === 0) {
      return '📡 尚无订阅配置。使用 /radar_subscribe 创建订阅。'
    }

    const lines: string[] = [
      '📡 **订阅列表**',
      `━━━ ${subs.length} 条订阅 ━━━`,
      '',
    ]

    for (const sub of subs) {
      const status = sub.enabled ? '✅ 启用' : '⏸️ 暂停'
      lines.push(`**${sub.name}** [${status}]`)
      lines.push(`  源: ${sub.sources.join(', ')}`)
      if (sub.keywords && sub.keywords.length > 0) {
        lines.push(`  关键词: ${sub.keywords.join(', ')}`)
      }
      if (sub.focusArea) {
        lines.push(`  关注领域: ${sub.focusArea}`)
      }
      lines.push(`  频率: ${sub.frequency} | 最低分: ${sub.minScore}`)
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 获取管理统计信息。
   */
  getStats(): {
    totalSubscriptions: number
    activeSubscriptions: number
    totalSources: number
    uniqueSources: string[]
    isFirstTimeUser: boolean
    initialized: boolean
  } {
    const all = this.getSubscriptions()
    const active = this.getSubscriptions({ enabled: true })

    return {
      totalSubscriptions: all.length,
      activeSubscriptions: active.length,
      totalSources: this.getAllSources().length,
      uniqueSources: this.getAllSources(),
      isFirstTimeUser: this.isFirstTimeUser(),
      initialized: this.initialized,
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 从 Memory 加载订阅到缓存。
   */
  private loadFromMemory(): void {
    if (!this.memoryRepo) {
      log('WARN', 'tg_sub_manager_no_repo')
      return
    }

    try {
      const profiles = this.memoryRepo.findUserProfiles()
      let loaded = 0

      for (const p of profiles) {
        if (!p.structuredData) continue
        try {
          const parsed = JSON.parse(p.structuredData) as SubscriptionMemoryEntry
          if (
            parsed.key &&
            parsed.key.startsWith(SUBSCRIPTION_MEMORY_KEY_PREFIX) &&
            parsed.subscription
          ) {
            this.cache.set(parsed.subscription.id, parsed.subscription)
            loaded++
          }
        } catch {
          // 解析失败跳过
        }
      }

      log('INFO', 'tg_sub_manager_loaded', { loaded })
    } catch (err) {
      log('WARN', 'tg_sub_manager_load_error', { error: String(err) })
    }
  }

  /**
   * 持久化单条订阅到 Memory。
   */
  private persistSubscription(
    sub: RadarSubscription,
    source: 'manual' | 'default',
  ): { success: boolean; error?: string } {
    if (!this.memoryRepo) {
      return { success: false, error: 'Memory 仓库未设置' }
    }

    const key = subscriptionMemoryKey(sub.id)
    const memoryEntry: SubscriptionMemoryEntry = {
      key,
      subscription: sub,
      migratedFrom: source === 'manual' ? 'manual' : 'default',
      migratedAt: Date.now(),
      version: 1,
    }

    const structuredData = JSON.stringify(memoryEntry)
    const sourceCount = sub.sources.length
    const keywordCount = sub.keywords?.length ?? 0
    const content = `【雷达订阅】${sub.name}: ${sourceCount} 个源${keywordCount > 0 ? `, ${keywordCount} 个关键词` : ''}`

    try {
      this.memoryRepo.saveUserProfile(key, content, structuredData, source, 0.85)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: String(err) }
    }
  }
}

/** 全局单例 */
export const telegramSubscriptionManager = new TelegramSubscriptionManager()
