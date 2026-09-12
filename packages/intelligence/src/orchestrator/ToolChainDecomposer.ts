/**
 * ToolChainDecomposer — LLM 驱动的任务分解器
 *
 * 职责：
 * 1. 接收用户自然语言请求
 * 2. 查询当前所有可用的 MCP 工具列表（含 schema）
 * 3. 使用 LLM 将请求分解为多个子步骤
 * 4. 为每个子步骤匹配合适的工具
 * 5. 推断步骤间的依赖关系
 * 6. 返回结构化 DecompositionResult
 *
 * ## 分解策略
 * - 每个步骤对应一个工具调用或纯 LLM 推理
 * - 工具匹配基于工具名称、描述和输入 schema
 * - 依赖推断基于：输出是否作为下游输入、逻辑时序关系
 * - 无依赖的步骤标记为可并行执行
 *
 * ## 使用示例
 * const decomposer = new ToolChainDecomposer(llmService, () => serverManager.getAllSchemas())
 * const result = await decomposer.decompose('帮我查北京的天气并设置一个 8 点的闹钟')
 * // result.steps = [
 * //   { id: 's1', name: '查询北京天气', toolName: 'get_weather', args: { city: '北京' }, dependsOn: [] },
 * //   { id: 's2', name: '设置 8 点闹钟', toolName: 'set_alarm', args: { time: '08:00' }, dependsOn: [] },
 * // ]
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'
import type { DecompositionResult, OrchestratorConfig } from '@akemi-mio/intelligence/orchestrator/types'

/** 工具 schema 摘要（工具选择器的输入） */
interface ToolSummary {
  name: string
  description: string
  parameters: string
  required: string[]
}

/** 分解配置 */
export interface DecomposerConfig {
  /** 温度参数（低 = 更确定性的分解） */
  temperature: number
}

const DEFAULT_DECOMPOSER_CONFIG: DecomposerConfig = {
  temperature: 0.2,
}

/**
 * ToolChainDecomposer — 任务分解器。
 * 使用 LLM 将用户请求分解为子步骤，并为每步匹配工具。
 */
export class ToolChainDecomposer {
  private llmService: LlmService
  /** 获取当前所有工具 schemas 的回调 */
  private getToolSchemas: () => ToolSummary[]
  private config: DecomposerConfig

  constructor(llmService: LlmService, getToolSchemas: () => ToolSummary[], config?: Partial<DecomposerConfig>) {
    this.llmService = llmService
    this.getToolSchemas = getToolSchemas
    this.config = { ...DEFAULT_DECOMPOSER_CONFIG, ...config }
  }

  /** 更新配置 */
  updateConfig(patch: Partial<DecomposerConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  /**
   * 将用户请求分解为可执行的子步骤。
   *
   * @param userRequest 用户原始请求
   * @param config 可选的运行时配置覆盖
   * @returns 分解结果（步骤列表）
   */
  async decompose(userRequest: string, config?: Partial<OrchestratorConfig>): Promise<DecompositionResult> {
    const tools = this.getToolSchemas()

    // 如果用户请求太短或无需分解，直接返回单步骤
    if (this.isSimpleRequest(userRequest)) {
      log('INFO', 'decomposer_simple_request', { request: userRequest.slice(0, 100) })
      return {
        reasoning: '简单请求，无需分解。',
        steps: [
          {
            id: 's1',
            name: '执行任务',
            description: userRequest,
            dependsOn: [],
            toolName: '',
            args: {},
          },
        ],
      }
    }

    const systemPrompt = this.buildSystemPrompt(tools)
    const userPrompt = this.buildUserPrompt(userRequest)

    log('INFO', 'decomposer_start', {
      requestLength: userRequest.length,
      availableTools: tools.length,
    })

    try {
      const result = await this.llmService.chatJson(userPrompt, {
        system: systemPrompt,
        temperature: config?.decompositionTemperature ?? this.config.temperature,
        timeoutMs: 30000,
      })

      if (result.error || !result.data) {
        log('WARN', 'decomposer_llm_failed', { error: result.error })
        return this.fallbackDecomposition(userRequest)
      }

      const parsed = result.data as DecompositionResult

      // 验证分解结果的完整性
      if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        log('WARN', 'decomposer_empty_steps', { data: JSON.stringify(parsed).slice(0, 200) })
        return this.fallbackDecomposition(userRequest)
      }

      // 为每个步骤填充 ID（如果缺失）
      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i]
        step.id = step.id || `s${i + 1}`
        step.args = step.args || {}
        step.dependsOn = step.dependsOn || []
      }

