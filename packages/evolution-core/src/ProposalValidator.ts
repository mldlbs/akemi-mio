import { resolve } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import { eventBus } from '@akemi-mio/core/core/EventBus'

export interface Proposal {
  id: string
  title: string
  description: string
  targetFiles: string[]
  expectedOutcome: string
  risk: 'low' | 'medium' | 'high'
  createdAt: number
}

export interface ProposalValidation {
  proposalId: string
  passed: boolean
  constitutional: { passed: boolean; violations: string[] }
  scopeCheck: { passed: boolean; message: string }
  regressionRisk: 'low' | 'medium' | 'high'
  budgetCheck?: { passed: boolean; message: string }
}

export class ProposalValidator {
  private constitution: { checkWrite: Function } | null = null
  private planManager: { listPlans: Function } | null = null
  private resourceBudget: any = null
  private stabilityScore: any = null

  setConstitution(engine: { checkWrite: Function }): void {
    this.constitution = engine
  }
  setPlanManager(mgr: { listPlans: Function }): void {
    this.planManager = mgr
  }
  setResourceBudget(budget: any): void {
    this.resourceBudget = budget
  }
  setStabilityScore(ss: any): void {
    this.stabilityScore = ss
  }

  async validate(proposal: Proposal): Promise<ProposalValidation> {
    const constitutional = this.checkConstitutional(proposal.targetFiles)
    const scopeCheck = this.checkScope(proposal)
    const regressionRisk = this.assessRegressionRisk(proposal.targetFiles)
    const budgetCheck = this.checkBudget(proposal)
    const passed = constitutional.passed && scopeCheck.passed && (budgetCheck?.passed ?? true)
    log('INFO', 'proposal_validation', { proposalId: proposal.id, passed, regressionRisk })
    const result: ProposalValidation = { proposalId: proposal.id, passed, constitutional, scopeCheck, regressionRisk, budgetCheck }
    eventBus.emit('evolution.proposal.validated', {
      proposalId: proposal.id,
      passed,
      regressionRisk,
    })
    return result
  }

  private checkConstitutional(targetFiles: string[]): { passed: boolean; violations: string[] } {
    const violations: string[] = []
    if (!this.constitution) return { passed: true, violations: [] }
    for (const file of targetFiles) {
      // ConstitutionEngine.checkWrite expects absolute paths
      const absolutePath = resolve(DEV_PROJECT_ROOT || process.cwd(), file)
      const check = this.constitution.checkWrite(absolutePath)
      if (!check.allowed) violations.push(`${file}: ${check.violation?.reason || '路径受保护'}`)
    }
    return { passed: violations.length === 0, violations }
  }

  private checkScope(proposal: Proposal): { passed: boolean; message: string } {
    if (!proposal.targetFiles?.length) return { passed: false, message: '提案未指定目标文件' }
    if ((proposal.title || '').length < 3) return { passed: false, message: '提案标题过短' }
    return { passed: true, message: '范围检查通过' }
  }

  private assessRegressionRisk(targetFiles: string[]): 'low' | 'medium' | 'high' {
    const risky = targetFiles.filter((file) => {
      const modulePath = file.replace(/\\/g, '/').toLowerCase().replace(/^.*?packages\/[^/]+\/src\//, '')
      return ['core/', 'eventbus', 'scheduler', 'lifecycle', 'constitution'].some((part) => modulePath.includes(part))
    })
    if (risky.length > 1) return 'high'
    if (risky.length > 0) return 'medium'
    return 'low'
  }

  private checkBudget(proposal: Proposal): { passed: boolean; message: string } | undefined {
    if (!this.resourceBudget) return undefined
    const check = this.resourceBudget.checkLlmCall('evolution')
    if (check) {
      return { passed: false, message: `预算不足: ${check}` }
    }
    // 高风险提案需要额外的预算余量
    if (proposal.risk === 'high' || this.stabilityScore?.getScore() < 70) {
      const doubleCheck = this.resourceBudget.checkLlmCall('evolution')
      if (doubleCheck) {
        return { passed: false, message: `高风险提案预算不足: ${doubleCheck}` }
      }
    }
    return { passed: true, message: '预算充足' }
  }
}
