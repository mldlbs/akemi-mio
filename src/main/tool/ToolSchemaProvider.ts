/**
 * ToolSchemaProvider — LLM-facing schema 统一入口
 *
 * ADR-015 P1.3a 决策 7:
 * - LlmService 获取 tools 的唯一入口
 * - 合并 tool schema（from ServerManager） + capability function schema
 * - ServerManager 不含 capability 概念
 *
 * 数据流：
 * ```
 * LlmService
 *    |
 *    v
 * ToolSchemaProvider.getSchemas()
 *    |
 *    + ServerManager.getAllSchemas()     — 原始工具
 *    + CapabilityFunctionSchemaAdapter   — capability 函数
 * ```
 */

import { log } from '../logger/Logger'
import type { CapabilityFunctionSchemaAdapter, OpenAIFunctionSchema } from '../capability/CapabilityFunctionSchemaAdapter'

/** OpenAI-compatible schema (re-exported for clarity) */
export type ToolSchema = OpenAIFunctionSchema

/**
 * P1.3b: ToolSchemaProvider 的 schema 暴露模式
 * - "dual": 同时暴露 raw tool + capability schemas（P1.3a 行为，默认）
 * - "capability-first": 只暴露 capability schemas + call_raw_tool 回退
 */
export type SchemaExposureMode = 'dual' | 'capability-first'

/**
 * P1.3b: capability-first mode 下暴露的通用回退工具 schema
 * LLM 通过 call_raw_tool 调用尚未映射为 capability 的原始工具
 */
const CALL_RAW_TOOL_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'call_raw_tool',
    description: 'Call a tool directly by its name. Use this only when no capability matches your intent.',
    parameters: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'The exact tool name to call' },
        args: { type: 'object', description: 'Arguments to pass to the tool' },
      },
      required: ['toolName', 'args'],
    },
  },
}

/**
 * ServerManager 的最小 schema 提供者接口 —
 * 避免 ToolSchemaProvider 直接依赖 ServerManager 类型。
 */
export interface ToolSchemaSource {
  getAllSchemas(): ToolSchema[]
}

export class ToolSchemaProvider {
  private toolSource: ToolSchemaSource
  private capabilityAdapter: CapabilityFunctionSchemaAdapter | null = null
  private _mode: SchemaExposureMode = 'dual'

  constructor(toolSource: ToolSchemaSource, capabilityAdapter?: CapabilityFunctionSchemaAdapter) {
    this.toolSource = toolSource
    this.capabilityAdapter = capabilityAdapter ?? null
  }

  /** 设置 schema 暴露模式 */
  setMode(mode: SchemaExposureMode): void {
    this._mode = mode
    log('INFO', 'tool_schema_provider.mode_set', { mode })
  }

  /** 获取当前模式 */
  getMode(): SchemaExposureMode {
    return this._mode
  }

  /** 设置或替换 capability adapter（延迟绑定） */
  setCapabilityAdapter(adapter: CapabilityFunctionSchemaAdapter | null): void {
    this.capabilityAdapter = adapter
  }

  /**
   * 获取合并后的所有 schema（tool + capability）。
   * tool schema 在前，capability schema 在后（不改变原有优先级排序）。
   *
   * P1.3b: capability-first mode 下只输出 capability schemas + call_raw_tool 回退
   */
  getSchemas(): ToolSchema[] {
    if (this._mode === 'capability-first') {
      return this.getCapabilityFirstSchemas()
    }

    const toolSchemas = this.toolSource.getAllSchemas()
    const capSchemas = this.capabilityAdapter?.buildSchemas() ?? []

    if (capSchemas.length === 0) return toolSchemas

    log('INFO', 'tool_schema_provider.merged', {
      toolCount: toolSchemas.length,
      capabilityCount: capSchemas.length,
    })

    return [...toolSchemas, ...capSchemas]
  }

  /**
   * P1.3b: capability-first mode — 只暴露 capability schemas + 一个通用回退工具。
   */
  private getCapabilityFirstSchemas(): ToolSchema[] {
    const capSchemas = this.capabilityAdapter?.buildSchemas() ?? []

    log('INFO', 'tool_schema_provider.capability_first', {
      capabilityCount: capSchemas.length,
      hasFallback: true,
    })

    // capability schemas 在前，call_raw_tool 在后（作为安全网）
    return [...capSchemas, CALL_RAW_TOOL_SCHEMA]
  }

  /** 仅获取 tool schema（不含 capability） */
  getToolSchemasOnly(): ToolSchema[] {
    return this.toolSource.getAllSchemas()
  }

  /** 仅获取 capability schema */
  getCapabilitySchemas(): ToolSchema[] {
    return this.capabilityAdapter?.buildSchemas() ?? []
  }

  /** 检查某个 function name 是否为 capability */
  isCapabilityTool(name: string): boolean {
    return this.capabilityAdapter?.isCapabilityTool(name) ?? false
  }

  /** P1.3b: 检查是否为 call_raw_tool 回退工具 */
  isCallRawTool(name: string): boolean {
    return name === 'call_raw_tool'
  }

  /** 将 sanitized function name 解析回原始 capability id */
  resolveCapabilityName(sanitizedName: string): string | undefined {
    return this.capabilityAdapter?.resolveCapabilityId(sanitizedName)
  }
}
