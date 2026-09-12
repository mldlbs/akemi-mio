/**
 * JsonObjectStore — 通用 JSON 对象持久化存储
 *
 * 核心抽象：将单个对象以 JSON 格式持久化到本地文件。
 * 补充 JsonStore（仅支持数组）的缺失场景。
 * 替代各模块中重复的 existsSync / readFileSync / JSON.parse / writeFileSync 样板代码。
 *
 * 用法：
 *   const store = new JsonObjectStore<{ count: number; name: string }>('/path/state.json')
 *   const state = store.load()        // { count: 42, name: 'foo' } | null
 *   store.save({ count: 43, name: 'foo' })
 *   const updated = store.update(s => ({ count: s.count + 1, name: s.name }))
 *
 * 设计原则：
 * - 无偏见：不关心对象结构，只处理 JSON 序列化/反序列化
 * - 容错：文件不存在时返回 null，解析失败时返回 null 并记录警告
 * - 自动创建目录：save() 自动确保目标目录存在
 * - 原子写入：先写 .tmp 文件再 rename，防止写入中断导致数据损坏
 *   （若失败则降级为直接写入）
 *
 * 来源分析（从以下模块提取的共性）：
 * - EvolutionStateManager.load/save — 进化冷却状态持久化
 * - ProblemQueue.load/save — 问题队列持久化
 * - SessionRecoveryManager.restoreLatestCheckpoint/createCheckpoint — 会话检查点
 * - 项目中 20+ 处类似的对象级别 JSON 文件读写模式
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { dirname } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'

// ── 配置 ──

export interface JsonObjectStoreOptions {
  /** 日志分类名（默认取文件名） */
  loggerName?: string
  /** 是否启用原子写入（默认 true） */
  atomicWrite?: boolean
}

// ── 核心类 ──

export class JsonObjectStore<T extends Record<string, unknown>> {
  protected readonly filePath: string
  private readonly loggerName: string
  private readonly atomicWrite: boolean

  /**
   * @param filePath JSON 文件绝对路径
   * @param options  可选配置
   */
  constructor(filePath: string, options?: JsonObjectStoreOptions) {
    this.filePath = filePath
    this.loggerName = options?.loggerName ?? `json_obj:${this.basename(filePath)}`
    this.atomicWrite = options?.atomicWrite ?? true
  }

  // ── 读写接口 ──

  /**
   * 从文件加载对象。
   * 文件不存在时返回 null。
   * 解析失败时记录警告并返回 null。
   */
  load(): T | null {
    try {
      if (!existsSync(this.filePath)) return null

      const raw = readFileSync(this.filePath, 'utf-8')
      const data: unknown = JSON.parse(raw)

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        log('WARN', `${this.loggerName}_invalid_format`, {
          note: 'JSON 根元素不是对象，返回 null',
        })
        return null
      }

      return data as T
    } catch (err) {
      log('WARN', `${this.loggerName}_load_failed`, {
        error: String(err),
        file: this.filePath,
      })
      return null
    }
  }

  /**
   * 将对象保存到文件。
   * 自动创建目标目录。
   * 使用原子写入（先写 .tmp 再 rename）防止数据损坏。
   */
  save(data: T): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const json = JSON.stringify(data, null, 2)

      if (this.atomicWrite) {
        const tmpPath = this.filePath + '.tmp'
        try {
          writeFileSync(tmpPath, json, 'utf-8')
          renameSync(tmpPath, this.filePath)
        } catch {
          // 原子写入降级：直接写入
          writeFileSync(this.filePath, json, 'utf-8')
        }
      } else {
        writeFileSync(this.filePath, json, 'utf-8')
      }
    } catch (err) {
      log('WARN', `${this.loggerName}_save_failed`, {
        error: String(err),
        file: this.filePath,
      })
    }
  }

  /**
   * 读取-修改-写入 原子操作。
   * 加载当前状态，应用更新函数，写回文件。
   *
   * @param updater 更新函数（接收当前状态或默认值，返回新状态）
   * @param defaultValue 文件不存在时使用的默认值
   * @returns 更新后的状态，失败时返回 null
   */
  update(updater: (current: T | null) => T, defaultValue?: T): T | null {
    try {
      const current = this.load() ?? defaultValue ?? null
      if (current === null) {
        log('WARN', `${this.loggerName}_update_no_data`, {
          note: '文件不存在且未提供默认值',
        })
        return null
      }
      const next = updater(current)
      this.save(next)
      return next
    } catch (err) {
      log('WARN', `${this.loggerName}_update_failed`, {
        error: String(err),
      })
      return null
    }
  }

  /**
   * 清空文件（删除文件）。
   * 区别于 JsonStore.clear()（写入空数组），
   * 对象持久化没有合理的"空值"，所以直接删除。
   */
  clear(): void {
    try {
      if (existsSync(this.filePath)) {
        const tmpPath = this.filePath + '.tmp'
        try {
          renameSync(this.filePath, tmpPath)
          writeFileSync(tmpPath, '{}', 'utf-8')
          renameSync(tmpPath, this.filePath)
        } catch {
          writeFileSync(this.filePath, '{}', 'utf-8')
        }
      }
    } catch (err) {
      log('WARN', `${this.loggerName}_clear_failed`, {
        error: String(err),
        file: this.filePath,
      })
    }
  }

  // ── 查询 ──

  /** 获取文件路径 */
  getPath(): string {
    return this.filePath
  }

  /** 文件是否存在 */
  exists(): boolean {
    return existsSync(this.filePath)
  }

  // ── 内部 ──

  private basename(fullPath: string): string {
    const parts = fullPath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] ?? 'unknown'
  }
}
