/**
 * CapabilityFunctionSchemaAdapter — CapabilityDefinition → OpenAI function schema 转换
 *
 * ADR-015 P1.3a:
 * - 从 CapabilityCatalog 读取 capability 定义
 * - 将每个 capability 转换为 OpenAI-compatible function calling schema
 * - 验证 inputSchema 非空（C-8）
 * - 每次 buildSchemas() 调用时发射 capability.suggested 事件（P1.2 观测续用）
 *
 * 数据流：
 * ```
 * CapabilityCatalog.getCapabilities()
 *     |
 *     v
 * CapabilityFunctionSchemaAdapter.buildSchemas()
 *     |
 *     v
 * [{ type: 'function', function: { name: "publishing", description: "...", parameters: {...} } }]
 *     |
 *     v
 * ToolSchemaProvider.getSchemas()  — 合并后传给 LLM
 * ```
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { CapabilityCatalog } from './CapabilityCatalog'
import type { CapabilityDefinition } from './types'

/** OpenAI-compatible function schema */
export interface OpenAIFunctionSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
  }
}

/**
 * 默认的通用 inputSchema — 当 capability 无具体 schema 时使用。
 * 非空（满足 C-8），包含 description 字段。
 */
const FALLBACK_INPUT_SCHEMA: CapabilityDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Describe what you want this capability to do. Explain the task or provide specific parameters.',
    },
  },
  required: ['description'],
}

export class CapabilityFunctionSchemaAdapter {
  private catalog: CapabilityCatalog

  constructor(catalog: CapabilityCatalog) {
    this.catalog = catalog
  }

  /**
   * 从 Catalog 生成所有 capability 的 function schema。
   * 验证每个 schema 非空（C-8）。
   * 同时发射 capability.suggested 事件（P1.2 观测延续）。
   */
  buildSchemas(): OpenAIFunctionSchema[] {
    const capabilities = this.catalog.getCapabilities()
    if (capabilities.length === 0) return []

    const schemas: OpenAIFunctionSchema[] = []

    for (const cap of capabilities) {
      const inputSchema = this._ensureNonEmptySchema(cap.inputSchema)

      schemas.push({
        type: 'function',
        function: {
          name: cap.id,
          description: cap.description,
          parameters: inputSchema,
        },
      })

      // P1.2: shadow 观测事件保持发射
      const relatedTools = cap.providers.flatMap((p) => p.tools).filter(Boolean)
      eventBus.emit('capability.suggested', {
        capability: cap.id,
        relatedTools,
        contextSource: 'llm_function_schema',
      })
    }

    log('INFO', 'capability_fn_schema.built', {
      count: schemas.length,
      names: schemas.map((s) => s.function.name),
    })

    return schemas
  }

  /**
   * 判断一个 function name 是否为 capability 工具名。
   */
  isCapabilityTool(name: string): boolean {
    return this.catalog.has(name)
  }

  /**
   * 确保 inputSchema 非空（C-8 合规）。
   * 如果 properties 或 required 为空，降级到 FALLBACK_INPUT_SCHEMA。
   */
  private _ensureNonEmptySchema(
    schema: CapabilityDefinition['inputSchema'],
  ): CapabilityDefinition['inputSchema'] {
    const props = schema.properties
    const req = schema.required

    if (!props || Object.keys(props).length === 0 || !req || req.length === 0) {
      return FALLBACK_INPUT_SCHEMA
    }

    return schema
  }
}
