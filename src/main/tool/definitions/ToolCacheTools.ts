/**
 * ToolCacheTools — 工具调用记忆缓存管理工具
 *
 * 提供手动清除缓存和查看缓存状态的 API：
 * 1. clear_tool_cache — 清除指定工具或全部工具的缓存
 * 2. get_tool_cache_stats — 查看缓存统计和错误记录
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { toolCallMemoryCache } from '../ToolCallMemoryCache'

// =============================================================================
// clear_tool_cache — 手动清除缓存
// =============================================================================

export const clearToolCacheTool = buildTool({
  name: 'clear_tool_cache',
  description:
    '手动清除工具调用记忆缓存。支持清除特定工具的缓存或全部清除。' +
    '缓存用于存储只读工具（如 read_file, grep, retrieve_memory 等）的调用结果，' +
    '以减少重复调用开销。当工具行为变更或文件内容更新后，可手动清除缓存确保最新结果。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: '要清除缓存的工具名（如 "read_file"），不传则清除全部缓存',
      },
      clear_errors: {
        type: 'boolean',
        description: '是否同时清除该工具的错误记录（默认 true）',
      },
    },
    required: [],
  },
  handler: async (args: { tool_name?: string; clear_errors?: boolean }) => {
    try {
      const before = toolCallMemoryCache.getStats()
      const removed = toolCallMemoryCache.clear(args.tool_name)

      return formatToolResult(
        `已清除缓存: ${removed} 条目\n` +
        `工具: ${args.tool_name || '全部'}\n` +
        `清除前: ${before.size} 条目, ${before.hits} 次命中\n` +
        `当前错误记录: ${before.errorRecordCount} 条`,
      )
    } catch (err: any) {
      return formatToolError(`清除缓存失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// get_tool_cache_stats — 查看缓存状态
// =============================================================================

export const getToolCacheStatsTool = buildTool({
  name: 'get_tool_cache_stats',
  description:
    '查看工具调用记忆缓存的当前状态，包括缓存大小、命中率、可缓存的工具列表等。' +
    '用于了解缓存的运行效果和进行调优。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: '可选，查看特定工具的缓存条目详情',
      },
      show_errors: {
        type: 'boolean',
        description: '是否显示错误记录（默认 false）',
      },
    },
    required: [],
  },
  handler: async (args: { tool_name?: string; show_errors?: boolean }) => {
    try {
      const stats = toolCallMemoryCache.getStats()
      const lines: string[] = []

      lines.push('【工具调用记忆缓存统计】')
      lines.push(`  缓存条目数: ${stats.size}`)
      lines.push(`  命中 / 未命中: ${stats.hits} / ${stats.misses}`)
      lines.push(`  命中率: ${(stats.hitRate * 100).toFixed(1)}%`)
      lines.push(`  错误记录数: ${stats.errorRecordCount}`)
      lines.push(`  可缓存工具: ${stats.cacheableTools.length} 个`)
      lines.push('')

      if (args.tool_name) {
        const entries = toolCallMemoryCache.getCacheSnapshot(args.tool_name)
        if (entries.length === 0) {
          lines.push(`工具 "${args.tool_name}" 无缓存条目。`)
        } else {
          lines.push(`工具 "${args.tool_name}" 的缓存条目 (${entries.length}):`)
          for (const e of entries.slice(0, 10)) {
            const age = Date.now() - e.createdAt
            const ttlRemaining = e.expiresAt - Date.now()
            lines.push(
              `  - 参数: ${e.argSignature.slice(0, 60)}` +
              ` | 已缓存: ${(age / 1000).toFixed(0)}s` +
              ` | 剩余: ${ttlRemaining > 0 ? (ttlRemaining / 1000).toFixed(0) + 's' : '已过期'}` +
              ` | 命中: ${e.hitCount} 次`,
            )
          }
        }

        if (args.show_errors) {
          const errors = toolCallMemoryCache.getErrorRecords(args.tool_name)
          if (errors.length > 0) {
            lines.push('')
            lines.push(`错误记录 (${errors.length}):`)
            for (const e of errors.slice(0, 5)) {
              lines.push(
                `  - 签名: ${e.argSignature.slice(0, 50)}` +
                ` | 失败: ${e.failureCount} 次` +
                ` | 类型: ${e.errorType || 'unknown'}` +
                ` | 最近: ${new Date(e.lastErrorAt).toLocaleTimeString()}`,
              )
            }
          }
        }
      } else {
        lines.push('可缓存工具列表:')
        const tools = stats.cacheableTools
        // 按工具名分组展示
        const groups: Record<string, string[]> = {}
        for (const t of tools) {
          const prefix = t.split('_')[0] || '其他'
          if (!groups[prefix]) groups[prefix] = []
          groups[prefix].push(t)
        }
        for (const [group, names] of Object.entries(groups)) {
          lines.push(`  ${group}...: ${names.join(', ')}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`获取缓存统计失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})
