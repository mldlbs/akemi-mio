/**
 * ToolAvailabilityCache — 工具可用性缓存
 *
 * 只缓存 TOOL_MISSING 和 MCP_ERROR 类错误，
 * ENVIRONMENT/PERMISSION/ARGUMENT 等错误不缓存（LLM 可换路）。
 *
 * 基于日志实证：agent 在 centos 远端反复尝试 node/pm2/SIGTERM
 *   28 次 retry → 8 次 ERROR → 直接导致预算耗尽
 */

import { log } from '../logger/Logger'
import { classifyToolError, ToolErrorType } from './ToolErrorType'

interface CacheEntry {
  key: string
  reason: string
  until: number
}

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_CACHE_SIZE = 200

class ToolAvailabilityCache {
  private cache = new Map<string, CacheEntry>()

  /** 检查工具在当前上下文中是否已知不可用。null = 可用 */
  check(name: string, args: Record<string, any>): string | null {
    const key = this.buildKey(name, args)
    const entry = this.cache.get(key)
    if (entry && Date.now() < entry.until) return entry.reason
    if (entry) this.cache.delete(key)
    return null
  }

  /** 记录失败。只有 TOOL_MISSING / MCP_ERROR 才会被缓存 */
  record(name: string, args: Record<string, any>, errorMessage: string): void {
    const errorType = classifyToolError(errorMessage)
    if (errorType !== ToolErrorType.TOOL_MISSING && errorType !== ToolErrorType.MCP_ERROR) return

    const key = this.buildKey(name, args)
    this.cache.set(key, {
      key,
      reason: errorMessage.slice(0, 200),
      until: Date.now() + CACHE_TTL_MS,
    })

    if (this.cache.size > MAX_CACHE_SIZE) {
      const entries = [...this.cache.entries()].sort((a, b) => a[1].until - b[1].until)
      for (let i = 0; i < Math.floor(MAX_CACHE_SIZE * 0.2); i++) {
        this.cache.delete(entries[i][0])
      }
    }

    log('INFO', 'tool_availability_cached', { tool: name, reason: errorMessage.slice(0, 100) })
  }

  clear(toolName?: string): void {
    if (toolName) {
      for (const [key] of this.cache) {
        if (key.startsWith(toolName + '|')) this.cache.delete(key)
      }
    } else {
      this.cache.clear()
    }
  }

  private buildKey(name: string, args: Record<string, any>): string {
    const parts: string[] = [name]
    if (typeof args.command === 'string') {
      parts.push(args.command.trim().split(/\s+/).slice(0, 2).join(' '))
    }
    if (typeof args.workspace === 'string') parts.push(args.workspace)
    if (typeof args.path === 'string') parts.push('file:' + args.path.slice(0, 50))
    return parts.join('|')
  }
}

export const toolAvailabilityCache = new ToolAvailabilityCache()
