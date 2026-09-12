/**
 * BehaviorPatternStore — 行为模式规则存储与生命周期管理
 *
 * ## 职责
 * 1. 存储用户行为关联规则（antecedent → consequent 条件概率）
 * 2. 规则置信度衰减与自动淘汰
 * 3. 提供 "遗忘模式" 一键清除入口
 *
 * ## 存储格式
 * 每条规则记录一个用户行为模式：
 *   "用户说 '天气' → 随后说 '时间' 的概率为 70%"
 *
 * ## 数据流
 *   BehaviorPatternMiner.mine() → store.addRule() 写入
 *   BehaviorPatternMatcher.match() → store.getActive() 读取
 *   MemoryService.clearBehaviorPatterns() → store.clearAll() 用户主动清除
 *
 * ## 隐私设计
 * - 所有数据本地存储，永不发送外部
 * - 规则以概括性关键词存储，不保留原始消息文本
 * - 低频规则自动淘汰
 * - "遗忘模式" 一键清除所有规则
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import {
  BEHAVIOR_PATTERN_DECAY_RATE,
  BEHAVIOR_PATTERN_MIN_CONFIDENCE,
  BEHAVIOR_PATTERN_DECAY_INTERVAL,
  BEHAVIOR_PATTERN_MAX_RULES,
} from '@akemi-mio/core/config'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 行为模式规则 */
export interface BehaviorPatternRule {
  /** 规则唯一标识 */
  id: string
  /** 前件模式：用于匹配用户输入的关键词/模式 */
  antecedent: string
  /** 后件描述：预测的用户下一步行为 */
  consequent: string
  /** 条件概率 P(consequent | antecedent) */
  probability: number
  /** 综合置信度 (0-1)，随时间衰减 */
  confidence: number
  /** 该模式被观测到的次数 */
  count: number
  /** 该规则被命中的次数（匹配成功） */
  matchedCount: number
  /** 规则创建时间 */
  createdAt: number
  /** 上次匹配时间 */
  lastMatchedAt: number
  /** 最后更新/观测时间 */
  lastUpdatedAt: number
}

/** 规则来源类型 */
export type PatternSource = 'text_sequence' | 'topic_sequence'

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_DECAY_RATE = 0.97 // 每次衰减保留 97%
const DEFAULT_MIN_CONFIDENCE = 0.15 // 低于此值淘汰
const DEFAULT_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000 // 每天衰减一次
const DEFAULT_MAX_RULES = 200 // 规则库上限

// ══════════════════════════════════════════
//  BehaviorPatternStore
// ══════════════════════════════════════════

export class BehaviorPatternStore {
  /** 内存中的规则列表 */
  private rules: BehaviorPatternRule[] = []
  /** 衰减定时器 */
  private decayTimer: ReturnType<typeof setInterval> | null = null

  /** 配置（支持环境变量覆盖） */
  private decayRate: number
  private minConfidence: number
  private decayIntervalMs: number
  private maxRules: number

  constructor(config?: { decayRate?: number; minConfidence?: number; decayIntervalMs?: number; maxRules?: number }) {
    this.decayRate = config?.decayRate ?? BEHAVIOR_PATTERN_DECAY_RATE ?? DEFAULT_DECAY_RATE
    this.minConfidence = config?.minConfidence ?? BEHAVIOR_PATTERN_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE
    this.decayIntervalMs = config?.decayIntervalMs ?? BEHAVIOR_PATTERN_DECAY_INTERVAL ?? DEFAULT_DECAY_INTERVAL_MS
    this.maxRules = config?.maxRules ?? BEHAVIOR_PATTERN_MAX_RULES ?? DEFAULT_MAX_RULES

    this.load()
    this.startDecayTimer()
    log('INFO', 'behavior_pattern_store_init', {
      rules: this.rules.length,
      decayRate: this.decayRate,
      minConfidence: this.minConfidence,
    })
  }

  // ══════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════

  /** 获取所有规则 */
  getAll(): BehaviorPatternRule[] {
    return [...this.rules]
  }

  /** 获取活跃规则（置信度高于阈值） */
  getActive(minConfidence?: number): BehaviorPatternRule[] {
    const threshold = minConfidence ?? this.minConfidence
    return this.rules.filter((r) => r.confidence >= threshold)
  }

  /** 按前件匹配规则（精确匹配标签） */
  matchByAntecedent(antecedent: string): BehaviorPatternRule[] {
    const lower = antecedent.toLowerCase()
    return this.rules.filter((r) => r.antecedent.toLowerCase() === lower && r.confidence >= this.minConfidence)
  }

  /** 添加或更新规则（按 antecedent + consequent 去重） */
  upsertRule(input: { antecedent: string; consequent: string; probability: number; source: PatternSource }): BehaviorPatternRule {
    const now = Date.now()
    const key = `${input.antecedent.toLowerCase()}::${input.consequent.toLowerCase()}`

    // 查找已有规则
    const existing = this.rules.find(
      (r) => r.antecedent.toLowerCase() === input.antecedent.toLowerCase() && r.consequent.toLowerCase() === input.consequent.toLowerCase(),
    )

    if (existing) {
      // 更新：增量平均概率，增加计数
      existing.count++
      existing.probability = (existing.probability * (existing.count - 1) + input.probability) / existing.count
      existing.lastUpdatedAt = now
      // 置信度随匹配次数增长（渐近饱和）
      existing.confidence = Math.min(1.0, existing.confidence + (1 - existing.confidence) * 0.15)
      this.upsertInDb(existing)
      return existing
    }

    // 新建规则
    const rule: BehaviorPatternRule = {
      id: `bpr_${now}_${Math.random().toString(36).slice(2, 8)}`,
      antecedent: input.antecedent,
      consequent: input.consequent,
      probability: Math.round(input.probability * 100) / 100,
      confidence: 0.4, // 初始置信度
      count: 1,
      matchedCount: 0,
      createdAt: now,
      lastMatchedAt: 0,
      lastUpdatedAt: now,
    }

    this.rules.push(rule)
    this.upsertInDb(rule)
    this.pruneIfNeeded()

    log('INFO', 'behavior_pattern_rule_created', {
      antecedent: rule.antecedent,
      consequent: rule.consequent,
      probability: rule.probability,
    })

    return rule
  }

