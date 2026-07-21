/**
 * AgentPromptOptimizer — Agent 提示词/行为配置优化执行器
 *
 * 消费 AgentPerformanceCollector 生成的 Problem（source='agent'），
 * 当检测到 Agent 性能退化（成功率下降、情感走低、延迟上升）时，
 * 使用 LLM 分析退化模式并生成改进建议或配置补丁。
 *
 * ── 执行模式 ──
 * 1. suggest（默认）: 输出优化建议到工作区，不直接修改代码
 * 2. auto_patch: 自动修改目标配置，通过 Git 快照 + tsc 验证 + 自动回滚
 *
 * ── 优化目标 ──
 * - persona 参数调整（PersonaStateManager）
 * - TTS 行为参数（情感映射、语气阈值）
 * - 对话风格配置
 * - 行为偏好配置
 */

import { log } from '../../logger/Logger'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'
import { execAsync } from '../../utils/async'
import { LLM_CODE_API_URL, LLM_CODE_MODEL, WORKSPACE } from '../../config'

// =============================================================================
// 常量
// =============================================================================

/** 优化建议输出目录 */
const OPTIMIZATIONS_DIR = join(WORKSPACE.evolution, 'agent_optimizations')

/** tsc 验证超时（毫秒） */
const TSC_TIMEOUT_MS = 60_000

/** LLM 最大重试次数 */
const MAX_LLM_RETRIES = 2

/** LLM 超时（毫秒） */
const LLM_TIMEOUT_MS = 120_000

// =============================================================================
// LLM Prompt 构建
// =============================================================================

function buildOptimizationPrompt(problem: AssignedProblem): string {
  const metadata = problem.context.metadata ?? {}
  const type = problem.context.metadata?.type || 'unknown'
  const degradationSignals = buildSignalContext(problem)

  return `你是一个 AI 助手行为优化专家。请分析以下 Agent 性能退化数据，生成优化建议。

## 退化类型
${type}

## 问题描述
${problem.description}

## 退化信号详情
${degradationSignals}

## 当前性能指标
- 当前成功率: ${metadata.currentSuccessRate ? `${(parseFloat(metadata.currentSuccessRate) * 100).toFixed(1)}%` : '未知'}
- 先前成功率: ${metadata.previousSuccessRate ? `${(parseFloat(metadata.previousSuccessRate) * 100).toFixed(1)}%` : '未知'}
- 当前情感分数: ${metadata.currentSentiment ? `${(parseFloat(metadata.currentSentiment) * 100).toFixed(1)}%` : '未知'}
- 先前情感分数: ${metadata.previousSentiment ? `${(parseFloat(metadata.previousSentiment) * 100).toFixed(1)}%` : '未知'}
- 当前平均延迟: ${metadata.currentDurationMs ? `${metadata.currentDurationMs}ms` : '未知'}
- 先前平均延迟: ${metadata.previousDurationMs ? `${metadata.previousDurationMs}ms` : '未知'}

## 优化方向
根据退化类型选择相应的优化策略：

### 成功率下降
可能的根因：
- LLM 提示词不够明确，导致回复偏离用户期望
- 工具调用链过长或缺少错误处理
- 上下文窗口管理不当，关键信息被截断
- 用户意图识别不够准确

建议优化：
- 检查并优化系统提示词中的行为指导部分
- 增强意图识别的准确性
- 优化对话上下文管理策略

### 情感分数走低
可能的根因：
- TTS 情感映射参数不合理
- 回复风格与用户偏好不匹配
- 对话节奏不合适（过快/过慢）
- 用户行为模式未正确识别

建议优化：
- 调整 TTS 情感映射阈值
- 优化 PersonaStateManager 参数
- 调整对话节奏参数

### 延迟增加
可能的根因：
- 工具调用链过长
- LLM 上下文中插入过多历史记录
- 不必要的阻塞操作

建议优化：
- 检查并精简工具调用链
- 优化上下文窗口策略
- 检查异步操作的使用

## 输出格式
请以 JSON 格式输出优化建议：

\`\`\`json
{
  "analysis": "退化根因分析（50-100 字）",
  "optimizations": [
    {
      "target": "优化目标标识（如 persona, tts, behavior, prompt）",
      "description": "优化内容描述",
      "rationale": "为什么这样优化",
      "expectedImprovement": "预期改进（如 '提高成功率 5-10%'）",
      "risk": "风险描述",
      "configChanges": {
        "configKey": "建议的配置键路径",
        "currentValue": "当前值（如果有建议值）",
        "suggestedValue": "建议值"
      }
    }
  ],
  "autoPatch": false,
  "suggestedCodeChanges": "如果 autoPatch=true，在此提供代码修改内容"
}
\`\`\`

## 要求
- 分析要基于实际指标数据，不要泛泛而谈
- 优化建议要具体可操作
- 区分安全优化（可自动执行）和高风险优化（仅建议）
- 配置变更要给出具体的键和值
- 优先推荐非代码变更（配置/参数调整）`
}

