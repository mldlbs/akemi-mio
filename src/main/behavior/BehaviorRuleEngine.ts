/**
 * BehaviorRuleEngine — 行为驱动自适应的 JSON 规则引擎
 *
 * 核心职责：
 * 1. 从外部 JSON 文件加载规则表
 * 2. 接收 BehaviorProfile，评估每条规则的条件
 * 3. 返回满足条件的规则所对应的动作决策列表
 *
 * 规则表设计为可被强化学习离线优化：
 * - 每条规则有 optimizable 标记 + rl_weight
 * - 条件中的阈值可在 RL 优化后通过 updateRule() 修改
 * - 动作优先级可在 RL 优化后调整
 *
 * 冷启动：无数据时默认规则（cold_start_default）自动生效。
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import type { BehaviorProfile } from './BehaviorProfile'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../config'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 条件操作符 */
export type ConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in' | 'not_in'

/** 单条原子条件 */
export interface AtomicCondition {
  /** 条件字段名（BehaviorProfile 的 key 或自定义标记） */
  field: string
  /** 操作符 */
  op: ConditionOp
  /** 比较值 */
  value: number | string | boolean | (number | string)[]
}

/** 条件组 — 支持 all（且）和 any（或） */
export interface ConditionGroup {
  /** 所有条件必须同时满足 */
  all?: AtomicCondition[]
  /** 任一条件满足即可 */
  any?: AtomicCondition[]
  /** 自定义条件名称（引擎内部实现的特殊检查） */
  custom?: string
}

/** 规则动作 */
export interface RuleAction {
  /** 动作类型 */
  type: string
  /** 动作值 */
  value: boolean | number | string
  /** 优先级：数字越大越优先 */
  priority: number
}

/** 规则元数据 */
export interface RuleMetadata {
  /** 是否可被 RL 优化 */
  optimizable: boolean
  /** RL 权重 */
  rl_weight?: number
  /** 预期影响描述 */
  expected_impact?: string
}

/** 单条规则定义 */
export interface RuleDefinition {
  /** 规则唯一 ID */
  id: string
  /** 人类可读描述 */
  description: string
  /** 规则分类 */
  category: string
  /** 触发条件 */
  conditions: ConditionGroup
  /** 满足条件时执行的动作列表 */
  actions: RuleAction[]
  /** 元数据 */
  metadata: RuleMetadata
}

/** 规则表 */
export interface RuleTable {
  /** Schema 版本 */
  version: number
  /** 描述 */
  description: string
  /** 更新时间戳 */
  updatedAt: number
  /** 规则列表 */
  rules: RuleDefinition[]
}

/** 规则引擎评估结果 — 按动作类型聚合的决策 */
export interface RuleDecision {
  /** 规则 ID（触发该动作的规则） */
  ruleId: string
  /** 规则分类 */
  category: string
  /** 动作类型 */
  actionType: string
  /** 动作值 */
  value: boolean | number | string
  /** 优先级 */
  priority: number
  /** 规则描述 */
  description: string
  /** 是否可优化 */
  optimizable: boolean
}

/** 规则引擎的整体评估结果 */
export interface RuleEngineResult {
  /** 所有触发的决策，按优先级降序排列 */
  decisions: RuleDecision[]
  /** 按动作类型聚合的决策映射 */
  decisionsByType: Record<string, RuleDecision[]>
  /** 当前生效的详细度等级 */
  detailLevel: 'high' | 'normal' | 'low'
  /** 是否启用自动工具触发 */
  autoToolTrigger: boolean
  /** 是否建议最常用工具 */
  suggestTopTool: boolean
  /** 是否启用话题上下文 */
  topicContextEnabled: boolean
  /** 是否优先使用工具而非直接回答 */
  preferTool: boolean
  /** 是否缩短回复周期 */
  shortenReplyCycle: boolean
  /** 匹配的规则数量 */
  matchedRuleCount: number
  /** 评估时间戳 */
  evaluatedAt: number
}

// ══════════════════════════════════════════
// 默认规则表文件路径
// ══════════════════════════════════════════

