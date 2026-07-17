/**
 * ReasoningChainTools — 推理链 MCP 工具
 *
 * MCP 不直接输出结果，而是生成一条推理路径（中间步骤链），
 * Plan 系统沿着这条路径逐步验证和执行。
 *
 * MCP 负责任务分解和优先级排序，
 * Plan 负责每一步的细节执行，
 * 最终结果由 Plan 汇总返回。
 *
 * ── 推理链步骤 ──
 * 1. MCP: 分析任务 → 分解为推理步骤（带依赖关系）
 * 2. Plan: 按优先级逐步骤执行
 * 3. Plan: 验证每步结果后推进到下一步
 * 4. Plan: 汇总所有步骤结果
 *
 * ── 关联 System ──
 * - ReasonPlanner: 认知思维模式选择
 * - ReasoningChainExecutor: 领域推理链 ASR/Piper/Songge
 *   本工具是通用任务分解推理链，供 Plan 系统使用
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getObserverService, getPlanManager } from '../deps'
import { log } from '../../logger/Logger'

// =============================================================================
// 类型定义
// =============================================================================

export interface ReasoningStepSpec {
  index: number
  description: string
  reasoning: string
  dependencies: number[]
  verificationCriteria: string
}

export interface ReasoningChainSpec {
  title: string
  summary: string
  priority: number
  steps: ReasoningStepSpec[]
}

export interface ReasoningChainStatus {
  id: string
  title: string
  planId: string
  totalSteps: number
  completedSteps: number
  status: 'active' | 'completed' | 'failed' | 'abandoned'
}

// =============================================================================
// 常量
// =============================================================================

const DECOMPOSE_SYSTEM_PROMPT = `你是一个任务分解专家。请将用户给出的复杂任务分解为推理链（中间步骤链）。

你的输出必须是严格的 JSON 格式，不要包含任何其他文字：

{
  "title": "任务标题（10字以内）",
  "summary": "任务概述（50字以内）",
  "priority": 0,
  "steps": [
    { "index": 0, "description": "步骤0的描述", "reasoning": "为什么需要这一步", "dependencies": [], "verificationCriteria": "如何验证完成" }
  ]
}

要求：
- 步骤按执行顺序排列，总共 3-8 个步骤
- dependencies 列出前置步骤索引（无依赖则 []）
- priority: 0=普通任务, 1=重要任务, 2=紧急/高优任务
- 步骤覆盖完整任务周期：分析 → 实施 → 验证 → 收尾`

function getFallbackSteps(task: string): ReasoningChainSpec {
  return {
    title: task.slice(0, 30),
    summary: task.slice(0, 100),
    priority: 0,
    steps: [
      { index: 0, description: '分析现有代码和相关系统', reasoning: '了解当前架构和实现细节是实施的基础', dependencies: [], verificationCriteria: '确认目录结构、关键文件职责和调用关系' },
      { index: 1, description: '设计实施方案', reasoning: '明确改动范围和接口定义，避免返工', dependencies: [0], verificationCriteria: '输出清晰的实施步骤和接口变更清单' },
      { index: 2, description: '实现核心逻辑', reasoning: '按设计方案编写代码', dependencies: [1], verificationCriteria: '核心功能可运行，通过基本测试' },
      { index: 3, description: '集成与测试', reasoning: '确保新逻辑与现有系统正确协作', dependencies: [2], verificationCriteria: '完整功能链路可用，无回归问题' },
      { index: 4, description: '验证与收尾', reasoning: '检查代码质量、清理调试代码、更新文档', dependencies: [3], verificationCriteria: '代码审查通过，构建无错误' },
    ],
  }
}

function parseReasoningChain(raw: string): ReasoningChainSpec | null {
  try {
    return JSON.parse(raw) as ReasoningChainSpec
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*"steps"[\s\S]*\}/)
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]) as ReasoningChainSpec } catch { return null }
    }
    return null
  }
}

function validateReasoningChain(spec: ReasoningChainSpec): boolean {
  if (!spec.title || !spec.summary || typeof spec.priority !== 'number') return false
  if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 12) return false
  for (const step of spec.steps) {
    if (typeof step.index !== 'number') return false
    if (!step.description || step.description.length < 2) return false
    if (!step.reasoning) return false
    if (!Array.isArray(step.dependencies)) return false
    if (!step.verificationCriteria) return false
  }
  const indices = new Set(spec.steps.map((s) => s.index))
  for (const step of spec.steps) {
    for (const dep of step.dependencies) {
      if (!indices.has(dep)) return false
    }
  }
  return true
}

// =============================================================================
// create_reasoning_chain — 创建推理链
// =============================================================================

export const createReasoningChainTool = buildTool({
  name: 'create_reasoning_chain',
  description:
    '将复杂任务分解为推理链（中间步骤链）。MCP 不负责任何执行，只做任务分析和优先级排序，' +
    '生成的推理链交给 Plan 系统逐步验证和执行。每个步骤包含推理依据、依赖关系和验证标准。' +
    '返回推理链 ID 和总步骤数，供后续 update_plan_progress / complete_plan 使用。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '要分解的复杂任务描述' },
      context: { type: 'string', description: '可选的附加上下文' },
      priority: { type: 'number', description: '可选的优先级覆盖 0=普通 1=高 2=紧急' },
    },
    required: ['task'],
  },
  handler: async (args: { task: string; context?: string; priority?: number }) => {
    try {
      const task = args.task.trim()
      if (task.length < 4) return formatToolError('任务描述太短，至少需要 4 个字符')
      if (task.length > 2000) return formatToolError('任务描述过长，请限制在 2000 字符以内')

      const pm = getPlanManager()
      if (!pm) return formatToolError('Plan 管理器尚未就绪，推理链需要 Plan 系统支撑')

      let chainSpec: ReasoningChainSpec | null = null
      const os = getObserverService()
      const llm = os?.getLlm?.()
      const useLlm = llm?.isLoaded

      if (useLlm) {
        const maxRetries = 2
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const contextBlock = args.context ? '\n附加上下文:\n' + args.context + '\n' : ''
            const decomposePrompt = '请分析以下任务并分解为推理链 JSON格式：\n\n任务: ' + task + contextBlock

            const result = await llm.generate(decomposePrompt, {
              system: DECOMPOSE_SYSTEM_PROMPT,
              temperature: 0.3,
              maxTokens: 4096,
            })

            if (result.data) {
              const parsed = parseReasoningChain(result.data)
              if (parsed && validateReasoningChain(parsed)) {
                chainSpec = parsed
                break
              }
            }

            if (attempt === maxRetries) {
              log('WARN', 'reasoning_chain_parse_failed', { task: task.slice(0, 60), rawOutput: result.data?.slice(0, 200) })
            }
          } catch (err: any) {
            log('WARN', 'reasoning_chain_llm_attempt_failed', { attempt, error: err.message })
          }
        }
      }

      if (!chainSpec) {
        log('INFO', 'reasoning_chain_fallback', { reason: useLlm ? 'llm_output_unparseable' : 'llm_unavailable', task: task.slice(0, 60) })
        chainSpec = getFallbackSteps(task)
      }

      if (args.priority !== undefined && [0, 1, 2].includes(args.priority)) {
        chainSpec.priority = args.priority
      }

      const stepDescriptions = chainSpec.steps.map((s) => {
        const depNote = s.dependencies.length > 0 ? '[依赖步骤 ' + s.dependencies.join(', ') + '] ' : ''
        return depNote + s.description
      })

      const planTitle = '推理链: ' + chainSpec.title
      const planLines = ['[推理链] ' + chainSpec.summary]
      planLines.push('优先级: ' + (chainSpec.priority === 0 ? '普通' : chainSpec.priority === 1 ? '高' : '紧急'))
      planLines.push('')
      for (const s of chainSpec.steps) {
        planLines.push('步骤 ' + s.index + ': ' + s.description)
        planLines.push('  推理: ' + s.reasoning)
        planLines.push('  验证: ' + s.verificationCriteria)
        planLines.push('')
      }
      const planDescription = planLines.join('\n')

      const plan = pm.createPlan(planTitle, planDescription, stepDescriptions, chainSpec.priority)

      const chainId = 'rc_' + plan.id + '_' + Date.now()
      const lines: string[] = [
        '推理链已生成 --- ' + chainSpec.title,
        '',
        '概要: ' + chainSpec.summary,
        'Plan ID: ' + plan.id,
        '推理链 ID: ' + chainId,
        '优先级: ' + (chainSpec.priority === 0 ? '普通' : chainSpec.priority === 1 ? '高' : '紧急'),
        '总步骤数: ' + chainSpec.steps.length,
        '',
        '--- 推理步骤 ---',
        '',
      ]

      for (const step of chainSpec.steps) {
        const depStr = step.dependencies.length > 0 ? ' 依赖步骤 ' + step.dependencies.join(', ') : '起始步骤'
        lines.push('步骤 ' + step.index + ': ' + depStr)
        lines.push('  ' + step.description)
        lines.push('  推理: ' + step.reasoning)
        lines.push('  验证: ' + step.verificationCriteria)
        lines.push('')
      }

      lines.push('---')
      lines.push('提示：创建计划后请使用已有的 Plan 工具依次执行各步骤')
      lines.push('  list_plans               - 查看活跃计划')
      lines.push('  update_plan_progress     - 更新步骤状态')
      lines.push('  complete_plan            - 完成计划并汇总结果')
      lines.push('  abandon_plan             - 放弃计划')

      log('INFO', 'reasoning_chain_created', { planId: plan.id, chainId, steps: chainSpec.steps.length, priority: chainSpec.priority, llmUsed: !!useLlm, title: chainSpec.title })

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      log('ERROR', 'reasoning_chain_failed', { error: err.message })
      return formatToolError('创建推理链失败: ' + err.message)
    }
  },
  isReadOnly: false,
})

export const reasoningChainTools = [createReasoningChainTool] as const