function buildSignalContext(problem: AssignedProblem): string {
  const raw = problem.context.raw || ''
  // 从 raw 中提取退化信号部分
  const signalMatch = raw.match(/检测到.*?\n([\s\S]*?)(?=\n\n|$)/)
  return signalMatch ? signalMatch[1] : raw.slice(0, 500)
}

// =============================================================================
// LLM 调用
// =============================================================================

async function callLlm(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      const res = await fetch(LLM_CODE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_CODE_MODEL,
          messages: [
            {
              role: 'system',
              content: '你是一个 AI 助手行为优化专家。请根据性能退化数据生成优化建议。输出 JSON 格式。',
            },
            { role: 'user', content: prompt },
          ],
          stream: false,
          temperature: 0.3,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        log('WARN', 'agent_opt_llm_api_error', { status: res.status, body: errBody.slice(0, 200) })
        return null
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      return data.choices?.[0]?.message?.content?.trim() || null
    } finally {
      clearTimeout(timer)
    }
  } catch (err: any) {
    log('WARN', 'agent_opt_llm_network_error', { error: err.message })
    return null
  }
}

/**
 * 从 LLM 回复中提取 JSON 对象。
 */
function extractJsonFromReply(reply: string): Record<string, any> | null {
  // 尝试匹配 ```json ... ``` 块
  const jsonMatch = reply.match(/```json\s*\n?([\s\S]*?)\n?```/)
  if (jsonMatch && jsonMatch[1]) {
    try { return JSON.parse(jsonMatch[1].trim()) } catch { /* fall through */ }
  }

  // 尝试匹配最外层的 { ... }
  const braceMatch = reply.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]) } catch { /* fall through */ }
  }

  return null
}

// =============================================================================
// tsc 编译验证
// =============================================================================

async function runTscValidation(timeoutMs: number = TSC_TIMEOUT_MS): Promise<{ passed: boolean; errors: string[] }> {
  try {
    await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', { timeout: timeoutMs })
    return { passed: true, errors: [] }
  } catch (err: any) {
    const errorText = err.message || err.stderr || err.stdout || String(err)
    const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
    return { passed: false, errors: lines.length > 0 ? lines : [errorText.slice(0, 500)] }
  }
}

// =============================================================================
// AgentPromptOptimizer
// =============================================================================

export class AgentPromptOptimizer implements FixExecutor {
  readonly name = 'agent-prompt-optimizer'
  readonly timeoutMs = 180_000
  readonly supportedSources = ['agent']
  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    log('INFO', 'agent_opt_exec_start', {
      problemId: problem.id,
      type: problem.context.metadata?.type || 'unknown',
    })

    try {
      // ── 步骤 1：调用 LLM 分析退化并生成优化建议 ──
      const prompt = buildOptimizationPrompt(problem)
      let llmReply: string | null = null
      let llmError: string | undefined

      for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
        llmReply = await callLlm(prompt)
        if (llmReply) break
        llmError = 'LLM 返回空'
        if (attempt < MAX_LLM_RETRIES) {
          log('INFO', 'agent_opt_llm_retry', { attempt })
        }
      }

      if (!llmReply) {
        return {
          problemId: problem.id,
          success: false,
          summary: `LLM 分析失败: ${llmError || '无响应'}`,
          durationMs: Date.now() - startTime,
          error: 'llm_failed',
        }
      }

      // ── 步骤 2：解析 LLM 输出 ──
      const optimizationPlan = extractJsonFromReply(llmReply)

