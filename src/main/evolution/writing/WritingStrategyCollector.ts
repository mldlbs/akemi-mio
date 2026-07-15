/**
 * WritingStrategyCollector — 写作策略质量采集器
 *
 * 作为自动化管道中的 Collector，采集已改写章节的质量数据。
 * 每次运行评估最近修改的章节，生成质量报告作为 Problem 提交到管道，
 * 供 WritingStrategyExecutor 消费以优化改写参数。
 *
 * 工作流：
 *   1. 扫描 docs/chapters/ 下最近修改的章节
 *   2. 使用 WritingQualityEvaluator 评估各维度质量
 *   3. 如果评分低于阈值，生成对应的 Problem
 *   4. Problem 被 Pipeline 捕获 → WritingStrategyExecutor 执行参数优化
 */

import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from '../automation/types'
import { WritingQualityEvaluator, type QualityEvalResult } from './WritingQualityEvaluator'
import { writingParameterSpace } from './WritingParameterSpace'

/** 默认质量阈值：低于此分数将触发优化 */
const DEFAULT_QUALITY_THRESHOLD = 65

/** 最小运行间隔：30 分钟（每次管道执行最多分析一次） */
const MIN_INTERVAL_MS = 30 * 60 * 1000

/** 每次评估的最大章节数 */
const MAX_CHAPTERS_PER_RUN = 5

export class WritingStrategyCollector implements SignalCollector {
  readonly name = 'writing-strategy-collector'
  readonly source = 'writing' as const

  private lastRun = 0
  private evaluator: WritingQualityEvaluator
  private qualityThreshold: number

  constructor(qualityThreshold?: number) {
    this.evaluator = new WritingQualityEvaluator()
    this.qualityThreshold = qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD
  }

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // 获取当前参数空间的格式化信息作为上下文
      const paramContext = writingParameterSpace.formatForPrompt()

      // 评估最近修改的章节
      const results = this.evaluator.evaluateRecentChapters(MAX_CHAPTERS_PER_RUN)

      if (results.length === 0) {
        log('INFO', 'writing_collector_no_chapters')
        return []
      }

      // 计算平均评分
      const avgOverall = results.reduce((sum, r) => sum + r.overall, 0) / results.length
      const avgCoherence = results.reduce((sum, r) => sum + r.dimensions.coherence, 0) / results.length
      const avgKeywordCoverage = results.reduce((sum, r) => sum + r.dimensions.keywordCoverage, 0) / results.length
      const avgStructure = results.reduce((sum, r) => sum + r.dimensions.structurePreservation, 0) / results.length
      const avgDialogue = results.reduce((sum, r) => sum + r.dimensions.dialoguePreservation, 0) / results.length

      log('INFO', 'writing_collector_quality_report', {
        chaptersEvaluated: results.length,
        avgOverall: avgOverall.toFixed(1),
        dimensions: {
          coherence: avgCoherence.toFixed(1),
          keywordCoverage: avgKeywordCoverage.toFixed(1),
          structure: avgStructure.toFixed(1),
          dialogue: avgDialogue.toFixed(1),
        },
      })

      // 记录评分到参数空间
      writingParameterSpace.recordScore({
        snapshot: writingParameterSpace.getCurrentSnapshot(),
        score: avgOverall,
        dimensions: {
          coherence: Math.round(avgCoherence),
          keywordCoverage: Math.round(avgKeywordCoverage),
          structurePreservation: Math.round(avgStructure),
          dialoguePreservation: Math.round(avgDialogue),
        },
        sampleSize: results.length,
        timestamp: Date.now(),
      })

