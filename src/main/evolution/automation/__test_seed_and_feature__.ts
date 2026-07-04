/**
 * Trigger one creativity cycle to seed the IdeaStore, then run feature pipeline.
 *
 * npx tsx src/main/evolution/automation/__test_seed_then_feature__.ts
 */

import { CreativityCollector } from './CreativityCollector'
import { CreativityExecutor } from './CreativityExecutor'
import { ProblemQueue } from './ProblemQueue'
import { join } from 'path'
import { tmpdir } from 'os'

async function main() {
  const key = process.env.LLM_KEY
  if (!key) {
    console.error('✗ LLM_KEY not set')
    process.exit(1)
  }

  const { initDatabase } = require('../../db/connection')
  await initDatabase()
  console.log('✓ Database ready')

  // Build minimal deps for CreativityService
  const { initCreativity, creativityService } = require('../../creativity')
  const { LlmService } = require('../../llm/LlmService')
  const llm = new LlmService()

  // Minimal creativity init — just to get sources + cycle working
  const creativity = initCreativity(
    join(require('os').tmpdir(), 'test_creativity.json'),
    {
      getSources: () => [
        { name: '用户快速唤醒', content: '用户希望更快的语音唤醒响应', type: 'behavior' as const, weight: 0.8 },
        { name: '多轮对话记忆', content: '用户经常在连续对话中丢失上下文', type: 'insight' as const, weight: 0.7 },
        { name: 'TTS 冷启动慢', content: '首次语音合成延迟较高', type: 'knowledge' as const, weight: 0.6 },
        { name: 'Telegram 消息积压', content: 'Telegram outbox 在高峰期会积压消息', type: 'failure' as const, weight: 0.5 },
        { name: '后台任务可视化', content: '用户无法直观看到后台运行的任务', type: 'behavior' as const, weight: 0.4 },
        { name: '自动环境光适配', content: '不同光照条件下界面对比度不足', type: 'knowledge' as const, weight: 0.3 },
        { name: '全局快捷键冲突', content: '多个快捷键注册时缺少冲突检测', type: 'failure' as const, weight: 0.7 },
        { name: '插件热加载', content: '插件更新后需要重启才能生效', type: 'insight' as const, weight: 0.6 },
      ],
      getInsights: () => [],
      getFailedHypotheses: () => [],
    },
    llm.chatJson.bind(llm),
    0.3,
    join(require('os').tmpdir(), 'test_creativity_reports'),
  )

  console.log('\n=== Running creativity cycle (seeding ideas) ===')
  console.time('creativity-cycle')
  await creativity.cycle()
  console.timeEnd('creativity-cycle')

  // Read ideas from store
  const { DrizzleIdeaStore } = require('../../creativity/DrizzleIdeaStore')
  const store = new DrizzleIdeaStore()
  const all = store.getHypotheses()
  console.log(`\nTotal hypotheses: ${all.length}`)

  if (all.length === 0) {
    console.log('No ideas generated. Exiting.')
    return
  }

  for (const h of all) {
    const score = (h.novelty || 0) + (h.feasibility || 0) + (h.impact || 0)
    console.log(`  [${h.status}]${h.title} (score=${score} N${h.novelty} F${h.feasibility} I${h.impact})`)
  }

  // Now run the feature pipeline
  console.log('\n=== Running CreativityCollector ===')
  const collector = new CreativityCollector()
  // Override minInterval for test
  ;(collector as any).lastRun = 0
  ;(collector as any).minIntervalMs = 0

  const problems = await collector.collect()
  console.log(`Collector returned ${problems.length} feature problems`)

  if (problems.length === 0) {
    console.log('No candidates meet threshold.')
    return
  }

  // Show candidates
  for (const p of problems) {
    const meta = p.context.metadata || {}
    console.log(`  [${p.id}] ${p.title}`)
    console.log(`    ${(p.description || '').slice(0, 120)}`)
  }

  // Execute top 1
  const persistDir = join(tmpdir(), 'test_feature_queue')
  const queue = new ProblemQueue(persistDir)
  queue.push(problems)

  const top = queue.pop()
  if (!top) {
    console.log('Queue empty')
    return
  }

  console.log(`\n=== Implementing: ${top.title} ===`)
  console.log(`  ${top.description}`)

  const executor = new CreativityExecutor()
  console.time('implement')

  const result = await executor.execute(top)

  console.timeEnd('implement')
  console.log(`\n=== Result: ${result.success ? 'SUCCESS' : 'SKIP/FAILED'} ===`)
  console.log(`  Summary: ${result.summary?.slice(0, 500)}`)
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(0)}s`)
}

main().catch(console.error)
