/**
 * ToolPatternStore — 工具链模式持久化存储
 *
 * ## 职责
 * 1. 存储 PatternMiner（PrefixSpan）挖掘出的工具链模式
 * 2. 支持 CRUD：增/删/改/查已识别的模式
 * 3. 按触发工具、频率、置信度等维度查询
 * 4. JSON 文件持久化（与 ToolCallChainStore 风格一致）
 *
 * ## 与 BehaviorPatternStore 的区别
 * - BehaviorPatternStore: 存储关键词/话题关联规则（antecedent→consequent）
 * - ToolPatternStore: 存储工具调用序列模式（有序工具链 + 参数模板）
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { BehaviorPattern } from './types'
import { STORAGE_PATH } from './types'

// ══════════════════════════════════════════
//  配置
// ══════════════════════════════════════════

const DEFAULT_CONFIG = {
  MAX_PATTERNS: 100,
  STORAGE_FILE: STORAGE_PATH,
}

// ══════════════════════════════════════════
//  ToolPatternStore
// ══════════════════════════════════════════

export class ToolPatternStore {
  private config: typeof DEFAULT_CONFIG
  private patterns: BehaviorPattern[] = []
  private persistPath: string
  private _loaded = false

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.persistPath = join(process.cwd(), this.config.STORAGE_FILE)
  }

  // ══════════════════════════════════════════
  //  持久化
  // ══════════════════════════════════════════

  private ensureLoaded(): void {
    if (this._loaded) return
    try {
      if (existsSync(this.persistPath)) {
        const raw = readFileSync(this.persistPath, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.patterns = data
          log('INFO', 'tool_pattern_store_loaded', {
            count: this.patterns.length,
            path: this.config.STORAGE_FILE,
          })
        }
      }
    } catch (err: any) {
      log('WARN', 'tool_pattern_store_load_failed', { error: err.message })
      this.patterns = []
    }
    this._loaded = true
  }

  private persist(): void {
    try {
      const dir = join(process.cwd(), '.claude')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.persistPath, JSON.stringify(this.patterns, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'tool_pattern_store_persist_failed', { error: err.message })
    }
  }

  // ══════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════

  /** 获取所有模式 */
  getAll(): BehaviorPattern[] {
    this.ensureLoaded()
    return [...this.patterns]
  }

  /** 获取启用状态的模式 */
  getEnabled(): BehaviorPattern[] {
    return this.getAll().filter((p) => p.enabled)
  }

  /** 根据 ID 获取模式 */
  getById(id: string): BehaviorPattern | undefined {
    return this.getAll().find((p) => p.id === id)
  }

  /** 根据触发工具获取模式 */
  getByTriggerTool(toolName: string): BehaviorPattern[] {
    return this.getAll().filter((p) => p.triggerTool === toolName && p.enabled)
  }

  /** 按频率降序获取模式 */
  getByFrequency(limit = 20): BehaviorPattern[] {
    return [...this.getAll()].sort((a, b) => b.frequency - a.frequency).slice(0, limit)
  }

  /** 按置信度降序获取模式 */
  getByConfidence(limit = 20): BehaviorPattern[] {
    return [...this.getAll()].sort((a, b) => b.confidence - a.confidence).slice(0, limit)
  }

  /**
   * 添加或更新模式。
   * 按 ID 去重：已存在则更新，不存在则添加。
   */
  upsert(pattern: BehaviorPattern): void {
    this.ensureLoaded()
    const idx = this.patterns.findIndex((p) => p.id === pattern.id)
    if (idx >= 0) {
      // 保留用户编辑过的字段
      const existing = this.patterns[idx]
      this.patterns[idx] = {
        ...pattern,
        enabled: existing.enabled, // 保留用户开关状态
        notes: existing.notes, // 保留用户备注
        confirmationThreshold: existing.confirmationThreshold, // 保留用户设置
      }
    } else {
      this.patterns.push(pattern)
    }

    // 裁剪超出上限的模式（移除频率最低的）
    if (this.patterns.length > this.config.MAX_PATTERNS) {
      const sorted = [...this.patterns].sort((a, b) => a.frequency - b.frequency)
      const excess = this.patterns.length - this.config.MAX_PATTERNS
      for (let i = 0; i < excess; i++) {
        const removeId = sorted[i].id
        const removeIdx = this.patterns.findIndex((p) => p.id === removeId)
        if (removeIdx >= 0) this.patterns.splice(removeIdx, 1)
      }
    }

    this.persist()
  }

  /**
   * 批量添加或更新模式。
   */
  upsertMany(patterns: BehaviorPattern[]): number {
    let count = 0
    for (const p of patterns) {
      this.upsert(p)
      count++
    }
    return count
  }

  /**
   * 删除模式。
   */
  remove(id: string): boolean {
    this.ensureLoaded()
    const idx = this.patterns.findIndex((p) => p.id === id)
    if (idx < 0) return false
    this.patterns.splice(idx, 1)
    this.persist()
    log('INFO', 'tool_pattern_removed', { id })
    return true
  }

  /**
   * 启用/禁用模式。
   */
  setEnabled(id: string, enabled: boolean): boolean {
    this.ensureLoaded()
    const pattern = this.patterns.find((p) => p.id === id)
    if (!pattern) return false
    pattern.enabled = enabled
    this.persist()
    log('INFO', 'tool_pattern_toggled', { id, enabled })
    return true
  }

  /**
   * 更新模式的备注。
   */
  updateNotes(id: string, notes: string): boolean {
    this.ensureLoaded()
    const pattern = this.patterns.find((p) => p.id === id)
    if (!pattern) return false
    pattern.notes = notes
    this.persist()
    return true
  }

  /**
   * 更新模式的确认阈值。
   */
  updateConfirmationThreshold(id: string, threshold: number): boolean {
    this.ensureLoaded()
    const pattern = this.patterns.find((p) => p.id === id)
    if (!pattern) return false
    pattern.confirmationThreshold = Math.max(0, Math.min(1, threshold))
    this.persist()
    return true
  }

  /**
   * 记录模式的匹配时间。
   */
  recordMatch(id: string): boolean {
    this.ensureLoaded()
    const pattern = this.patterns.find((p) => p.id === id)
    if (!pattern) return false
    pattern.lastMatchedAt = Date.now()
    pattern.frequency++
    this.persist()
    return true
  }

  /** 获取已存在的模式 ID 集合 */
  getExistingIds(): Set<string> {
    return new Set(this.getAll().map((p) => p.id))
  }

  /** 获取模式数量 */
  get size(): number {
    return this.getAll().length
  }

  /** 清除所有模式 */
  clear(): void {
    this.patterns = []
    this.persist()
    log('INFO', 'tool_pattern_store_cleared')
  }

  /** 获取统计信息 */
  getStats(): {
    total: number
    enabled: number
    avgConfidence: number
    avgFrequency: number
    topTriggerTools: Array<{ toolName: string; count: number }>
  } {
    const all = this.getAll()
    const enabled = all.filter((p) => p.enabled)
    const avgConfidence = all.length > 0 ? all.reduce((s, p) => s + p.confidence, 0) / all.length : 0
    const avgFrequency = all.length > 0 ? all.reduce((s, p) => s + p.frequency, 0) / all.length : 0

    const triggerCount = new Map<string, number>()
    for (const p of all) {
      triggerCount.set(p.triggerTool, (triggerCount.get(p.triggerTool) || 0) + 1)
    }
    const topTriggerTools = Array.from(triggerCount.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return {
      total: all.length,
      enabled: enabled.length,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      avgFrequency: Math.round(avgFrequency * 10) / 10,
      topTriggerTools,
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const toolPatternStore = new ToolPatternStore()
