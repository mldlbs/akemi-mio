/**
 * FileOrganizerExecutor — 文件整理执行器
 *
 * FixExecutor 实现，消费 source='file_organizer' 的 Problem。
 *
 * 职责：
 * 1. 解析 Problem metadata 获取目标文件与最佳规则
 * 2. 将文件移动到规则指定的目录
 * 3. 记录移动轨迹供 FeedbackTracker 追踪反馈（基因池规则）
 * 4. 记录执行结果到记忆系统中的归档规则（对话记忆规则）
 * 5. 非破坏性操作：不删除文件，仅移动
 */

import { existsSync, renameSync, mkdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import type { FixExecutor, FixResult, AssignedProblem } from '../automation/types'
import { genePool } from './GenePool'
import { feedbackTracker } from './FeedbackTracker'
import { fileRuleMemoryAdapter } from './FileRuleMemoryAdapter'
import { WORKSPACE } from '../../config'

export class FileOrganizerExecutor implements FixExecutor {
  readonly name = 'file-organizer-executor'
  readonly timeoutMs = 15_000
  readonly supportedSources = ['file_organizer']

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    try {
      const metadata = problem.context.metadata || {}
      const ruleId = metadata.ruleId || ''
      const ruleSource = metadata.ruleSource || 'genepool'
      const targetDir = metadata.targetDir || ''
      const filePath = problem.file || ''
      const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || ''

      if (!filePath || !targetDir) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少文件路径或目标目录信息',
          durationMs: Date.now() - startTime,
          error: 'missing_file_or_target',
        }
      }

      if (!ruleId) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少规则 ID，无法追踪反馈',
          durationMs: Date.now() - startTime,
          error: 'missing_rule_id',
        }
      }

      log('INFO', 'file_organizer_exec_start', {
        problemId: problem.id,
        filePath,
        targetDir,
        ruleId,
        ruleSource,
      })

      // ── 构造源/目标完整路径 ──
      const srcFullPath = join(WORKSPACE.projects, filePath)
      if (!existsSync(srcFullPath)) {
        if (ruleSource === 'memory') {
          fileRuleMemoryAdapter.recordResult(ruleId, false)
        }
        eventBus.emit('file_organizer.move.skipped' as any, {
          filePath,
          sourcePath: filePath,
          targetPath: targetDir.replace(/\/$/, '') + '/' + fileName,
          ruleId,
          ruleSource,
          reason: 'source_not_found',
          timestamp: Date.now(),
        })
        return {
          problemId: problem.id,
          success: false,
          summary: `源文件不存在: ${filePath}`,
          durationMs: Date.now() - startTime,
          error: 'source_not_found',
        }
      }

      const dstFullDir = join(WORKSPACE.projects, targetDir.replace(/\/$/, ''))
      const dstFullPath = join(dstFullDir, fileName)

      // 目标路径与源路径相同 → 跳过
      if (resolve(srcFullPath) === resolve(dstFullPath)) {
        if (ruleSource === 'memory') {
          fileRuleMemoryAdapter.recordResult(ruleId, true)
        }
        eventBus.emit('file_organizer.move.skipped' as any, {
          filePath,
          sourcePath: filePath,
          targetPath: targetDir.replace(/\/$/, '') + '/' + fileName,
          ruleId,
          ruleSource,
          reason: 'already_in_place',
          timestamp: Date.now(),
        })
        return {
          problemId: problem.id,
          success: true,
          summary: `文件已在目标位置: ${filePath}`,
          durationMs: 0,
        }
      }

      // ── 确保目标目录存在 ──
      if (!existsSync(dstFullDir)) {
        mkdirSync(dstFullDir, { recursive: true })
      }

      // ── 发射移动开始事件 ──
      const organizedPath = targetDir.replace(/\/$/, '') + '/' + fileName
      eventBus.emit('file_organizer.move.start' as any, {
        filePath,
        sourcePath: filePath,
        targetPath: organizedPath,
        ruleId,
        ruleSource,
        timestamp: Date.now(),
      })

      // ── 执行移动 ──
      renameSync(srcFullPath, dstFullPath)

      // ── 发射移动完成事件 ──
      eventBus.emit('file_organizer.move.completed' as any, {
        filePath,
        sourcePath: filePath,
        targetPath: organizedPath,
        ruleId,
        ruleSource,
        success: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      })

      // ── 记录移动轨迹 ──
      if (ruleSource === 'memory') {
        fileRuleMemoryAdapter.recordResult(ruleId, true)
      } else {
        genePool.recordApply(ruleId)
        feedbackTracker.recordMove(ruleId, filePath, organizedPath)
      }

      log('INFO', 'file_organizer_exec_done', {
        source: filePath,
        target: organizedPath,
        ruleId,
        ruleSource,
        durationMs: Date.now() - startTime,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 已整理: ${filePath} → ${organizedPath}`,
        durationMs: Date.now() - startTime,
        output: `文件已从 ${filePath} 移动到 ${organizedPath}\n匹配规则: ${ruleId} (来源: ${ruleSource})`,
      }
    } catch (err: any) {
      const metadata = problem.context.metadata || {}
      if (metadata.ruleSource === 'memory' && metadata.ruleId) {
        fileRuleMemoryAdapter.recordResult(metadata.ruleId, false)
      }

      eventBus.emit('file_organizer.move.failed' as any, {
        filePath: metadata.filePath || problem.file || '',
        sourcePath: problem.file || '',
        targetPath: (metadata.targetDir || '') + '/' + ((problem.file || '').split('/').pop() || ''),
        ruleId: metadata.ruleId || '',
        ruleSource: metadata.ruleSource || 'genepool',
        error: err.message,
        timestamp: Date.now(),
      })

      log('ERROR', 'file_organizer_exec_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `文件整理失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }
}
