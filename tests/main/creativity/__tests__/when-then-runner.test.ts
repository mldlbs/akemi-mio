import { describe, it, expect } from 'vitest'
import {
  evaluateCondition,
  evaluateWhen,
  lookupField,
  compileBudgetToConstraints,
  topologicalOrder,
  runWhenThenRule,
  MAX_CONDITION_FIELD_LEN,
} from '@akemi-mio/creativity/WhenThenRunner'
import type { WhenThenRule, ThenAction, StepExecutor } from '@akemi-mio/creativity/WhenThenRunner'

describe('WhenThenRunner — 条件求值器', () => {
  const ctx = {
    metrics: { latency: 120, errorRate: 0.02 },
    capabilities: { publishing: { outcome: 'success' } },
    flag: true,
    count: 5,
    name: 'test',
  }

  it('eq / neq', () => {
    expect(evaluateCondition(ctx, { field: 'count', op: 'eq', value: 5 })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'count', op: 'neq', value: 5 })).toBe(false)
    expect(evaluateCondition(ctx, { field: 'capabilities.publishing.outcome', op: 'eq', value: 'success' })).toBe(true)
  })

  it('gt / gte / lt / lte', () => {
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'gt', value: 100 })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'gt', value: 120 })).toBe(false)
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'gte', value: 120 })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'lt', value: 200 })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'lte', value: 120 })).toBe(true)
  })

  it('exists / notExists', () => {
    expect(evaluateCondition(ctx, { field: 'metrics.latency', op: 'exists' })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'missing.path', op: 'exists' })).toBe(false)
    expect(evaluateCondition(ctx, { field: 'missing.path', op: 'notExists' })).toBe(true)
  })

  it('in / nin', () => {
    expect(evaluateCondition(ctx, { field: 'capabilities.publishing.outcome', op: 'in', value: ['success', 'partial'] })).toBe(true)
    expect(evaluateCondition(ctx, { field: 'capabilities.publishing.outcome', op: 'nin', value: ['success'] })).toBe(false)
  })

  it('unknown op returns null (fail-closed)', () => {
    expect(evaluateCondition(ctx, { field: 'count', op: 'foo' as any, value: 1 })).toBeNull()
  })

  it('non-scalar value returns null', () => {
    expect(evaluateCondition(ctx, { field: 'count', op: 'eq', value: { a: 1 } as any })).toBeNull()
  })

  it('prototype pollution path returns null', () => {
    expect(evaluateCondition(ctx, { field: '__proto__', op: 'exists' })).toBeNull()
    expect(evaluateCondition(ctx, { field: 'constructor.prototype', op: 'exists' })).toBeNull()
  })

  it('field exceeding length limit returns null', () => {
    const longField = 'a'.repeat(MAX_CONDITION_FIELD_LEN + 1)
    expect(evaluateCondition(ctx, { field: longField, op: 'exists' })).toBeNull()
  })

  it('evaluateWhen: empty when = true', () => {
    expect(evaluateWhen(ctx, undefined)).toBe(true)
    expect(evaluateWhen(ctx, [])).toBe(true)
  })

  it('evaluateWhen: AND semantics', () => {
    expect(
      evaluateWhen(ctx, [
        { field: 'count', op: 'gt', value: 3 },
        { field: 'flag', op: 'eq', value: true },
      ]),
    ).toBe(true)
    expect(
      evaluateWhen(ctx, [
        { field: 'count', op: 'gt', value: 3 },
        { field: 'flag', op: 'eq', value: false },
      ]),
    ).toBe(false)
  })

  it('evaluateWhen: any parse failure → null (fail-closed)', () => {
    expect(
      evaluateWhen(ctx, [
        { field: 'count', op: 'gt', value: 3 },
        { field: 'count', op: 'bogus' as any, value: 1 },
      ]),
    ).toBeNull()
  })
})

