/**
 * Runtime pipeline integration test for Telegram notification verification
 *
 * Uses existing runtime components (EventBus, TelegramService subscribers).
 * Run: npx tsx src/main/evolution/automation/__test_pipeline_full__.ts
 */

import { PipelineOrchestrator } from './PipelineOrchestrator'
import { TscCollector } from './TscCollector'
import { ClaudeCodeExecutor } from './ClaudeCodeExecutor'
import { join } from 'path'
import { tmpdir } from 'os'
import { eventBus } from '../../core/EventBus'

async function main() {
  const hasKey = process.env.LLM_KEY
  if (!hasKey) {
    console.error('✗ LLM_KEY not set')
    process.exit(1)
  }
  console.log(`✓ LLM_KEY found (${hasKey.slice(0, 8)}...)`)

  // Create pipeline (no fallback executor, no mcp manager needed)
  const persistDir = join(tmpdir(), 'test_pipeline_run')
  const pipeline = new PipelineOrchestrator({
    projectRoot: process.cwd(),
    persistDir,
    maxFixesPerCycle: 2,
  })
  pipeline.addCollector(new TscCollector(process.cwd()))
  pipeline.addExecutor(new ClaudeCodeExecutor())

  // Hook to stdout events for visibility
  eventBus.on('pipeline.started', (p) => {
    console.log('\n[EVENT] pipeline.started')
    const time = new Date(p.timestamp).toLocaleString('zh-CN', { hour12: false })
    console.log(`  timestamp: ${time}`)
  })

  eventBus.on('pipeline.completed', (p) => {
    console.log('\n[EVENT] pipeline.completed')
    console.log(`  collected: ${p.collected}`)
    console.log(`  fixed: ${p.fixed}`)
    console.log(`  failed: ${p.failed}`)
    console.log(`  queueRemaining: ${p.queueRemaining}`)
    console.log(`  durationMs: ${p.durationMs}`)
    for (const d of p.details) {
      const icon = d.success ? '✅' : '❌'
      const loc = d.file ? d.file.split('/').pop() + (d.line ? `:${d.line}` : '') : 'unknown'
      console.log(`  ${icon} [${d.source}] ${loc} (${(d.durationMs / 1000).toFixed(0)}s)`)
      console.log(`     ${d.summary.slice(0, 120)}`)
    }
  })

  eventBus.on('pipeline.errored', (p) => {
    console.log('\n[EVENT] pipeline.errored')
    console.log(`  error: ${p.error}`)
  })

  console.log('\n=== Running PipelineOrchestrator.runOnce() ===')
  console.time('pipeline')

  const metrics = await pipeline.runOnce()

  console.timeEnd('pipeline')
  console.log(`\n=== Pipeline Complete ===`)
  console.log(`  collected: ${metrics.totalCollected}`)
  console.log(`  fixed: ${metrics.totalFixed}`)
  console.log(`  failed: ${metrics.totalFailed}`)
  console.log(`  queueSize: ${metrics.queueSize}`)
}

main().catch(console.error)
