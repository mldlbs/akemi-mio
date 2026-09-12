/**
 * Verification Worker — 在 worker_thread 中执行编译/测试/lint 验证
 *
 * 从主进程接收 { config, changedFiles }，返回结构化检查结果。
 * execSync 在 worker 中不会阻塞主线程事件循环。
 */

import './base-worker'

interface WorkerInput {
  config: {
    compileCheck: boolean
    testRun: boolean
    lintCheck: boolean
    typeCheck: boolean
    timeout: number
  }
  changedFiles: string[]
}

interface CheckResult {
  passed: boolean
  errors: string[]
  output?: string
}

interface TestCheckResult {
  passed: boolean
  passedCount: number
  failedCount: number
  output: string
}

const IGNORED_TS_CODES = ['TS6305', 'TS6192', 'TS5053']

function runCompileCheck(): CheckResult {
  try {
    const { execSync } = require('child_process')
    const output = execSync('npx tsc --noEmit --pretty false 2>&1', {
      cwd: process.cwd(),
      timeout: 60000,
      encoding: 'utf-8',
      windowsHide: true,
    }) as string
    const errors = output.match(/error TS\d+/g) || []
    const filtered = errors.filter((e: any) => !IGNORED_TS_CODES.some((code) => e.includes(code)))
    return { passed: filtered.length === 0, errors: filtered.length > 0 ? [output.slice(0, 500)] : [] }
  } catch (e: any) {
    const text = e.stdout || e.message || ''
    const errors = text.match(/error TS\d+/g) || []
    const filtered = errors.filter((e: any) => !IGNORED_TS_CODES.some((code) => e.includes(code)))
    return { passed: filtered.length === 0, errors: filtered.length > 0 ? [text.slice(0, 500)] : [] }
  }
}

function runTestCheck(): TestCheckResult {
  try {
    const { execSync } = require('child_process')
    const output = execSync('npx vitest run --reporter=json 2>&1', {
      cwd: process.cwd(),
      timeout: 120000,
      encoding: 'utf-8',
      windowsHide: true,
      shell: true,
    }) as string
    const total = parseInt(output.match(/(\d+)\s+tests/)?.[1] || '0')
    const failed = parseInt(output.match(/(\d+)\s+failed/)?.[1] || '0')
    return { passed: failed === 0, passedCount: total - failed, failedCount: failed, output: output.slice(0, 500) }
  } catch (e: any) {
    const text = e.stdout || e.message || ''
    const total = parseInt(text.match(/(\d+)\s+tests/)?.[1] || '0')
    const failed = parseInt(text.match(/(\d+)\s+failed/)?.[1] || '0')
    return { passed: failed === 0, passedCount: total - failed, failedCount: failed, output: text.slice(0, 500) }
  }
}

function runLintCheck(changedFiles: string[]): CheckResult {
  const tsFiles = changedFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  if (tsFiles.length === 0) return { passed: true, errors: [] }
  try {
    const { execSync } = require('child_process')
    const output = execSync(`npx eslint ${tsFiles.join(' ')} --format=compact 2>&1`, {
      cwd: process.cwd(),
      timeout: 30000,
      encoding: 'utf-8',
      windowsHide: true,
      shell: true,
    }) as string
    const errors = (output.match(/error/g) || []).length
    return { passed: errors === 0, errors: errors > 0 ? [output.slice(0, 500)] : [] }
  } catch (e: any) {
    const text = e.stderr || e.stdout || e.message || ''
    const errors = (text.match(/error/g) || []).length
    return { passed: errors === 0, errors: errors > 0 ? [text.slice(0, 500)] : [] }
  }
}

;(globalThis as any).__workerHandler = async (data: WorkerInput) => {
  const { config, changedFiles } = data
  const checks: { compile?: CheckResult; test?: TestCheckResult; lint?: CheckResult } = {}

  if (config.compileCheck) checks.compile = runCompileCheck()
  if (config.testRun) checks.test = runTestCheck()
  if (config.lintCheck) checks.lint = runLintCheck(changedFiles)

  return { checks, duration: Date.now(), affectedFiles: changedFiles }
}
