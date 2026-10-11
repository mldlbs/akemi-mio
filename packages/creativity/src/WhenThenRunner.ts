/**
 * WhenThenRunner — 声明式 WHEN/THEN 受限 DSL 运行器（机制涌现 P2a，定案 D5/R5/A2）
 *
 * 候选执行不写任意代码：DSL 查表求值（阈值比较 + 字段存在性 + 枚举匹配，禁 JS eval）。
 * 步骤依赖执行 + 显式 named outputs（无隐式上下文注入）。
 * resourceBudget 编译为 CapabilityToken.constraints。
 * 求值器输入输出全白名单序列化（JSON number/boolean/string）。
 * 条件字符串长度上限，解析失败 = fail-closed（步骤跳过 + 记 guardrail 事件，不中断实验、不泄漏沙箱内部）。
 */

import type { CapabilityToken } from '@akemi-mio/capabilities'

// ══════════════════════════════════════════
// DSL 类型
// ══════════════════════════════════════════

/** 比较操作符（白名单，禁自由表达式） */
export type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'notExists'

/** WHEN 条件（查表求值，无 JS eval） */
export interface WhenCondition {
  /** 数据源路径（点分，如 `metrics.latency` 或 `capabilities.publishing.outcome`） */
  field: string
  op: CompareOp
  /** 比较值（number/boolean/string 白名单；in/nin 时为 string[]） */
  value?: number | boolean | string | string[]
}

/** THEN 动作 */
export interface ThenAction {
  /** 步骤 id（图内唯一） */
  id: string
  /** capability id（执行时 resolve） */
  capabilityId: string
  /** 显式 named inputs：来自上游 named outputs 或初始 context 的白名单路径 */
  inputs?: Record<string, string>
  /** 显式 named outputs：本步骤产出名（下游可引用） */
  outputs?: string[]
  /** 资源预算（编译为 CapabilityToken.constraints） */
  resourceBudget?: ResourceBudgetSpec
  /** 依赖的上游步骤 id（显式 DAG，无隐式顺序） */
  dependsOn?: string[]
  /** WHEN 条件为空则无条件执行；条件不满足 = 本步骤跳过 */
  when?: WhenCondition[]
}

/** 单步资源预算 */
export interface ResourceBudgetSpec {
  maxCalls?: number
  maxTokens?: number
  expiryMs?: number
  allowedValues?: Record<string, string[]>
}

/** 完整 WHEN/THEN 规则（一个候选实验的声明式执行计划） */
export interface WhenThenRule {
  id: string
  /** 假设 id（回溯） */
  hypothesisId?: string
  /** 规则描述 */
  description?: string
  /** 步骤列表（依赖 DAG） */
  steps: ThenAction[]
  /** 规则级资源预算（步骤级覆盖规则级） */
  resourceBudget?: ResourceBudgetSpec
}

// ══════════════════════════════════════════
// 求值器（白名单查表，禁 eval）
// ══════════════════════════════════════════

/** 条件字符串长度上限（防超长注入） */
export const MAX_CONDITION_FIELD_LEN = 128
export const MAX_CONDITION_STRING_VALUE_LEN = 512
export const MAX_CONDITION_LIST_LEN = 32

/** 白名单值：仅 JSON number | boolean | string | string[]（嵌套对象拒绝） */
type ScalarValue = number | boolean | string

function isScalar(v: unknown): v is ScalarValue {
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string'
}

/** 按点分路径从 context 取值；中间路径不存在返回 undefined。不深入数组索引（防原型链）。 */
export function lookupField(context: Record<string, unknown>, field: string): unknown {
  if (typeof field !== 'string' || field.length === 0 || field.length > MAX_CONDITION_FIELD_LEN) return undefined
  // 禁原型链：字段不得含 `__proto__` / `constructor` / `prototype`
  if (field.includes('__proto__') || field.includes('constructor') || field.includes('prototype')) return undefined
  const parts = field.split('.')
  let cur: unknown = context
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    const obj = cur as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(obj, p)) return undefined
    cur = obj[p]
  }
  return cur
}

