/**
 * RadarPushRuleStore — 雷达推送规则 SQLite 持久化存储
 *
 * 在 main.db 中创建 radar_push_rules 表，提供 CRUD 操作。
 * 遵循现有 outbox.ts 的数据库访问模式（getRawDb）。
 *
 * ## 线程安全
 *
 * 所有方法均为同步操作（better-sqlite3 是同步的），
 * 可在 setInterval 定时器和 Telegram 消息处理中安全调用。
 */

import { log } from '../../logger/Logger'
import { getRawDb } from '../../db/connection'
import type {
  RadarPushRule,
  PushRuleOperationResult,
  PushRuleListResult,
} from './types'
import { CREATE_PUSH_RULES_TABLE_SQL, MAX_PUSH_RULES } from './types'

// ════════════════════════════════════════════════════════════════
// RadarPushRuleStore
// ════════════════════════════════════════════════════════════════

export class RadarPushRuleStore {
  private initialized = false

  /**
   * 初始化：创建表（如不存在）
   */
  initialize(): void {
    if (this.initialized) return
    try {
      getRawDb().run(CREATE_PUSH_RULES_TABLE_SQL)
      this.initialized = true
      log('INFO', 'radar_push_rule_store_initialized')
    } catch (err) {
      log('ERROR', 'radar_push_rule_store_init_failed', { error: String(err) })
      throw err
    }
  }

  // ════════════════════════════════════════════════════════════════
  // CRUD
  // ════════════════════════════════════════════════════════════════

