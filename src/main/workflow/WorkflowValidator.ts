/**
 * WorkflowValidator — 工作流定义质量验证器
 *
 * 在创建工作流或启动前校验，防止 AI 生成有缺陷的工作流。
 * 检查项：循环依赖、step 引用完整性、必填字段、不可达步骤。
 */
import type { WorkflowDef, WorkflowStepDef } from './types'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  stepId?: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

export function validateWorkflow(def: WorkflowDef): ValidationResult {
  const issues: ValidationIssue[] = []

  // 1. 基本结构
  if (!def.id) issues.push({ severity: 'error', message: '工作流缺少 id' })
  if (!def.name) issues.push({ severity: 'error', message: '工作流缺少 name' })
  if (!def.steps || def.steps.length === 0) {
    issues.push({ severity: 'error', message: '工作流没有步骤' })
    return { valid: false, issues }
  }

  // 2. 唯一 step ID
  const allIds = new Map<string, number>()
  for (let i = 0; i < def.steps.length; i++) {
    const sid = def.steps[i].id
    if (allIds.has(sid)) {
      issues.push({ severity: 'error', stepId: sid, message: `步骤 ID "${sid}" 重复（第 ${allIds.get(sid)! + 1} 行和第 ${i + 1} 行）` })
    }
    allIds.set(sid, i)
  }

  // 3. 检查 dependsOn / goto / sources 引用
  for (const step of def.steps) {
    for (const dep of step.dependsOn) {
      if (!allIds.has(dep)) {
        issues.push({ severity: 'error', stepId: step.id, message: `dependsOn 引用了不存在的步骤 "${dep}"` })
      }
    }

    const cond = step.config?.condition
    if (cond) {
      if (cond.cases) {
        for (const c of cond.cases) {
          if (c.goto && !allIds.has(c.goto)) {
            issues.push({ severity: 'error', stepId: step.id, message: `条件分支 goto="${c.goto}" 引用了不存在的步骤` })
          }
        }
      }
      if (cond.defaultGoto && !allIds.has(cond.defaultGoto)) {
        issues.push({ severity: 'error', stepId: step.id, message: `defaultGoto="${cond.defaultGoto}" 引用了不存在的步骤` })
      }
    }

    const agg = step.config?.aggregate
    if (agg?.sources) {
      for (const src of agg.sources) {
        if (!allIds.has(src)) {
          issues.push({ severity: 'error', stepId: step.id, message: `aggregate.sources 引用了不存在的步骤 "${src}"` })
        }
      }
    }
  }

  // 4. 循环依赖检测 (DFS)
  const cycleResult = detectCycle(def.steps)
  if (cycleResult.hasCycle) {
    issues.push({ severity: 'error', message: `检测到循环依赖: ${cycleResult.path?.join(' → ')}` })
  }

  // 5. Handler 必填字段
  for (const step of def.steps) {
    issues.push(...validateHandlerConfig(step))
  }

  // 6. 模板引用检查
  for (const step of def.steps) {
    issues.push(...validateTemplateRefs(step, allIds))
  }

  // 7. runOn: 'failure' 合理性
  for (const step of def.steps) {
    if (step.runOn === 'failure' && (!step.dependsOn || step.dependsOn.length === 0)) {
      issues.push({ severity: 'warning', stepId: step.id, message: 'runOn=failure 但没有 dependsOn，永远无法触发' })
    }
  }

  // 8. 不可达步骤检测
  const unreachable = findUnreachable(def.steps)
  for (const sid of unreachable) {
    issues.push({ severity: 'warning', stepId: sid, message: '该步骤可能无法到达（没有路径从入口指向它）' })
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  }
}

// ── 循环依赖检测 ──

interface CycleResult {
  hasCycle: boolean
  path?: string[]
}