/** 求值单个 WHEN 条件；解析失败（非法字段/值/操作符）返回 null（调用方 fail-closed）。 */
export function evaluateCondition(context: Record<string, unknown>, cond: WhenCondition): boolean | null {
  if (!cond || typeof cond !== 'object') return null
  const { field, op, value } = cond
  if (typeof field !== 'string' || field.length === 0 || field.length > MAX_CONDITION_FIELD_LEN) return null
  if (field.includes('__proto__') || field.includes('constructor') || field.includes('prototype')) return null

  const actual = lookupField(context, field)

  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'notExists':
      return actual === undefined || actual === null
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!isScalar(value)) return null
      if (!isScalar(actual)) return false
      switch (op) {
        case 'eq':
          return actual === value
        case 'neq':
          return actual !== value
        case 'gt':
          return typeof actual === 'number' && typeof value === 'number' && actual > value
        case 'gte':
          return typeof actual === 'number' && typeof value === 'number' && actual >= value
        case 'lt':
          return typeof actual === 'number' && typeof value === 'number' && actual < value
        case 'lte':
          return typeof actual === 'number' && typeof value === 'number' && actual <= value
        default:
          return null
      }
    }
    case 'in':
    case 'nin': {
      if (!Array.isArray(value) || value.length > MAX_CONDITION_LIST_LEN) return null
      if (!value.every((v) => typeof v === 'string' && v.length <= MAX_CONDITION_STRING_VALUE_LEN)) return null
      if (!isScalar(actual)) return false
      const hit = value.includes(actual as string)
      return op === 'in' ? hit : !hit
    }
    default:
      // 未知操作符 = 解析失败
      return null
  }
}

/** 求值全部 WHEN 条件（AND）；任一解析失败返回 null（fail-closed）。 */
export function evaluateWhen(context: Record<string, unknown>, when: WhenCondition[] | undefined): boolean | null {
  if (!when || when.length === 0) return true
  for (const c of when) {
    const r = evaluateCondition(context, c)
    if (r === null) return null
    if (r === false) return false
  }
  return true
}

// ══════════════════════════════════════════
// resourceBudget → CapabilityToken.constraints
// ══════════════════════════════════════════

/** 把 ResourceBudgetSpec 编译为 CapabilityToken.constraints（白名单字段）。 */
export function compileBudgetToConstraints(
  budget: ResourceBudgetSpec | undefined,
  ruleBudget?: ResourceBudgetSpec,
): CapabilityToken['constraints'] | undefined {
  // 步骤级覆盖规则级
  const b = budget ?? ruleBudget
  if (!b) return undefined
  const constraints: NonNullable<CapabilityToken['constraints']> = {}
  if (typeof b.maxCalls === 'number' && Number.isFinite(b.maxCalls) && b.maxCalls >= 0) {
    constraints.maxCalls = Math.floor(b.maxCalls)
  }
  if (typeof b.maxTokens === 'number' && Number.isFinite(b.maxTokens) && b.maxTokens >= 0) {
    constraints.maxTokens = Math.floor(b.maxTokens)
  }
  if (typeof b.expiryMs === 'number' && Number.isFinite(b.expiryMs) && b.expiryMs >= 0) {
    constraints.expiryMs = Math.floor(b.expiryMs)
  }
  if (b.allowedValues && typeof b.allowedValues === 'object' && !Array.isArray(b.allowedValues)) {
    const allowed: Record<string, string[]> = {}
    for (const [k, arr] of Object.entries(b.allowedValues)) {
      if (Array.isArray(arr) && arr.every((v) => typeof v === 'string' && v.length <= MAX_CONDITION_STRING_VALUE_LEN)) {
        if (arr.length <= MAX_CONDITION_LIST_LEN) allowed[k] = arr
      }
    }
    if (Object.keys(allowed).length > 0) constraints.allowedValues = allowed
  }
  return Object.keys(constraints).length > 0 ? constraints : undefined
}

// ══════════════════════════════════════════
// 步骤执行器（由调用方注入；无隐式沙箱）
// ══════════════════════════════════════════

/** 单步执行输入（全白名单序列化） */
export interface StepExecInput {
  stepId: string
  capabilityId: string
  /** 显式 named inputs（路径解析后的值） */
  inputs: Record<string, unknown>
  /** 编译后的 token constraints */
  constraints?: CapabilityToken['constraints']
}