  /** 记录规则命中（更新匹配计数和置信度） */
  recordMatch(ruleId: string): boolean {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return false

    rule.matchedCount++
    rule.lastMatchedAt = Date.now()
    // 命中增强置信度
    rule.confidence = Math.min(1.0, rule.confidence + (1 - rule.confidence) * 0.2)
    this.upsertInDb(rule)
    return true
  }

  /** 删除单条规则 */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId)
    if (idx < 0) return false

    this.rules.splice(idx, 1)
    try {
      const db = getRawDb()
      db.run('DELETE FROM behavior_pattern_rules WHERE id = ?', [ruleId])
      markDirty()
    } catch {
      // 静默处理
    }
    return true
  }

  /**
   * 清除全部行为记忆（"遗忘模式"）。
   * 删除所有规则并持久化。
   */
  clearAll(): number {
    const count = this.rules.length
    this.rules = []
    try {
      const db = getRawDb()
      db.run('DELETE FROM behavior_pattern_rules')
      markDirty()
    } catch {
      // 静默
    }
    log('INFO', 'behavior_pattern_store_cleared', { removed: count })
    return count
  }

  /**
   * 应用置信度衰减。
   * 所有规则置信度乘以衰减因子。
   * 衰减后低于阈值的规则被自动淘汰。
   *
   * @returns 被淘汰的规则数
   */
  applyDecay(): number {
    const now = Date.now()
    let pruned = 0

    for (const rule of this.rules) {
      // 衰减置信度
      rule.confidence = rule.confidence * this.decayRate
      rule.lastUpdatedAt = now

      // 如果低于阈值，标记淘汰
      if (rule.confidence < this.minConfidence) {
        this.removeRule(rule.id)
        pruned++
      } else {
        this.upsertInDb(rule)
      }
    }

    if (pruned > 0) {
      log('INFO', 'behavior_pattern_decay_pruned', {
        pruned,
        remaining: this.rules.length,
      })
    }

    return pruned
  }

  /** 获取规则统计 */
  getStats(): { total: number; active: number; avgConfidence: number } {
    const active = this.rules.filter((r) => r.confidence >= this.minConfidence)
    const avgConfidence = this.rules.length > 0 ? this.rules.reduce((s, r) => s + r.confidence, 0) / this.rules.length : 0

    return {
      total: this.rules.length,
      active: active.length,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
    }
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /** 启动衰减定时器 */
  private startDecayTimer(): void {
    if (this.decayTimer) clearInterval(this.decayTimer)
    this.decayTimer = setInterval(() => {
      this.applyDecay()
    }, this.decayIntervalMs)
  }

  /** 停止衰减定时器 */
  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /** 从数据库加载所有规则 */
  private load(): void {
    try {
      const db = getRawDb()
      // 兼容表不存在的情况（迁移可能尚未执行）
      const result = db.exec(`
        SELECT id, antecedent, consequent, probability, confidence, count,
               matched_count, created_at, last_matched_at, last_updated_at
        FROM behavior_pattern_rules
        ORDER BY confidence DESC, count DESC
      `)
      if (result && result.length > 0) {
        const columns = result[0].columns
        this.rules = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            antecedent: obj.antecedent,
            consequent: obj.consequent,
            probability: obj.probability,
            confidence: obj.confidence,
            count: obj.count,
            matchedCount: obj.matched_count,
            createdAt: obj.created_at,
            lastMatchedAt: obj.last_matched_at,
            lastUpdatedAt: obj.last_updated_at,
          } as BehaviorPatternRule
        })
      }
    } catch (err) {
      log('WARN', 'behavior_pattern_store_load_failed', { error: String(err) })
    }
  }

  /** 写入或更新单条规则到数据库 */
  private upsertInDb(rule: BehaviorPatternRule): void {
    try {
      const db = getRawDb()
      db.run(
        `INSERT OR REPLACE INTO behavior_pattern_rules
         (id, antecedent, consequent, probability, confidence, count,
          matched_count, created_at, last_matched_at, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rule.id,
          rule.antecedent,
          rule.consequent,
          rule.probability,
          rule.confidence,
          rule.count,
          rule.matchedCount,
          rule.createdAt,
          rule.lastMatchedAt,
          rule.lastUpdatedAt,
        ],
      )
      markDirty()
    } catch (err) {
      log('WARN', 'behavior_pattern_store_save_failed', { error: String(err) })
    }
  }

  /** 必要时裁剪超出上限的规则（移除置信度最低的） */
  private pruneIfNeeded(): void {
    if (this.rules.length <= this.maxRules) return

    // 按置信度排序，移除最低的
    const sorted = [...this.rules].sort((a, b) => a.confidence - b.confidence)
    const toRemove = this.rules.length - this.maxRules

    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      this.removeRule(sorted[i].id)
    }

    log('INFO', 'behavior_pattern_store_pruned', {
      removed: toRemove,
      remaining: this.rules.length,
    })
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPatternStore = new BehaviorPatternStore()
