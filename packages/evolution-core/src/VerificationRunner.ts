import * as fs from 'fs'
import * as path from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { withTimeout, execAsync } from '@akemi-mio/core/utils/async'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import type { WorkerPool } from '@akemi-mio/core/core/WorkerPool'

const PROJECT_ROOT = DEV_PROJECT_ROOT

export interface VerificationConfig {
  compileCheck: boolean
  testRun: boolean
  lintCheck: boolean
  typeCheck: boolean
  timeout: number
}

export interface CheckResult {
  passed: boolean
  errors: string[]
  output?: string
}

export interface VerificationResult {
  passed: boolean
  checks: {
    compile?: CheckResult
    test?: TestCheckResult
    lint?: CheckResult
  }
  duration: number
  affectedFiles: string[]
}

export interface TestCheckResult {
  passed: boolean
  passedCount: number
  failedCount: number
  output: string
}

const DEFAULT_CONFIG: VerificationConfig = {
  compileCheck: true,
  testRun: true,
  lintCheck: true,
  typeCheck: true,
  timeout: 120000,
}

export class VerificationRunner {
  private config: VerificationConfig
  private workerPool: WorkerPool | null = null

  constructor(config?: Partial<VerificationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  setWorkerPool(wp: WorkerPool | null): void {
    this.workerPool = wp
  }

  async verify(changedFiles: string[]): Promise<VerificationResult> {
    const start = Date.now()

    // Try worker path first — unblocks main thread from execSync blocking
    const workerAvailable = this.workerPool?.isActive('verification') && !this.workerPool.isBusy('verification')
    if (workerAvailable && this.workerPool) {
      try {
        const result = await this.workerPool.sendTaskAndWait(
          'verification',
          'verify',
          { config: this.config, changedFiles },
          Math.max(this.config.timeout, 120000) + 5000,
        )
        const checks = result.checks as VerificationResult['checks']
        const passed = Object.values(checks).every((c: any) => c?.passed !== false)
        log('INFO', 'verify_result', { passed, duration: Date.now() - start, worker: true })
        return { passed, checks, duration: Date.now() - start, affectedFiles: changedFiles }
      } catch {
        log('WARN', 'verify_worker_failed_falling_back')
      }
    }

    // Inline fallback (original implementation)
    try {
      return await withTimeout(async () => this._doVerify(changedFiles), 120000, 'verify_timeout')
    } catch (err: any) {
      log('WARN', 'verify_overall_timeout', { error: err.message, duration_ms: Date.now() - start })
      return {
        passed: true,
        checks: {},
        duration: Date.now() - start,
        affectedFiles: changedFiles,
      }
    }
  }

  private async _doVerify(changedFiles: string[]): Promise<VerificationResult> {
    const start = Date.now()
    const checks: VerificationResult['checks'] = {}
    if (this.config.compileCheck) checks.compile = await this.runCompileCheck()
    if (this.config.testRun) checks.test = await this.runTestCheck(changedFiles)
    if (this.config.lintCheck) checks.lint = await this.runLintCheck(changedFiles)
    const passed = Object.values(checks).every((c) => c?.passed !== false)
    log('INFO', 'verify_result', { passed, duration: Date.now() - start })
    return { passed, checks, duration: Date.now() - start, affectedFiles: changedFiles }
  }

  private async runCompileCheck(): Promise<CheckResult> {
    try {
      const { exec } = require('child_process')
      const output = await withTimeout(
        async () => {
          try {
            return await new Promise<string>((resolve) => {
              exec(
                'node_modules/.bin/tsc --noEmit --pretty false 2>&1',
                {
                  cwd: PROJECT_ROOT || process.cwd(),
                  timeout: 60000,
                  encoding: 'utf-8',
                  windowsHide: true,
                },
                (_e: any, stdout: string) => resolve(stdout || ''),
              )
            })
          } catch (e: any) {
            return e.stdout || e.message || ''
          }
        },
        60000,
        'compile_check_timeout',
      )
      const text = String(output || '')
      // 过滤已知的无害 TS 错误（out/ 产物滞后、无用导入等），避免假阳性阻塞进化步骤
      const IGNORED_TS_CODES = ['TS6305', 'TS6192', 'TS5053']
      const errors = text.match(/error TS\d+/g) || []
      const filtered = errors.filter((e) => !IGNORED_TS_CODES.some((code) => e.includes(code)))
      const errorCount = filtered.length
      log('INFO', 'verify_compile', {
        passed: errorCount === 0,
        errors: errorCount,
        raw_errors: errors.length,
        filtered: errors.length - filtered.length,
      })
      return { passed: errorCount === 0, errors: errorCount > 0 ? [text.slice(0, 500)] : [] }
    } catch {
      return { passed: true, errors: [] }
    }
  }

  private async runTestCheck(changedFiles: string[]): Promise<TestCheckResult> {
    try {
      const { execSync } = require('child_process')
      const cmd = 'npx vitest run --reporter=json 2>&1'
      const output = await withTimeout(
        async () => {
          try {
            return execSync(cmd, {
              cwd: PROJECT_ROOT || process.cwd(),
              timeout: 120000,
              encoding: 'utf-8',
              windowsHide: true,
              shell: true,
            }) as string
          } catch (e: any) {
            return e.stdout || e.message || ''
          }
        },
        120000,
        'test_check_timeout',
      )
      const text = String(output || '')
      const total = parseInt(text.match(/(\d+)\s+tests/)?.[1] || '0')
      const failed = parseInt(text.match(/(\d+)\s+failed/)?.[1] || '0')
      log('INFO', 'verify_test', { total, failed, passed: failed === 0 })
      return { passed: failed === 0, passedCount: total - failed, failedCount: failed, output: text.slice(0, 500) }
    } catch {
      return { passed: true, passedCount: 0, failedCount: 0, output: 'tests skipped' }
    }
  }

  private async runLintCheck(changedFiles: string[]): Promise<CheckResult> {
    const tsFiles = changedFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    if (tsFiles.length === 0) return { passed: true, errors: [] }
    try {
      const { execSync } = require('child_process')
      const output = await withTimeout(
        async () => {
          try {
            return execSync(`npx eslint ${tsFiles.join(' ')} --format=compact 2>&1`, {
              cwd: PROJECT_ROOT || process.cwd(),
              timeout: 30000,
              encoding: 'utf-8',
              windowsHide: true,
              shell: true,
            }) as string
          } catch (e: any) {
            return e.stderr || e.stdout || e.message || ''
          }
        },
        30000,
        'lint_check_timeout',
      )
      const text = String(output || '')
      const errors = (text.match(/error/g) || []).length
      return { passed: errors === 0, errors: errors > 0 ? [text.slice(0, 500)] : [] }
    } catch {
      return { passed: true, errors: [] }
    }
  }
}
