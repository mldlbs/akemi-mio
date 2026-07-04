/**
 * Run CreativityCollector through PipelineOrchestrator
 *
 * Uses DrizzleIdeaStore to fetch high-scoring hypotheses,
 * then runs the full pipeline to implement one.
 *
 * npx tsx src/main/evolution/automation/__test_feature__.ts
 */

import { CreativityCollector } from './CreativityCollector'
import { CreativityExecutor } from './CreativityExecutor'
import { PipelineOrchestrator } from './PipelineOrchestrator'
import { ProblemQueue } from './ProblemQueue'
import { join } from 'path'
import { tmpdir } from 'os'

async function main() {
  const key = process.env.LLM_KEY
  if (!key) {
    console.error('✗ LLM_KEY 未设置')
    process.exit(1)
  }
  console.log(`✓ LLM_KEY found`)

  // Init database first (required by DrizzleIdeaStore)
  const { initDatabase } = require('../../db/connection')
  await initDatabase()
  console.log('✓ Database connected')

  // Check what's in the store — use DrizzleIdeaStore directly
  const { DrizzleIdeaStore } = require('../../creativity/DrizzleIdeaStore')
  const store = new DrizzleIdeaStore()
  const all = store.getHypotheses()
  console.log(`\nTotal hypotheses in store: ${all.length}`)

  for (const h of all) {
    const score = (h.novelty || 0) + (h.feasibility || 0) + (h.impact || 0)
    console.log(`  [${h.status}] ${h.title} (score=${score} N${h.novelty} F${h.feasibility} I${h.impact})`)
  }

  // Run collector
  const collector = new CreativityCollector()
  if (!collector.shouldRun()) {
    console.log('\nCollector shouldRun() returned false (no store or too soon)')
  }

  const problems = await collector.collect()
  console.log(`\nCollector returned ${problems.length} problems`)

  if (problems.length === 0) {
    console.log('No feature candidates — nothing to implement.')
    console.log('\nTo seed ideas, run the creativity cycle first:')
    console.log('To seed ideas, run the creativity cycle first')
    return
  }

  for (const p of problems) {
    const meta = p.context.metadata || {}
    const score = parseInt(meta.novelty || '0') + parseInt(meta.feasibility || '0') + parseInt(meta.impact || '0')
    console.log(`\n  [${p.id}] ${p.title}`)
    console.log(`    score=${score} diff=${meta.implementationDifficulty} benefit=${meta.expectedBenefit}`)
    console.log(`    ${p.description.slice(0, 150)}`)
  }

  // Push top 1 to queue and execute
  const persistDir = join(tmpdir(), 'test_feature_queue')
  const queue = new ProblemQueue(persistDir)
  queue.push(problems)

  const top = queue.pop()
  if (!top) {
    console.log('\nQueue empty')
    return
  }

  console.log(`\n=== Implementing: ${top.title} ===`)
  console.log(`  ${top.description}`)

  const executor = new CreativityExecutor()
  console.time('implement')

  const result = await executor.execute(top)

  console.timeEnd('implement')
  console.log(`\n=== Result: ${result.success ? 'SUCCESS' : 'SKIP/FAILED'} ===`)
  console.log(`  Summary: ${result.summary}`)
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(0)}s`)
  if (result.output && result.output.length > 0) {
    console.log(`\n  Output:\n${result.output.slice(0, 1000)}`)
  }
  if (result.error) {
    console.log(`  Error: ${result.error}`)
  }
}

main().catch(console.error)