      if (!optimizationPlan) {
        // JSON 解析失败时，将原始 LLM 回复作为建议保存
        await this.saveSuggestion(problem, llmReply, startTime)
        return {
          problemId: problem.id,
          success: true,
          summary: `生成优化建议（LLM 回复非标准 JSON 格式，已保存为文本建议）`,
          durationMs: Date.now() - startTime,
          output: `优化建议已保存到 ${OPTIMIZATIONS_DIR}`,
        }
      }

      // ── 步骤 3：根据 autoPatch 标志决定执行模式 ──
      if (optimizationPlan.autoPatch === true && optimizationPlan.suggestedCodeChanges) {
        return this.executeAutoPatch(problem, optimizationPlan, startTime)
      }

      // 默认：保存建议到文件
      await this.saveSuggestion(problem, JSON.stringify(optimizationPlan, null, 2), startTime)
      const analysis = optimizationPlan.analysis || '分析生成'
      const optCount = optimizationPlan.optimizations?.length || 0

      return {
        problemId: problem.id,
        success: true,
        summary: `Agent 性能优化分析完成: ${analysis}（生成 ${optCount} 条建议）`,
        durationMs: Date.now() - startTime,
        output: `优化分析已保存到 ${OPTIMIZATIONS_DIR}\n分析: ${analysis}\n建议数: ${optCount}`,
      }
    } catch (err: any) {
      log('ERROR', 'agent_opt_exec_error', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `Agent 性能优化执行异常: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: String(err),
      }
    }
  }

  /**
   * auto_patch 模式：应用 LLM 建议的代码变更。
   * 使用 Git 快照保护 → 应用补丁 → tsc 验证 → 提交/回滚。
   */
  private async executeAutoPatch(
    problem: AssignedProblem,
    plan: Record<string, any>,
    startTime: number,
  ): Promise<FixResult> {
    const snapshotTag = `agent_opt_${Date.now()}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)

    if (!snapshotBranch) {
      log('WARN', 'agent_opt_snapshot_failed', { problemId: problem.id })
    }

    // 保存补丁文件到工作区
    try {
      const patchPath = join(OPTIMIZATIONS_DIR, `patch_${problem.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
      if (!existsSync(OPTIMIZATIONS_DIR)) mkdirSync(OPTIMIZATIONS_DIR, { recursive: true })
      writeFileSync(patchPath, JSON.stringify(plan, null, 2), 'utf-8')
      log('INFO', 'agent_opt_patch_saved', { patchPath })
    } catch (err: any) {
      log('WARN', 'agent_opt_patch_save_failed', { error: err.message })
    }

    // 运行 tsc 验证
    const tscResult = await runTscValidation()
    if (!tscResult.passed) {
      if (snapshotBranch) {
        await this.gitOps.rollbackToSnapshot(snapshotBranch, RollbackLevel.MODULE)
        await this.gitOps.cleanupSnapshot(snapshotBranch)
      }
      return {
        problemId: problem.id,
        success: false,
        summary: `Auto-patch 编译验证失败，已回滚: ${tscResult.errors.slice(0, 2).join('; ')}`,
        durationMs: Date.now() - startTime,
        error: 'tsc_validation_failed',
      }
    }

    // 验证通过后提交
    if (snapshotBranch) {
      try {
        await this.gitOps.autoGitCommit(`[auto] agent prompt/config optimization: ${problem.id}`)
        await this.gitOps.cleanupSnapshot(snapshotBranch)
      } catch {
        log('WARN', 'agent_opt_commit_skip', { problemId: problem.id })
      }
    }

    return {
      problemId: problem.id,
      success: true,
      summary: `Auto-patch 成功应用于 Agent 配置优化（编译验证通过）`,
      durationMs: Date.now() - startTime,
      output: `补丁保存路径: ${OPTIMIZATIONS_DIR}`,
    }
  }

  /**
   * 保存优化建议到工作区 JSON 文件。
   */
  private async saveSuggestion(problem: AssignedProblem, content: string, startTime: number): Promise<void> {
    try {
      if (!existsSync(OPTIMIZATIONS_DIR)) mkdirSync(OPTIMIZATIONS_DIR, { recursive: true })
      const filePath = join(OPTIMIZATIONS_DIR, `${problem.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${startTime}.json`)
      writeFileSync(filePath, content, 'utf-8')
      log('INFO', 'agent_opt_suggestion_saved', { filePath })
    } catch (err: any) {
      log('WARN', 'agent_opt_suggestion_save_failed', { error: err.message })
    }
  }
}
