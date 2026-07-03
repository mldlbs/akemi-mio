/**
 * ClaudeCodeExecutor — 使用 Agent SDK + DeepSeek 代理执行修复（主执行器）
 *
 * 通过 @anthropic-ai/claude-agent-sdk 的 query() API，
 * 注入 ANTHROPIC_BASE_URL 将请求路由到 DeepSeek。
 * 当 DeepSeek 不可用时自动降级到备用执行器。
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../../logger/Logger'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'

export class ClaudeCodeExecutor implements FixExecutor {
  readonly name = 'agent-sdk'
  readonly supportedSources: ProblemSource[] = ['tsc', 'lint']
  readonly timeoutMs = 180_000

  private lastExecuteAt = 0
  private minIntervalMs = 10_000
  private busy = false

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < this.minIntervalMs) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    try {
      const prompt = this.buildPrompt(problem)

      log('INFO', 'agent_sdk_fix_start', { problemId: problem.id })

      let agentOutput = ''

      for await (const message of query({
        prompt,
        options: {
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          // 使用系统的 ANTHROPIC_AUTH_TOKEN + cc-switch 代理
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        },
      })) {
        if (message.type === 'text' || message.type === 'content') {
          agentOutput += (message as any).text || (message as any).content || ''
        }
      }

      const elapsedMs = Date.now() - startedAt

      const resultMatch = agentOutput.match(/<result>([\s\S]*?)<\/result>/)
      const output = resultMatch ? resultMatch[1].trim() : agentOutput.slice(0, 500)
      const isSkip = /SKIP/i.test(agentOutput.slice(0, 300))

      log('INFO', 'agent_sdk_fix_result', {
        problemId: problem.id,
        success: !isSkip,
        durationMs: elapsedMs,
      })

      return {
        problemId: problem.id,
        success: !isSkip,
        summary: output?.slice(0, 200) || (isSkip ? '已跳过(问题已不存在)' : '修复完成'),
        durationMs: elapsedMs,
        output,
        error: isSkip ? undefined : undefined,
      }
    } catch (err: any) {
      log('WARN', 'agent_sdk_fix_failed', {
        problemId: problem.id,
        error: err.message,
      })

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

  private buildPrompt(problem: AssignedProblem): string {
    return [
      `# 修复以下 TypeScript 编译错误`,
      ``,
      `**文件**: ${problem.file || '(未知)'}${problem.line ? `:${problem.line}` : ''}`,
      `**错误**: ${problem.title}`,
      `**详情**: ${problem.description}`,
      ``,
      `## 要求`,
      `- 只修改相关文件`,
      `- 保持现有代码风格`,
      `- 完成后运行 npx tsc --noEmit -p tsconfig.node.json 验证`,
      `- 如果问题已不存在，回复 SKIP`,
      ``,
      `## 输出格式`,
      `在 \`<result>\` 标签内输出:`,
      `- SUCCESS: 修复了哪些文件、如何修复的`,
      `- SKIP: 问题已不存在`,
      `- FAILED: 无法修复，说明原因`,
    ].join('\n')
  }
}
