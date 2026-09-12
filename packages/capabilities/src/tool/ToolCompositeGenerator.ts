/**
 * ToolCompositeGenerator — 复合工具生成器
 *
 * ## 职责
 * 将频繁出现的工具调用序列封装为一步到位的复合 MCP 工具。
 *
 * ## 流程
 * 1. 接收来自 PatternMiner 的频繁序列（BehaviorPattern）
 * 2. 为序列生成复合工具的函数名、描述、输入 Schema
 * 3. 生成 handler：按序调用每个子工具，传递结果
 * 4. 通过 DynamicToolLifecycle 注册到运行时
 * 5. 生成 review 提案供人工审核
 *
 * ## 示例
 * 输入序列: grep → read_file → edit_file
 * 输出工具: search_and_edit
 *  - 输入: { pattern, filePath, editContent }
 *  - handler: 调用 grep → 从结果提取文件名 → 调用 read_file → 调用 edit_file
 *
 * ## 与 ToolGeneratorService 的关系
 * ToolGeneratorService 通过 LLM 从自然语言生成工具，
 * ToolCompositeGenerator 通过确定性模板从序列生成复合工具。
 * 两者互补：复合工具使用确定性 handler 包装，更可靠。
 *
 * @module tool
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getAllTools } from './index'
import { formatToolResult, formatToolError } from './types'
import { dynamicToolLifecycle } from './dynamic/DynamicToolLifecycle'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { BehaviorPattern, PatternStep } from '@akemi-mio/evolution/behavior/types'

// =============================================================================
// 类型定义
// =============================================================================

/** 复合工具提案状态 */
export type ProposalStatus = 'pending_review' | 'approved' | 'rejected' | 'auto_registered'

/** 复合工具提案 */
export interface CompositeToolProposal {
  /** 提案唯一 ID */
  id: string
  /** 生成时间 */
  createdAt: number
  /** 工具名 */
  toolName: string
  /** 工具描述 */
  description: string
  /** 输入 JSON Schema */
  inputJSONSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  /** 源工具序列 */
  toolSequence: string[]
  /** 该序列在挖掘窗口中的出现次数 */
  frequency: number
  /** 支持度 */
  support: number
  /** 置信度（历史成功率） */
  confidence: number
  /** 来源模式 ID（用于关联 PatternMiner） */
  patternId: string
  /** 审核状态 */
  status: ProposalStatus
  /** 审核时间 */
  reviewedAt?: number
  /** 审核意见 */
  reviewNote?: string
  /** 注册后的提供者名 */
  providerName?: string
  /** 关联的会话 ID */
  sessionId: string
}

/** 复合工具注册结果 */
export interface CompositeRegistrationResult {
  success: boolean
  toolName: string
  providerName?: string
  error?: string
}

/** 复合工具生成配置 */
export interface CompositeGenConfig {
  /** 提案存储文件路径（相对于 project root） */
  proposalsFile: string
  /** 自动注册的置信度阈值（≥此值可跳过审核） */
  autoRegisterConfidence: number
  /** 复合工具名最大长度 */
  maxToolNameLength: number
  /** 复合工具会话 ID */
  sessionId: string
  /** 是否启用审核模式 */
  reviewMode: boolean
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: CompositeGenConfig = {
  proposalsFile: '.claude/composite_tool_proposals.json',
  autoRegisterConfidence: 0.85,
  maxToolNameLength: 48,
  sessionId: 'session_composite_tools',
  reviewMode: true,
}

// =============================================================================
// 工具名 ↔ 参数映射（用于生成复合工具的输入 Schema）
// =============================================================================

/**
 * 常用工具的输入参数映射。
 * 用于从序列中推断复合工具需要哪些输入参数。
 */
const TOOL_INPUT_MAP: Record<string, { params: Record<string, string>; label: string }> = {
  grep: {
    params: { pattern: 'string' },
    label: '搜索模式',
  },
  read_file: {
    params: { path: 'string' },
    label: '文件路径',
  },
  write_file: {
    params: { path: 'string', content: 'string' },
    label: '写入文件',
  },
  edit_file: {
    params: { path: 'string', old_string: 'string', new_string: 'string' },
    label: '编辑文件',
  },
  run_command: {
    params: { command: 'string' },
    label: '执行命令',
  },
  list_files: {
    params: { path: 'string' },
    label: '列出文件',
  },
  search: {
    params: { query: 'string' },
    label: '搜索内容',
  },
  remember_fact: {
    params: { key: 'string', value: 'string' },
    label: '记忆事实',
  },
  analyze_codebase: {
    params: { query: 'string' },
    label: '分析代码库',
  },
  planning: {
    params: { goal: 'string' },
    label: '制定计划',
  },
}

// =============================================================================
// 静态工具 —— 工具名 → handler 映射（避免动态 import）
// =============================================================================

/** 预构建的工具名到 handler 的映射（运行时快速查找） */
let _toolHandlerCache: Map<string, (args: Record<string, any>) => Promise<any>> | null = null

function getToolHandlerMap(): Map<string, (args: Record<string, any>) => Promise<any>> {
  if (_toolHandlerCache) return _toolHandlerCache
  _toolHandlerCache = new Map()
  try {
    const tools = getAllTools()
    for (const tool of tools) {
      _toolHandlerCache.set(tool.name, tool.handler)
    }
  } catch {
    log('WARN', 'composite_tool_handler_cache_failed')
  }
  return _toolHandlerCache
}

// =============================================================================
// ToolCompositeGenerator
// =============================================================================

export class ToolCompositeGenerator {
  private config: CompositeGenConfig
  private proposals: CompositeToolProposal[] = []
  private proposalsLoaded = false

