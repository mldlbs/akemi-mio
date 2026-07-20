/**
 * WorkflowScheduler — resume context rebuild contract tests.
 *
 * Verifies that rebuildExecutionSteps correctly reconstructs scheduler
 * state from persisted WorkflowStepRun[] after restart.
 *
 * Resume semantics:
 * - done step: skipped, output restored for dependency chain
 * - failed step: re-evaluated under current retry policy
 * - skipped step: skipped
 * - retry counter: reset after process restart
 */
import { describe, it, expect } from 'vitest'
import { rebuildExecutionSteps } from '../WorkflowScheduler'
import type { WorkflowStepRun } from '../types'

function done(id: string, output?: string): WorkflowStepRun {
  return { stepId: id, status: 'done', agentResult: output, startedAt: 100, completedAt: 200 }
}

function failed(id: string): WorkflowStepRun {
  return { stepId: id, status: 'failed', error: 'oops', startedAt: 100, completedAt: 200 }
}

function skipped(id: string): WorkflowStepRun {
  return { stepId: id, status: 'skipped', startedAt: 100, completedAt: 200 }
}

function pending(id: string): WorkflowStepRun {
  return { stepId: id, status: 'pending', startedAt: 100 }
}

describe('rebuildExecutionSteps — resume context contract', () => {

  it('should populate completed set from done steps', () => {
    const steps = [done('s1'), pending('s2')]
    const result = rebuildExecutionSteps(steps, '')
    expect(result.completed.has('s1')).toBe(true)
    expect(result.completed.has('s2')).toBe(false)
  })

  it('should restore step output in ctx.steps for done steps', () => {
    const steps = [done('s1', 'hello'), pending('s2')]
    const result = rebuildExecutionSteps(steps, '')
    expect(result.ctx.steps['s1']).toEqual({ result: 'hello', status: 'done' })
    expect(result.ctx.steps['s2']).toBeUndefined()
  })

  it('should restore dependency chain: B receives A output after resume', () => {
    const steps = [done('A', 'x42'), pending('B')]
    const result = rebuildExecutionSteps(steps, '')
    // B's caller resolves templates via ctx.steps, e.g. {{steps.A.result}}
    expect(result.ctx.steps['A']?.result).toBe('x42')
    expect(result.ctx.steps['B']).toBeUndefined()
  })

  it('should populate failures set from failed steps', () => {
    const steps = [failed('s1')]
    const result = rebuildExecutionSteps(steps, '')
    expect(result.failures.has('s1')).toBe(true)
    expect(result.ctx.steps['s1']).toEqual({ result: null, status: 'failed', error: 'oops' })
  })

  it('should populate skipped set from skipped steps', () => {
    const steps = [skipped('s1')]
    const result = rebuildExecutionSteps(steps, '')
    expect(result.skipped.has('s1')).toBe(true)
    expect(result.ctx.steps['s1']).toBeUndefined()
  })

  it('should keep pending steps out of all sets', () => {
    const steps = [done('s1'), pending('s2'), pending('s3')]
    const result = rebuildExecutionSteps(steps, '')
    expect(result.failures.size).toBe(0)
    expect(result.skipped.size).toBe(0)
    expect(result.pending).toBeUndefined() // no pending set
  })

  it('should preserve input in ctx', () => {
    const result = rebuildExecutionSteps([], 'user-query')
    expect(result.ctx.input).toBe('user-query')
  })

  it('should handle empty steps array', () => {
    const result = rebuildExecutionSteps([], '')
    expect(result.completed.size).toBe(0)
    expect(result.failures.size).toBe(0)
    expect(result.skipped.size).toBe(0)
    expect(Object.keys(result.ctx.steps).length).toBe(0)
  })

  it('should handle mixed states correctly', () => {
    const steps = [
      done('s1', 'a'),
      failed('s2'),
      skipped('s3'),
      pending('s4'),
      done('s5', 'b'),
    ]
    const result = rebuildExecutionSteps(steps, 'test')
    expect(result.completed).toEqual(new Set(['s1', 's5']))
    expect(result.failures).toEqual(new Set(['s2']))
    expect(result.skipped).toEqual(new Set(['s3']))
    expect(result.ctx.steps['s1']).toBeDefined()
    expect(result.ctx.steps['s2']).toBeDefined()
    expect(result.ctx.steps['s3']).toBeUndefined()
    expect(result.ctx.steps['s4']).toBeUndefined()
    expect(result.ctx.steps['s5']).toBeDefined()
    expect(result.ctx.input).toBe('test')
  })
})
