/**
 * StoreRegistry — 存储注册中心与策略模式
 *
 * 职责：
 * 1. 注册所有 ReadableStore / WritableStore 实现
 * 2. 提供按名称/类型检索的统一入口
 * 3. 通过 StoreSelector 策略在运行时选择最佳实现
 * 4. 支持搜索所有已注册的存储
 */
import { log } from '@akemi-mio/core/logger/Logger'
import type { ReadableStore, WritableStore, StoreSelector, StoreType, SearchResult, SearchOptions, WriteInput, WriteResult } from '@akemi-mio/intelligence/store/types'

// ══════════════════════════════════════════
//  内置策略
// ══════════════════════════════════════════

/** 按名称精确匹配 */
export class NameSelector implements StoreSelector {
  readonly description = '按名称精确匹配'

  constructor(private preferredName: string) {}

  select(_query: string, stores: ReadableStore[]): ReadableStore | null {
    return stores.find((s) => s.name === this.preferredName) || null
  }
}

/** 按类型选择 */
export class TypeSelector implements StoreSelector {
  readonly description = `按类型匹配: ${this.preferredType}`

  constructor(private preferredType: StoreType) {}

  select(_query: string, stores: ReadableStore[]): ReadableStore | null {
    return stores.find((s) => s.type === this.preferredType) || null
  }
}

/**
 * 智能选择器 — 根据查询文本和存储名称/类型的相关性选择。
 * 优先级：名称包含关键词 > 类型匹配 > 名称最短匹配。
 */
export class SmartSelector implements StoreSelector {
  readonly description = '智能匹配（名称 + 类型 + 查询相关性）'

  select(query: string, stores: ReadableStore[]): ReadableStore | null {
    if (!stores.length) return null
    if (stores.length === 1) return stores[0]

    const queryLower = query.toLowerCase()

    // 1. 名称包含查询关键词的优先
    const nameMatch = stores.find((s) => s.name.toLowerCase().includes(queryLower))
    if (nameMatch) return nameMatch

    // 2. 按类型相关性
    const typeOrder: Record<string, number> = { memory: 0, agent: 1, cognitive: 2 }
    const sorted = [...stores].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9))
    return sorted[0]
  }
}

/** 默认选择器：返回第一个可用 */
export class FirstSelector implements StoreSelector {
  readonly description = '返回第一个可用存储'

  select(_query: string, stores: ReadableStore[]): ReadableStore | null {
    return stores[0] || null
  }
}

// ══════════════════════════════════════════
//  StoreRegistry
// ══════════════════════════════════════════

export class StoreRegistry {
  private stores = new Map<string, ReadableStore>()
  private strategy: StoreSelector = new SmartSelector()

  /** 设置当前策略 */
  setStrategy(strategy: StoreSelector): void {
    this.strategy = strategy
    log('INFO', 'store_strategy_set', { description: strategy.description })
  }

  /** 获取当前策略 */
  getStrategy(): StoreSelector {
    return this.strategy
  }

  /** 注册一个存储实现 */
  register(store: ReadableStore): void {
    const existing = this.stores.get(store.name)
    if (existing && existing === store) return
    this.stores.set(store.name, store)
    log('INFO', 'store_registered', { name: store.name, type: store.type })
  }

  /** 注销一个存储实现 */
  unregister(name: string): boolean {
    const removed = this.stores.delete(name)
    if (removed) {
      log('INFO', 'store_unregistered', { name })
    }
    return removed
  }

  /** 按名称获取存储 */
  get(name: string): ReadableStore | undefined {
    return this.stores.get(name)
  }

  /** 检查存储是否存在 */
  has(name: string): boolean {
    return this.stores.has(name)
  }

  /** 获取所有已注册的存储 */
  getAll(): ReadableStore[] {
    return Array.from(this.stores.values())
  }

  /** 按类型过滤 */
  getByType(type: StoreType): ReadableStore[] {
    return this.getAll().filter((s) => s.type === type)
  }

  /** 获取所有存储名称 */
  getNames(): string[] {
    return Array.from(this.stores.keys())
  }

  /**
   * 使用当前策略选择一个最优存储。
   * 调用方不需要知道具体是哪个实现。
   */
  selectBest(query: string): ReadableStore | null {
    return this.strategy.select(query, this.getAll())
  }

  /**
   * 跨所有存储并行搜索。
   * 结果按相关性得分降序排列，去重。
   */
  async searchAll(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const stores = this.getAll()
    const results = await Promise.all(
      stores.map((store) =>
        store.search(query, options).catch((err) => {
          log('WARN', 'store_search_failed', { store: store.name, error: String(err) })
          return [] as SearchResult[]
        }),
      ),
    )

    // 合并 + 去重 + 排序
    const seen = new Set<string>()
    const merged: SearchResult[] = []
    for (const batch of results) {
      for (const r of batch) {
        const key = `${r.source}:${r.content}`
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(r)
        }
      }
    }

    return merged.sort((a, b) => b.score - a.score)
  }

  /**
   * 收集所有存储的格式化上下文。
   * 用于构建注入 system prompt 的综合上下文。
   */
  async collectContext(keywords?: string[]): Promise<string> {
    const stores = this.getAll()
    const contexts = await Promise.all(
      stores.map((store) =>
        store.getContext(keywords).catch((err) => {
          log('WARN', 'store_context_failed', { store: store.name, error: String(err) })
          return ''
        }),
      ),
    )

    return contexts.filter(Boolean).join('\n')
  }

  // ══════════════════════════════════════════
  //  写入操作（仅对 WritableStore 生效）
  // ══════════════════════════════════════════

  /** 向指定存储写入 */
  async storeTo(name: string, input: WriteInput): Promise<WriteResult> {
    const store = this.stores.get(name)
    if (!store) return { success: false, error: `store ${name} not found` }

    if (!('store' in store)) {
      return { success: false, error: `store ${name} is read-only` }
    }

    return await (store as WritableStore).store(input)
  }

  /** 使用策略选择一个最佳存储并写入 */
  async storeBest(query: string, input: WriteInput): Promise<WriteResult> {
    const store = this.selectBest(query)
    if (!store) return { success: false, error: 'no store available' }
    if (!('store' in store)) {
      return { success: false, error: `selected store ${store.name} is read-only` }
    }

    return await (store as WritableStore).store(input)
  }

  /** 从指定存储删除 */
  async deleteFrom(name: string, id: string): Promise<boolean> {
    const store = this.stores.get(name)
    if (!store) return false
    if (!('delete' in store)) return false

    return await (store as WritableStore).delete(id)
  }

  /** 获取统计信息 */
  getRegistryStats(): Record<string, unknown> {
    const byType: Partial<Record<StoreType, number>> = {}
    for (const store of this.stores.values()) {
      byType[store.type] = (byType[store.type] || 0) + 1
    }

    return {
      totalStores: this.stores.size,
      byType,
      strategy: this.strategy.description,
      names: this.getNames(),
    }
  }
}
