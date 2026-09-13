import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../db/__tests__/testDatabase'
// 拆分前这里是 '@akemi-mio/evolution/PlanManager'。该类已随包拆分改名为
// DrizzlePlanManager 并迁入 @akemi-mio/evolution-core，方法集未变
// （createPlan / getPlan / listPlans / updateStep / completePlan / abandonPlan /
//  getActivePlan / getFormattedContext），故这里只改指向、保留原用例。
//
// 注意：DrizzlePlanManager 全程依赖 getRawDb()，拿不到库时所有读方法会静默返回
// 空值（listPlans→[]、getPlan→undefined、updateStep→false、getFormattedContext→''）。
// 所以这里必须真正 initDatabase()，否则「starts with no plans」这类断言全是假通过。
import { DrizzlePlanManager as PlanManager } from '@akemi-mio/evolution-core'

describe('PlanManager', () => {
  let pm: PlanManager
  let dispose: () => void

  beforeEach(async () => {
    dispose = useIsolatedTestDatabase()
    await initDatabase()
    pm = new PlanManager()
  })

  afterEach(() => {
    closeDatabase()
    dispose()
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
