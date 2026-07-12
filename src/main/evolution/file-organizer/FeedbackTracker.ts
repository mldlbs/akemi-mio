/**
 * FeedbackTracker — 用户行为反馈追踪器
 *
 * 跟踪文件整理后的状态变化，检测用户的反向操作
 * （撤销移动、重新归类），转化为规则的反馈信号。
 *
 * 工作流程：
 * 1. FileOrganizerExecutor 每次移动文件时调用 recordMove()
 * 2. 每轮扫描时调用 checkFeedback() 检查所有待确认的记录
 * 3. 文件若停留在整理位置 → 正反馈
 * 4. 文件若被移回原处或移动到别处 → 负反馈
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type { FileMoveRecord } from './types'

// =============================================================================
// 文件路径
// =============================================================================

const MOVE_RECORDS_FILE = join(WORKSPACE.evolution, 'file_organizer_moves.json')

// =============================================================================
// FeedbackTracker
// =============================================================================

export class FeedbackTracker {
  private records: FileMoveRecord[] = []
  private loaded = false

  /** 初始化：加载持久化的移动记录 */
  init(): void {
    this.load()
    log('INFO', 'feedback_tracker_init', { pendingRecords: this.getPendingCount() })
  }

  /** 记录一次文件移动 */
  recordMove(ruleId: string, originalPath: string, organizedPath: string): void {
    const record: FileMoveRecord = {
      ruleId,
      originalPath,
      organizedPath,
      currentPath: organizedPath,
      movedAt: Date.now(),
    }
    this.records.push(record)
    this.save()
    log('INFO', 'feedback_tracker_move_recorded', {
      ruleId,
      originalPath,
      organizedPath,
    })
  }

  /**
   * 检查所有待确认的移动记录，返回反馈结果
   *
   * @param currentFiles 当前所有文件的路径集合（用于检查文件当前位置）
   * @returns [positiveFeedbacks, negativeFeedbacks] 正负反馈的规则 ID 数组
   */
  checkFeedback(currentFiles: Set<string>): [string[], string[]] {
    const positive: string[] = []
    const negative: string[] = []

    for (const record of this.records) {
      // 跳过已检查过的记录
      if (record.feedbackCheckedAt !== undefined) continue

      const now = Date.now()
      record.feedbackCheckedAt = now

      // 检查文件当前是否存在
      const currentlyInOrganized = currentFiles.has(record.organizedPath)
      const currentlyInOriginal = currentFiles.has(record.originalPath)

      if (currentlyInOrganized) {
        // 文件仍留在整理后的位置 → 正反馈
        record.feedback = true
        record.currentPath = record.organizedPath
        positive.push(record.ruleId)
      } else if (currentlyInOriginal) {
        // 文件回到了原位置 → 负反馈（用户撤销移动）
        record.feedback = false
        record.currentPath = record.originalPath
        negative.push(record.ruleId)
      } else {
        // 文件既不在原位也不在目标位 → 可能被删除或移动到别处
        // 搜索接近的位置...
        const newLocation = this.findNearbyLocation(currentFiles, record.originalPath, record.organizedPath)
        if (newLocation) {
          // 用户手动移动到了新位置 → 负反馈
          record.feedback = false
          record.currentPath = newLocation
          negative.push(record.ruleId)
        } else {
          // 文件已被删除 — 不产生反馈（非用户偏好行为）
          record.currentPath = ''
          // 但不算反馈
        }
      }
    }

    this.save()

    if (positive.length > 0 || negative.length > 0) {
      log('INFO', 'feedback_tracker_checked', {
        positive: positive.length,
        negative: negative.length,
        totalRecords: this.records.length,
      })
    }

    return [positive, negative]
  }

  /**
   * 清理过旧的记录（保留最近 N 条）
   */
  cleanup(maxRecords = 500): void {
    if (this.records.length <= maxRecords) return
    // 保留最新的 N 条（按 movedAt 排序）
    this.records.sort((a, b) => b.movedAt - a.movedAt)
    this.records = this.records.slice(0, maxRecords)
    this.save()
    log('INFO', 'feedback_tracker_cleanup', { remaining: this.records.length })
  }

  /** 获取待确认的记录数量 */
  getPendingCount(): number {
    return this.records.filter((r) => r.feedbackCheckedAt === undefined).length
  }

  /** 获取统计信息 */
  getStats(): { total: number; pending: number; positive: number; negative: number } {
    return {
      total: this.records.length,
      pending: this.getPendingCount(),
      positive: this.records.filter((r) => r.feedback === true).length,
      negative: this.records.filter((r) => r.feedback === false).length,
    }
  }

  // ============================================================================
  // 私有工具
  // ============================================================================

  /**
   * 在现有文件集合中查找与原路径或目标路径相似的文件
   * 用于检测用户手动移动文件到其他位置的情况
   */
  private findNearbyLocation(currentFiles: Set<string>, originalPath: string, organizedPath: string): string | null {
    const originalName = originalPath.split('/').pop() || ''
    const organizedName = organizedPath.split('/').pop() || ''
    const searchNames = [originalName, organizedName].filter(Boolean)

    for (const path of currentFiles) {
      const fileName = path.split('/').pop() || ''
      for (const search of searchNames) {
        if (fileName === search && path !== originalPath && path !== organizedPath) {
          return path
        }
      }
    }

    return null
  }

  // ============================================================================
  // 持久化
  // ============================================================================

  private load(): void {
    try {
      if (!existsSync(MOVE_RECORDS_FILE)) return
      const raw = readFileSync(MOVE_RECORDS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data.records)) {
        this.records = data.records
      }
      this.loaded = true
      log('INFO', 'feedback_tracker_loaded', { records: this.records.length })
    } catch (err: any) {
      log('WARN', 'feedback_tracker_load_failed', { error: err.message })
    }
  }

  private save(): void {
    try {
      const dir = dirname(MOVE_RECORDS_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(
        MOVE_RECORDS_FILE,
        JSON.stringify(
          {
            records: this.records,
            updatedAt: Date.now(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch (err: any) {
      log('WARN', 'feedback_tracker_save_failed', { error: err.message })
    }
  }
}

/** 全局单例 */
export const feedbackTracker = new FeedbackTracker()
