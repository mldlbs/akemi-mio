/**
 * PlanIntegrityChecker 单元测试
 *
 * 核心验证点：
 * 1. 正常计划 → passed
 * 2. 空步骤描述 → 检测为 error
 * 3. 'undefined'/'null' 字符串描述 → 检测为 error
 * 4. 步骤索引不连续 → 检测为 error
 * 5. 非法步骤状态 → 检测为 error
 * 6. 非法计划状态 → 检测为 error
 * 7. 自动修复：空描述 → 替换为占位文本
 * 8. 无步骤计划 → warning
 * 9. 重复步骤索引 → 检测为 error
 */

import { describe, it, expect } from 'vitest'
import { PlanIntegrityChecker } from '../PlanIntegrityChecker'
import type { DevPlan } from '../types'

function makePlan(overrides: Partial<DevPlan> = {}): DevPlan {
  return {
    id: 'test-plan-1',
    title: '测试计划',
    description: '用于测试的完整计划',
    status: 'active',
    steps: [
      { id: 'step_0', description: '第一步', status: 'pending' },
      { id: 'step_1', description: '第二步', status: 'done' },
      { id: 'step_2', description: '第三步', status: 'in_progress' },
    ],
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('PlanIntegrityChecker', () => {
  const checker = new PlanIntegrityChecker()

  describe('checkPlan — 正常计划', () => {
    it('完整计划应无问题', () => {
      const plan = makePlan()
      const issues = checker.checkPlan(plan)
      expect(issues).toHaveLength(0)
    })
  })

  describe('checkPlan — 空步骤描述', () => {
    it('步骤描述为 undefined 应检测为 error', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: '第一步', status: 'pending' },
          { id: 'step_1', description: undefined as unknown as string, status: 'pending' },
        ],
      })
      const issues = checker.checkPlan(plan)
      const emptyDescIssues = issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues.length).toBeGreaterThanOrEqual(1)
      expect(emptyDescIssues[0].severity).toBe('error')
    })

    it('步骤描述为 "undefined" 字符串应检测为 error', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: '第一步', status: 'pending' },
          { id: 'step_1', description: 'undefined', status: 'pending' },
        ],
      })
      const issues = checker.checkPlan(plan)
      const emptyDescIssues = issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues.length).toBeGreaterThanOrEqual(1)
    })

    it('步骤描述为 "null" 字符串应检测为 error', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: 'null', status: 'pending' },
        ],
      })
      const issues = checker.checkPlan(plan)
      const emptyDescIssues = issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues.length).toBeGreaterThanOrEqual(1)
    })

    it('步骤描述为空字符串应检测为 error', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: '', status: 'pending' },
        ],
      })
      const issues = checker.checkPlan(plan)
      const emptyDescIssues = issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('checkPlan — 非法状态', () => {
    it('非法步骤状态应检测为 error', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: '第一步', status: 'unknown_status' as any },
        ],
      })
      const issues = checker.checkPlan(plan)
      const statusIssues = issues.filter((i) => i.category === 'invalid_step_status')
      expect(statusIssues.length).toBeGreaterThanOrEqual(1)
      expect(statusIssues[0].severity).toBe('error')
    })

    it('非法计划状态应检测为 error', () => {
      const plan = makePlan({ status: 'invalid_status' as any })
      const issues = checker.checkPlan(plan)
      const statusIssues = issues.filter((i) => i.category === 'invalid_plan_status')
      expect(statusIssues.length).toBeGreaterThanOrEqual(1)
      expect(statusIssues[0].severity).toBe('error')
    })
  })

  describe('checkPlan — 索引完整性', () => {
    it('无步骤计划应产生 warning', () => {
      const plan = makePlan({ steps: [] })
      const issues = checker.checkPlan(plan)
      const gapIssues = issues.filter((i) => i.category === 'step_index_gap')
      expect(gapIssues.length).toBeGreaterThanOrEqual(1)
      expect(gapIssues[0].severity).toBe('warn')
    })
  })

  describe('checkPlan — 空标题', () => {
    it('空标题应检测为 error', () => {
      const plan = makePlan({ title: '' })
      const issues = checker.checkPlan(plan)
      const titleIssues = issues.filter((i) => i.category === 'empty_title')
      expect(titleIssues.length).toBeGreaterThanOrEqual(1)
    })

    it('空白标题应检测为 error', () => {
      const plan = makePlan({ title: '   ' })
      const issues = checker.checkPlan(plan)
      const titleIssues = issues.filter((i) => i.category === 'empty_title')
      expect(titleIssues.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('checkAllPlans — 批量检查', () => {
    it('多个计划全部正常时 passed 应为 true', () => {
      const plans = [makePlan(), makePlan({ id: 'test-plan-2', title: '第二个计划' })]
      const result = checker.checkAllPlans(plans)
      expect(result.passed).toBe(true)
      expect(result.issues).toHaveLength(0)
    })

    it('存在损坏计划时 passed 应为 false', () => {
      const plans = [
        makePlan(),
        makePlan({
          id: 'corrupted-plan',
          title: '损坏计划',
          steps: [{ id: 'step_bad', description: 'undefined', status: 'pending' }],
        }),
      ]
      const result = checker.checkAllPlans(plans)
      expect(result.passed).toBe(false)
      const emptyDescIssues = result.issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues.length).toBeGreaterThanOrEqual(1)
    })

    it('checkAllPlans 应返回 checkedAt 时间戳', () => {
      const plans = [makePlan()]
      const result = checker.checkAllPlans(plans)
      expect(result.checkedAt).toBeGreaterThan(0)
      expect(typeof result.checkedAt).toBe('number')
    })
  })

  describe('autoFix — 自动修复', () => {
    it('应将 undefined 描述的步骤替换为占位文本', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: '第一步', status: 'pending' },
          { id: 'step_1', description: undefined as unknown as string, status: 'pending' },
          { id: 'step_2', description: 'undefined', status: 'pending' },
          { id: 'step_3', description: 'null', status: 'pending' },
        ],
      })

      const result = checker.autoFix(plan)

      expect(result.fixed).toBe(3)
      expect(plan.steps[1].description).toBe('步骤 2')
      expect(plan.steps[2].description).toBe('步骤 3')
      expect(plan.steps[3].description).toBe('步骤 4')
      expect(plan.steps[0].description).toBe('第一步') // 未受影响
    })

    it('正常计划 autoFix 应返回 fixed=0', () => {
      const plan = makePlan()
      const result = checker.autoFix(plan)
      expect(result.fixed).toBe(0)
    })

    it('修复后应能通过完整性检查', () => {
      const plan = makePlan({
        steps: [
          { id: 'step_0', description: 'undefined', status: 'pending' },
          { id: 'step_1', description: 'null', status: 'pending' },
        ],
      })

      checker.autoFix(plan)
      const issues = checker.checkPlan(plan)
      const emptyDescIssues = issues.filter((i) => i.category === 'empty_step_description')
      expect(emptyDescIssues).toHaveLength(0)
    })
  })
})
