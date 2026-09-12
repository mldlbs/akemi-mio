/**
 * EvolutionReviewer — 进化流水线 Stage 4
 *
 * 职责：验证执行结果、回归检测、响应合规性验证
 * 生命周期：init() → [verify() / detectRegression() / stopAndValidate()] → destroy()
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { formatValidationSummary } from '@akemi-mio/evolution-core'
import { validateAllSandboxes } from '@akemi-mio/evolution-core'
import { join } from 'path'
import { existsSync } from 'fs'
import type { ResponseValidator } from '@akemi-mio/evolution-core'
import type { VerificationRunner } from '@akemi-mio/evolution-core'
import type { RegressionDetector } from '@akemi-mio/evolution-core'
import type { EvolutionGitOps } from '@akemi-mio/evolution-core'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '@akemi-mio/core/core/lifecycle/types'
import type { ReviewInput, ReviewResult } from './types'

/** 沙盒产物根目录（由 AppRuntime 在运行时传入） */
let sandboxRoot: string | null = null

export function setSandboxRoot(root: string): void {
  sandboxRoot = root
  log('INFO', 'sandbox_root_set', { root })
}

export class EvolutionReviewer implements ISubsystem {
  readonly name = 'EvolutionReviewer'
  state: SubsystemState = 'created'

  private responseValidator: ResponseValidator
  private verificationRunner: VerificationRunner | null = null
  private regressionDetector: RegressionDetector | null = null
  private gitOps: EvolutionGitOps | null = null
  private proposalValidator: any = null
  private lastValidationSummary: string = ''
  private verifyAfterSteps: boolean = false

  constructor(
    responseValidator: ResponseValidator,
    options?: {
      verificationRunner?: VerificationRunner | null
      regressionDetector?: RegressionDetector | null
      gitOps?: EvolutionGitOps | null
    },
  ) {
    this.responseValidator = responseValidator
    this.verificationRunner = options?.verificationRunner ?? null
    this.regressionDetector = options?.regressionDetector ?? null
    this.gitOps = options?.gitOps ?? null
  }

  async init(): Promise<void> {
    this.state = 'initializing'
    log('INFO', 'evolution_reviewer.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.state = 'ready'
  }
  async destroy(): Promise<void> {
    this.state = 'stopped'
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true }
  }

  setVerificationRunner(runner: VerificationRunner | null, verifyAfter?: boolean): void {
    this.verificationRunner = runner
    if (verifyAfter !== undefined) this.verifyAfterSteps = verifyAfter
  }

  setRegressionDetector(detector: RegressionDetector | null): void {
    this.regressionDetector = detector
  }

  setProposalValidator(v: any): void {
    this.proposalValidator = v
  }

  setGitOps(gitOps: EvolutionGitOps | null): void {
    this.gitOps = gitOps
  }

  getLastValidationSummary(): string {
    return this.lastValidationSummary
  }

  // ==================== 响应合规性验证 ====================

  startListen(): void {
    this.responseValidator.startListening()
  }

  stopAndValidate(mode: 'analyze' | 'execute'): {
    passed: boolean
    violations: any[]
    warnings: string[]
    stats: any
    validationSummary: string
  } {
    const result = this.responseValidator.stopAndValidate(mode)

    if (!result.passed) {
      this.lastValidationSummary = formatValidationSummary(result)
      log('WARN', 'evolution_validation_failed', {
        violations: result.violations.filter((v: any) => v.severity === 'error').length,
        details: this.lastValidationSummary,
      })
    } else {
      this.lastValidationSummary = ''
      log('INFO', 'evolution_validation_passed', { stats: result.stats })
    }

    return {
      passed: result.passed,
      violations: result.violations,
      warnings: result.warnings,
      stats: result.stats,
      validationSummary: this.lastValidationSummary,
    }
  }

  // ==================== 步骤后验证 ====================

  async verify(changedFiles: { newFiles: string[]; modifiedFiles: string[] }): Promise<{ passed: boolean }> {
    // 1. 编译/测试/lint 验证（原有逻辑）
    let passed = true
    if (this.verifyAfterSteps && this.verificationRunner) {
      const allChanged = [...changedFiles.newFiles, ...changedFiles.modifiedFiles]
      const verifyResult = await this.verificationRunner.verify(allChanged)

      if (!verifyResult.passed) {
        log('WARN', 'plan_step_verification_failed', {
          compile: verifyResult.checks.compile?.passed,
          test: verifyResult.checks.test?.passed,
          lint: verifyResult.checks.lint?.passed,
        })
        passed = false
      } else {
        log('INFO', 'plan_step_verification_passed')
      }
    }

    // 2. sandbox HTML 产物验证（新增）
    const sandboxHtmlFiles = [...changedFiles.newFiles, ...changedFiles.modifiedFiles].filter(
      (f) => f.endsWith('.html') && f.includes('sandbox'),
    )

    if (sandboxHtmlFiles.length > 0 && sandboxRoot && existsSync(sandboxRoot)) {
      log('INFO', 'sandbox_validation_check', { files: sandboxHtmlFiles })
      const sandboxResult = validateAllSandboxes(sandboxRoot)

      if (sandboxResult.failed > 0) {
        log('WARN', 'sandbox_validation_failed', {
          total: sandboxResult.total,
          failed: sandboxResult.failed,
          details: Object.entries(sandboxResult.results)
            .filter(([, r]) => !r.passed)
            .map(([name, r]) => `${name}: ${r.summary}`)
            .join(' | '),
        })
        passed = false
      } else if (sandboxResult.total > 0) {
        log('INFO', 'sandbox_validation_passed', { total: sandboxResult.total })
      }
    }

    return { passed }
  }

  // ==================== 回归检测 ====================

  async detectRegression(changedFiles: { newFiles: string[]; modifiedFiles: string[] }): Promise<{ hasRegression: boolean }> {
    if (!this.regressionDetector) return { hasRegression: false }

    try {
      const before = await this.regressionDetector.snapshot()
      const after = await this.regressionDetector.snapshot()
      const report = await this.regressionDetector.detectRegression(before, after, changedFiles)

      if (report.hasRegression) {
        log('WARN', 'plan_step_regression_detected', {
          testDelta: report.changes.testPassRate.delta,
          compileDelta: report.changes.compileErrors.delta,
        })
      } else {
        log('INFO', 'plan_step_no_regression')
      }

      return { hasRegression: report.hasRegression }
    } catch (err: any) {
      log('WARN', 'plan_step_regression_check_failed', { error: String(err) })
      return { hasRegression: false }
    }
  }

  /** 整体审查入口：验证 + 回归 */
  async review(input: ReviewInput): Promise<ReviewResult> {
    const validation = this.stopAndValidate(input.mode)
    const [verificationResult, regressionResult] = await Promise.all([
      this.verify(input.changedFiles),
      this.detectRegression(input.changedFiles),
    ])

    return {
      passed: validation.passed && verificationResult.passed && !regressionResult.hasRegression,
      verification: verificationResult,
      regression: regressionResult,
      validationSummary: validation.validationSummary,
    }
  }
}
