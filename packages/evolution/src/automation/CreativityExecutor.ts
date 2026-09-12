/**
 * CreativityExecutor — 创意点子实现执行器
 *
 * 接收 CreativityCollector 采集的 feature Problem，
 * 使用 Agent SDK（DeepSeek 代理）生成代码实现。
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { CreativityWorkspace } from './CreativityWorkspace'
import { log } from '@akemi-mio/core/logger/Logger'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'
import { ideaStore } from '@akemi-mio/creativity'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'

export class CreativityExecutor implements FixExecutor {
  readonly name = 'creativity-agent'
  readonly supportedSources: ProblemSource[] = ['feature']
  readonly timeoutMs = 300_000

  private lastExecuteAt = 0
  private minIntervalMs = 30_000
  private busy = false
  private workspace: CreativityWorkspace

  constructor(workspace?: CreativityWorkspace) {
    this.workspace = workspace ?? new CreativityWorkspace()
  }

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < this.minIntervalMs) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    // 独立工作区隔离：agent 在 worktree 里改文件，主仓库/主应用零接触
    const isolated = process.env.CREATIVITY_EXEC_ISOLATED !== '0'
    let execCwd = process.cwd()
    if (isolated) {
      try {
        execCwd = await this.workspace.ensure()
      } catch (err: any) {
        log('WARN', 'creativity_workspace_ensure_failed', { error: err.message, fallback: 'main' })
      }
    }

    const hypothesisId = problem.context.metadata?.hypothesisId

    try {
      const prompt = this.buildPrompt(problem)

      log('INFO', 'creativity_exec_start', {
        problemId: problem.id,
        hypothesisId,
        title: problem.title,
        cwd: execCwd,
        isolated,
      })

      let agentOutput = ''

      const { code } = getRuntimeLlmConfig({ getCredential: (key) => credentialsManager.get(key) })
      const llmKey = code.apiKey
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
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1841',
        ANTHROPIC_MODEL: code.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: code.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: code.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: code.model,
        CLAUDE_CODE_SUBAGENT_MODEL: code.model,
      }

      for await (const message of query({
        prompt,
        options: {
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          env: baseEnv,
          cwd: execCwd,
        },
      })) {
        if (message.type === 'assistant') {
          agentOutput += message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
        } else if (message.type === 'result' && message.subtype === 'success') {
          agentOutput = message.result
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

      // 落地：把 worktree 改动安全应用到主仓库（主仓库脏时 patch 落盘待人工 review）
      if (isolated && execCwd !== process.cwd()) {
        try {
          const deliver = await this.workspace.deliver(problem.id, problem.title)
          log('INFO', 'creativity_exec_delivered', {
            problemId: problem.id,
            applied: deliver.applied,
            changedFiles: deliver.changedFiles.length,
            reason: deliver.reason,
            patchPath: deliver.patchPath,
            committed: deliver.committed,
            commitSha: deliver.commitSha,
          })
        } catch (err: any) {
          log('WARN', 'creativity_exec_deliver_failed', { problemId: problem.id, error: err.message })
        }
      }

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
      `- packages/evolution/src/ — 自进化系统`,
      `- packages/creativity/src/ — 创造力引擎（功能点子来源）`,
      `- packages/capabilities/src/tool/ — MCP 工具定义`,
      `- packages/messaging/src/telegram/ — Telegram 推送`,
      `- packages/intelligence/src/llm/ — LLM 服务`,
      ``,
      `## 输出格式`,
      `在 \`<result>\` 标签内输出:`,
      `- SUCCESS: 实现了什么、新文件/修改了哪些文件`,
      `- SKIP: 为什么不能实现（太大/需决策/风险高）`,
      `- ALREADY_EXISTS: 功能已存在`,
    ].join('\n')
  }
}