describe('WhenThenRunner — lookupField', () => {
  it('resolves dotted path', () => {
    expect(lookupField({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })

  it('returns undefined for missing intermediate', () => {
    expect(lookupField({ a: {} }, 'a.b.c')).toBeUndefined()
  })

  it('rejects prototype pollution', () => {
    expect(lookupField({} as any, '__proto__.polluted')).toBeUndefined()
  })
})

describe('WhenThenRunner — compileBudgetToConstraints', () => {
  it('compiles step budget', () => {
    const c = compileBudgetToConstraints({ maxCalls: 3, maxTokens: 1000, expiryMs: 5000 })
    expect(c).toEqual({ maxCalls: 3, maxTokens: 1000, expiryMs: 5000 })
  })

  it('step overrides rule', () => {
    const c = compileBudgetToConstraints({ maxCalls: 1 }, { maxCalls: 99, maxTokens: 100 })
    expect(c).toEqual({ maxCalls: 1 })
  })

  it('no budget → undefined', () => {
    expect(compileBudgetToConstraints(undefined)).toBeUndefined()
  })

  it('filters non-numeric / negative values', () => {
    const c = compileBudgetToConstraints({ maxCalls: -1, maxTokens: NaN as any })
    expect(c).toBeUndefined()
  })
})

describe('WhenThenRunner — topologicalOrder', () => {
  it('orders by dependencies', () => {
    const steps: ThenAction[] = [
      { id: 'b', capabilityId: 'x', dependsOn: ['a'] },
      { id: 'a', capabilityId: 'x' },
      { id: 'c', capabilityId: 'x', dependsOn: ['a', 'b'] },
    ]
    const order = topologicalOrder(steps)
    expect(order).not.toBeNull()
    expect(order!.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('detects cycle', () => {
    const steps: ThenAction[] = [
      { id: 'a', capabilityId: 'x', dependsOn: ['b'] },
      { id: 'b', capabilityId: 'x', dependsOn: ['a'] },
    ]
    expect(topologicalOrder(steps)).toBeNull()
  })

  it('detects unknown dependency', () => {
    const steps: ThenAction[] = [{ id: 'a', capabilityId: 'x', dependsOn: ['ghost'] }]
    expect(topologicalOrder(steps)).toBeNull()
  })

  it('detects duplicate id', () => {
    const steps: ThenAction[] = [
      { id: 'a', capabilityId: 'x' },
      { id: 'a', capabilityId: 'y' },
    ]
    expect(topologicalOrder(steps)).toBeNull()
  })
})

describe('WhenThenRunner — runWhenThenRule', () => {
  const okExecutor: StepExecutor = (input) =>
    Promise.resolve({ success: true, outputs: { [`${input.stepId}_out`]: input.inputs.x ?? 'ok' } })

  it('runs steps in order, collects named outputs', async () => {
    const rule: WhenThenRule = {
      id: 'r1',
      steps: [
        { id: 'a', capabilityId: 'cap.a', outputs: ['a_out'] },
        { id: 'b', capabilityId: 'cap.b', dependsOn: ['a'], inputs: { x: 'a.a_out' }, outputs: ['b_out'] },
      ],
    }
    const result = await runWhenThenRule(rule, {}, okExecutor)
    expect(result.success).toBe(true)
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true)
    expect(result.namedOutputs['a.a_out']).toBeDefined()
    expect(result.namedOutputs['b.b_out']).toBeDefined()
  })

  it('when parse failure → step skipped + guardrail event, rule continues', async () => {
    const rule: WhenThenRule = {
      id: 'r2',
      steps: [
        { id: 'a', capabilityId: 'cap.a', when: [{ field: 'x', op: 'bad' as any, value: 1 }] },
        { id: 'b', capabilityId: 'cap.b', dependsOn: ['a'], when: [{ field: 'x', op: 'exists' }] },
      ],
    }
    const result = await runWhenThenRule(rule, { x: 1 }, okExecutor)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].reason).toBe('when_parse_failed')
    // downstream depends on skipped → blocked
    expect(result.steps[1].status).toBe('blocked')
    expect(result.events.some((e) => e.event_type === 'whenthen.step.skipped')).toBe(true)
  })

  it('step failure → dependents blocked, independent steps continue', async () => {
    const executor: StepExecutor = (input) =>
      input.stepId === 'fail' ? Promise.resolve({ success: false, error: 'boom' }) : Promise.resolve({ success: true, outputs: { out: 1 } })
    const rule: WhenThenRule = {
      id: 'r3',
      steps: [
        { id: 'fail', capabilityId: 'cap.fail' },
        { id: 'dep', capabilityId: 'cap.dep', dependsOn: ['fail'] },
        { id: 'indep', capabilityId: 'cap.indep' },
      ],
    }
    const result = await runWhenThenRule(rule, {}, executor)
    expect(result.steps.find((s) => s.id === 'fail')!.status).toBe('failed')
    expect(result.steps.find((s) => s.id === 'dep')!.status).toBe('blocked')
    expect(result.steps.find((s) => s.id === 'indep')!.status).toBe('ok')
    expect(result.events.some((e) => e.event_type === 'whenthen.step.failed')).toBe(true)
  })

  it('budget compiles to constraints on StepExecInput', async () => {
    let capturedConstraints: any
    const executor: StepExecutor = (input) => {
      capturedConstraints = input.constraints
      return Promise.resolve({ success: true })
    }
    const rule: WhenThenRule = {
      id: 'r4',
      steps: [{ id: 'a', capabilityId: 'cap.a', resourceBudget: { maxCalls: 2 } }],
    }
    await runWhenThenRule(rule, {}, executor)
    expect(capturedConstraints).toEqual({ maxCalls: 2 })
  })

  it('invalid graph → rule fail-closed', async () => {
    const rule: WhenThenRule = {
      id: 'r5',
      steps: [
        { id: 'a', capabilityId: 'cap.a', dependsOn: ['b'] },
        { id: 'b', capabilityId: 'cap.b', dependsOn: ['a'] },
      ],
    }
    const result = await runWhenThenRule(rule, {}, okExecutor)
    expect(result.success).toBe(false)
    expect(result.events.some((e) => e.event_type === 'whenthen.rule.failed')).toBe(true)
  })
})