/** 内置默认规则表 */
const DEFAULT_RULES: RuleTable = {
  version: 1,
  description: 'Akemi Mio 行为驱动自适应默认规则表',
  updatedAt: Date.now(),
  rules: [
    {
      id: 'cold_start_default',
      description: '冷启动默认策略：交互<3次时保守模式',
      category: 'cold_start',
      conditions: { all: [{ field: 'hasSufficientData', op: 'eq', value: false }] },
      actions: [
        { type: 'set_detail_level', value: 'normal', priority: 100 },
        { type: 'enable_auto_tool_trigger', value: false, priority: 100 },
      ],
      metadata: { optimizable: false, expected_impact: '冷启动默认' },
    },
    {
      id: 'detail_level_by_length_and_frequency',
      description: '平均消息长度>50字且交互>10次→回复详细度设为高',
      category: 'reply_detail',
      conditions: {
        all: [
          { field: 'avgMessageLength', op: 'gt', value: 50 },
          { field: 'totalInteractions', op: 'gt', value: 10 },
        ],
      },
      actions: [{ type: 'set_detail_level', value: 'high', priority: 80 }],
      metadata: { optimizable: true, rl_weight: 1.0, expected_impact: '减少冗余解释' },
    },
    {
      id: 'detail_level_concise_by_short_msgs',
      description: '平均消息长度<20字且交互>5次→回复详细度设为低',
      category: 'reply_detail',
      conditions: {
        all: [
          { field: 'avgMessageLength', op: 'lt', value: 20 },
          { field: 'totalInteractions', op: 'gt', value: 5 },
        ],
      },
      actions: [{ type: 'set_detail_level', value: 'low', priority: 70 }],
      metadata: { optimizable: true, rl_weight: 0.9, expected_impact: '用户短消息习惯' },
    },
    {
      id: 'auto_tool_by_usage_rate',
      description: '工具使用率>30%→启用自动工具触发模式',
      category: 'tool_behavior',
      conditions: { all: [{ field: 'toolUsageRatio', op: 'gt', value: 0.3 }] },
      actions: [{ type: 'enable_auto_tool_trigger', value: true, priority: 90 }],
      metadata: { optimizable: true, rl_weight: 1.2, expected_impact: '主动工具调用' },
    },
    {
      id: 'high_tool_success_prefer_tools',
      description: '工具成功率>0.9且工具使用率>0.2→优先使用工具',
      category: 'tool_behavior',
      conditions: {
        all: [
          { field: 'toolSuccessRate', op: 'gt', value: 0.9 },
          { field: 'toolUsageRatio', op: 'gt', value: 0.2 },
        ],
      },
      actions: [{ type: 'prefer_tool_over_direct', value: true, priority: 70 }],
      metadata: { optimizable: true, rl_weight: 0.9, expected_impact: '可靠工具优先' },
    },
    {
      id: 'topic_focused_reply',
      description: '活跃话题>2个且置信度>0.5→启用话题上下文',
      category: 'reply_content',
      conditions: {
        all: [
          { field: 'activeTopicsCount', op: 'gt', value: 2 },
          { field: 'sceneConfidence', op: 'gt', value: 0.5 },
        ],
      },
      actions: [{ type: 'enable_topic_context', value: true, priority: 50 }],
      metadata: { optimizable: true, rl_weight: 0.7, expected_impact: '话题贴合' },
    },
    {
      id: 'scene_based_response_mode',
      description: '场景置信度>0.5且场景有效→应用场景模式',
      category: 'response_mode',
      conditions: {
        all: [
          { field: 'sceneConfidence', op: 'gt', value: 0.5 },
          { field: 'scene', op: 'in', value: ['code_debugging', 'quick_qa', 'deep_discussion', 'creative_writing', 'system_evolution', 'task_execution'] },
        ],
      },
      actions: [{ type: 'apply_scene_mode', value: true, priority: 85 }],
      metadata: { optimizable: true, rl_weight: 0.8, expected_impact: '场景驱动风格' },
    },
  ],
}

/** 默认规则表外部 JSON 文件路径 */
const RULES_FILE = join(WORKSPACE.cache, 'behavior-rules.json')

// ══════════════════════════════════════════
// BehaviorRuleEngine
// ══════════════════════════════════════════

export class BehaviorRuleEngine {
  /** 当前加载的规则表 */
  private ruleTable: RuleTable

  constructor() {
    this.ruleTable = this._loadRules()
  }

  // ── 规则加载 ──

