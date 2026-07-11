/**
 * TypeHealthCollector — 类型健康度采集器
 *
 * 集成到进化系统的自动化管道中，周期性扫描项目代码库的类型健康度。
 * 当学习系统有活跃学习计划时，根据学习计划的目标分类过滤检测项，
 * 将相关类型问题作为 Problem 提交到进化管道。
 */

import { existsSync } from 'fs'
import { log } from '../../logger/Logger'
import { DEV_PROJECT_ROOT } from '../../config'
import { typeHealthScanner } from './TypeHealthScanner'
import { learningVocabularyManager } from '../../learning/LearningVocabularyManager'
import type { SignalCollector, Problem, ProblemSource, Severity } from '../automation/types'
import type { TypeHealthCategory } from './TypeHealthIssue'
import type { LearningCategory } from '../../learning/types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 最小扫描间隔（毫秒） */
const MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

// ══════════════════════════════════════════
//  Severity 映射
// ══════════════════════════════════════════

const SEVERITY_MAP: Record<string, Severity> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  suggestion: 'info',
}

/**
 * 估算修复成本（字符数）
 */
function estimateCost(category: TypeHealthCategory): number {
  const costs: Record<TypeHealthCategory, number> = {
    explicit_any: 30,
    as_any: 40,
    unsafe_assertion: 80,
    missing_return_type: 20,
    missing_param_type: 15,
    any_array: 25,
    ts_ignore: 100,
    generic_opportunity: 120,
    conditional_opportunity: 200,
    type_guard_opportunity: 150,
  }
  return costs[category] || 50
}

/**
 * 获取问题 ID
 */
function issueToProblemId(file: string, line: number, category: string): string {
  return `typehealth:${file}:${line}:${category}`
}

// ══════════════════════════════════════════
//  TypeHealthCollector
// ══════════════════════════════════════════

export class TypeHealthCollector implements SignalCollector {
  readonly name = 'type-health'
  readonly source: ProblemSource = 'tsc'

  private lastRun = 0

  shouldRun(): boolean {
    const root = this.getProjectRoot()
    if (!root || !existsSync(root)) return false
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const root = this.getProjectRoot()
    if (!root) return []

    try {
      // 1. 获取当前学习上下文
      const learningCategories = this.getLearningCategories()

      // 2. 配置扫描器
      typeHealthScanner.setConfig({
        projectRoot: root,
        targetCategories: learningCategories,
      })

      // 3. 执行扫描
      const issues = typeHealthScanner.scan()

      if (issues.length === 0) {
        log('INFO', 'type_health_collector_empty', {
          learningCategories: learningCategories.join(','),
        })
        return []
      }

      // 4. 转换为 Problem[]
      const problems: Problem[] = issues.map((issue) => ({
        id: issueToProblemId(issue.file, issue.line, issue.category),
        source: 'tsc' as ProblemSource,
        severity: SEVERITY_MAP[issue.severity] || 'info',
        title: `[类型健康] ${issue.title}: ${issue.file}:${issue.line}`,
        description: issue.description,
        file: issue.file,
        line: issue.line,
        estimatedCostChars: estimateCost(issue.category),
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: issue.snippet,
          metadata: {
            category: issue.category,
            suggestion: issue.suggestion,
            learningCategory: issue.learningCategory || '未关联',
          },
        },
      }))

      log('INFO', 'type_health_collector_done', {
        count: problems.length,
        learningCategories: learningCategories.join(','),
      })

      return problems
    } catch (err: any) {
      log('WARN', 'type_health_collector_error', { error: err.message })
      return []
    }
  }

  /**
   * 获取当前学习计划中的分类。
   * 从 LearningVocabularyManager 中提取未掌握的学习项对应的分类。
   */
  private getLearningCategories(): LearningCategory[] {
    try {
      const items = learningVocabularyManager.getUnmasteredItems()
      if (!items || items.length === 0) return []

      // 按分类聚合，选择掌握度最低的分类作为目标
      const categoryAvgMastery = new Map<string, { sum: number; count: number }>()
      for (const item of items) {
        const cat = item.category
        if (!categoryAvgMastery.has(cat)) {
          categoryAvgMastery.set(cat, { sum: 0, count: 0 })
        }
        const entry = categoryAvgMastery.get(cat)!
        entry.sum += item.mastery
        entry.count++
      }

      // 按掌握度从低到高排序，取前 3 个分类作为扫描目标
      const sorted = Array.from(categoryAvgMastery.entries())
        .map(([cat, { sum, count }]) => ({ category: cat, avgMastery: sum / count }))
        .sort((a, b) => a.avgMastery - b.avgMastery)
        .slice(0, 3)

      return sorted.map((s) => s.category as LearningCategory)
    } catch {
      // 如果学习系统不可用，返回空（扫描全部）
      return []
    }
  }

  /**
   * 获取项目根目录。
   */
  private getProjectRoot(): string {
    return DEV_PROJECT_ROOT || process.cwd()
  }
}
