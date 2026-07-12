/**
 * FileOrganizerCollector — 文件整理问题采集器
 *
 * SignalCollector 实现，source='file_organizer'。
 *
 * 职责：
 * 1. 扫描工作区文件并提取特征
 * 2. 用基因池规则判断文件是否需要整理
 * 3. 用对话记忆中的归档规则匹配文件
 * 4. 为需要整理的文件生成 Problem（源类型 file_organizer）
 * 5. 触发反馈检查，记录用户反向操作的反馈信号
 * 6. 消耗基因池 tick，到达进化间隔时触发规则进化
 */

import { minimatch } from 'minimatch'
import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from '../automation/types'
import { fileScanner } from './FileScanner'
import { genePool } from './GenePool'
import { feedbackTracker } from './FeedbackTracker'
import { fileRuleMemoryAdapter } from './FileRuleMemoryAdapter'
import { voiceFileOrganizerBridge } from './VoiceFileOrganizerBridge'
import type { FileRuleEntry } from './FileRuleMemoryAdapter'

export class FileOrganizerCollector implements SignalCollector {
  readonly name = 'file-organizer-collector'
  readonly source = 'file_organizer' as const

  private lastRun = 0
  /** 最小运行间隔：30 分钟 */
  private minIntervalMs = 30 * 60 * 1000

  /** 是否已初始化 */
  private initialized = false

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    if (!this.initialized) {
      genePool.init()
      feedbackTracker.init()
      this.initialized = true
    }

    try {
      // ── 阶段 1：扫描文件 ──
      const files = fileScanner.scan()

      if (files.length === 0) {
        log('INFO', 'file_organizer_collector_no_files')
        return []
      }

      // ── 阶段 2：反馈检查 ──
      const currentPaths = new Set(files.map((f) => f.path))
      const [positiveFeedbacks, negativeFeedbacks] = feedbackTracker.checkFeedback(currentPaths)

      // 应用反馈到基因池
      for (const ruleId of positiveFeedbacks) {
        genePool.recordPositiveFeedback(ruleId)
      }
      for (const ruleId of negativeFeedbacks) {
        genePool.recordNegativeFeedback(ruleId)
      }

      // ── 阶段 3：匹配规则，生成问题 ──
      const problems: Problem[] = []
      const seenPaths = new Set<string>() // 去重：同一文件只生成一个问题

      // 3a. 先用对话记忆中的归档规则匹配（用户明确的规则优先级更高）
      const memoryRules = fileRuleMemoryAdapter.getAllRules()
      const activeMemoryRules = memoryRules.filter((r) => !r.rule.disabled)

      for (const file of files) {
        // 遍历活跃的记忆规则找第一个匹配的
        let matchedMemoryRule: FileRuleEntry | null = null
        for (const mr of activeMemoryRules) {
          try {
            if (minimatch(file.path, mr.rule.filePattern, { dot: true })) {
              matchedMemoryRule = mr
              break
            }
          } catch {
            continue
          }
        }
        if (!matchedMemoryRule) continue

        const rule = matchedMemoryRule
        const targetDir = rule.rule.targetPath.replace(/\/?$/, '/')

        // 检查文件是否已在目标目录中
        const normalizedFilePath = file.path.replace(/\\/g, '/')
        const normalizedTarget = targetDir.replace(/\\/g, '/')
        if (normalizedFilePath.startsWith(normalizedTarget)) continue

        const problemId = `file_rule:${file.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        seenPaths.add(file.path)

        problems.push({
          id: problemId,
          source: 'file_organizer',
          severity: 'info',
          title: `整理文件(对话规则): ${file.name}`,
          description: `${file.path} → ${targetDir}${file.name}（记忆规则: ${rule.rule.description}）`,
          file: file.path,
          estimatedCostChars: 50,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `文件整理建议(来自对话记忆规则):\n源路径: ${file.path}\n目标目录: ${targetDir}\n记忆规则: ${rule.memoryId}\n规则描述: ${rule.rule.description}\n来源对话: ${rule.rule.sourceText}`,
            metadata: {
              ruleId: rule.memoryId,
              ruleSource: 'memory',
              targetDir,
              fileExtension: file.extension,
              fileSize: String(file.sizeBytes),
              isTest: String(file.isTest),
              isConfig: String(file.isConfig),
              filePattern: rule.rule.filePattern,
            },
          },
        })
      }

      // 3b. 再用基因池规则匹配（用户未明确指定的文件交给基因池）
      for (const file of files) {
        // 跳过已由记忆规则处理的文件
        if (seenPaths.has(file.path)) continue

        const bestRule = genePool.findBestRule(file)
        if (!bestRule) continue

        // 如果文件已在目标位置，跳过
        if (genePool.isOrganized(file)) continue

        const targetDir = genePool.expandTargetTemplate(bestRule.action.target, file)
        const problemId = `file_organizer:${file.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`

        problems.push({
          id: problemId,
          source: 'file_organizer',
          severity: 'info',
          title: `整理文件: ${file.name}`,
          description: `${file.path} → ${targetDir}${file.name}（规则: ${bestRule.label || bestRule.id}）`,
          file: file.path,
          estimatedCostChars: 50,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `文件整理建议:\n源路径: ${file.path}\n目标目录: ${targetDir}\n匹配规则: ${bestRule.id} (适应度: ${bestRule.fitness})\n规则标签: ${bestRule.label || '未命名'}`,
            metadata: {
              ruleId: bestRule.id,
              ruleSource: 'genepool',
              ruleFitness: String(bestRule.fitness),
              targetDir,
              fileExtension: file.extension,
              fileSize: String(file.sizeBytes),
              isTest: String(file.isTest),
              isConfig: String(file.isConfig),
              generation: String(genePool.currentGeneration),
            },
          },
        })
      }

      // ── 阶段 4：清理过期的反馈记录 ──
      feedbackTracker.cleanup()

      // ── 阶段 5：消耗基因池 tick，触发进化 ──
      const evolved = genePool.tick()

      // ── 阶段 6：激活语音辅助整理 ──
      // 非阻塞执行：voiceFileOrganizerBridge.activateOnScan 内部有超时保护
      // 即使语音监听失败也不影响主流程
      voiceFileOrganizerBridge
        .activateOnScan(files)
        .then((voiceResult) => {
          if (voiceResult.voiceText || voiceResult.filesOrganized > 0) {
            log('INFO', 'file_organizer_voice_result', {
              hasVoice: !!voiceResult.voiceText,
              filesOrganized: voiceResult.filesOrganized,
              summary: voiceResult.summary.slice(0, 100),
              hasSuggestedCategories: (voiceResult.suggestedCategories?.length ?? 0) > 0,
            })
          }
        })
        .catch((err) => {
          log('WARN', 'file_organizer_voice_failed', { error: String(err) })
        })

      log('INFO', 'file_organizer_collector_done', {
        filesScanned: files.length,
        problemsCreated: problems.length,
        memoryRuleCount: activeMemoryRules.length,
        genePoolSize: genePool.size,
        generation: genePool.currentGeneration,
        evolved,
        positiveFeedbacks: positiveFeedbacks.length,
        negativeFeedbacks: negativeFeedbacks.length,
        pendingFeedback: feedbackTracker.getPendingCount(),
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'file_organizer_collector_error', { error: err.message })
      return []
    }
  }
}