      // 如果评分低于阈值，生成优化问题
      if (avgOverall < this.qualityThreshold || avgCoherence < 55 || avgKeywordCoverage < 50) {
        const worstDim = this.findWorstDimension({
          coherence: avgCoherence,
          keywordCoverage: avgKeywordCoverage,
          structurePreservation: avgStructure,
          dialoguePreservation: avgDialogue,
        })

        const dimLabels: Record<string, string> = {
          coherence: '语义连贯性',
          keywordCoverage: '关键词覆盖率',
          structurePreservation: '结构保留度',
          dialoguePreservation: '对话保留度',
        }

        const problem: Problem = {
          id: `writing:quality:${Date.now()}`,
          source: 'writing',
          severity: avgOverall < 50 ? 'error' : 'warning',
          title: `写作质量需要优化: ${dimLabels[worstDim] || '综合'} (${avgOverall.toFixed(0)}分)`,
          description: [
            `写作质量评分低于阈值(${this.qualityThreshold})，需要调整改写参数。`,
            ``,
            `综合评分: ${avgOverall.toFixed(1)}/100`,
            `  - 语义连贯性: ${avgCoherence.toFixed(1)}`,
            `  - 关键词覆盖率: ${avgKeywordCoverage.toFixed(1)}`,
            `  - 结构保留度: ${avgStructure.toFixed(1)}`,
            `  - 对话保留度: ${avgDialogue.toFixed(1)}`,
            ``,
            `评估章节: ${results.map((r) => r.chapterFile).join(', ')}`,
            ``,
            `当前参数:\n${paramContext}`,
            ``,
            `改进建议:`,
            ...results.flatMap((r) => r.suggestions.map((s) => `  - ${s}`)),
          ].join('\n'),
          estimatedCostChars: 2000,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `writing_quality_${avgOverall.toFixed(0)}`,
            metadata: {
              avgOverall: avgOverall.toFixed(1),
              avgCoherence: avgCoherence.toFixed(1),
              avgKeywordCoverage: avgKeywordCoverage.toFixed(1),
              avgStructure: avgStructure.toFixed(1),
              avgDialogue: avgDialogue.toFixed(1),
              chaptersCount: String(results.length),
              currentParamLabel: writingParameterSpace.getLabel(),
            },
          },
        }

        problems.push(problem)
        log('INFO', 'writing_collector_quality_problem', {
          score: avgOverall.toFixed(1),
          threshold: this.qualityThreshold,
        })
      } else {
        log('INFO', 'writing_collector_quality_ok', {
          score: avgOverall.toFixed(1),
          threshold: this.qualityThreshold,
        })
      }

      // 附加：如果某章节质量特别差，单独报告
      for (const result of results) {
        if (result.overall < 50) {
          problems.push({
            id: `writing:quality:chapter:${Date.now()}:${result.chapterFile.replace(/\//g, '_')}`,
            source: 'writing',
            severity: 'warning',
            title: `章节质量偏低: ${result.chapterTitle} (${result.overall}分)`,
            description: [
              `章节 ${result.chapterFile} 的写作质量评分偏低:`,
              ...result.details,
              ``,
              ...result.suggestions.map((s) => `建议: ${s}`),
            ].join('\n'),
            estimatedCostChars: 1000,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: `chapter_low_quality:${result.chapterFile}`,
              metadata: {
                chapter: result.chapterFile,
                score: String(result.overall),
              },
            },
          })
        }
      }
    } catch (err: any) {
      log('ERROR', 'writing_collector_error', { error: String(err) })
    }

    return problems
  }

  /** 找到评分最低的维度 */
  private findWorstDimension(dimensions: {
    coherence: number
    keywordCoverage: number
    structurePreservation: number
    dialoguePreservation: number
  }): string {
    let worst = 'coherence'
    let minScore = dimensions.coherence
    for (const [key, value] of Object.entries(dimensions)) {
      if (value < minScore) {
        minScore = value
        worst = key
      }
    }
    return worst
  }

  /** 设置质量阈值 */
  setThreshold(threshold: number): void {
    this.qualityThreshold = threshold
  }

  /** 获取当前阈值 */
  getThreshold(): number {
    return this.qualityThreshold
  }
}