  /**
   * 从外部 JSON 文件加载规则表。
   * 文件不存在时回退到内置默认规则。
   */
  private _loadRules(): RuleTable {
    try {
      if (existsSync(RULES_FILE)) {
        const raw = readFileSync(RULES_FILE, 'utf-8')
        const parsed = JSON.parse(raw)
        const table = parsed as RuleTable
        if (Array.isArray(table.rules) && table.version > 0) {
          log('INFO', 'behavior_rules_loaded_from_file', {
            path: RULES_FILE,
            version: table.version,
            rulesCount: table.rules.length,
          })
          return table
        }
        log('WARN', 'behavior_rules_file_invalid_format', { path: RULES_FILE })
      }
    } catch (err) {
      log('WARN', 'behavior_rules_load_failed', {
        error: String(err),
        path: RULES_FILE,
      })
    }
    log('INFO', 'behavior_rules_using_defaults', {
      rulesCount: DEFAULT_RULES.rules.length,
    })
    return JSON.parse(JSON.stringify(DEFAULT_RULES))
  }

  /**
   * 重新加载规则表（外部文件更新后调用）。
   * 若外部文件不存在，使用内置默认规则。
   */
  reloadRules(): void {
    this.ruleTable = this._loadRules()
  }

  /**
   * 用新的规则表替换当前规则（供 RL 优化使用）。
   * 调用者负责持久化到 RULES_FILE。
   */
  updateRuleTable(table: RuleTable): void {
    this.ruleTable = JSON.parse(JSON.stringify(table))
    log('INFO', 'behavior_rules_table_updated', {
      version: table.version,
      rulesCount: table.rules.length,
    })
  }

  /** 获取当前规则表的副本 */
  getRuleTable(): RuleTable {
    return JSON.parse(JSON.stringify(this.ruleTable))
  }

  // ── 规则评估 ──

  /**
   * 评估所有规则，返回满足条件的规则对应的动作决策。
   *
   * @param profile 当前用户画像
   * @returns RuleEngineResult 所有触发的决策
   */
  evaluate(profile: BehaviorProfile): RuleEngineResult {
    const decisions: RuleDecision[] = []

    for (const rule of this.ruleTable.rules) {
      if (this._evaluateConditions(rule.conditions, profile)) {
        for (const action of rule.actions) {
          decisions.push({
            ruleId: rule.id,
            category: rule.category,
            actionType: action.type,
            value: action.value,
            priority: action.priority,
            description: rule.description,
            optimizable: rule.metadata?.optimizable ?? false,
          })
        }
      }
    }

    // 按优先级降序排列
    decisions.sort((a, b) => b.priority - a.priority)

    // 聚合决策结果
    const decisionsByType = this._groupByType(decisions)
    const result = this._buildResult(decisions, decisionsByType)

    if (decisions.length > 0) {
      log('INFO', 'behavior_rules_evaluated', {
        matchedRules: decisions.length,
        uniqueDecisions: Object.keys(decisionsByType).length,
        detailLevel: result.detailLevel,
        autoTool: result.autoToolTrigger,
        topicContext: result.topicContextEnabled,
        preferTool: result.preferTool,
      })
    }

    return result
  }

  /** 解构结果：按动作类型聚合 + 构建最终决策 */
  private _groupByType(decisions: RuleDecision[]): Record<string, RuleDecision[]> {
    const grouped: Record<string, RuleDecision[]> = {}
    for (const d of decisions) {
      if (!grouped[d.actionType]) grouped[d.actionType] = []
      grouped[d.actionType].push(d)
    }
    return grouped
  }

  private _buildResult(
    decisions: RuleDecision[],
    byType: Record<string, RuleDecision[]>,
  ): RuleEngineResult {
    // 取优先级最高的 detail_level
    const detailDecisions = byType['set_detail_level'] ?? []
    const detailLevel = detailDecisions.length > 0
      ? (detailDecisions.sort((a, b) => b.priority - a.priority)[0].value as 'high' | 'normal' | 'low')
      : 'normal'

    // 取优先级最高的 auto_tool_trigger
    const toolDecisions = byType['enable_auto_tool_trigger'] ?? []
    const autoToolTrigger = toolDecisions.length > 0
      ? toolDecisions.sort((a, b) => b.priority - a.priority)[0].value === true
      : true // 默认启用

    // 其他布尔开关
    const suggestTopTool = this._resolveBoolean(byType['suggest_top_tool'])
    const topicContextEnabled = this._resolveBoolean(byType['enable_topic_context'])
    const preferTool = this._resolveBoolean(byType['prefer_tool_over_direct'])
    const shortenReplyCycle = this._resolveBoolean(byType['shorten_reply_cycle'])

    return {
      decisions,
      decisionsByType: byType,
      detailLevel,
      autoToolTrigger,
      suggestTopTool,
      topicContextEnabled,
      preferTool,
      shortenReplyCycle,
      matchedRuleCount: decisions.length,
      evaluatedAt: Date.now(),
    }
  }