  /**
   * 创建推送规则。
   * 如果已有规则数达到上限，返回错误。
   */
  create(rule: RadarPushRule): PushRuleOperationResult {
    this.ensureInitialized()

    // 检查数量上限
    const count = this.count()
    if (count >= MAX_PUSH_RULES) {
      return {
        success: false,
        error: `推送规则已达上限 ${MAX_PUSH_RULES} 条。请先删除旧规则后再添加。`,
      }
    }

    try {
      const db = getRawDb()
      db.run(
        `INSERT INTO ${'radar_push_rules'} (id, name, enabled, frequency, minute, hour, day_of_week, location, keywords, sources, raw_text, created_at, updated_at, last_pushed_at, push_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rule.id,
          rule.name,
          rule.enabled ? 1 : 0,
          rule.frequency,
          rule.minute,
          rule.hour,
          rule.dayOfWeek ?? null,
          rule.location ?? null,
          JSON.stringify(rule.keywords),
          JSON.stringify(rule.sources),
          rule.rawText,
          rule.createdAt,
          rule.updatedAt,
          rule.lastPushedAt ?? null,
          rule.pushCount,
          rule.notes ?? null,
        ],
      )
      log('INFO', 'radar_push_rule_created', { id: rule.id, name: rule.name })
      return { success: true, rule }
    } catch (err: any) {
      log('ERROR', 'radar_push_rule_create_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  }

  /**
   * 根据 ID 获取规则。
   */
  get(id: string): RadarPushRule | undefined {
    this.ensureInitialized()
    try {
      const rows = getRawDb().exec(
        `SELECT * FROM radar_push_rules WHERE id = ?`,
        [id],
      )
      if (!rows.length || !rows[0].values.length) return undefined
      return this.rowToRule(rows[0].values[0], rows[0].columns)
    } catch {
      return undefined
    }
  }

  /**
   * 获取所有规则。
   */
  getAll(): PushRuleListResult {
    this.ensureInitialized()
    try {
      const rows = getRawDb().exec(
        `SELECT * FROM radar_push_rules ORDER BY created_at ASC`,
      )
      if (!rows.length) return { rules: [], total: 0 }

      const rules = rows[0].values.map((row: any[]) =>
        this.rowToRule(row, rows[0].columns),
      )
      return { rules, total: rules.length }
    } catch (err) {
      log('ERROR', 'radar_push_rule_get_all_failed', { error: String(err) })
      return { rules: [], total: 0 }
    }
  }

  /**
   * 获取所有已启用的规则。
   */
  getEnabled(): RadarPushRule[] {
    this.ensureInitialized()
    try {
      const rows = getRawDb().exec(
        `SELECT * FROM radar_push_rules WHERE enabled = 1 ORDER BY created_at ASC`,
      )
      if (!rows.length) return []
      return rows[0].values.map((row: any[]) =>
        this.rowToRule(row, rows[0].columns),
      )
    } catch {
      return []
    }
  }

  /**
   * 更新规则。
   */
  update(id: string, patch: Partial<RadarPushRule>): PushRuleOperationResult {
    this.ensureInitialized()

    const existing = this.get(id)
    if (!existing) {
      return { success: false, error: `规则 ${id} 不存在` }
    }

    try {
      const updated: RadarPushRule = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      }

      const db = getRawDb()
      db.run(
        `UPDATE radar_push_rules SET
          name = ?, enabled = ?, frequency = ?, minute = ?, hour = ?,
          day_of_week = ?, location = ?, keywords = ?, sources = ?,
          raw_text = ?, updated_at = ?, last_pushed_at = ?,
          push_count = ?, notes = ?
         WHERE id = ?`,
        [
          updated.name,
          updated.enabled ? 1 : 0,
          updated.frequency,
          updated.minute,
          updated.hour,
          updated.dayOfWeek ?? null,
          updated.location ?? null,
          JSON.stringify(updated.keywords),
          JSON.stringify(updated.sources),
          updated.rawText,
          updated.updatedAt,
          updated.lastPushedAt ?? null,
          updated.pushCount,
          updated.notes ?? null,
          id,
        ],
      )
      log('INFO', 'radar_push_rule_updated', { id, patches: Object.keys(patch).join(',') })
      return { success: true, rule: updated }
    } catch (err: any) {
      log('ERROR', 'radar_push_rule_update_failed', { id, error: String(err) })
      return { success: false, error: String(err) }
    }
  }

  /**
   * 删除规则。
   */
  delete(id: string): PushRuleOperationResult {
    this.ensureInitialized()

    const existing = this.get(id)
    if (!existing) {
      return { success: false, error: `规则 ${id} 不存在` }
    }

    try {
      getRawDb().run(`DELETE FROM radar_push_rules WHERE id = ?`, [id])
      log('INFO', 'radar_push_rule_deleted', { id, name: existing.name })
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'radar_push_rule_delete_failed', { id, error: String(err) })
      return { success: false, error: String(err) }
    }
  }

  /**
   * 切换规则启用/禁用状态。
   */
  toggle(id: string): PushRuleOperationResult {
    const rule = this.get(id)
    if (!rule) {
      return { success: false, error: `规则 ${id} 不存在` }
    }
    return this.update(id, { enabled: !rule.enabled })
  }

  /**
   * 更新规则的上次推送时间。
   */
  markPushed(id: string): void {
    try {
      const db = getRawDb()
      db.run(
        `UPDATE radar_push_rules SET last_pushed_at = ?, push_count = push_count + 1, updated_at = ? WHERE id = ?`,
        [Date.now(), Date.now(), id],
      )
    } catch {
      // 静默
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 查询
  // ════════════════════════════════════════════════════════════════

  /** 获取规则总数 */
  count(): number {
    this.ensureInitialized()
    try {
      const rows = getRawDb().exec(`SELECT COUNT(*) as cnt FROM radar_push_rules`)
      if (!rows.length || !rows[0].values.length) return 0
      return Number(rows[0].values[0][0]) || 0
    } catch {
      return 0
    }
  }

  /** 获取最大规则数量 */
  get maxRules(): number {
    return MAX_PUSH_RULES
  }

  // ════════════════════════════════════════════════════════════════
  // 格式化
  // ════════════════════════════════════════════════════════════════

  /**
   * 格式化规则列表为 Telegram 消息文本。
   */
  formatRulesForTelegram(rules?: RadarPushRule[]): string {
    const list = rules ?? this.getAll().rules
    if (list.length === 0) {
      return '📡 尚未设置雷达推送规则。\n\n发送"设置雷达推送 每天上午8点 北京 AI创业"来创建一条规则。'
    }

    const lines: string[] = [
      '📡 **雷达推送规则**',
      `━━━ ${list.length}/${MAX_PUSH_RULES} 条规则 ━━━`,
      '',
    ]

    for (let i = 0; i < list.length; i++) {
      const rule = list[i]
      const status = rule.enabled ? '✅ 启用' : '⏸️ 暂停'
      lines.push(`**#${i + 1}** ${rule.name} [${status}]`)

      // 时间
      const timeStr = `${rule.hour.toString().padStart(2, '0')}:${rule.minute.toString().padStart(2, '0')}`
      const freqLabel = this.frequencyLabel(rule)
      lines.push(`  ⏰ ${freqLabel} ${timeStr}`)

      // 地点
      if (rule.location) {
        lines.push(`  📍 ${rule.location}`)
      }

      // 关键词
      if (rule.keywords.length > 0) {
        lines.push(`  🔑 ${rule.keywords.join(', ')}`)
      }

      // 来源
      if (rule.sources.length > 0) {
        lines.push(`  📡 ${rule.sources.join(', ')}`)
      }

      // 统计
      const stats = [`推送 ${rule.pushCount} 次`]
      if (rule.lastPushedAt) {
        const lastPush = new Date(rule.lastPushedAt)
        stats.push(`上次: ${lastPush.toLocaleString('zh-CN', { hour12: false })}`)
      }
      lines.push(`  📊 ${stats.join(' | ')}`)
      lines.push('')
    }

    lines.push('━━━ 📋 操作提示 ━━━')
    lines.push('• 发送"设置雷达推送 [时间] [地点] [关键词]" 创建规则')
    lines.push('• 发送"查看雷达推送" 查看所有规则')
    lines.push('• 发送"删除雷达推送 #序号" 删除规则')
    lines.push('• 发送"暂停/启用雷达推送 #序号" 切换规则状态')

    return lines.join('\n')
  }

  // ════════════════════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════════════════════

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize()
    }
  }

  /**
   * SQLite 行 → RadarPushRule 对象
   */
  private rowToRule(row: any[], columns: string[]): RadarPushRule {
    const col = (name: string): number => columns.indexOf(name)
    return {
      id: String(row[col('id')]),
      name: String(row[col('name')]),
      enabled: row[col('enabled')] === 1 || row[col('enabled')] === true,
      frequency: String(row[col('frequency')]) as RadarPushRule['frequency'],
      minute: Number(row[col('minute')]),
      hour: Number(row[col('hour')]),
      dayOfWeek: row[col('day_of_week')] != null ? Number(row[col('day_of_week')]) : undefined,
      location: row[col('location')] || undefined,
      keywords: this.parseJSONArray(row[col('keywords')]),
      sources: this.parseJSONArray(row[col('sources')]),
      rawText: String(row[col('raw_text')]),
      createdAt: Number(row[col('created_at')]),
      updatedAt: Number(row[col('updated_at')]),
      lastPushedAt: row[col('last_pushed_at')] != null ? Number(row[col('last_pushed_at')]) : undefined,
      pushCount: Number(row[col('push_count')]),
      notes: row[col('notes')] || undefined,
    }
  }

  /**
   * 解析 JSON 数组字符串
   */
  private parseJSONArray(value: any): string[] {
    if (!value) return []
    try {
      const parsed = JSON.parse(String(value))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * 频率的中文标签
   */
  private frequencyLabel(rule: RadarPushRule): string {
    switch (rule.frequency) {
      case 'daily': return '每天'
      case 'weekday': return '工作日'
      case 'weekend': return '周末'
      case 'weekly': {
        const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        return `每周${labels[rule.dayOfWeek ?? 0]}`
      }
      default: return '每天'
    }
  }
}

/** 全局单例 */
export const radarPushRuleStore = new RadarPushRuleStore()
