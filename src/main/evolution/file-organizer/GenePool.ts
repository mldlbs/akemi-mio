/**
 * GenePool — 规则基因池
 *
 * 维护文件整理规则的种群，支持：
 * - 规则匹配与排序
 * - 适应度跟踪（正/负反馈）
 * - 进化循环（精英选择、交叉、变异）
 * - 磁盘持久化
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type {
  OrganizerRule,
  FileFeatures,
  GenePoolData,
  EvolutionConfig,
  RuleCondition,
  RuleAction,
  ConditionOperator,
} from './types'
import { DEFAULT_EVOLUTION_CONFIG, createDefaultRules } from './types'

// =============================================================================
// 基因池文件路径
// =============================================================================

const GENE_POOL_FILE = join(WORKSPACE.evolution, 'file_organizer_genepool.json')

// =============================================================================
// 基因池类
// =============================================================================

export class GenePool {
  private rules: OrganizerRule[] = []
  private generation = 0
  private lastEvolvedAt = 0
  private isColdStart = true
  private config: EvolutionConfig
  private evolutionCycleCount = 0

  constructor(config?: Partial<EvolutionConfig>) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config }
  }

  // ============================================================================
  // 初始化与持久化
  // ============================================================================

  /** 初始化：尝试加载已有基因池，失败则创建默认规则 */
  init(): void {
    if (this.tryLoad()) {
      log('INFO', 'gene_pool_loaded', {
        rules: this.rules.length,
        generation: this.generation,
        lastEvolvedAt: new Date(this.lastEvolvedAt).toISOString(),
      })
      return
    }

    // 冷启动：创建默认规则
    this.rules = createDefaultRules()
    this.generation = 0
    this.lastEvolvedAt = Date.now()
    this.isColdStart = true
    this.save()
    log('INFO', 'gene_pool_cold_start', {
      rules: this.rules.length,
      initialGeneration: this.generation,
    })
  }

  private tryLoad(): boolean {
    try {
      if (!existsSync(GENE_POOL_FILE)) return false
      const raw = readFileSync(GENE_POOL_FILE, 'utf-8')
      const data: GenePoolData = JSON.parse(raw)
      if (data.version !== 1) return false
      this.rules = data.rules
      this.generation = data.generation
      this.lastEvolvedAt = data.lastEvolvedAt
      this.isColdStart = data.isColdStart ?? false
      return true
    } catch (err: any) {
      log('WARN', 'gene_pool_load_failed', { error: err.message })
      return false
    }
  }

  /** 持久化基因池到磁盘 */
  save(): void {
    try {
      const dir = dirname(GENE_POOL_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data: GenePoolData = {
        version: 1,
        rules: this.rules,
        generation: this.generation,
        lastEvolvedAt: this.lastEvolvedAt,
        isColdStart: this.isColdStart,
      }
      writeFileSync(GENE_POOL_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'gene_pool_save_failed', { error: err.message })
    }
  }

  // ============================================================================
  // 规则查询与匹配
  // ============================================================================

  /** 获取所有规则（按适应度降序） */
  getAllRules(): OrganizerRule[] {
    return [...this.rules].sort((a, b) => b.fitness - a.fitness)
  }

  /** 获取适应度最高的前 N 条规则 */
  getTopRules(n: number): OrganizerRule[] {
    return this.getAllRules().slice(0, n)
  }

  /** 根据文件特征查找所有匹配的规则（按适应度降序） */
  findMatchingRules(features: FileFeatures): OrganizerRule[] {
    return this.rules
      .filter((rule) => this.matchesAllConditions(rule.conditions, features))
      .sort((a, b) => b.fitness - a.fitness)
  }

  /** 查找最佳匹配规则（适应度最高的） */
  findBestRule(features: FileFeatures): OrganizerRule | undefined {
    return this.findMatchingRules(features)[0]
  }

  /** 检查文件是否已在整理后的目标位置 */
  isOrganized(features: FileFeatures): boolean {
    const rule = this.findBestRule(features)
    if (!rule) return false
    const targetDir = this.expandTargetTemplate(rule.action.target, features)
    // 规范化路径比较
    const normalizedDir = features.directory.replace(/\\/g, '/').replace(/\/$/, '')
    const normalizedTarget = targetDir.replace(/\\/g, '/').replace(/\/$/, '')
    return normalizedDir === normalizedTarget || normalizedDir.startsWith(normalizedTarget + '/')
  }

  /** 获取规则的数量 */
  get size(): number {
    return this.rules.length
  }

  /** 当前进化代数 */
  get currentGeneration(): number {
    return this.generation
  }

  /** 是否是冷启动状态 */
  get coldStart(): boolean {
    return this.isColdStart
  }

  // ============================================================================
  // 反馈记录
  // ============================================================================

  /** 记录正反馈（文件留在整理后的位置，用户未撤销） */
  recordPositiveFeedback(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return
    rule.feedbackCount++
    rule.positiveCount++
    rule.fitness = Math.min(100, rule.fitness + 5)
    rule.updatedAt = Date.now()
    log('INFO', 'gene_pool_positive_feedback', { ruleId, fitness: rule.fitness })
  }

  /** 记录负反馈（文件被用户移回原处） */
  recordNegativeFeedback(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return
    rule.feedbackCount++
    rule.negativeCount++
    rule.fitness = Math.max(0, rule.fitness - 15)
    rule.updatedAt = Date.now()
    log('INFO', 'gene_pool_negative_feedback', { ruleId, fitness: rule.fitness })
  }

  /** 记录规则被应用一次 */
  recordApply(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (rule) {
      rule.applyCount++
      rule.updatedAt = Date.now()
    }
  }

  // ============================================================================
  // 进化循环
  // ============================================================================

  /** 消耗一个周期计数，到达进化间隔时触发进化 */
  tick(): boolean {
    this.evolutionCycleCount++
    if (this.evolutionCycleCount >= this.config.evolutionInterval) {
      this.evolutionCycleCount = 0
      this.evolve()
      this.save()
      return true
    }
    this.save()
    return false
  }

  /**
   * 执行一轮进化：
   * 1. 精英保留 — 适应度最高的 eliteRatio 直接进入下一代
   * 2. 交叉 — 选择适应度高的父代进行规则交叉
   * 3. 变异 — 对新规则随机变异
   * 4. 淘汰 — 低适应度规则被替换
   */
  private evolve(): void {
    const before = this.rules.length
    this.generation++

    // 按适应度降序排序
    const sorted = [...this.rules].sort((a, b) => b.fitness - a.fitness)

    // 计算精英保留数量
    const eliteCount = Math.max(1, Math.floor(sorted.length * this.config.eliteRatio))
    const elites = sorted.slice(0, eliteCount)
    const nonElites = sorted.slice(eliteCount)

    // 新种群：从精英开始
    const newRules: OrganizerRule[] = [...elites]

    // 从非精英中选父母进行交叉，直到填满种群
    while (newRules.length < this.config.populationSize) {
      if (Math.random() < this.config.crossoverRate && nonElites.length >= 2) {
        // 交叉：选择两个父代
        const parentA = this.selectParent(nonElites)
        const parentB = this.selectParent(nonElites)
        if (parentA && parentB && parentA.id !== parentB.id) {
          const child = this.crossover(parentA, parentB)
          // 变异
          if (Math.random() < this.config.mutationRate) {
            this.mutate(child)
          }
          newRules.push(child)
          continue
        }
      }

      // 变异：基于非精英个体随机变异
      const parent = this.selectParent(nonElites) || this.selectParent(elites)
      if (parent) {
        const child = this.cloneRule(parent)
        if (Math.random() < this.config.mutationRate) {
          this.mutate(child)
        }
        newRules.push(child)
      } else {
        // 无可选父代，从精英复制
        break
      }
    }

    // 限制种群大小
    this.rules = newRules.slice(0, this.config.populationSize)
    this.lastEvolvedAt = Date.now()
    this.isColdStart = false

    log('INFO', 'gene_pool_evolved', {
      generation: this.generation,
      before,
      after: this.rules.length,
      elites: eliteCount,
    })
  }

  /**
   * 锦标赛选择：从候选列表中随机选取 3 个，返回适应度最高的
   */
  private selectParent(candidates: OrganizerRule[]): OrganizerRule | undefined {
    if (candidates.length === 0) return undefined
    const tournamentSize = Math.min(3, candidates.length)
    const selected: OrganizerRule[] = []
    for (let i = 0; i < tournamentSize; i++) {
      const idx = Math.floor(Math.random() * candidates.length)
      selected.push(candidates[idx])
    }
    return selected.reduce((best, cur) => (cur.fitness > best.fitness ? cur : best))
  }

  /**
   * 交叉：组合两个父代的规则
   * - 条件列表取并集（前一条来自父 A，后一条来自父 B）
   * - 动作随机选择
   */
  private crossover(parentA: OrganizerRule, parentB: OrganizerRule): OrganizerRule {
    const now = Date.now()
    const splitPoint = Math.floor(parentA.conditions.length / 2)
    const conditions: RuleCondition[] = [
      ...parentA.conditions.slice(0, splitPoint),
      ...parentB.conditions.slice(splitPoint),
    ]
    // 去重
    const uniqueConditions = this.dedupeConditions(conditions)

    const action: RuleAction = Math.random() < 0.5
      ? { ...parentA.action }
      : { ...parentB.action }

    return {
      id: `evolved:${now}:${Math.random().toString(36).slice(2, 8)}`,
      conditions: uniqueConditions,
      action,
      fitness: Math.round((parentA.fitness + parentB.fitness) / 2),
      feedbackCount: 0,
      positiveCount: 0,
      negativeCount: 0,
      applyCount: 0,
      generation: this.generation,
      createdAt: now,
      updatedAt: now,
      label: `交叉：${parentA.label || parentA.id} × ${parentB.label || parentB.id}`,
    }
  }

  /**
   * 变异：随机修改规则
   * - 50% 概率修改一个条件
   * - 30% 概率添加一个随机条件
   * - 20% 概率修改动作目标
   */
  private mutate(rule: OrganizerRule): void {
    const rand = Math.random()
    const extensions = ['.ts', '.tsx', '.js', '.json', '.md', '.css', '.scss', '.py', '.html', '.yaml', '.yml', '.toml']

    if (rand < 0.5 && rule.conditions.length > 0) {
      // 修改一个现有条件
      const idx = Math.floor(Math.random() * rule.conditions.length)
      const cond = rule.conditions[idx]
      if (cond.type === 'extension') {
        cond.value = [extensions[Math.floor(Math.random() * extensions.length)]]
      } else if (cond.type === 'depthRange') {
        cond.value = String(Math.floor(Math.random() * 3))
      }
    } else if (rand < 0.8) {
      // 添加一个随机条件
      const newCond: RuleCondition = {
        type: 'extension',
        operator: 'in',
        value: [extensions[Math.floor(Math.random() * extensions.length)]],
      }
      rule.conditions.push(newCond)
    } else {
      // 修改动作目标
      const dirs = ['src/', 'docs/', 'assets/', 'config/', 'scripts/', 'lib/', 'utils/', 'components/']
      rule.action.target = dirs[Math.floor(Math.random() * dirs.length)]
    }

    rule.updatedAt = Date.now()
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  /**
   * 检查规则的所有条件是否匹配文件特征
   */
  private matchesAllConditions(conditions: RuleCondition[], features: FileFeatures): boolean {
    for (const cond of conditions) {
      if (!this.matchesCondition(cond, features)) return false
    }
    return true
  }

  /**
   * 单条件匹配
   */
  private matchesCondition(cond: RuleCondition, f: FileFeatures): boolean {
    switch (cond.type) {
      case 'extension':
        return this.compareValue(f.extension, cond.operator, cond.value)

      case 'namePattern':
        return this.compareValue(f.name, cond.operator, cond.value)

      case 'sizeRange':
        return this.compareValue(f.sizeBytes, cond.operator, cond.value)

      case 'depthRange':
        return this.compareValue(f.depth, cond.operator, cond.value)

      case 'isTest':
        return this.compareValue(f.isTest ? 'true' : 'false', cond.operator, cond.value)

      case 'isConfig':
        return this.compareValue(f.isConfig ? 'true' : 'false', cond.operator, cond.value)

      default:
        return false
    }
  }

  /**
   * 通用值比较
   */
  private compareValue(actual: string | number, operator: ConditionOperator, expected: string | string[]): boolean {
    switch (operator) {
      case 'equals':
        return String(actual).toLowerCase() === String(expected).toLowerCase()

      case 'matches': {
        if (typeof expected === 'string') {
          try {
            return new RegExp(expected, 'i').test(String(actual))
          } catch {
            return false
          }
        }
        return false
      }

      case 'in': {
        const arr = Array.isArray(expected) ? expected : [expected]
        return arr.some((v) => String(actual).toLowerCase() === String(v).toLowerCase())
      }

      case 'gt':
        return Number(actual) > Number(expected)

      case 'lt':
        return Number(actual) < Number(expected)

      case 'between': {
        const arr = Array.isArray(expected) ? expected : String(expected).split(',')
        if (arr.length >= 2) {
          return Number(actual) >= Number(arr[0]) && Number(actual) <= Number(arr[1])
        }
        return false
      }

      default:
        return false
    }
  }

  /**
   * 展开目标模板中的占位符
   */
  expandTargetTemplate(template: string, features: FileFeatures): string {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return template
      .replace(/\{ext\}/g, features.extension.replace('.', ''))
      .replace(/\{stem\}/g, features.stem)
      .replace(/\{date\}/g, dateStr)
      .replace(/\/\//g, '/')
  }

  /**
   * 条件去重
   */
  private dedupeConditions(conditions: RuleCondition[]): RuleCondition[] {
    const seen = new Set<string>()
    return conditions.filter((c) => {
      const key = `${c.type}:${c.operator}:${JSON.stringify(c.value)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /**
   * 克隆规则（生成新 ID）
   */
  private cloneRule(rule: OrganizerRule): OrganizerRule {
    const now = Date.now()
    return {
      ...rule,
      id: `evolved:${now}:${Math.random().toString(36).slice(2, 8)}`,
      conditions: rule.conditions.map((c) => ({ ...c, value: Array.isArray(c.value) ? [...c.value] : c.value })),
      action: { ...rule.action },
      feedbackCount: 0,
      positiveCount: 0,
      negativeCount: 0,
      applyCount: 0,
      generation: this.generation,
      createdAt: now,
      updatedAt: now,
      label: `变异：${rule.label || rule.id}`,
    }
  }
}

/** 全局单例 */
export const genePool = new GenePool()
