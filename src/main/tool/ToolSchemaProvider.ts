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
 * ServerManager 的最小 schema 提供者接口 —
 * 避免 ToolSchemaProvider 直接依赖 ServerManager 类型。
 */
export interface ToolSchemaSource {
  getAllSchemas(): ToolSchema[]
}

export class ToolSchemaProvider {
  private toolSource: ToolSchemaSource
  private capabilityAdapter: CapabilityFunctionSchemaAdapter | null = null

  constructor(toolSource: ToolSchemaSource, capabilityAdapter?: CapabilityFunctionSchemaAdapter) {
    this.toolSource = toolSource
    this.capabilityAdapter = capabilityAdapter ?? null
  }

  /** 设置或替换 capability adapter（延迟绑定） */
  setCapabilityAdapter(adapter: CapabilityFunctionSchemaAdapter | null): void {
    this.capabilityAdapter = adapter
  }

  /**
   * 获取合并后的所有 schema（tool + capability）。
   * tool schema 在前，capability schema 在后（不改变原有优先级排序）。
   */
  getSchemas(): ToolSchema[] {
    const toolSchemas = this.toolSource.getAllSchemas()
    const capSchemas = this.capabilityAdapter?.buildSchemas() ?? []

    if (capSchemas.length === 0) return toolSchemas

    log('INFO', 'tool_schema_provider.merged', {
      toolCount: toolSchemas.length,
      capabilityCount: capSchemas.length,
    })

    return [...toolSchemas, ...capSchemas]
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

  /** 将 sanitized function name 解析回原始 capability id */
  resolveCapabilityName(sanitizedName: string): string | undefined {
    return this.capabilityAdapter?.resolveCapabilityId(sanitizedName)
  }
}
