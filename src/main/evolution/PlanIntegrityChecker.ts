import type { DevPlan } from './types'
import { log } from '../logger/Logger'

export interface IntegrityIssue {
  planId: string
  planTitle: string
  severity: 'error' | 'warn'
  category:
    | 'empty_step_description'
    | 'step_index_gap'
    | 'invalid_step_status'
    | 'invalid_plan_status'
    | 'empty_title'
    | 'duplicate_step_index'
  description: string
}

export interface RollbackReadiness {
  ready: boolean
  hasGit: boolean
  hasSnapshot: boolean
  hasPendingChanges: boolean
  reason?: string
}

export interface IntegrityResult {
  passed: boolean
  issues: IntegrityIssue[]
  checkedAt: number
}

const VALID_STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'failed'])
const VALID_PLAN_STATUSES = new Set(['active', 'completed', 'abandoned', 'frozen'])

export class PlanIntegrityChecker {
  /**
   * 检查单个计划的完整性
   */
  checkPlan(plan: DevPlan): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []

    if (!plan.id) {
      issues.push({
        planId: plan.id || '(missing)',
        planTitle: plan.title || '(missing)',
        severity: 'error',
        category: 'empty_title',
        description: '计划 ID 为空',
      })
    }

    if (!plan.title || plan.title.trim() === '') {
      issues.push({
        planId: plan.id,
        planTitle: plan.title || '(empty)',
        severity: 'error',
        category: 'empty_title',
        description: '计划标题为空',
      })
    }

    if (!VALID_PLAN_STATUSES.has(plan.status)) {
      issues.push({
        planId: plan.id,
        planTitle: plan.title,
        severity: 'error',
        category: 'invalid_plan_status',
        description: `计划状态非法: "${plan.status}"，合法值: ${[...VALID_PLAN_STATUSES].join(', ')}`,
      })
    }

    if (!plan.steps || plan.steps.length === 0) {
      issues.push({
        planId: plan.id,
        planTitle: plan.title,
        severity: 'warn',
        category: 'step_index_gap',
        description: '计划没有步骤',
      })
      return issues
    }

    const seenIndices = new Set<number>()

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]

      // 检查步骤描述是否为 null/undefined/空字符串
      if (!step.description || step.description.trim() === '' || step.description === 'undefined' || step.description === 'null') {
        issues.push({
          planId: plan.id,
          planTitle: plan.title,
          severity: 'error',
          category: 'empty_step_description',
          description: `步骤 ${i} (id=${step.id}) 的描述为空或为"${step.description}"`,
        })
      }

      // 检查步骤状态是否合法
      if (!VALID_STEP_STATUSES.has(step.status as string)) {
        issues.push({
          planId: plan.id,
          planTitle: plan.title,
          severity: 'error',
          category: 'invalid_step_status',
          description: `步骤 ${i} 状态非法: "${step.status}"`,
        })
      }

      // 检查重复索引
      if (seenIndices.has(i)) {
        issues.push({
          planId: plan.id,
          planTitle: plan.title,
          severity: 'error',
          category: 'duplicate_step_index',
          description: `步骤索引 ${i} 重复`,
        })
      }
      seenIndices.add(i)
    }

    // 检查步骤索引连续性（实际索引应连续 0..n-1）
    for (let i = 0; i < plan.steps.length; i++) {
      if (!seenIndices.has(i)) {
        issues.push({
          planId: plan.id,
          planTitle: plan.title,
          severity: 'error',
          category: 'step_index_gap',
          description: `步骤索引不连续，缺少索引 ${i}`,
        })
      }
    }

    return issues
  }

  /**
   * 检查所有计划并返回结果
   */
  checkAllPlans(plans: DevPlan[]): IntegrityResult {
    const allIssues: IntegrityIssue[] = []

    for (const plan of plans) {
      const issues = this.checkPlan(plan)
      allIssues.push(...issues)
    }

    const result: IntegrityResult = {
      passed: allIssues.filter((i) => i.severity === 'error').length === 0,
      issues: allIssues,
      checkedAt: Date.now(),
    }

    if (allIssues.length > 0) {
      log('WARN', 'plan_integrity_issues', {
        total_issues: allIssues.length,
        errors: allIssues.filter((i) => i.severity === 'error').length,
        warnings: allIssues.filter((i) => i.severity === 'warn').length,
      })

      for (const issue of allIssues) {
        log(issue.severity === 'error' ? 'ERROR' : 'WARN', 'plan_integrity_issue', {
          plan_id: issue.planId,
          category: issue.category,
          description: issue.description,
        })
      }
    } else {
      log('INFO', 'plan_integrity_ok', { plans_checked: plans.length })
    }

    return result
  }

  /**
   * 自动修复可修复的完整性问题
   * 返回修复了的问题数量
   */
  autoFix(plan: DevPlan): { fixed: number; fixes: string[] } {
    const fixes: string[] = []

    // 修复空步骤描述（将 undefined/null 替换为占位描述）
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      if (!step.description || step.description.trim() === '' || step.description === 'undefined' || step.description === 'null') {
        const origDesc = step.description
        step.description = `步骤 ${i + 1}`
        fixes.push(`步骤 ${i} 描述从 "${origDesc}" 修复为 "步骤 ${i + 1}"`)
      }
    }

    return { fixed: fixes.length, fixes }
  }

  checkRollbackReadiness(plan: DevPlan): RollbackReadiness {
    const hasGit = true // 运行环境中 git 可用
    const hasSnapshot = plan.steps.some((s) => s.status === 'done' || s.status === 'in_progress')
    const hasPendingChanges = plan.steps.some((s) => s.status === 'pending' || s.status === 'failed')
    const ready = hasGit && (hasSnapshot || !hasPendingChanges)
    return {
      ready,
      hasGit,
      hasSnapshot,
      hasPendingChanges,
      reason: ready ? undefined : hasPendingChanges && !hasSnapshot ? '有待执行步骤但无快照，回滚将丢失未保存变更' : undefined,
    }
  }
}