function detectCycle(steps: WorkflowStepDef[]): CycleResult {
  const idToIdx = new Map<string, number>()
  steps.forEach((s, i) => idToIdx.set(s.id, i))

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Array(steps.length).fill(WHITE)
  const parent = new Array(steps.length).fill(-1)

  function dfs(u: number): boolean {
    color[u] = GRAY
    for (const dep of steps[u].dependsOn) {
      const v = idToIdx.get(dep)
      if (v === undefined) continue
      if (color[v] === GRAY) {
        const path = [steps[u].id, steps[v].id]
        let cur = u
        while (cur !== v && parent[cur] !== -1) {
          cur = parent[cur]
          path.push(steps[cur].id)
        }
        path.reverse()
        return true
      }
      if (color[v] === WHITE) {
        parent[v] = u
        if (dfs(v)) return true
      }
    }
    color[u] = BLACK
    return false
  }

  for (let i = 0; i < steps.length; i++) {
    if (color[i] === WHITE) {
      if (dfs(i)) return { hasCycle: true }
    }
  }

  return { hasCycle: false }
}

// ── Handler 必填字段校验 ──

function validateHandlerConfig(step: WorkflowStepDef): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = step.config || {}

  switch (step.handler) {
    case 'subagent':
    case 'prompt':
      if (!cfg.prompt) issues.push({ severity: 'error', stepId: step.id, message: `handler=${step.handler} 缺少 config.prompt` })
      break

    case 'tool':
      if (!cfg.tool) issues.push({ severity: 'error', stepId: step.id, message: 'handler=tool 缺少 config.tool（工具名）' })
      break

    case 'api':
      if (!cfg.apiUrl) issues.push({ severity: 'error', stepId: step.id, message: 'handler=api 缺少 config.apiUrl' })
      if (!cfg.apiMethod) issues.push({ severity: 'warning', stepId: step.id, message: 'handler=api 未指定 apiMethod，默认 GET' })
      break

    case 'plan':
      if (!cfg.planPrompt) issues.push({ severity: 'error', stepId: step.id, message: 'handler=plan 缺少 config.planPrompt' })
      break

    case 'condition': {
      if (!cfg.condition) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=condition 缺少 config.condition' })
        break
      }
      if (!cfg.condition.source) issues.push({ severity: 'error', stepId: step.id, message: 'condition 缺少 source（条件判断来源）' })
      if (!cfg.condition.cases || cfg.condition.cases.length === 0)
        issues.push({ severity: 'error', stepId: step.id, message: 'condition 缺少 cases（条件分支列表）' })
      break
    }

    case 'gate':
      if (!cfg.gate) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=gate 缺少 config.gate' })
        break
      }
      if (!cfg.gate.message) issues.push({ severity: 'error', stepId: step.id, message: 'gate 缺少 message（审批消息）' })
      if (!cfg.gate.preview) issues.push({ severity: 'warning', stepId: step.id, message: 'gate 缺少 preview（无法展示预览内容）' })
      break

    case 'foreach':
      if (!cfg.foreach) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=foreach 缺少 config.foreach' })
        break
      }
      if (!cfg.foreach.items) issues.push({ severity: 'error', stepId: step.id, message: 'foreach 缺少 items（要遍历的数组变量）' })
      break

    case 'transform':
      if (!cfg.transform) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=transform 缺少 config.transform' })
        break
      }
      if (!cfg.transform.mapping || Object.keys(cfg.transform.mapping).length === 0)
        issues.push({ severity: 'warning', stepId: step.id, message: 'transform 没有 mapping（输出映射为空）' })
      break

    case 'aggregate':
      if (!cfg.aggregate) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=aggregate 缺少 config.aggregate' })
        break
      }
      if (!cfg.aggregate.sources || cfg.aggregate.sources.length === 0)
        issues.push({ severity: 'error', stepId: step.id, message: 'aggregate 缺少 sources（要聚合的步骤列表）' })
      if (!cfg.aggregate.strategy) issues.push({ severity: 'warning', stepId: step.id, message: 'aggregate 未指定 strategy，默认 merge' })
      break

    case 'subflow':
      if (!cfg.subflow) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=subflow 缺少 config.subflow' })
        break
      }
      if (!cfg.subflow.workflowId && !cfg.subflow.inlineSteps)
        issues.push({ severity: 'error', stepId: step.id, message: 'subflow 需要 workflowId 或 inlineSteps' })
      break

    case 'wait':
      if (!cfg.wait) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=wait 缺少 config.wait' })
        break
      }
      if (!cfg.wait.durationMs && !cfg.wait.waitForStep && !cfg.wait.waitUntil)
        issues.push({ severity: 'error', stepId: step.id, message: 'wait 需要 durationMs 或 waitForStep 或 waitUntil' })
      break

    case 'script':
      if (!cfg.script) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=script 缺少 config.script' })
        break
      }
      if (!cfg.script.code) issues.push({ severity: 'error', stepId: step.id, message: 'script 缺少 code（要执行的 JS 代码）' })
      break

    case 'event':
      if (!cfg.event) {
        issues.push({ severity: 'error', stepId: step.id, message: 'handler=event 缺少 config.event' })
        break
      }
      if (!cfg.event.eventName) issues.push({ severity: 'error', stepId: step.id, message: 'event 缺少 eventName（事件名称）' })
      break
  }

  return issues
}

