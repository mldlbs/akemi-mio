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
  const lines = output.split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
  return { n: lines.length, lines }
}

// 2026-09-22：原来只打印计数、把 tsc 的输出整个丢掉，这道门禁就是个黑箱 ——
// CI 上失败时唯一线索是「Process completed with exit code 1」，而 job 日志还要
// 管理员权限才能下载（实测 403）。连本地失败也不知道错在哪，只能自己再跑一遍 tsc。
// 所以失败时把错误原样打出来；在 GitHub Actions 里加 ::error:: 前缀，
// 让它变成 run 页面上的注解，不必下载日志就能看见。
const MAX_DETAIL = 30
const inActions = process.env.GITHUB_ACTIONS === 'true'

let errors = 0
const details = []
for (const config of CONFIGS) {
  const { n, lines } = countErrors(config)
  errors += n
  if (n) details.push({ config, lines })
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

for (const { config, lines } of details) {
  console.error(`--- ${config} (${lines.length} errors) ---`)
  for (const line of lines.slice(0, MAX_DETAIL)) {
    console.error(inActions ? `::error::${line}` : line)
  }
  if (lines.length > MAX_DETAIL) {
    console.error(`  ... 其余 ${lines.length - MAX_DETAIL} 条已省略`)
  }
}
console.error(`FAIL: ${errors} errors exceeds budget ceiling of ${BUDGET}. Fix or triage before merging.`)
process.exit(1)
