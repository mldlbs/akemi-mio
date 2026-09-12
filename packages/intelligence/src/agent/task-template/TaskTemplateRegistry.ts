/**
 * TaskTemplateRegistry — 任务模板注册表
 *
 * 职责：
 * 1. 模板 CRUD（创建/读取/更新/删除）
 * 2. 模板持久化（SQLite）
 * 3. 按使用频率和成功率排序推荐
 * 4. 自动模板发现 → 生成 → 存储流程
 */

import { getRawDb } from '@akemi-mio/core/db/connection'
import { log } from '@akemi-mio/core/logger/Logger'
import { PatternExtractor, patternExtractor } from './PatternExtractor'
import { type TaskTemplate, type TemplateStep, type TemplateMatch, type ToolCallSequence, type PatternExtractOptions } from './types'

// =============================================================================
// Helper: 生成唯一 ID
// =============================================================================

function createTemplateId(): string {
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// =============================================================================
// TaskTemplateRegistry
// =============================================================================

export class TaskTemplateRegistry {
  private extractor: PatternExtractor
  /** 运行时缓存（避免频繁读 DB） */
  private cache: Map<string, TaskTemplate> = new Map()
  /** 缓存是否已填充 */
  private cacheLoaded = false
  /** 自上次分析后的新序列 */
  private pendingSequences: ToolCallSequence[] = []
  /** 自动分析冷却时间戳（防止频繁分析） */
  private lastAutoAnalysisAt = 0

  constructor(extractor?: PatternExtractor) {
    this.extractor = extractor ?? patternExtractor
  }

  // ── 初始化 / 缓存 ──

  /** 强制从 DB 刷新缓存 */
  refreshCache(): void {
    try {
      const db = getRawDb()
      const rows = db.exec(
        `SELECT id, name, description, trigger_keywords, tool_sequence, source, status,
                use_count, success_count, last_used_at, created_at, updated_at
         FROM task_templates
         ORDER BY use_count DESC`,
      )

      this.cache.clear()
      if (rows.length && rows[0].values.length) {
        const cols = rows[0].columns
        for (const row of rows[0].values) {
          const obj: Record<string, any> = {}
          for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
          const tmpl = this._rowToTemplate(obj)
          this.cache.set(tmpl.id, tmpl)
        }
      }
      this.cacheLoaded = true
      log('INFO', 'template_cache_refreshed', { count: this.cache.size })
    } catch (err: any) {
      log('ERROR', 'template_cache_refresh_failed', { error: err.message })
    }
  }

  /** 获取所有活跃模板（按使用次数降序） */
  getAllTemplates(status?: 'active' | 'disabled' | 'archived'): TaskTemplate[] {
    if (!this.cacheLoaded) this.refreshCache()
    const templates = Array.from(this.cache.values())
    if (status) {
      return templates.filter((t) => t.status === status).sort((a, b) => b.useCount - a.useCount)
    }
    return templates.sort((a, b) => b.useCount - a.useCount)
  }

  /** 按 ID 获取模板 */
  getTemplate(id: string): TaskTemplate | null {
    if (!this.cacheLoaded) this.refreshCache()
    return this.cache.get(id) ?? null
  }

  /** 按名称搜索模板 */
  searchTemplates(query: string): TaskTemplate[] {
    if (!this.cacheLoaded) this.refreshCache()
    const q = query.toLowerCase()
    return Array.from(this.cache.values()).filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.triggerKeywords.some((kw) => kw.toLowerCase().includes(q)),
    )
  }

  // ── 模板 CRUD ──

  /**
   * 创建新模板。
   */
  createTemplate(tmpl: Omit<TaskTemplate, 'id' | 'createdAt' | 'updatedAt'>): TaskTemplate {
    const now = Date.now()
    const newTmpl: TaskTemplate = {
      ...tmpl,
      id: createTemplateId(),
      createdAt: now,
      updatedAt: now,
    }

    this._insertTemplate(newTmpl)
    this.cache.set(newTmpl.id, newTmpl)

    log('INFO', 'template_created', { id: newTmpl.id, name: newTmpl.name })
    return newTmpl
  }

  /**
   * 更新模板（只更新提供的字段）。
   */
  updateTemplate(id: string, updates: Partial<Omit<TaskTemplate, 'id' | 'createdAt'>>): TaskTemplate | null {
    const existing = this.getTemplate(id)
    if (!existing) return null

    const updated: TaskTemplate = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }

    this._updateTemplateDb(updated)
    this.cache.set(updated.id, updated)

    log('INFO', 'template_updated', { id, name: updated.name })
    return updated
  }

  /**
   * 删除模板。
   */
  deleteTemplate(id: string): boolean {
    const existing = this.getTemplate(id)
    if (!existing) return false

    try {
      const db = getRawDb()
      db.run('DELETE FROM task_templates WHERE id = ?', [id])
      this.cache.delete(id)
      log('INFO', 'template_deleted', { id, name: existing.name })
      return true
    } catch (err: any) {
      log('ERROR', 'template_delete_failed', { id, error: err.message })
      return false
    }
  }

  /**
   * 模板使用计数递增。
   */
  recordUse(templateId: string, success: boolean): void {
    const tmpl = this.getTemplate(templateId)
    if (!tmpl) return

    const updates: Partial<Omit<TaskTemplate, 'id' | 'createdAt'>> = {
      useCount: tmpl.useCount + 1,
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (success) {
      updates.successCount = tmpl.successCount + 1
    }
    this.updateTemplate(templateId, updates)
  }

  // ── 模板匹配 ──

  /**
   * 对用户输入进行模板匹配。
   */
  matchForInput(userInput: string, limit?: number): TemplateMatch[] {
    if (!this.cacheLoaded) this.refreshCache()
    const activeTemplates = Array.from(this.cache.values()).filter((t) => t.status === 'active')

    if (activeTemplates.length === 0) return []

    const matches = patternExtractor.matchTemplates(userInput, activeTemplates)
    return limit ? matches.slice(0, limit) : matches
  }

  // ── 自动模板发现 ──

  /**
   * 记录工具调用序列（供后续聚类分析）。
   */
  recordSequence(sessionId: string, toolNames: string[], intentLabel: string, userInputSummary: string): void {
    patternExtractor.recordSequence(sessionId, toolNames, intentLabel, userInputSummary)
    this.pendingSequences.push({
      sessionId,
      toolNames,
      intentLabel,
      userInputSummary,
      timestamp: Date.now(),
    })
  }

  /**
   * 执行自动模板发现分析。
   * 从近期序列中聚类 -> 生成模板 -> 去重存储。
   * 建议每小时调用不超过一次（内部有冷却）。
   *
   * @returns 新生成的模板数
   */
  runAutoDiscovery(options?: PatternExtractOptions): number {
    const now = Date.now()
    const cooldownMs = 60 * 60 * 1000 // 1 小时冷却

    if (now - this.lastAutoAnalysisAt < cooldownMs) {
      return 0 // 冷却中
    }

    // 从历史加载更多序列
    patternExtractor.loadFromHistory(options)

    // 聚类
    const clusters = patternExtractor.clusterSequences(options)
    if (clusters.length === 0) {
      this.lastAutoAnalysisAt = now
      return 0
    }

    // 生成模板
    const newTemplates = patternExtractor.generateTemplatesFromClusters(clusters)
    if (newTemplates.length === 0) {
      this.lastAutoAnalysisAt = now
      return 0
    }

    // 去重：检查是否已有同名/同序列模板
    const existingNames = new Set(Array.from(this.cache.values()).map((t) => t.name))
    const existingSignatures = new Set(Array.from(this.cache.values()).map((t) => t.toolSequence.map((s) => s.toolName).join(',')))

    let created = 0
    for (const tmpl of newTemplates) {
      const sig = tmpl.toolSequence.map((s) => s.toolName).join(',')

      // 跳过已存在的
      if (existingNames.has(tmpl.name) || existingSignatures.has(sig)) {
        continue
      }

      this.createTemplate(tmpl)
      existingNames.add(tmpl.name)
      existingSignatures.add(sig)
      created++
    }

    this.lastAutoAnalysisAt = now
    this.pendingSequences = []

    if (created > 0) {
      log('INFO', 'template_auto_discovery', { created, totalClusters: clusters.length })
    }

    return created
  }

  // ── 私有方法 ──

  /** 插入模板到 DB */
  private _insertTemplate(tmpl: TaskTemplate): void {
    try {
      const db = getRawDb()
      db.run(
        `INSERT INTO task_templates (id, name, description, trigger_keywords, tool_sequence, source, status, use_count, success_count, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tmpl.id,
          tmpl.name,
          tmpl.description,
          JSON.stringify(tmpl.triggerKeywords),
          JSON.stringify(tmpl.toolSequence),
          tmpl.source,
          tmpl.status,
          tmpl.useCount,
          tmpl.successCount,
          tmpl.lastUsedAt,
          tmpl.createdAt,
          tmpl.updatedAt,
        ],
      )
    } catch (err: any) {
      log('ERROR', 'template_insert_failed', { id: tmpl.id, error: err.message })
    }
  }

  /** 更新 DB 中的模板记录 */
  private _updateTemplateDb(tmpl: TaskTemplate): void {
    try {
      const db = getRawDb()
      db.run(
        `UPDATE task_templates SET
          name = ?, description = ?, trigger_keywords = ?, tool_sequence = ?,
          source = ?, status = ?, use_count = ?, success_count = ?,
          last_used_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          tmpl.name,
          tmpl.description,
          JSON.stringify(tmpl.triggerKeywords),
          JSON.stringify(tmpl.toolSequence),
          tmpl.source,
          tmpl.status,
          tmpl.useCount,
          tmpl.successCount,
          tmpl.lastUsedAt,
          tmpl.updatedAt,
          tmpl.id,
        ],
      )
    } catch (err: any) {
      log('ERROR', 'template_update_failed', { id: tmpl.id, error: err.message })
    }
  }

  /** 从 DB 行数据反序列化模板 */
  private _rowToTemplate(row: Record<string, any>): TaskTemplate {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      triggerKeywords: JSON.parse(String(row.trigger_keywords)),
      toolSequence: JSON.parse(String(row.tool_sequence)) as TemplateStep[],
      source: String(row.source) as 'auto' | 'user' | 'edited',
      status: String(row.status) as 'active' | 'disabled' | 'archived',
      useCount: Number(row.use_count),
      successCount: Number(row.success_count),
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }
}

// =============================================================================
// 单例
// =============================================================================

export const taskTemplateRegistry = new TaskTemplateRegistry()