      log('INFO', 'decomposer_success', {
        steps: parsed.steps.length,
        stepNames: parsed.steps.map((s) => s.name).join(', '),
        tools: parsed.steps
          .filter((s) => s.toolName)
          .map((s) => s.toolName)
          .join(', '),
      })

      return parsed
    } catch (err: any) {
      log('ERROR', 'decomposer_error', { error: err.message })
      return this.fallbackDecomposition(userRequest)
    }
  }

  /**
   * 构建分解用 system prompt。
   * 包含当前所有可用工具的信息。
   */
  private buildSystemPrompt(tools: ToolSummary[]): string {
    const toolList = tools
      .map((t) => `- ${t.name}: ${t.description}\n  参数: ${t.parameters}\n  必需: ${t.required.join(', ') || '无'}`)
      .join('\n')

    return `你是一个智能任务分解器。你的职责是：
1. 分析用户的自然语言请求
2. 将其分解为多个顺序或可并行的子步骤
3. 为每个步骤匹配最合适的可用工具
4. 确定步骤之间的依赖关系（dependsOn）

## 可用工具列表
${toolList || '（当前没有可用工具，所有步骤将作为纯 LLM 推理步骤）'}

## 分解规则
- 每个步骤应该完成一个原子操作
- 如果某步骤依赖前序步骤的输出，在 dependsOn 中声明
- 不依赖任何其他步骤的步骤可以并行执行（dependsOn: []）
- 如果找不到合适的工具，将 toolName 设为空字符串（纯 LLM 推理）
- 每个步骤的 args 应该包含工具调用所需的所有参数

## 输出格式（必须是合法 JSON，不要用 markdown 围栏）
{
  "reasoning": "简短说明你的分解思路",
  "steps": [
    {
      "id": "s1", "name": "步骤名称",
      "description": "步骤详细描述",
      "dependsOn": [],
      "toolName": "匹配的工具名或空字符串",
      "args": { "参数名": "参数值" }
    }
  ]
}`
  }

  /** 构建用户请求 prompt */
  private buildUserPrompt(request: string): string {
    return `请分解以下用户请求为可执行的子步骤：

用户请求: "${request}"

请分析这个请求需要哪些步骤完成，为每个步骤匹配合适的工具，并确定依赖关系。`
  }

  /** 简单请求检测（单句短请求或打招呼） */
  private isSimpleRequest(text: string): boolean {
    const trimmed = text.trim()
    // 打招呼、简短问答
    if (trimmed.length < 8) return true
    // 纯情感表达
    if (/^(你好|早安|晚安|谢谢|好的|嗯|哦|哈[哈喽]?)$/.test(trimmed)) return true
    return false
  }

  /** LLM 失败时的兜底分解（将整个请求作为一个步骤） */
  private fallbackDecomposition(userRequest: string): DecompositionResult {
    return {
      reasoning: 'LLM 分解失败，将整个请求作为单个步骤执行。',
      steps: [
        {
          id: 's1',
          name: '处理请求',
          description: userRequest,
          dependsOn: [],
          toolName: '',
          args: {},
        },
      ],
    }
  }
}

/**
 * 从 MCP 工具 schema 列表转换为 ToolSummary 的工具函数。
 * 与 ServerManager.getAllSchemas() 的输出兼容。
 */
export function toToolSummaries(
  schemas: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] }
    }
  }>,
): ToolSummary[] {
  return schemas.map((s) => ({
    name: s.function.name,
    description: s.function.description,
    parameters: Object.entries(s.function.parameters.properties || {})
      .map(([key, val]) => `${key}: ${val.type}${val.description ? ` - ${val.description}` : ''}`)
      .join('; '),
    required: s.function.parameters.required || [],
  }))
}
