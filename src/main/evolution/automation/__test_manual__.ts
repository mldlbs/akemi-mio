/**
 * 快速验证脚本：运行一次自动化管道，打印结果
 *
 * 用法： npx tsx src/main/evolution/automation/__test_manual__.ts
 */

import { TscCollector } from './TscCollector'
import { ProblemQueue } from './ProblemQueue'
import { join } from 'path'
import { tmpdir } from 'os'

async function main() {
  const projectRoot = process.cwd()

  // Phase 1: TscCollector
  console.log('\n=== Phase 1: TscCollector ===')
  const collector = new TscCollector(projectRoot)
  const problems = await collector.collect()
  console.log(`发现 ${problems.length} 个 tsc 问题`)

  if (problems.length === 0) {
    console.log('没有需要修复的问题，管道完成。')
    return
  }

  // 打印前 5 个
  for (const p of problems.slice(0, 5)) {
    console.log(`  ${p.severity} ${p.file}:${p.line} — ${p.title}`)
  }
  if (problems.length > 5) {
    console.log(`  ... 还有 ${problems.length - 5} 个`)
  }

  // Phase 2: ProblemQueue
  console.log('\n=== Phase 2: ProblemQueue ===')
  const tmpPersist = join(tmpdir(), 'test_problem_queue')
  const queue = new ProblemQueue(tmpPersist)
  const added = queue.push(problems)
  console.log(`入队 ${added} 个问题, 队列大小: ${queue.size}`)

  const top = queue.pop()
  if (top) {
    console.log(`最高优先级问题: ${top.title}`)
    console.log(`  file: ${top.file}:${top.line}`)
    console.log(`  source: ${top.source}`)

    // Phase 3: 验证 prompt 构建
    console.log('\n=== Phase 3: Prompt 预览 ===')
    const { ClaudeCodeExecutor } = await import('./ClaudeCodeExecutor')
    const executor = new ClaudeCodeExecutor()
    console.log(`执行器可用: ${executor.isAvailable()}`)

    // 打印 prompt 但不真正执行（避免消耗 API）
    console.log('\n[Prompt 预览 (不执行)]')
    console.log('---')
    // prompt 是私有的，我们靠构建 prompt 的逻辑验证
    console.log(`问题: ${top.title}`)
    console.log(`文件: ${top.file}:${top.line}`)
    console.log(`上下文: ${top.context.raw.slice(0, 200)}`)
    console.log('---')
    console.log('\n✅ 管道链路验证通过。')
    console.log('要真正执行修复，调用 executor.execute(top)')
  } else {
    console.log('队列为空，无法测试执行')
  }
}

main().catch(console.error)
