import type { MemoryService } from '@akemi-mio/intelligence-memory'
import { log } from '@akemi-mio/core/logger/Logger'

export interface ToolParamDefaults {
  [toolParamKey: string]: string
}

export class MemoryRetriever {
  private memoryService: MemoryService | null = null

  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
  }

  getPreference(key: string): { value: string; confidence: number } | null {
    if (!this.memoryService) return null
    try {
      const prefs = this.memoryService.getUserPreferences()
      const match = prefs.find((p) => p.key === key)
      if (match) {
        return { value: match.value, confidence: match.confidence }
      }
      return null
    } catch (err) {
      log('WARN', 'memory_retriever_pref_failed', { key, error: String(err) })
      return null
    }
  }

  getRecentToolCalls(toolName: string, limit = 5): string[] {
    if (!this.memoryService) return []
    try {
      const legacyMarker = `[工具调用] ${toolName}`
      const capabilityMarker = `tool:${toolName}`
      return this.memoryService
        .getEntries()
        .filter((e) => e.type === 'user_fact' && (e.content.includes(legacyMarker) || e.content.includes(capabilityMarker)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((e) => e.content)
    } catch (err) {
      log('WARN', 'memory_retriever_history_failed', { toolName, error: String(err) })
      return []
    }
  }

  getFrequentTools(limit = 10): Array<{ toolName: string; count: number }> {
    if (!this.memoryService) return []
    try {
      const legacyMarker = '[工具调用] '
      const capabilityMarker = '[能力调用] '
      const toolCounts = new Map<string, number>()

      for (const entry of this.memoryService.getEntries()) {
        if (entry.type !== 'user_fact') continue

        let toolName = ''
        if (entry.content.startsWith(legacyMarker)) {
          const rest = entry.content.slice(legacyMarker.length)
          const parenIdx = rest.indexOf('(')
          const arrowIdx = rest.indexOf(' →')
          const endIdx = parenIdx > 0 ? parenIdx : arrowIdx > 0 ? arrowIdx : rest.length
          toolName = rest.slice(0, endIdx).trim()
        } else if (entry.content.startsWith(capabilityMarker)) {
          const match = entry.content.match(/\btool:([^\s)]+)/)
          toolName = match?.[1]?.trim() ?? ''
        } else {
          continue
        }

        if (toolName) {
          toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1)
        }
      }

      return Array.from(toolCounts.entries())
        .map(([name, count]) => ({ toolName: name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
    } catch (err) {
      log('WARN', 'memory_retriever_freq_failed', { error: String(err) })
      return []
    }
  }
}

export class ToolMemoryDefaults {
  private registry: ToolParamDefaults = {}
  private memoryRetriever: MemoryRetriever

  constructor(memoryRetriever: MemoryRetriever) {
    this.memoryRetriever = memoryRetriever
  }

  register(toolName: string, paramName: string, prefKey: string): void {
    const key = `${toolName}.${paramName}`
    this.registry[key] = prefKey
    log('INFO', 'tool_defaults_registered', { tool: toolName, param: paramName, prefKey })
  }

  registerAll(mappings: ToolParamDefaults): void {
    for (const [key, prefKey] of Object.entries(mappings)) {
      this.registry[key] = prefKey
    }
    log('INFO', 'tool_defaults_registered_batch', { count: Object.keys(mappings).length })
  }

  unregister(toolName: string, paramName: string): void {
    const key = `${toolName}.${paramName}`
    delete this.registry[key]
  }

  fill(
    toolName: string,
    args: Record<string, any>,
    level?: 'off' | 'conservative' | 'balanced' | 'aggressive',
  ): {
    args: Record<string, any>
    filled: Array<{ param: string; value: string; source: string; confidence: number }>
  } {
    if (level === 'off') return { args: { ...args }, filled: [] }

    const confidenceThreshold = this.getConfidenceThreshold(level)
    const filled: Array<{ param: string; value: string; source: string; confidence: number }> = []
    const enriched = { ...args }

    for (const [toolParamKey, prefKey] of Object.entries(this.registry)) {
      const [regTool, param] = toolParamKey.split('.', 2)
      if (regTool !== toolName || !param) continue
      if (param in args) continue

      const pref = this.memoryRetriever.getPreference(prefKey)
      if (pref && pref.confidence >= confidenceThreshold) {
        enriched[param] = pref.value
        filled.push({
          param,
          value: pref.value,
          source: `user_preference:${prefKey}`,
          confidence: pref.confidence,
        })
      }
    }

    if (filled.length > 0) {
      log('INFO', 'tool_defaults_filled', {
        tool: toolName,
        filled: filled.map((f) => `${f.param}=${f.value}`).join(', '),
      })
    }

    return { args: enriched, filled }
  }

  getRegistry(): ToolParamDefaults {
    return { ...this.registry }
  }

  hasDefaults(toolName: string): boolean {
    return Object.keys(this.registry).some((k) => k.startsWith(`${toolName}.`))
  }

  private getConfidenceThreshold(level?: 'off' | 'conservative' | 'balanced' | 'aggressive'): number {
    switch (level) {
      case 'conservative':
        return 0.8
      case 'balanced':
        return 0.5
      case 'aggressive':
        return 0.2
      default:
        return 0.5
    }
  }
}