/** 单步执行结果 */
export interface StepExecResult {
  success: boolean
  /** 显式 named outputs（本步骤产出） */
  outputs?: Record<string, unknown>
  error?: string
}

/** 步骤执行器接口（由 CreativityExecutor / CapabilityService 实现） */
export type StepExecutor = (input: StepExecInput) => Promise<StepExecResult>

/** 运行器事件（guardrail 事件 sink） */
export interface RunnerEvent {
  event_type: 'whenthen.step.skipped' | 'whenthen.step.failed' | 'whenthen.rule.complete' | 'whenthen.rule.failed'
  rule_id: string
  step_id?: string
  /** 公开原因（不泄漏沙箱内部） */
  reason?: string
  outcome?: string
  timestamp: number
}

export type RunnerEventSink = (ev: RunnerEvent) => void

// ══════════════════════════════════════════
// 依赖调度（DAG 拓扑 + named outputs）
// ══════════════════════════════════════════

/** 拓扑排序步骤；环路/未知依赖返回 null（fail-closed）。 */
export function topologicalOrder(steps: readonly ThenAction[]): ThenAction[] | null {
  const byId = new Map<string, ThenAction>()
  for (const s of steps) {
    if (!s || typeof s.id !== 'string' || s.id.length === 0) return null
    if (byId.has(s.id)) return null
    byId.set(s.id, s)
  }
  const indegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const s of steps) {
    indegree.set(s.id, 0)
  }
  for (const s of steps) {
    const deps = s.dependsOn ?? []
    for (const d of deps) {
      if (!byId.has(d)) return null // 未知依赖
      indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1)
      const list = children.get(d) ?? []
      list.push(s.id)
      children.set(d, list)
    }
  }
  const queue: string[] = []
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id)
  }
  queue.sort()
  const order: ThenAction[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(byId.get(id)!)
    for (const child of children.get(id) ?? []) {
      const nd = (indegree.get(child) ?? 1) - 1
      indegree.set(child, nd)
      if (nd === 0) queue.push(child)
    }
    queue.sort()
  }
  if (order.length !== steps.length) return null // 环
  return order
}

// ══════════════════════════════════════════
// 运行器主入口
// ══════════════════════════════════════════

export interface RunRuleResult {
  success: boolean
  /** 各步骤 named outputs 汇总（key = stepId.outputName 或 outputName） */
  namedOutputs: Record<string, unknown>
  /** 各步骤状态 */
  steps: Array<{
    id: string
    status: 'ok' | 'skipped' | 'failed' | 'blocked'
    reason?: string
    outputs?: Record<string, unknown>
  }>
  events: RunnerEvent[]
}

/**
 * 执行一条 WHEN/THEN 规则。
 *
 * - 按 DAG 拓扑顺序调度
 * - 每步先求值 WHEN（解析失败 → fail-closed skip + guardrail 事件）
 * - 输入从初始 context + 上游 named outputs 显式解析（无隐式注入）
 * - 预算编译为 CapabilityToken.constraints 传给 executor
 * - 任一步失败不中断实验：后续依赖步骤 blocked，独立步骤继续
 */