  constructor(config?: Partial<CompositeGenConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /**
   * 从 BehaviorPattern 生成复合工具。
   * 按 reviewMode 配置决定是直接注册还是先生成提案。
   *
   * @param pattern PatternMiner 挖掘到的频繁序列模式
   * @returns 注册结果或提案
   */
  async generateFromPattern(pattern: BehaviorPattern): Promise<CompositeToolProposal | CompositeRegistrationResult> {
    const toolName = this.buildToolName(pattern.toolSignature)
    const description = this.buildDescription(pattern)
    const inputJSONSchema = this.buildInputSchema(pattern)

    const proposal: CompositeToolProposal = {
      id: `composite_${toolName}_${Date.now()}`,
      createdAt: Date.now(),
      toolName,
      description,
      inputJSONSchema,
      toolSequence: pattern.toolSignature,
      frequency: pattern.frequency,
      support: pattern.support,
      confidence: pattern.confidence,
      patternId: pattern.id,
      status: 'pending_review',
      sessionId: this.config.sessionId,
    }

    // 高置信度 + 非审核模式 → 自动注册
    if (!this.config.reviewMode || pattern.confidence >= this.config.autoRegisterConfidence) {
      const result = await this.registerCompositeTool(proposal)
      if (result.success) {
        proposal.status = 'auto_registered'
        proposal.providerName = result.providerName
      }
      this.saveProposal(proposal)
      return result
    }

    // 审核模式 → 保存提案待审
    proposal.status = 'pending_review'
    this.saveProposal(proposal)

    log('INFO', 'composite_tool_proposal_created', {
      toolName,
      sequence: proposal.toolSequence.join(' → '),
      frequency: proposal.frequency,
      confidence: proposal.confidence,
    })

    return proposal
  }

  /**
   * 审核并注册复合工具。
   *
   * @param proposalId 提案 ID
   * @param approved 是否批准
   * @param note 审核意见
   * @returns 注册结果
   */
  async reviewProposal(proposalId: string, approved: boolean, note?: string): Promise<CompositeRegistrationResult> {
    this.loadProposals()
    const proposal = this.proposals.find((p) => p.id === proposalId)
    if (!proposal) {
      return { success: false, toolName: '', error: `提案 ${proposalId} 未找到` }
    }

    if (!approved) {
      proposal.status = 'rejected'
      proposal.reviewedAt = Date.now()
      proposal.reviewNote = note || '人工驳回'
      this.saveProposals()
      log('INFO', 'composite_tool_rejected', { toolName: proposal.toolName, note })
      return { success: true, toolName: proposal.toolName, error: '已驳回' }
    }

    // 批准 → 注册
    const result = await this.registerCompositeTool(proposal)
    if (result.success) {
      proposal.status = 'approved'
      proposal.reviewedAt = Date.now()
      proposal.reviewNote = note || '人工批准'
      proposal.providerName = result.providerName
      this.saveProposals()
    }

    return result
  }

  /**
   * 获取所有待审核的复合工具提案。
   */
  getPendingProposals(): CompositeToolProposal[] {
    this.loadProposals()
    return this.proposals.filter((p) => p.status === 'pending_review')
  }

  /**
   * 获取所有已注册的复合工具。
   */
  getRegisteredProposals(): CompositeToolProposal[] {
    this.loadProposals()
    return this.proposals.filter((p) => p.status === 'approved' || p.status === 'auto_registered')
  }

  /**
   * 获取所有复合工具提案。
   */
  getAllProposals(): CompositeToolProposal[] {
    this.loadProposals()
    return [...this.proposals]
  }

  /**
   * 清除历史提案。
   */
  clearProposals(): void {
    this.proposals = []
    this.saveProposals()
    log('INFO', 'composite_tool_proposals_cleared')
  }

  /**
   * 更新配置。
   */
  setConfig(partial: Partial<CompositeGenConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * 获取当前配置。
   */
  getConfig(): Readonly<CompositeGenConfig> {
    return { ...this.config }
  }

  // =========================================================================
  // 复合工具注册
  // =========================================================================

  /**
   * 注册复合工具到运行时。
   * 生成一个 handler，按序调用每个子工具并传递结果。
   */
  private async registerCompositeTool(proposal: CompositeToolProposal): Promise<CompositeRegistrationResult> {
    try {
      const { toolName, description, inputJSONSchema, toolSequence } = proposal

      // 构建复合 handler：按序调用每个子工具
      const handler = async (args: Record<string, any>): Promise<any> => {
        const results: string[] = []
        const currentArgs = { ...args }

        for (let i = 0; i < toolSequence.length; i++) {
          const stepToolName = toolSequence[i]
          const stepArgs = this.buildStepArgs(stepToolName, currentArgs, i, toolSequence)
          try {
            const toolHandler = getToolHandlerMap().get(stepToolName)
            if (!toolHandler) {
              results.push(`[步骤 ${i + 1}/${toolSequence.length}] ${stepToolName}: ❌ 工具未注册`)
              continue
            }
            const stepResult = await toolHandler(stepArgs)
            const resultText = typeof stepResult === 'string' ? stepResult : JSON.stringify(stepResult)
            results.push(`[步骤 ${i + 1}/${toolSequence.length}] ${stepToolName}: ✅ 完成`)
            // 将上一步的结果中提取关键信息传递给下一步
            currentArgs._previousResult = resultText.slice(0, 1000)
          } catch (err: any) {
            results.push(`[步骤 ${i + 1}/${toolSequence.length}] ${stepToolName}: ❌ ${err.message}`)
            // 步骤失败不再继续执行后续步骤
            break
          }
        }

        return formatToolResult(
          `【复合工具: ${toolName}】\n` + `工具序列: ${toolSequence.join(' → ')}\n` + `执行结果:\n${results.join('\n')}`,
        )
      }

      // 注册到 DynamicToolLifecycle
      const providerName = dynamicToolLifecycle.registerTool(
        this.config.sessionId,
        toolName,
        description,
        inputJSONSchema as any,
        handler,
        ['composite', 'auto_generated'],
      )

      log('INFO', 'composite_tool_registered', {
        toolName,
        providerName,
        sequence: toolSequence.join(' → '),
        frequency: proposal.frequency,
      })

      return { success: true, toolName, providerName }
    } catch (err: any) {
      log('ERROR', 'composite_tool_register_failed', {
        toolName: proposal.toolName,
        error: err.message,
      })
      return { success: false, toolName: proposal.toolName, error: err.message }
    }
  }

  // =========================================================================
  // 内部方法：工具名 & 描述 & Schema 生成
  // =========================================================================

  /**
   * 从工具序列生成复合工具名。
   * 例如 ["grep", "read_file", "edit_file"] → "search_and_edit"
   */
  private buildToolName(toolSequence: string[]): string {
    if (toolSequence.length === 0) return 'composite_tool'

    // 常用工具名 → 动词映射
    const verbMap: Record<string, string> = {
      grep: 'search',
      read_file: 'read',
      write_file: 'write',
      edit_file: 'edit',
      run_command: 'exec',
      list_files: 'list',
      search: 'find',
      remember_fact: 'remember',
      analyze_codebase: 'analyze',
      planning: 'plan',
      generate_image: 'gen_image',
      create_dev_plan: 'create_plan',
    }

    // 取前两个工具生成名字
    const verbs = toolSequence.slice(0, 2).map((t) => verbMap[t] || t.replace(/_/g, ''))
    let name = verbs.join('_and_')

    // 加上尾缀表示复合
    if (toolSequence.length > 2) {
      name = name + '_multi'
    }

    // 控制长度
    if (name.length > this.config.maxToolNameLength) {
      name = name.slice(0, this.config.maxToolNameLength)
    }

    // 确保以字母开头
    if (!/^[a-zA-Z]/.test(name)) {
      name = 'z_' + name
    }

    return name
  }

  /**
   * 生成复合工具的描述。
   */
  private buildDescription(pattern: BehaviorPattern): string {
    const seq = pattern.toolSignature.join(' → ')
    const freq = pattern.frequency
    const conf = (pattern.confidence * 100).toFixed(0)
    return `复合工具: ${seq}（历史出现 ${freq} 次，成功率 ${conf}%）。将 ${pattern.toolSignature.length} 步操作合并为一步调用。`
  }

  /**
   * 从工具序列生成输入 Schema。
   * 合并所有子工具的参数定义，去重同名参数。
   */
  private buildInputSchema(pattern: BehaviorPattern): CompositeToolProposal['inputJSONSchema'] {
    const properties: Record<string, { type: string; description: string }> = {}
    const required: string[] = []

    for (let i = 0; i < pattern.toolSignature.length; i++) {
      const toolName = pattern.toolSignature[i]
      const step = pattern.steps[i]

      // 从步骤的 paramTemplate 中获取参数
      if (step && step.paramTemplate) {
        for (const [key] of Object.entries(step.paramTemplate)) {
          if (!properties[key]) {
            properties[key] = {
              type: 'string',
              description: `参数 ${key}（${toolName} 步骤需要）`,
            }
            if (!key.startsWith('_')) {
              required.push(key)
            }
          } else {
            // 补充描述
            properties[key].description += `；也用于 ${toolName}`
          }
        }
      }

      // 从 TOOL_INPUT_MAP 补全缺失的参数定义
      const inputDef = TOOL_INPUT_MAP[toolName]
      if (inputDef) {
        for (const [paramName, paramType] of Object.entries(inputDef.params)) {
          if (!properties[paramName]) {
            properties[paramName] = {
              type: paramType,
              description: `${inputDef.label}（${toolName} 需要）`,
            }
            if (['path', 'pattern', 'query', 'command', 'content'].includes(paramName)) {
              if (!required.includes(paramName)) required.push(paramName)
            }
          } else {
            // 已在 properties 中，确保在 required 中
            if (!paramName.startsWith('_') && !required.includes(paramName)) {
              required.push(paramName)
            }
          }
        }
      }
    }

    // 去重 required
    const uniqueRequired = [...new Set(required)]

    return {
      type: 'object',
      properties,
      required: uniqueRequired,
    }
  }

  /**
   * 为某一步构建参数。
   * 从用户传入的共享参数中提取该步骤需要的参数，
   * 同时传入上一步结果（如果可用）。
   */
  private buildStepArgs(
    stepToolName: string,
    sharedArgs: Record<string, any>,
    stepIndex: number,
    toolSequence: string[],
  ): Record<string, any> {
    const stepArgs: Record<string, any> = {}

    // 从 TOOL_INPUT_MAP 获取该工具所需的参数名
    const inputDef = TOOL_INPUT_MAP[stepToolName]
    const neededParams = inputDef ? Object.keys(inputDef.params) : []

    // 从共享参数中提取该步骤需要的
    if (neededParams.length > 0) {
      for (const param of neededParams) {
        if (sharedArgs[param] !== undefined) {
          stepArgs[param] = sharedArgs[param]
        }
      }
    } else {
      // 没有定义参数映射时，传递所有共享参数
      Object.assign(stepArgs, sharedArgs)
    }

    // 如果是第一步（grep/search）且有 pattern 但没有 path，是正常的
    // 如果是第二步（read_file）且第一步是 grep，用上一步结果推断路径
    if (stepIndex > 0 && stepToolName === 'read_file' && !stepArgs.path) {
      // 如果上一步结果中有文件名信息但无法可靠提取，
      // 用户需要在共享参数中提供 path
      // 这里不做自动推断（避免不可靠）
    }

    // 注入上一步结果上下文
    if (sharedArgs._previousResult) {
      stepArgs._context = sharedArgs._previousResult
    }

    return stepArgs
  }

  // =========================================================================
  // 提案持久化
  // =========================================================================

  /**
   * 从磁盘加载提案。
   */
  private loadProposals(): void {
    if (this.proposalsLoaded) return
    try {
      const filePath = join(process.cwd(), this.config.proposalsFile)
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.proposals = data
        }
      }
    } catch {
      this.proposals = []
    }
    this.proposalsLoaded = true
  }

  /**
   * 保存单条提案到磁盘。
   */
  private saveProposal(proposal: CompositeToolProposal): void {
    this.loadProposals()
    const idx = this.proposals.findIndex((p) => p.id === proposal.id)
    if (idx >= 0) {
      this.proposals[idx] = proposal
    } else {
      this.proposals.push(proposal)
    }
    this.saveProposals()
  }

  /**
   * 持久化所有提案到磁盘。
   */
  private saveProposals(): void {
    try {
      const filePath = join(process.cwd(), this.config.proposalsFile)
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(filePath, JSON.stringify(this.proposals, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'composite_tool_proposals_save_failed', { error: err.message })
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolCompositeGenerator = new ToolCompositeGenerator()

