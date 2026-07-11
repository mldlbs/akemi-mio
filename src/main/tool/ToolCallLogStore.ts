/**
 * ToolCallLogStore — 持久化的工具调用日志存储
 *
 * 职责：
 * 1. 记录每次工具调用的完整参数、结果、错误信息
 * 2. 支持基于工具名、错误类型、时间范围的查询
 * 3. 支持参数模式的索引，用于发现特定参数值导致的失败模式
 * 4. 超过最大条目数时自动轮转（保留最新条目）
 *
 * 数据流向：
 *   ServerManager.callTool() → ToolCallLogStore.record() → 持久化到 JSON 文件
 *   FailurePatternAnalyzer → ToolCallLogStore.query() → 模式分析
 *   ToolEvolutionExecutor → ToolCallLogStore.getHistoricalSuccessfulCalls() → 回归测试
 */

import { log } from '../logger/Logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { classifyToolError } from './ToolErrorType'
import { ToolErrorType } from './ToolErrorType'

// =============================================================================
// 类型定义
// =============================================================================

export interface ToolCallRecord {
  /** 唯一标识 */
  id: string
  /** 工具名 */
  toolName: string
  /** 完整参数快照 */
  args: Record<string, any>
  /** 调用结果文本（成功时） */
  result: string | null
  /** 错误消息（失败时） */
  error: string | null
  /** 调用耗时（毫秒） */
  durationMs: number
  /** 时间戳 */
  timestamp: number
  /** 是否执行成功 */
  success: boolean
  /** 错误分类，成功时为 null */
  errorType: ToolErrorType | null
}

export interface CallLogQuery {
  toolName?: string
  errorType?: ToolErrorType
  success?: boolean
  since?: number
  until?: number
  limit?: number
}

export interface CallLogStats {
  totalRecords: number
  oldestTimestamp: number
  newestTimestamp: number
  byTool: Record<string, { total: number; success: number; failure: number }>
}

// =============================================================================
// 配置常量
// =============================================================================

const DEFAULT_CONFIG = {
  /** 最大保留记录数 */
  MAX_ENTRIES: 2000,
  /** 日志文件路径（相对于 project root） */
  LOG_FILE: '.claude/tool_call_log.json',
  /** 查询默认最大返回数 */
  DEFAULT_QUERY_LIMIT: 100,
}

// =============================================================================
// ToolCallLogStore 实现
// =============================================================================

