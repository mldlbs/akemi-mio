/**
 * CreativityExecutor — 创意点子实现执行器
 *
 * 接收 CreativityCollector 采集的 feature Problem，
 * 使用 Agent SDK（DeepSeek 代理）生成代码实现。
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../../logger/Logger'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'
import { ideaStore } from '../../creativity'
import { credentialsManager } from '../../credentials/CredentialsManager'

export class CreativityExecutor implements FixExecutor {
  readonly name = 'creativity-agent'
  readonly supportedSources: ProblemSource[] = ['feature']
  readonly timeoutMs = 300_000

  private lastExecuteAt = 0
  private minIntervalMs = 30_000
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

    const hypothesisId = problem.context.metadata?.hypothesisId

    try {
      const prompt = this.buildPrompt(problem)

      log('INFO', 'creativity_exec_start', {
        problemId: problem.id,
        hypothesisId,
        title: problem.title,
      })

      let agentOutput = ''

      const llmKey = process.env.LLM_KEY || credentialsManager.get('llm_key') || ''
      if (!llmKey) {
        log('WARN', 'creativity_exec_no_key')
        return {
          problemId: problem.id,
          success: false,
          summary: 'LLM_KEY 未配置',
          durationMs: Date.now() - startedAt,
          error: 'NO_KEY',
        }
      }

      const baseEnv: Record<string, string> = {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_AUTH_TOKEN: llmKey,
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      }

      for await (const message of query({
        prompt,
        options: {
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          env: baseEnv,
        },
      })) {
        if (message.type === 'text' || message.type === 'content') {
          agentOutput += (message as any).text || (message as any).content || ''
        }
      }

      const elapsedMs = Date.now() - startedAt

      // 标记假设为 experimenting
      if (hypothesisId && ideaStore) {
        ideaStore.updateHypothesisStatus(hypothesisId, 'experimenting')
      }

      // 解析结果
      const resultMatch = agentOutput.match(/<result>([\s\S]*?)<\/result>/)
      const output = resultMatch ? resultMatch[1].trim() : agentOutput.slice(0, 500)
      const isSkip = /SKIP|ALREADY_EXISTS/i.test(agentOutput.slice(0, 300))

      log('INFO', 'creativity_exec_result', {
        problemId: problem.id,
        success: !isSkip,
        durationMs: elapsedMs,
      })

      return {
        problemId: problem.id,
        success: !isSkip,
        summary: output?.slice(0, 200) || (isSkip ? '已跳过(功能已存在或无需实现)' : '实现完成'),
        durationMs: elapsedMs,
        output: output?.slice(0, 1000),
      }
    } catch (err: any) {
      log('WARN', 'creativity_exec_failed', {
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
    const meta = problem.context.metadata || {}
    const perspectives = problem.context.snippet

    return [
      `# 实现以下功能特性`,
      ``,
      `**标题**: ${problem.title}`,
      `**描述**: ${problem.description}`,
      `**预期收益**: ${meta.expectedBenefit || '未知'}`,
      `**风险注意**: ${meta.risk || '无'}`,
      `**实现难度**: ${meta.implementationDifficulty || '3'}/5`,
      ``,
      ...(perspectives ? [`## 多视角评估`, ``, perspectives, ``] : []),
      `## 要求`,
      `- 先阅读现有相关代码，理解项目结构`,
      `- 保持现有代码风格和架构`,
      `- 如果功能已存在直接回复 ALREADY_EXISTS`,
      `- 如果是小功能可以直接实现`,
      `- 大功能（需多文件架构设计）回复 SKIP 并说明需要的架构决策`,
      `- 完成后运行 npx tsc --noEmit -p tsconfig.node.json 验证`,
      ``,
      `## 项目结构`,
      `- src/main/ — 主进程（Electron）`,
      `- src/renderer/ — 渲染进程（React）`,
      `- src/main/evolution/ — 自进化系统`,
      `- src/main/creativity/ — 创造力引擎（功能点子来源）`,
      `- src/main/tool/ — MCP 工具定义`,
      `- src/main/telegram/ — Telegram 推送`,
      `- src/main/llm/ — LLM 服务`,
      ``,
      `## 输出格式`,
      `在 \`<result>\` 标签内输出:`,
      `- SUCCESS: 实现了什么、新文件/修改了哪些文件`,
      `- SKIP: 为什么不能实现（太大/需决策/风险高）`,
      `- ALREADY_EXISTS: 功能已存在`,
    ].join('\n')
  }
}
