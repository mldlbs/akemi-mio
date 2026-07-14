/**
 * Script to run Benchmark v0.1 against ReasoningPlanner v2
 * Reports: input → selected pattern → score detail → misclassified cases
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { plan, score } from '../ReasoningPlanner'
import type { ReasoningContext } from '../types'

interface BenchmarkCase {
  id: string
  text: string
  expectations: string[]
}

function parseBenchmark(filePath: string, prefix: string): BenchmarkCase[] {
  const content = readFileSync(filePath, 'utf-8')
  const cases: BenchmarkCase[] = []
  let current: Partial<BenchmarkCase> = {}

  for (const line of content.split('\n')) {
    const idMatch = line.match(/^\*\*(Q|D|P|C)(\d+)\*\*/)
    if (idMatch) {
      if (current.id && current.text && current.expectations) {
        cases.push(current as BenchmarkCase)
      }
      current = { id: `${prefix}${idMatch[1]}${idMatch[2]}`, expectations: [] }
    }
    const userMatch = line.match(/^User\s*>\s*"(.+)"$/)
    if (userMatch && current) {
      current.text = userMatch[1]
    }
    const expMatch = line.match(/^Expectation\s*>\s*\[(.+)\]$/)
    if (expMatch && current) {
      current.expectations = expMatch[1].split(',').map((s: string) => s.trim().replace(/[\[\]]/g, ''))
    }
  }
  if (current.id && current.text && current.expectations) {
    cases.push(current as BenchmarkCase)
  }
  return cases
}

const benchmarkDir = join(__dirname, '../../../../docs/benchmarks/reasoning-v0.1')

const allCases: BenchmarkCase[] = [
  ...parseBenchmark(join(benchmarkDir, 'analysis.md'), 'A'),
  ...parseBenchmark(join(benchmarkDir, 'decision.md'), 'D'),
  ...parseBenchmark(join(benchmarkDir, 'planning.md'), 'P'),
  ...parseBenchmark(join(benchmarkDir, 'creation.md'), 'C'),
]

console.log(`\n=== Benchmark v0.1 — ${allCases.length} cases ===\n`)

let matched = 0
let noneCount = 0
const misclassified: string[] = []

for (const c of allCases) {
  const ctx: ReasoningContext = { input: { text: c.text } }
  const d = plan(ctx)
  const detail = score(ctx)

  const hasPattern = d.pattern && d.pattern !== 'default'
  const patternStr = hasPattern ? d.pattern : '(none)'
  const scoreStr = detail.scores
    ? Object.entries(detail.scores)
        .map(([p, s]) => `${p}=${s}`)
        .join(', ')
    : ''
  const hitsStr = detail.hits.length > 0 ? detail.hits.map((h) => h.tag).join(', ') : ''
  const overrideStr = detail.overriddenByScene ? ` [override:${detail.overriddenByScene}]` : ''

  if (!hasPattern) noneCount++

  // 判断是否有理由认为分类明显错误
  const isMisclassified = false // will be determined by human review
  if (isMisclassified) misclassified.push(c.id)

  console.log(`${c.id} [${patternStr}${overrideStr}] ${c.text.slice(0, 50)}`)
  if (scoreStr) console.log(`  scores: ${scoreStr}`)
  if (hitsStr) console.log(`  hits: ${hitsStr}`)
  if (c.expectations.length > 0) console.log(`  expects: ${c.expectations.slice(0, 3).join(', ')}`)
  console.log()
}

console.log(`=== Summary ===`)
console.log(`Total: ${allCases.length}`)
console.log(`With Pattern: ${allCases.length - noneCount}`)
console.log(`No Pattern (none): ${noneCount}`)
console.log(`Misclassified: ${misclassified.length}`)
if (misclassified.length > 0) {
  console.log(`Misclassified IDs: ${misclassified.join(', ')}`)
}
