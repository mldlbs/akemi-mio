/**
 * ToolGenerator — 自进化工具生成类型定义
 *
 * 定义 Agent 创建新工具流程中使用的数据结构。
 * 与 ToolEvolutionExecutor 的改进 Existing 工具不同，
 * ToolGenerator 是从零创建新工具（名称、描述、Schema、实现）。
 */

// =============================================================================
// 工具规格：LLM 生成的工具设计
// =============================================================================

/** LLM 生成的新工具完整规格 */
export interface ToolSpec {
  /** 工具名（snake_case，如 get_weather） */
  name: string
  /** 工具简短描述 */
  description: string
  /** 输入 JSON Schema */
  inputJSONSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  /** 生成的 TypeScript 实现源码 */
  sourceCode: string
  /** 纯 JavaScript handler 体（用于运行时 new Function 注册） */
  jsHandlerBody: string
  /** 该工具实现依赖的额外导入模块列表 */
  imports?: string[]
}

// =============================================================================
// 生成结果
// =============================================================================

/** 工具生成流程的最终结果 */
export interface GeneratedTool {
  /** 工具名 */
  name: string
  /** 工具描述 */
  description: string
  /** 输入 JSON Schema */
  inputJSONSchema: ToolSpec['inputJSONSchema']
  /** 生成的源文件路径 */
  sourcePath: string
  /** 注册时的提供者名 */
  providerName: string
  /** 生成时间戳 */
  createdAt: number
  /** tsc 是否通过 */
  tscPassed: boolean
}

/** 生成阶段状态 */
export type GeneratorPhase = 'generating_spec' | 'generating_code' | 'writing_file' | 'validating_tsc' | 'registering' | 'done' | 'failed'

/** 生成流程进度回调 */
export interface GeneratorProgress {
  phase: GeneratorPhase
  message: string
}

/** 生成请求参数 */
export interface GenerateToolRequest {
  /** 自然语言描述：需要什么功能的新工具 */
  need: string
  /** 可选：期望的工具名（snake_case） */
  preferredName?: string
  /** 可选：安全模式。auto=自动注册，review=仅生成文件不注册 */
  safetyMode?: 'auto' | 'review'
}

/** 生成结果 */
export interface GenerateToolResult {
  success: boolean
  tool?: GeneratedTool
  /** 失败时的错误信息 */
  error?: string
  /** 生成的源码（失败时也可查看） */
  sourceCode?: string
  /** 详细日志 */
  log?: string[]
}

// =============================================================================
// LLM 响应结构
// =============================================================================

/** LLM 返回的工具规格 JSON */
export interface LlmToolSpecResponse {
  name: string
  description: string
  inputSchema: {
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

/** LLM 返回的工具实现代码 JSON */
export interface LlmToolCodeResponse {
  sourceCode: string
  imports: string[]
}