export async function runWhenThenRule(
  rule: WhenThenRule,
  context: Record<string, unknown>,
  executeStep: StepExecutor,
  options?: {
    /** 初始 named outputs（可选）；与 context 不同：context 只用于 WHEN 求值 */
    initialOutputs?: Record<string, unknown>
    onEvent?: RunnerEventSink
  },
): Promise<RunRuleResult> {
  const events: RunnerEvent[] = []
  const namedOutputs: Record<string, unknown> = { ...(options?.initialOutputs ?? {}) }
  const stepStatus = new Map<string, 'ok' | 'skipped' | 'failed' | 'blocked'>()
  const stepReason = new Map<string, string>()
  const stepOutputs = new Map<string, Record<string, unknown>>()
  const sink = (ev: RunnerEvent) => {
    events.push(ev)
    options?.onEvent?.(ev)
  }

  // 1. 拓扑排序（环/未知依赖 → 整规则 fail-closed）
  const order = topologicalOrder(rule.steps ?? [])
  if (!order) {
    sink({
      event_type: 'whenthen.rule.failed',
      rule_id: rule.id,
      reason: 'invalid_graph',
      outcome: 'failed',
      timestamp: Date.now(),
    })
    return { success: false, namedOutputs, steps: [], events }
  }

  // 2. 逐步骤
  for (const step of order) {
    const deps = step.dependsOn ?? []
    const depBlocked = deps.some((d) => {
      const st = stepStatus.get(d)
      return st === 'failed' || st === 'blocked' || st === 'skipped'
    })
    if (depBlocked) {
      stepStatus.set(step.id, 'blocked')
      stepReason.set(step.id, 'upstream_blocked')
      sink({
        event_type: 'whenthen.step.skipped',
        rule_id: rule.id,
        step_id: step.id,
        reason: 'upstream_blocked',
        outcome: 'skipped',
        timestamp: Date.now(),
      })
      continue
    }

    // 3. WHEN 求值（fail-closed）
    const whenOk = evaluateWhen(context, step.when)
    if (whenOk === null) {
      stepStatus.set(step.id, 'skipped')
      stepReason.set(step.id, 'when_parse_failed')
      sink({
        event_type: 'whenthen.step.skipped',
        rule_id: rule.id,
        step_id: step.id,
        reason: 'when_parse_failed',
        outcome: 'skipped',
        timestamp: Date.now(),
      })
      continue
    }
    if (whenOk === false) {
      stepStatus.set(step.id, 'skipped')
      stepReason.set(step.id, 'when_not_satisfied')
      sink({
        event_type: 'whenthen.step.skipped',
        rule_id: rule.id,
        step_id: step.id,
        reason: 'when_not_satisfied',
        outcome: 'skipped',
        timestamp: Date.now(),
      })
      continue
    }

    // 4. 显式 named inputs 解析（路径 = 初始 context 或 namedOutputs）
    const inputs: Record<string, unknown> = {}
    if (step.inputs) {
      for (const [name, path] of Object.entries(step.inputs)) {
        if (typeof path !== 'string' || path.length === 0 || path.length > MAX_CONDITION_FIELD_LEN) continue
        if (path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')) continue
        const v = lookupField(namedOutputs, path) ?? lookupField(context, path)
        if (v !== undefined) inputs[name] = v
      }
    }

    // 5. 预算编译
    const constraints = compileBudgetToConstraints(step.resourceBudget, rule.resourceBudget)

    // 6. 执行
    try {
      const result = await executeStep({
        stepId: step.id,
        capabilityId: step.capabilityId,
        inputs,
        constraints,
      })
      if (result.success) {
        stepStatus.set(step.id, 'ok')
        const outs = result.outputs ?? {}
        stepOutputs.set(step.id, outs)
        for (const [k, v] of Object.entries(outs)) {
          namedOutputs[k] = v
          namedOutputs[`${step.id}.${k}`] = v
        }
      } else {
        stepStatus.set(step.id, 'failed')
        stepReason.set(step.id, result.error ?? 'step_failed')
        sink({
          event_type: 'whenthen.step.failed',
          rule_id: rule.id,
          step_id: step.id,
          reason: result.error ?? 'step_failed',
          outcome: 'failed',
          timestamp: Date.now(),
        })
      }
    } catch {
      stepStatus.set(step.id, 'failed')
      stepReason.set(step.id, 'step_exception')
      sink({
        event_type: 'whenthen.step.failed',
        rule_id: rule.id,
        step_id: step.id,
        reason: 'step_exception',
        outcome: 'failed',
        timestamp: Date.now(),
      })
    }
  }

  const allOk = order.every((s) => stepStatus.get(s.id) === 'ok' || stepStatus.get(s.id) === 'skipped')
  sink({
    event_type: allOk ? 'whenthen.rule.complete' : 'whenthen.rule.failed',
    rule_id: rule.id,
    reason: allOk ? 'complete' : 'partial_failure',
    outcome: allOk ? 'success' : 'partial',
    timestamp: Date.now(),
  })

  return {
    success: allOk,
    namedOutputs,
    steps: order.map((s) => ({
      id: s.id,
      status: stepStatus.get(s.id) ?? 'blocked',
      reason: stepReason.get(s.id),
      outputs: stepOutputs.get(s.id),
    })),
    events,
  }
}