  /** 解析布尔型动作：优先级最高的 true/false */
  private _resolveBoolean(actions: RuleDecision[] | undefined): boolean {
    if (!actions || actions.length === 0) return false
    const sorted = actions.sort((a, b) => b.priority - a.priority)
    return sorted[0].value === true
  }

  // ── 条件引擎 ──

  /**
   * 评估单条规则的条件组是否满足。
   */
  private _evaluateConditions(
    conditions: ConditionGroup,
    profile: BehaviorProfile,
  ): boolean {
    // 评估 all 组（与条件）
    if (conditions.all && conditions.all.length > 0) {
      for (const cond of conditions.all) {
        if (!this._evaluateAtomic(cond, profile)) return false
      }
    }

    // 评估 any 组（或条件）
    if (conditions.any && conditions.any.length > 0) {
      let anyMatched = false
      for (const cond of conditions.any) {
        if (this._evaluateAtomic(cond, profile)) {
          anyMatched = true
          break
        }
      }
      if (!anyMatched) return false
    }

    // 评估自定义条件
    if (conditions.custom) {
      return this._evaluateCustom(conditions.custom, profile)
    }

    return true
  }

  /**
   * 评估单条原子条件。
   * field 是 BehaviorProfile 的 key。
   */
  private _evaluateAtomic(
    cond: AtomicCondition,
    profile: BehaviorProfile,
  ): boolean {
    const value = this._getProfileField(cond.field, profile)
    return this._compare(value, cond.op, cond.value)
  }

  /**
   * 从 BehaviorProfile 中获取字段值（支持嵌套路径和计算字段）。
   */
  private _getProfileField(
    field: string,
    profile: BehaviorProfile,
  ): any {
    switch (field) {
      case 'activeTopicsCount':
        return profile.activeTopics.length
      case 'topToolIdsCount':
        return profile.topToolIds.length
      case 'topToolDominance': {
        // 计算 top1 工具占比：最高频工具调用数 / 总工具调用数
        const counts = Object.values(profile.toolCallCounts)
        if (counts.length === 0) return 0
        const total = counts.reduce((s, c) => s + c, 0)
        const max = Math.max(...counts)
        return total > 0 ? max / total : 0
      }
      default:
        return (profile as any)[field]
    }
  }

  /** 执行比较操作 */
  private _compare(
    actual: any,
    op: ConditionOp,
    expected: any,
  ): boolean {
    switch (op) {
      case 'gt':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected
      case 'gte':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
      case 'lt':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected
      case 'lte':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
      case 'eq':
        return actual === expected
      case 'neq':
        return actual !== expected
      case 'in':
        return Array.isArray(expected) && expected.includes(actual)
      case 'not_in':
        return Array.isArray(expected) && !expected.includes(actual)
      default:
        return false
    }
  }

  /**
   * 评估自定义条件。
   * 在此添加需要特殊逻辑的判断。
   */
  private _evaluateCustom(
    customName: string,
    profile: BehaviorProfile,
  ): boolean {
    switch (customName) {
      case 'topToolDominance':
        return this._checkTopToolDominance(profile)
      case 'repeatedPatternDetected':
        return this._repeatedPatternDetected
      default:
        log('WARN', 'behavior_rules_unknown_custom_condition', { customName })
        return false
    }
  }

  /**
   * topToolDominance: top1 工具调用数占总调用数比例 > 50%
   */
  private _checkTopToolDominance(profile: BehaviorProfile): boolean {
    const counts = Object.values(profile.toolCallCounts)
    if (counts.length === 0) return false
    const total = counts.reduce((s, c) => s + c, 0)
    const max = Math.max(...counts)
    if (total === 0) return false
    return max / total > 0.5
  }

  // ── 外部设置：运行时标记（用于自定义条件） ──

  /** 运行时标记：是否检测到重复提问模式（供 repeatedPatternDetected 使用） */
  private _repeatedPatternDetected = false

  /** 设置重复模式检测标记 */
  setRepeatedPatternDetected(detected: boolean): void {
    this._repeatedPatternDetected = detected
  }

  // 重写 _evaluateCustom 中 repeatedPatternDetected 分支
  // 已在 _evaluateCustom 中实现，返回 this._repeatedPatternDetected
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

/** 全局单例，供 ChatExecutor 和调试接口共享 */
export const behaviorRuleEngine = new BehaviorRuleEngine()
