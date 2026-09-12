/**
 * Runtime RC Auto-Runner
 *
 * 独立运行的脚本，不依赖 Electron 窗口。
 * 通过 Mock LlmService 自动运行 Worker 产生事件流，推进 RC 阶段。
 *
 * 用法:
 *   npx tsx src/main/runtime/__tests__/RcAutoRunner.ts
 */

import { ServerManager } from '@akemi-mio/intelligence/mcp/ServerManager'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import { RuntimeManagerImpl } from '@akemi-mio/intelligence/runtime/RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '@akemi-mio/intelligence/runtime/SupervisedAgentSupervisorImpl'
import { RuntimeValidator } from '@akemi-mio/intelligence/runtime/RuntimeValidator'
import { ReplayRunner, SCENARIO_SINGLE_TASK, SCENARIO_PARALLEL_5 } from '@akemi-mio/intelligence/runtime/ReplayRunner'

// ── Mock LlmService — 不依赖真实 LLM API ──

const mockLlm = {
  setConfig: () => {},
  chatWithTools: async (): Promise<{ reply?: string; toolCalls?: ToolCallInfo[]; error?: string }> => ({
    reply: 'mock reply from auto-runner',
  }),
} as any

// ── 创建运行时组件 ──

const mcpManager = new ServerManager()
const supervisorFactory = () => new SupervisedAgentSupervisorImpl(mcpManager, 'mock_key', 'mock_key', mockLlm)
const mgr = new RuntimeManagerImpl(supervisorFactory)

const validator = new RuntimeValidator()
validator.start(mgr)

console.log('═══════════════════════════════════════════════')
console.log('  Runtime RC Auto-Runner')
console.log(`  Started: ${new Date().toISOString()}`)
console.log('═══════════════════════════════════════════════\n')

const runner = new ReplayRunner(mgr, validator)

// ── Phase 1: 标准场景（~16 Worker） ──

console.log('── Phase 1: Standard Scenarios ──\n')

await runner.runScenario(SCENARIO_SINGLE_TASK)
console.log('  ✅ single-task (1 worker)')

await runner.runScenario(SCENARIO_PARALLEL_5)
console.log('  ✅ parallel-5 (5 workers)')

// ── Phase 2: Battery (~80 Worker → 达到 100 门槛) ──

console.log('\n── Phase 2: Battery (pushing to RC-2 entry) ──\n')

const phase2 = await runner.runUntilPhase('rc-2_default', 10, 10)
console.log()
console.log(phase2.generateReport())
console.log()

// ── Phase 3: Scale to 500 if not blocked ──

if (!phase2.blocked && phase2.phase !== 'retirement_ready') {
  console.log('── Phase 3: Scaling to 500 workers ──\n')
  const final = await runner.runUntilPhase('retirement_ready', 25, 20)
  console.log()
  console.log(final.generateReport())
  console.log()

  if (final.blocked) {
    console.error('RC BLOCKED')
    process.exit(1)
  }
}

validator.stop()
console.log('Done.')