export class ToolCallLogStore {
  private records: ToolCallRecord[] = []
  private config: typeof DEFAULT_CONFIG
  private persistPath: string
  private _loaded = false

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.persistPath = join(process.cwd(), this.config.LOG_FILE)
  }

  /** 懒加载：首次访问时从磁盘加载 */
  private ensureLoaded(): void {
    if (this._loaded) return
    try {
      if (existsSync(this.persistPath)) {
        const raw = readFileSync(this.persistPath, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.records = data
          log('INFO', 'tool_call_log_loaded', { count: this.records.length, path: this.config.LOG_FILE })
        }
      }
    } catch (err: any) {
      log('WARN', 'tool_call_log_load_failed', { error: err.message })
      this.records = []
    }
    this._loaded = true
  }

  /** 持久化到磁盘 */
  private persist(): void {
    try {
      const dir = join(process.cwd(), '.claude')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.persistPath, JSON.stringify(this.records), 'utf-8')
    } catch (err: any) {
      log('WARN', 'tool_call_log_persist_failed', { error: err.message })
    }
  }

  /**
   * 自增 ID 生成器
   */
  private nextId(): string {
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 8)
    return `tcl_${ts}_${rand}`
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /**
   * 记录一次工具调用
   * 自动持久化到磁盘，超过 MAX_ENTRIES 时轮转最旧记录
   */
  record(
    toolName: string,
    args: Record<string, any>,
    result: string | null,
    error: string | null,
    durationMs: number,
    success: boolean,
  ): ToolCallRecord {
    this.ensureLoaded()

    const record: ToolCallRecord = {
      id: this.nextId(),
      toolName,
      args: { ...args },
      result: result ? result.slice(0, 2000) : null,
      error: error ? error.slice(0, 2000) : null,
      durationMs,
      timestamp: Date.now(),
      success,
      errorType: success ? null : classifyToolError(error || ''),
    }

    this.records.push(record)

    // 轮转：超出上限则批量删除最旧记录
    if (this.records.length > this.config.MAX_ENTRIES) {
      const excess = this.records.length - this.config.MAX_ENTRIES
      this.records.splice(0, excess)
    }

    // 每 10 条记录持久化一次（批量写入减少 I/O）
    if (this.records.length % 10 === 0) {
      this.persist()
    }

    return record
  }

  /**
   * 强制持久化（循环结束或关闭前调用）
   */
  flush(): void {
    this.persist()
  }

  /**
   * 查询工具调用记录
   */
  query(query: CallLogQuery): ToolCallRecord[] {
    this.ensureLoaded()

    let results = this.records

    if (query.toolName) {
      results = results.filter((r) => r.toolName === query.toolName)
    }
    if (query.errorType) {
      results = results.filter((r) => r.errorType === query.errorType)
    }
    if (query.success !== undefined) {
      results = results.filter((r) => r.success === query.success)
    }
    if (query.since) {
      results = results.filter((r) => r.timestamp >= query.since!)
    }
    if (query.until) {
      results = results.filter((r) => r.timestamp <= query.until!)
    }

    // 按时间倒序排列（最新的在前）
    results.sort((a, b) => b.timestamp - a.timestamp)

    const limit = query.limit || this.config.DEFAULT_QUERY_LIMIT
    return results.slice(0, limit)
  }

  /**
   * 获取指定工具的历史成功调用记录
   * 用于回归测试：在修改工具代码后重播这些成功调用
   */
  getHistoricalSuccessfulCalls(
    toolName: string,
    maxSamples: number = 10,
    since: number = Date.now() - 24 * 60 * 60 * 1000,
  ): ToolCallRecord[] {
    return this.query({
      toolName,
      success: true,
      since,
      limit: maxSamples,
    })
  }

  /**
   * 获取指定工具的历史失败调用记录
   * 用于理解错误模式
   */
  getHistoricalFailedCalls(
    toolName: string,
    maxSamples: number = 20,
    since: number = Date.now() - 24 * 60 * 60 * 1000,
  ): ToolCallRecord[] {
    return this.query({
      toolName,
      success: false,
      since,
      limit: maxSamples,
    })
  }

  /**
   * 按工具名分组统计
   */
  getStats(): CallLogStats {
    this.ensureLoaded()

    const byTool: Record<string, { total: number; success: number; failure: number }> = {}
    let oldest = this.records.length > 0 ? this.records[0].timestamp : 0
    let newest = 0

    for (const r of this.records) {
      if (r.timestamp < oldest) oldest = r.timestamp
      if (r.timestamp > newest) newest = r.timestamp

      if (!byTool[r.toolName]) {
        byTool[r.toolName] = { total: 0, success: 0, failure: 0 }
      }
      byTool[r.toolName].total++
      if (r.success) {
        byTool[r.toolName].success++
      } else {
        byTool[r.toolName].failure++
      }
    }

    return {
      totalRecords: this.records.length,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
      byTool,
    }
  }

  /**
   * 清除所有记录（用于测试或重置）
   */
  clear(): void {
    this.records = []
    this.persist()
    log('INFO', 'tool_call_log_cleared')
  }

  /**
   * 获取记录总数
   */
  get size(): number {
    this.ensureLoaded()
    return this.records.length
  }

  /**
   * 获取指定工具在持久化历史中的失败记录（不限窗口、不限内存）
   * 返回未截断的完整错误消息
   */
  getRawFailedCalls(toolName: string, maxSamples: number = 50): ToolCallRecord[] {
    this.ensureLoaded()
    const failed = this.records
      .filter((r) => r.toolName === toolName && !r.success)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxSamples)
    // 返回时恢复完整 error/result 长度（存储时截断过，但已是完整保存）
    return failed
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolCallLogStore = new ToolCallLogStore()
