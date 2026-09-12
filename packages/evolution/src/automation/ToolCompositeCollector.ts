/**
 * ToolCompositeCollector — 复合工具机会采集器
 *
 * ## 职责
 * 1. 使用 PatternMiner（PrefixSpan）挖掘频繁工具调用序列
 * 2. 筛选适合封装为复合工具的序列（长度 >= 2、支持度达标、成功率高）
 * 3. 检查是否已存在同名的复合工具提案，避免重复
 * 4. 为新序列生成 Problem 条目供 ToolCompositeExecutor 处理
 *
 * ## 触发条件
 * - 运行间隔与进化周期匹配（每 2 小时）
 * - 序列长度 >= 2 且 <= 5
 * - 支持度 >= 3（至少出现 3 次）
 * - 置信度（成功率）>= 0.6
 * - 该序列不在最近生成的复合工具列表中
 *
 * ## 输出
 * Problem（source='tool', severity='info'）
 * 上下文包含：工具序列、频率、置信度、参数模板
 *
 * @module evolution/automation
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { patternMiner } from '@akemi-mio/evolution/behavior/PatternMiner'
import { toolCompositeGenerator } from '@akemi-mio/capabilities/tool/ToolCompositeGenerator'
import type { SignalCollector, Problem, ProblemSource } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 采集最小运行间隔（与进化周期匹配） */
const COLLECT_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 复合工具的最小序列长度 */
const MIN_SEQUENCE_LENGTH = 2

/** 复合工具的最大序列长度 */
const MAX_SEQUENCE_LENGTH = 5

/** 最小支持度（序列出现次数） */
const MIN_SUPPORT = 3

/** 最小置信度（成功率） */
const MIN_CONFIDENCE = 0.6

/** 单次采集最大生成的问题数 */
const MAX_PROBLEMS_PER_COLLECT = 3

/** 问题来源 */
const SOURCE: ProblemSource = 'tool'

// =============================================================================
// ToolCompositeCollector
// =============================================================================

export class ToolCompositeCollector implements SignalCollector {
  readonly name = 'ToolCompositeCollector'
  readonly source: ProblemSource = SOURCE

  private lastRunAt = 0

