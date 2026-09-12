import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { WORKSPACE } from '@akemi-mio/core/config'
import { getSystemStateSnapshot } from './EvolutionUtils'

/** 单次 evolution 的历史记录 */
export interface EvolutionHistoryEntry {
  timestamp: number
  perspective: string
  summary: string
  planCreated: boolean
  planTitle?: string
  stepsCompleted: number
  stepsTotal: number
  success: boolean
}

/** 历史记录文件结构 */
export interface EvolutionHistory {
  cycles: EvolutionHistoryEntry[]
}

const DEFAULT_HISTORY_PATH = WORKSPACE.evolution + '/history.json'

/**
 * 历史记录管理 — 加载/保存/摘要。
 * 从 SelfEvolutionService 提取。
 */
export class EvolutionHistoryManager {
  private historyPath: string

  constructor(historyPath?: string) {
    this.historyPath = historyPath || DEFAULT_HISTORY_PATH
  }

  load(): EvolutionHistory {
    try {
      if (!existsSync(this.historyPath)) return { cycles: [] }
      return JSON.parse(readFileSync(this.historyPath, 'utf-8'))
    } catch {
      return { cycles: [] }
    }
  }

  save(history: EvolutionHistory): void {
    try {
      const dir = dirname(this.historyPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.historyPath, JSON.stringify(history, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'evolution_history_save_failed', { error: String(err), snapshot: getSystemStateSnapshot() })
    }
  }

  recordCycle(entry: EvolutionHistoryEntry): void {
    try {
      const history = this.load()
      history.cycles.push(entry)
      if (history.cycles.length > 20) history.cycles = history.cycles.slice(-20)
      this.save(history)
    } catch (err) {
      log('ERROR', 'evolution_history_record_failed', { error: String(err), snapshot: getSystemStateSnapshot() })
    }
  }

  getHistorySummary(maxEntries: number = 5): string {
    try {
      const history = this.load()
      if (history.cycles.length === 0) return '【历史记录】暂无历史进化记录，这是首次运行。\n请全面分析项目状态。'
      const sliceCount = Math.min(maxEntries, history.cycles.length)
      const recent = history.cycles.slice(-sliceCount)
      const lines = ['【近期进化历史】']
      for (const h of recent) {
        const time = new Date(h.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        lines.push(`- [${time}] ${h.success ? '成功' : '失败'}`)
        lines.push(`  摘要: ${h.summary.slice(0, 200)}`)
        if (h.planCreated) lines.push(`  计划: ${h.planTitle || '(未命名)'} (${h.stepsCompleted}/${h.stepsTotal})`)
      }
      lines.push('\n请基于以上历史记录，避免重复分析已经看过的方向。选择一个之前未被充分关注的新视角进行分析。')
      return lines.join('\n')
    } catch {
      return '【历史记录】读取失败，请全面分析。'
    }
  }

  loadRecentFailures(): Array<{ task: string; error: string; timestamp: number }> {
    try {
      const history = this.load()
      return history.cycles
        .filter((c) => !c.success)
        .slice(-10)
        .map((c) => ({
          task: c.perspective,
          error: c.summary.slice(0, 60),
          timestamp: c.timestamp,
        }))
    } catch {
      return []
    }
  }
}
