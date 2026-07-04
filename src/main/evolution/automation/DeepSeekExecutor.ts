/**
 * DeepSeekExecutor — 使用 DeepSeek (SubAgentPool) 修复（备用执行器）
 *
 * Claude Code CLI 不可用时自动降级到此执行器。
 */

import { log } from '../../logger/Logger'
import type { ServerManager } from '../../mcp/ServerManager'
import type { SubAgentPool } from '../../agent/SubAgentPool'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'

export class DeepSeekExecutor implements FixExecutor {
  readonly name = 'deepseek-agent'
  readonly supportedSources: ProblemSource[] = ['tsc']
  readonly timeoutMs = 180_000

  private pool: SubAgentPool | null = null
  private lastExecuteAt = 0
  private minIntervalMs = 5_000
  private busy = false

  constructor(mcpManager?: ServerManager) {
    if (mcpManager) {
      const { SubAgentPool: Pool } = require('../../agent/SubAgentPool')
      this.pool = new Pool(mcpManager)
    }
  }

  /** 延迟注入 pool（init 时 mcpManager 可能还没就绪） */
  setPool(pool: SubAgentPool): void {
    this.pool = pool
  }

  isAvailable(): boolean {
    if (this.busy) return false
    if (!this.pool) return false
    if (Date.now() - this.lastExecuteAt < this.minIntervalMs) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    if (!this.pool) {
      this.busy = false
      return {
        problemId: problem.id,
        success: false,
        summary: 'SubAgentPool 未就绪',
        durationMs: Date.now() - startedAt,
        error: 'pool_not_ready',
      }
    }

    try {
      const prompt = [
        `# 修复以下 TypeScript 编译错误`,
        ``,
        `**文件**: ${problem.file || '(未知)'}${problem.line ? `:${problem.line}` : ''}`,
        `**错误**: ${problem.title}`,
        `**详情**: ${problem.description}`,
        ``,
        `## 要求`,
        `1. 使用 Read 工具读取相关文件`,
        `2. 使用 Edit 或 Write 工具修复错误`,
        `3. 完成后运行 \`npx tsc --noEmit -p tsconfig.node.json\` 验证`,
        `4. 如果问题已不存在，回复 SKIP`,
        ``,
        `## 输出格式`,
        `在 \`<result>\` 标签内输出:`,
        `- SUCCESS: 修复了哪些文件、如何修复的`,
        `- SKIP: 问题已不存在`,
        `- FAILED: 无法修复，说明原因`,
      ].join('\n')

      log('INFO', 'deepseek_fix_start', { problemId: problem.id })

      const result = await this.pool.spawnTask(prompt, undefined, {
        maxTurns: 10,
        llmTimeoutMs: this.timeoutMs,
        allowedToolNames: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      })

      const elapsedMs = Date.now() - startedAt
      const summary = result.summary || ''
      const outputMatch = summary.match(/<result>([\s\S]*?)<\/result>/)
      const output = outputMatch ? outputMatch[1].trim() : summary.slice(0, 500)
      const isSuccess = result.status === 'completed' && !/FAILED/i.test(summary.slice(0, 200))
      const isSkip = /SKIP/i.test(summary.slice(0, 200))

      log('INFO', 'deepseek_fix_result', {
        problemId: problem.id,
        success: isSuccess && !isSkip,
        status: result.status,
        durationMs: elapsedMs,
      })

      return {
        problemId: problem.id,
        success: isSuccess && !isSkip,
        summary: output?.slice(0, 200) || (isSkip ? '已跳过(问题已不存在)' : summary.slice(0, 200)),
        durationMs: elapsedMs,
        output,
        error: result.error,
      }
    } catch (err: any) {
      return {
        problemId: problem.id,
        success: false,
        summary: `执行异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: err.message,
      }
    } finally {
      this.busy = false
    }
  }
}