// ── 模板引用检查 ──

const TEMPLATE_RE = /\{\{steps\.([^.]+)\./g

function validateTemplateRefs(step: WorkflowStepDef, allIds: Map<string, number>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = step.config || {}

  const checkString = (label: string, val: string | undefined) => {
    if (!val) return
    const matches = val.matchAll(TEMPLATE_RE)
    for (const m of matches) {
      const refId = m[1]
      if (!allIds.has(refId)) {
        issues.push({ severity: 'error', stepId: step.id, message: `"${label}" 引用了不存在的步骤 "${refId}"（{{steps.${refId}...}}）` })
      }
    }
  }

  checkString('prompt', cfg.prompt)
  checkString('planPrompt', cfg.planPrompt)
  checkString('condition.source', cfg.condition?.source)
  checkString('gate.preview', cfg.gate?.preview)
  checkString('gate.message', cfg.gate?.message)
  checkString('transform.input', cfg.transform?.input)
  checkString('event.payload', cfg.event?.payload)

  if (cfg.foreach?.items) {
    const pureMatch = cfg.foreach.items.match(/^\{\{steps\.([^.]+)/)
    if (pureMatch && !allIds.has(pureMatch[1])) {
      issues.push({ severity: 'error', stepId: step.id, message: `foreach.items 引用了不存在的步骤 "${pureMatch[1]}"` })
    }
  }

  return issues
}

// ── 不可达步骤检测 ──

function findUnreachable(steps: WorkflowStepDef[]): string[] {
  const idToIdx = new Map<string, number>()
  steps.forEach((s, i) => idToIdx.set(s.id, i))

  const reachable = new Set<string>()
  const queue: string[] = []

  for (const s of steps) {
    if (!s.dependsOn || s.dependsOn.length === 0) {
      reachable.add(s.id)
      queue.push(s.id)
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!
    const idx = idToIdx.get(cur)
    if (idx === undefined) continue

    for (const s of steps) {
      if (reachable.has(s.id)) continue
      if (s.dependsOn && s.dependsOn.includes(cur)) {
        reachable.add(s.id)
        queue.push(s.id)
      }
    }

    const cond = steps[idx].config?.condition
    if (cond) {
      const gotoTargets = [...(cond.cases?.map((c) => c.goto) || []), cond.defaultGoto].filter(Boolean) as string[]
      for (const gt of gotoTargets) {
        if (!reachable.has(gt)) {
          reachable.add(gt)
          queue.push(gt)
        }
      }
    }
  }

  return steps.filter((s) => !reachable.has(s.id)).map((s) => s.id)
}
