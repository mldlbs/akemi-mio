// TypeScript error budget guard: fails if the combined error count exceeds the ceiling.
// Usage: node scripts/typecheck-budget.mjs [--budget N]
//
// 2026-09-12：预算在 2026-09-11 已收紧到 0，但当时只统计 tsconfig.node.json ——
// renderer 侧（tsconfig.web.json）从未入门禁，长期带着数百个错误静默出厂
// （renderer 走 vite/esbuild 转译，擦类型不做检查）。现已把 web 侧一并纳入统计。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const budgetArg = process.argv.indexOf('--budget')
const BUDGET = budgetArg >= 0 ? Number(process.argv[budgetArg + 1]) : 0

const CONFIGS = ['tsconfig.node.json', 'tsconfig.web.json']

function countErrors(config) {
  let output = ''
  try {
    output = execFileSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', config],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    output = String(err.stdout || '') + String(err.stderr || '')
  }
  return (output.match(/error TS\d+/g) || []).length
}

let errors = 0
for (const config of CONFIGS) {
  const n = countErrors(config)
  errors += n
  console.log(`  ${config}: ${n} errors`)
}
console.log(`TypeScript errors: ${errors} (budget: ${BUDGET})`)

if (errors === 0) {
  console.log('PASS: typecheck clean.')
  process.exit(0)
}
if (errors <= BUDGET) {
  console.log(`PASS: within budget (${errors} <= ${BUDGET}). Reduce the ceiling as errors shrink.`)
  process.exit(0)
}
console.error(`FAIL: ${errors} errors exceeds budget ceiling of ${BUDGET}. Fix or triage before merging.`)
process.exit(1)
