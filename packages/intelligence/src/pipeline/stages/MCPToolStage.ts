/**
 * pipeline/stages/MCPToolStage — MCP 工具执行 Stage
 *
 * 将 MCP Tool 的调用封装为流水线中的一环：
 * - 从 JSON 配置中读取工具名 + 参数
 * - 通过 toolProviderRegistry 查找并执行对应工具
 * - 输出工具执行结果（包含输出文本、元数据等）
 *
 * 这使得 MCP 工具的调用可以被流水线编排（依赖、缓存、重放），
 * 并能将工具的输出直接传递给下游 ASR 处理等环节。
 *
 * 使用方式（pipeline JSON）：
 * {
 *   "id": "mcp-exec",
 *   "stageType": "mcp-tool-execution",
 *   "config": {
 *     "toolName": "read_file",
 *     "toolArgs": { "path": "{{pipeline.filePath}}" },
 *     "timeoutMs": 30000
 *   }
 * }
 *
 * 参数模板支持：
 * - {{pipeline.xxx}} — 从 pipelineInput 中取值
 * - {{stage.stageId.xxx}} — 从指定上游 stage 的输出中取值
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { toolProviderRegistry } from '@akemi-mio/capabilities/tool/registry'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

/** 参数模板占位符正则 */
const TEMPLATE_REGEX = /\{\{(\w+)\.([\w.]+)\}\}/g

/**
 * 解析参数字符串，替换模板占位符为实际值。
 *
 * 支持的占位符：
 * - {{pipeline.xxx}}      → pipelineInput 中的 xxx 字段
 * - {{stage.stageId.xxx}} → 上游 stageId 输出的 xxx 字段
 */
function resolveTemplate(
  template: string,
  pipelineInput: Readonly<Record<string, unknown>>,
  stageInputs: ReadonlyMap<string, StageOutput>,
): string {
  return template.replace(TEMPLATE_REGEX, (_match, prefix, path) => {
    if (prefix === 'pipeline') {
      const val = getNestedValue(pipelineInput, path)
      return val !== undefined ? String(val) : ''
    }
    if (prefix === 'stage') {
      const dotIdx = path.indexOf('.')
      if (dotIdx === -1) return ''
      const stageId = path.slice(0, dotIdx)
      const fieldPath = path.slice(dotIdx + 1)
      const stageOutput = stageInputs.get(stageId)
      if (!stageOutput) return ''
      const val = getNestedValue(stageOutput.data, fieldPath)
      return val !== undefined ? String(val) : ''
    }
    return ''
  })
}

/**
 * 递归获取嵌套对象属性值。
 * 如 getNestedValue({ a: { b: 'v' } }, 'a.b') → 'v'
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * 深度解析配置对象中的所有模板字符串。
 */
function resolveConfig(
  config: Record<string, unknown>,
  pipelineInput: Readonly<Record<string, unknown>>,
  stageInputs: ReadonlyMap<string, StageOutput>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      resolved[key] = resolveTemplate(value, pipelineInput, stageInputs)
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveConfig(value as Record<string, unknown>, pipelineInput, stageInputs)
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

export class MCPToolStage implements StageExecutor {
  readonly stageType = 'mcp-tool-execution'

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()

    // 解析配置
    const resolvedConfig = resolveConfig(config, ctx.pipelineInput, ctx.inputs)
    const toolName = resolvedConfig.toolName as string
    const toolArgs = (resolvedConfig.toolArgs as Record<string, unknown>) ?? {}
    const timeoutMs = (resolvedConfig.timeoutMs as number) ?? 30000

    if (!toolName) {
      return {
        stageId: 'mcp-tool-execution',
        data: {
          success: false,
          error: 'Missing toolName in stage config',
          toolName: '',
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    // 从注册表查找工具
    const tool = toolProviderRegistry.getTool(toolName)
    if (!tool) {
      log('WARN', 'pipeline_mcp_tool_not_found', { toolName })
      return {
        stageId: 'mcp-tool-execution',
        data: {
          success: false,
          error: `MCP tool "${toolName}" not found in registry`,
          toolName,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    log('INFO', 'pipeline_mcp_tool_start', {
      toolName,
      args: Object.keys(toolArgs),
      traceId: ctx.traceId,
    })

    try {
      // 带超时执行工具
      const result = await withTimeout(tool.handler(toolArgs), timeoutMs, `Tool "${toolName}" timed out after ${timeoutMs}ms`)

      const elapsed = Date.now() - t0

      // 标准化工具输出
      const outputText = extractToolOutputText(result)
      const isError = result?.isError === true

      log('INFO', 'pipeline_mcp_tool_done', {
        toolName,
        success: !isError,
        outputLen: outputText.length,
        durationMs: elapsed,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'mcp-tool-execution',
        data: {
          success: !isError,
          toolName,
          outputText,
          rawOutput: result,
          isError,
          durationMs: elapsed,
          argsUsed: toolArgs,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      const errMsg = err instanceof Error ? err.message : String(err)

      log('ERROR', 'pipeline_mcp_tool_failed', {
        toolName,
        error: errMsg,
        durationMs: elapsed,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'mcp-tool-execution',
        data: {
          success: false,
          toolName,
          error: errMsg,
          outputText: '',
          durationMs: elapsed,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }
}

/**
 * 带超时的 Promise 包装。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise
      .then((val) => {
        clearTimeout(timer)
        resolve(val)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/**
 * 从 MCP 工具返回值中提取文本内容。
 * 支持标准 MCPToolResult { content: [{ type: 'text', text }] } 格式
 * 也支持简单的 string 返回值。
 */
function extractToolOutputText(result: unknown): string {
  if (!result) return ''
  if (typeof result === 'string') return result

  const obj = result as Record<string, unknown>

  // MCPToolResult 格式
  if (Array.isArray(obj.content)) {
    const texts = obj.content
      .filter((item: unknown) => {
        const c = item as Record<string, unknown>
        return c?.type === 'text' && typeof c.text === 'string'
      })
      .map((item: unknown) => (item as Record<string, unknown>).text as string)
    if (texts.length > 0) return texts.join('\n')
  }

  // fallback: toString
  try {
    const str = JSON.stringify(result)
    return str && str !== '{}' ? str : ''
  } catch {
    return String(result)
  }
}
