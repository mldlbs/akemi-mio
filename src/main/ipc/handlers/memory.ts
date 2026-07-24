/**
 * memory IPC handlers — 行为导向记忆手动干预接口
 *
 * 提供记忆权重的手动干预、关键字频率查询、清理确认等 IPC 通道。
 * 供渲染进程（React UI）或外部工具调用。
 */

import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { getMemoryService } from '../../tool/deps'
import type { HandlerContext } from './context'

export function registerMemoryHandlers(_ctx: HandlerContext): void {
  // ══════════════════════════════════════════
  //  关键字频率查询
  // ══════════════════════════════════════════

  /**
   * 获取关键字频率统计概览。
   */
  ipcMain.handle('memory:keywordStats', async () => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const stats = ms.getKeywordFreqStats()
      return { success: true, ...stats }
    } catch (err) {
      log('ERROR', 'ipc_memory_keywordStats_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 获取所有关键字的频率详情。
   */
  ipcMain.handle('memory:keywordDetails', async () => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const details = ms.getAllKeywordFrequencies()
      return { success: true, keywords: details }
    } catch (err) {
      log('ERROR', 'ipc_memory_keywordDetails_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 计算文本内容与高频关键字的匹配度。
   */
  ipcMain.handle('memory:keywordMatch', async (_event, content: string) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const score = ms.getContentKeywordMatch(content)
      return { success: true, score }
    } catch (err) {
      log('ERROR', 'ipc_memory_keywordMatch_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ══════════════════════════════════════════
  //  记忆权重手动干预
  // ══════════════════════════════════════════

  /**
   * 手动覆盖记忆得分（0-1，null=恢复自动计算）。
   */
  ipcMain.handle('memory:setManualScore', async (_event, id: string, score: number | null) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const result = ms.setManualScore(id, score)
      return { success: result }
    } catch (err) {
      log('ERROR', 'ipc_memory_setManualScore_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 固定记忆（不受自动清理影响）。
   */
  ipcMain.handle('memory:pin', async (_event, id: string) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const result = ms.pinMemory(id)
      return { success: result }
    } catch (err) {
      log('ERROR', 'ipc_memory_pin_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 取消固定记忆。
   */
  ipcMain.handle('memory:unpin', async (_event, id: string) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const result = ms.unpinMemory(id)
      return { success: result }
    } catch (err) {
      log('ERROR', 'ipc_memory_unpin_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ══════════════════════════════════════════
  //  记忆清理审查
  // ══════════════════════════════════════════

  /**
   * 获取当前得分最低的记忆列表（用于用户审查）。
   */
  ipcMain.handle('memory:getLowestScored', async (_event, limit?: number) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready', entries: [] }
    try {
      const entries = ms.getLowestScored(limit ?? 10)
      const formatted = entries.map((e) => ({
        id: e.id,
        content: e.content.slice(0, 100),
        score: ms.getEffectiveScore(e),
        tier: e.tier,
        isPinned: e.isPinned,
        lastAccessedAt: e.lastAccessedAt,
        accessCount: e.accessCount,
        topics: e.topics ?? [],
        manualScoreOverride: e.manualScoreOverride,
      }))
      return { success: true, entries: formatted }
    } catch (err) {
      log('ERROR', 'ipc_memory_getLowestScored_failed', { error: String(err) })
      return { success: false, error: String(err), entries: [] }
    }
  })

  /**
   * 获取清理候选列表（预览，不删除）。
   */
  ipcMain.handle('memory:getCleanupCandidates', async () => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready', candidates: [] }
    try {
      const candidates = ms.getCleanupCandidates()
      const formatted = candidates.map((c) => ({
        id: c.entry.id,
        content: c.entry.content.slice(0, 100),
        reason: c.reason,
        score: ms.getEffectiveScore(c.entry),
        behaviorMultiplier: c.behaviorMultiplier,
        topics: c.entry.topics ?? [],
      }))
      return { success: true, candidates: formatted }
    } catch (err) {
      log('ERROR', 'ipc_memory_getCleanupCandidates_failed', { error: String(err) })
      return { success: false, error: String(err), candidates: [] }
    }
  })

  /**
   * 用户确认清理候选记忆。
   */
  ipcMain.handle('memory:confirmCleanup', async (_event, confirmIds?: string[]) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const count = ms.confirmCleanup(confirmIds)
      return { success: true, removedCount: count }
    } catch (err) {
      log('ERROR', 'ipc_memory_confirmCleanup_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 拒绝所有待清理候选。
   */
  ipcMain.handle('memory:rejectCleanup', async () => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      ms.rejectCleanup()
      return { success: true }
    } catch (err) {
      log('ERROR', 'ipc_memory_rejectCleanup_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  /**
   * 立即触发快速清理（手动触发 6 小时清理周期）。
   */
  ipcMain.handle('memory:runQuickCleanup', async () => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const count = ms.runQuickCleanup()
      return { success: true, removedCount: count }
    } catch (err) {
      log('ERROR', 'ipc_memory_runQuickCleanup_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ══════════════════════════════════════════
  //  记忆条目元数据
  // ══════════════════════════════════════════

  /**
   * 获取指定记忆条目的详细信息。
   */
  ipcMain.handle('memory:getEntry', async (_event, id: string) => {
    const ms = getMemoryService()
    if (!ms) return { success: false, error: 'memory service not ready' }
    try {
      const entry = ms.getEntries().find((e) => e.id === id)
      if (!entry) return { success: false, error: 'entry not found' }
      return {
        success: true,
        entry: {
          id: entry.id,
          content: entry.content,
          type: entry.type,
          tier: entry.tier,
          confidence: entry.confidence,
          behaviorScore: entry.behaviorScore,
          utilityScore: entry.utilityScore,
          effectiveScore: ms.getEffectiveScore(entry),
          accessCount: entry.accessCount,
          lastAccessedAt: entry.lastAccessedAt,
          isPinned: entry.isPinned,
          manualScoreOverride: entry.manualScoreOverride,
          topics: entry.topics ?? [],
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      }
    } catch (err) {
      log('ERROR', 'ipc_memory_getEntry_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  log('INFO', 'memory_ipc_handlers_registered')
}
