/**
 * 真实执行测试：Agent SDK + DeepSeek 代理全链路
 *
 * 运行管道：TscCollector → ProblemQueue → ClaudeCodeExecutor (Agent SDK)
 * 用法： npx tsx src/main/evolution/automation/__test_fix__.ts
 */

import { TscCollector } from './TscCollector'
import { ProblemQueue } from './ProblemQueue'
import { ClaudeCodeExecutor } from './ClaudeCodeExecutor'
import { join } from 'path'
import { tmpdir } from 'os'

async function main() {
  const hasAuth = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY
  if (!hasAuth) {
    console.error('✗ ANTHROPIC_AUTH_TOKEN 未设置（需要 cc-switch 代理）')
    process.exit(1)
  }
  console.log(`✓ Auth found (${process.env.ANTHROPIC_AUTH_TOKEN ? 'AUTH_TOKEN' : 'API_KEY'})`)

  // Collect
  const memStart = process.memoryUsage().heapUsed / 1024 / 1024
  console.log('\n=== Collecting tsc errors ===')
  const collector = new TscCollector(process.cwd())
  const allProblems = await collector.collect()
  console.log(`Found ${allProblems.length} problems`)

  if (allProblems.length === 0) {
    console.log('No tsc errors found, nothing to fix.')
    return
  }

  // Queue
  const tmpPersist = join(tmpdir(), 'test_problem_queue')
  const queue = new ProblemQueue(tmpPersist)
  queue.push(allProblems)

  // Pop top
  const problem = queue.pop()
  if (!problem) {
    console.log('Queue empty, nothing to fix.')
    return
  }

  console.log(`\n=== Fixing: ${problem.title} ===`)
  console.log(`  File: ${problem.file}:${problem.line}`)
  console.log(`  Description: ${problem.description}`)

  // Execute via Agent SDK + DeepSeek
  const executor = new ClaudeCodeExecutor()
  console.log('\n=== Executing Agent SDK (DeepSeek proxy) ===')
  console.time('fix')

  const result = await executor.execute(problem)

  console.timeEnd('fix')
  console.log(`\n=== Result: ${result.success ? 'SUCCESS' : 'FAILED'} ===`)
  console.log(`  Summary: ${result.summary}`)
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  if (result.output) {
    // Show last 500 chars of output
    const short = result.output.length > 500 ? '...' + result.output.slice(-500) : result.output
    console.log(`\n  Output:\n${short}`)
  }
  if (result.error) {
    console.log(`  Error: ${result.error}`)
  }

  // Re-check
  if (result.success) {
    console.log('\n=== Re-checking tsc ===')
    const remaining = await collector.collect()
    const sameSource = remaining.filter((p) => p.file === problem.file && p.line === problem.line)
    if (sameSource.length === 0) {
      console.log('✓ Problem fixed, no longer in tsc output')
    } else {
      console.log(`✗ Problem persists: ${sameSource.length} similar errors`)
    }
    console.log(`Remaining tsc problems: ${remaining.length}`)
  }

  const memEnd = process.memoryUsage().heapUsed / 1024 / 1024
  console.log(`\nMemory: ${memStart.toFixed(0)}MB → ${memEnd.toFixed(0)}MB`)
}

main().catch(console.error)
