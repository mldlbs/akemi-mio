import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlanManager } from '@akemi-mio/evolution/PlanManager'
import { existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => resolve(process.cwd(), 'test-user-data'),
  },
}))

const TEST_DIR = resolve(process.cwd(), 'test-user-data')

function cleanAllTestFiles() {
  try {
    if (existsSync(TEST_DIR)) {
      for (const f of readdirSync(TEST_DIR)) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) {
          unlinkSync(resolve(TEST_DIR, f))
        }
      }
    }
  } catch {}
}

describe('PlanManager', () => {
  let pm: PlanManager

  beforeEach(() => {
    cleanAllTestFiles()
    pm = new PlanManager()
  })

  afterEach(() => {
    cleanAllTestFiles()
  })

  it('starts with no plans', () => {
    expect(pm.listPlans()).toEqual([])
  })

  it('creates a plan', () => {
    const plan = pm.createPlan('Test Plan', 'A test plan', ['Step 1', 'Step 2'])
    expect(plan.title).toBe('Test Plan')
    expect(plan.steps.length).toBe(2)
    expect(plan.status).toBe('active')
  })

  it('returns active plan', () => {
    pm.createPlan('Active Plan', 'Description', ['Step 1'])
    const active = pm.getActivePlan()
    expect(active?.title).toBe('Active Plan')
  })

  it('prevents duplicate active plans with same title', () => {
    pm.createPlan('Test Plan', 'Desc', ['Step 1'])
    pm.createPlan('Test Plan', 'Desc again', ['Step 2'])
    const plans = pm.listPlans().filter((p) => p.status === 'active')
    expect(plans.length).toBe(1)
  })

  it('updates step status', () => {
    const plan = pm.createPlan('Plan', 'Desc', ['Step 1', 'Step 2'])
    const result = pm.updateStep(plan.id, 0, 'in_progress')
    expect(result).toBe(true)

    const updated = pm.getPlan(plan.id)
    expect(updated?.steps[0].status).toBe('in_progress')
  })

  it('updateStep returns false for invalid step index', () => {
    const plan = pm.createPlan('Plan', 'Desc', ['Step 1'])
    expect(pm.updateStep(plan.id, 5, 'done')).toBe(false)
  })

  it('completes a plan', () => {
    const plan = pm.createPlan('Plan', 'Desc', ['Step 1'])
    pm.completePlan(plan.id, 'Done!')
    const updated = pm.getPlan(plan.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.reflection).toBe('Done!')
  })

  it('abandons a plan', () => {
    const plan = pm.createPlan('Plan', 'Desc', ['Step 1'])
    pm.abandonPlan(plan.id, 'Not needed')
    const updated = pm.getPlan(plan.id)
    expect(updated?.status).toBe('abandoned')
  })

  it('getFormattedContext returns active plan summary', () => {
    pm.createPlan('My Plan', 'Test', ['Step A', 'Step B'])
    const ctx = pm.getFormattedContext()
    expect(ctx).toContain('My Plan')
    expect(ctx).toContain('0/2')
    expect(ctx).toContain('Step A')
    expect(ctx).toContain('Step B')
  })

  it('getFormattedContext returns empty string when no active plan', () => {
    expect(pm.getFormattedContext()).toBe('')
  })
})