  /**
   * 已复合的工具序列集合（指纹：sequence.join('→')）。
   * 用于去重：同一指纹不重复提交 Problem。
   */
  private seenSequenceFingerprints = new Set<string>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRunAt < COLLECT_INTERVAL_MS) return false
    return true
  }

  getSkipReason(): string {
    const elapsed = Date.now() - this.lastRunAt
    const remaining = Math.max(0, COLLECT_INTERVAL_MS - elapsed)
    return `冷却中，距下次运行还有 ${Math.round(remaining / 60000)} 分钟`
  }

  async collect(): Promise<Problem[]> {
    this.lastRunAt = Date.now()
    const problems: Problem[] = []

    try {
      // ── 阶段 1：运行 PatternMiner ──
      // 收集已注册的复合工具指纹，避免重复提议
      const existingProposals = toolCompositeGenerator.getAllProposals()
      const existingFingerprints = new Set(existingProposals.map((p) => p.toolSequence.join('→')))

      // 将 existingFingerprints 也加入 seenSequenceFingerprints
      for (const fp of existingFingerprints) {
        this.seenSequenceFingerprints.add(fp)
      }

      // 使用已有的 seenFingerprints 作为为现有模式 ID
      const existingIds = new Set(existingProposals.map((p) => p.patternId))
      const { patterns } = patternMiner.mine(existingIds)

      if (patterns.length === 0) {
        log('INFO', 'composite_collector_no_patterns')
        return []
      }

      log('INFO', 'composite_collector_patterns_found', {
        totalPatterns: patterns.length,
      })

      // ── 阶段 2：筛选适合复合的序列 ──
      const candidates = patterns
        .filter((p) => {
          // 长度检查
          if (p.toolSignature.length < MIN_SEQUENCE_LENGTH) return false
          if (p.toolSignature.length > MAX_SEQUENCE_LENGTH) return false

          // 支持度检查
          if (p.frequency < MIN_SUPPORT) return false

          // 置信度检查
          if (p.confidence < MIN_CONFIDENCE) return false

          // 去重检查
          const fingerprint = p.toolSignature.join('→')
          if (this.seenSequenceFingerprints.has(fingerprint)) return false

          return true
        })
        .sort((a, b) => b.frequency - a.frequency) // 按频率降序
        .slice(0, MAX_PROBLEMS_PER_COLLECT)

      if (candidates.length === 0) {
        log('INFO', 'composite_collector_no_candidates')
        return []
      }

      // ── 阶段 3：生成 Problem ──
      for (const candidate of candidates) {
        const fingerprint = candidate.toolSignature.join('→')
        this.seenSequenceFingerprints.add(fingerprint)

        const sequenceDesc = candidate.toolSignature.join(' → ')
        const problemId = `composite:${candidate.id}`
        const generatedToolName = this.inferToolName(candidate.toolSignature)

        const problem: Problem = {
          id: problemId,
          source: SOURCE,
          severity: 'info',
          title: `发现可复合的工具序列: ${sequenceDesc}`,
          description: this.buildDescription(candidate),
          estimatedCostChars: 200 + candidate.toolSignature.length * 50,
          lastSeen: Date.now(),
          occurrenceCount: candidate.frequency,
          context: {
            raw: [
              `频繁工具序列: ${sequenceDesc}`,
              `出现次数: ${candidate.frequency}`,
              `置信度: ${(candidate.confidence * 100).toFixed(0)}%`,
              `序列长度: ${candidate.toolSignature.length}`,
              `生成工具名: ${generatedToolName}`,
              `模式 ID: ${candidate.id}`,
              ``,
              `步骤详情:`,
              ...candidate.steps.map((s, i) => `  ${i + 1}. ${s.toolName} - ${s.description}${s.optional ? ' (可选)' : ''}`),
            ].join('\n'),
            metadata: {
              toolSequence: candidate.toolSignature.join(','),
              sequenceLength: String(candidate.toolSignature.length),
              frequency: String(candidate.frequency),
              confidence: String(candidate.confidence),
              patternId: candidate.id,
              generatedToolName,
              source: 'composite_mining',
            },
          },
        }

        problems.push(problem)
      }

      log('INFO', 'composite_collector_result', {
        candidates: candidates.length,
        problemsGenerated: problems.length,
        seenFingerprints: this.seenSequenceFingerprints.size,
      })
    } catch (err: any) {
      log('ERROR', 'composite_collector_error', { error: err.message })
    }

    return problems
  }

  /**
   * 重置去重缓存（用于测试或强制重新发现）。
   */
  resetSeenCache(): void {
    this.seenSequenceFingerprints.clear()
    log('INFO', 'composite_collector_cache_reset')
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 构建 Problem 的可读描述。
   */
  private buildDescription(candidate: {
    toolSignature: string[]
    frequency: number
    confidence: number
    steps: Array<{ toolName: string; description: string }>
  }): string {
    const sequenceDesc = candidate.toolSignature.join(' → ')
    const stepsDesc = candidate.steps.map((s, i) => `  ${i + 1}. ${s.toolName}: ${s.description}`).join('\n')

    return [
      `【复合工具机会 - 自动发现】`,
      ``,
      `检测到频繁出现的工具调用序列，适合封装为一步复合工具：`,
      ``,
      `- 工具序列: ${sequenceDesc}`,
      `- 出现次数: ${candidate.frequency} 次`,
      `- 历史成功率: ${(candidate.confidence * 100).toFixed(0)}%`,
      `- 序列长度: ${candidate.toolSignature.length} 步`,
      ``,
      `步骤详情:`,
      stepsDesc,
      ``,
      `【操作建议】`,
      `复合工具执行器将自动为此序列生成复合工具，`,
      `生成后需要您审核批准方可注册到运行时。`,
      `审核通过后，该复合工具将像普通 MCP 工具一样可用。`,
      ``,
      `【风险提示】`,
      `- 复合工具可能因参数不完整导致中间步骤失败`,
      `- 生成后建议先在安全场景测试`,
      `- 可随时通过工具驳回不再需要的复合工具`,
    ].join('\n')
  }

  /**
   * 从工具序列推断复合工具名。
   */
  private inferToolName(toolSignature: string[]): string {
    const verbMap: Record<string, string> = {
      grep: 'search',
      read_file: 'read',
      write_file: 'write',
      edit_file: 'edit',
      run_command: 'exec',
      list_files: 'list',
      search: 'find',
      remember_fact: 'remember',
      analyze_codebase: 'analyze',
    }

    const verbs = toolSignature.slice(0, 2).map((t) => verbMap[t] || t.replace(/_/g, ''))
    let name = verbs.join('_and_')
    if (toolSignature.length > 2) name = name + '_multi'
    return name
  }
}
