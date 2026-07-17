/**
 * DataSourceTool — 数据源工具类型定义
 *
 * 为 MessageGateway 提供标准化的数据源工具接口。
 * 所有外部数据源（雷达、RSS、社交媒体等）通过此接口注册到网关。
 *
 * ## 输出格式协商
 *
 * 每个工具声明支持的输出格式列表。调用方（Telegram push、Agent 工具调用）
 * 可指定期望格式，工具按需返回对应结构的数据。
 *
 * ## 附件支持
 *
 * 结果可以附带多种类型的附件（图片、JSON、文件），
 * 网关负责根据消费端能力（Telegram 支持 text+photo、Agent 支持多模态）转换。
 */

import type { Tool } from '../tool/types'
import type { MCPToolResult } from '../mcp/types'

// =============================================================================
// 输出格式
// =============================================================================

/** 支持的输出格式 */
export type OutputFormat = 'text' | 'image' | 'json' | 'auto'

/** 输出格式中文标签 */
export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  text: '文本',
  image: '图片',
  json: 'JSON',
  auto: '自动',
}

// =============================================================================
// 附件
// =============================================================================

/** 附件类型 */
export type AttachmentType = 'text' | 'image' | 'json' | 'file'

/** 附件 */
export interface DataAttachment {
  type: AttachmentType
  /** 文本内容或JSON字符串 */
  content?: string
  /** 图片Base64 */
  base64?: string
  /** 文件名 */
  filename?: string
  /** MIME类型 */
  mimeType?: string
  /** 元数据 */
  metadata?: Record<string, any>
}

// =============================================================================
// 数据源工具结果
// =============================================================================

/** 数据源工具运行结果（含附件） */
export interface DataSourceResult {
  /** 主要文本输出 */
  text: string
  /** 额外附件列表 */
  attachments?: DataAttachment[]
  /** 是否错误 */
  isError?: boolean
  /** 原始数据（用于 JSON 格式输出） */
  rawData?: any
}

// =============================================================================
// 数据源工具定义
// =============================================================================

/** 数据源工具定义 */
export interface DataSourceToolDef {
  /** 工具唯一名 */
  name: string
  /** 工具描述 */
  description: string
  /** 输入 JSON Schema */
  inputJSONSchema: Tool['inputJSONSchema']
  /** 支持的输出格式 */
  supportedFormats: OutputFormat[]
  /** 默认输出格式 */
  defaultFormat: OutputFormat
  /** 执行处理器（参数 + 请求格式 → 结果） */
  handler: (args: Record<string, any>, format: OutputFormat) => Promise<DataSourceResult>
  /** 是否只读 */
  isReadOnly?: boolean
  /** 是否启用 */
  isEnabled?: boolean
}

// =============================================================================
// 转换函数
// =============================================================================

/**
 * 将 DataSourceResult 转换为 MCPToolResult（供 Agent 工具链使用）。
 * 图片附件转为 image content，JSON/文件附件转为 resource content。
 */
export function dataSourceResultToMCP(result: DataSourceResult): MCPToolResult {
  const content: MCPToolResult['content'] = [{ type: 'text', text: result.text }]

  for (const att of result.attachments ?? []) {
    if (att.type === 'image' && att.base64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType ?? 'image/png',
          data: att.base64,
        },
      })
    } else if (att.type === 'json' && att.content) {
      content.push({ type: 'text', text: `\`\`\`json\n${att.content}\n\`\`\`` })
    } else if (att.type === 'file' && att.filename && att.content) {
      content.push({
        type: 'resource',
        resource: {
          text: att.content,
          uri: `data://${att.filename}`,
          mimeType: att.mimeType ?? 'text/plain',
        },
      })
    }
  }

  return { content, isError: result.isError ?? false }
}

/**
 * 将 DataSourceResult 格式化为 Telegram 消息文本。
 * 根据格式类型选择最佳呈现方式。
 */
export function formatForTelegram(result: DataSourceResult, format: OutputFormat): { text: string; photoBase64?: string } {
  if (result.isError) {
    return { text: `❌ ${result.text}` }
  }

  let photoBase64: string | undefined

  // 检查是否有图片附件
  if (format === 'image' || format === 'auto') {
    const imageAtt = result.attachments?.find((a) => a.type === 'image' && a.base64)
    if (imageAtt) {
      photoBase64 = imageAtt.base64
    }
  }

  // JSON 格式优先输出原始数据
  if (format === 'json' && result.rawData !== undefined) {
    const jsonStr = typeof result.rawData === 'string' ? result.rawData : JSON.stringify(result.rawData, null, 2)
    const truncated = jsonStr.length > 4000 ? jsonStr.slice(0, 3900) + '\n\n...（已截断）' : jsonStr
    return { text: `📄 JSON 输出 (${jsonStr.length} 字符):\n\n\`\`\`json\n${truncated}\n\`\`\``, photoBase64 }
  }

  return { text: result.text, photoBase64 }
}

/**
 * 验证输出格式是否被工具支持。
 * auto 格式始终合法。
 */
export function isFormatSupported(tool: DataSourceToolDef, format: OutputFormat): boolean {
  if (format === 'auto') return true
  return tool.supportedFormats.includes(format)
}
