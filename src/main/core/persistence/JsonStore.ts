/**
 * JsonStore — 通用 JSON 文件持久化存储
 *
 * 核心抽象：将任意数组数据以 JSON 格式持久化到本地文件。
 * 替代各模块中重复的 existsSync / readFileSync / writeFileSync 样板代码。
 *
 * 用法：
 *   const store = new JsonStore<MyItem>('/path/to/data.json')
 *   const items = store.load()       // 加载
 *   items.push(newItem)
 *   store.save(items)                // 保存
 *
 * 设计原则：
 * - 无偏见：不关心数据结构，只处理 JSON 序列化/反序列化
 * - 容错：文件不存在时返回空数组，解析失败时返回空数组并记录警告
 * - 自动创建目录：save() 自动确保目标目录存在
 *
 * 来源分析（从以下模块提取的共性）：
 * - LearningVocabularyManager — learning-vocabulary.json 持久化
 * - LearningProgressTracker   — learning-difficulties.json / learning-eval-snapshots.json
 * - 项目中 30+ 处类似的 JSON 文件读写模式
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '../../logger/Logger'

// ── 配置 ──

export interface JsonStoreOptions {
  /**
   * 日志分类名（用于统一日志前缀，默认取文件名）。
   */
  loggerName?: string
}

// ── 核心类 ──

export class JsonStore<T> {
  protected readonly filePath: string
  private readonly loggerName: string

  /**
   * @param filePath JSON 文件绝对路径
   * @param options  可选配置
   */
  constructor(filePath: string, options?: JsonStoreOptions) {
    this.filePath = filePath
    this.loggerName = options?.loggerName ?? `json_store:${this.basename(filePath)}`
  }

  // ── 读写接口 ──

  /**
   * 从文件加载数据。
   * 文件不存在时返回空数组。
   * 解析失败时记录警告并返回空数组。
   */
  load(): T[] {
    try {
      if (!existsSync(this.filePath)) return []

      const raw = readFileSync(this.filePath, 'utf-8')
      const data: unknown = JSON.parse(raw)

      if (!Array.isArray(data)) {
        log('WARN', `${this.loggerName}_invalid_format`, {
          note: 'JSON 根元素不是数组，返回空数组',
        })
        return []
      }

      return data as T[]
    } catch (err) {
      log('WARN', `${this.loggerName}_load_failed`, {
        error: String(err),
        file: this.filePath,
      })
      return []
    }
  }

  /**
   * 将数据保存到文件。
   * 自动创建目标目录。
   */
  save(items: T[]): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', `${this.loggerName}_save_failed`, {
        error: String(err),
        file: this.filePath,
        count: Array.isArray(items) ? items.length : -1,
      })
    }
  }

  /**
   * 清空文件（写入空数组）。
   */
  clear(): void {
    this.save([])
  }

  // ── 查询 ──

  /** 获取文件路径 */
  getPath(): string {
    return this.filePath
  }

  // ── 内部 ──

  private basename(fullPath: string): string {
    const parts = fullPath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] ?? 'unknown'
  }
}

/**
 * IdentifiableJsonStore — 支持按 id 合并的扩展 JsonStore
 *
 * 在 JsonStore 基础上增加 merge 方法，通过 id 字段合并已有数据。
 * 适用于「预定义项 + 持久化覆盖」的场景。
 *
 * 用法：
 *   const store = new IdentifiableJsonStore<{ id: string; mastery: number }>('/path/data.json')
 *   // 先加载持久化数据，合并到预定义 map 中
 *   store.mergeInto(existingMap, (item) => ({ id: item.id }))
 */
export class IdentifiableJsonStore<T extends { id: string }> extends JsonStore<T> {
  /**
   * 从持久化数据加载并合并到现有 Map 中。
   *
   * 对于持久化中的每一项，如果 Map 中已存在同 id 项，则用持久化字段覆盖它；
   * 如果持久化中有 Map 中不存在的项，也将其加入 Map。
   *
   * @param target 目标 Map（通常为预定义项集合）
   * @param mergeFn 自定义合并函数，接收 (existing, persisted) → merged
   * @returns 加载并合并的项数
   */
  mergeInto(
    target: Map<string, T>,
    mergeFn?: (existing: T, persisted: T) => T,
  ): number {
    const persisted = this.load()
    let loaded = 0

    for (const persistedItem of persisted) {
      const existing = target.get(persistedItem.id)
      if (existing) {
        // 合并持久化数据到预定义项
        target.set(persistedItem.id, mergeFn ? mergeFn(existing, persistedItem) : persistedItem)
      } else {
        // 持久化中有，但预定义清单中没有 → 直接添加
        target.set(persistedItem.id, persistedItem)
      }
      loaded++
    }

    return loaded
  }
}
