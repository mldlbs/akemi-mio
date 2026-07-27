/**
 * UserErrorPatternCollector — 用户错误模式采集器
 *
 * 职责：
 * 读取 ToolFeedbackLoop 的实时工具错误数据 + UserBehaviorAnalyzer 的
 * 工具调用质量记录，将高频错误工具映射到源码模块，生成进化管道 Problem，
 * 使 Evolution 能自动识别用户频繁出错的痛点并优先改进。
 *
 * 数据流：
 *   ToolFeedbackLoop 记录工具成功率
 *     → UserErrorPatternCollector.collect()
 *     → 识别高错误率工具（EMA 成功率 < 阈值）
 *     → 映射到源码模块/文件路径
 *     → 构建 Problem[]（source='behavior'）
 *     → LearningCurveExecutor 执行代码分析 + 补丁生成
 *
 * 学习曲线适配：
 * - 高频错误工具 → 高优先级 Problem（改进错误处理/提示信息/简化逻辑）
 * - 多错误模式叠加 → 更高优先级（用户反复在相同模式上出错）
 * - 同一工具连续多周期错误 → 升级严重度
 */

import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from './types'
import { toolFeedbackLoop } from '../../behavior/ToolFeedbackLoop'

// ════════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════════

/** 最小运行间隔（毫秒），避免每周期重复采集 */
const MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

/** 工具高错误阈值：EMA 成功率低于此值视为需要改进 */
const HIGH_ERROR_THRESHOLD = 0.5

/** 工具中等错误阈值：EMA 成功率在此值以下但高于 HIGH_ERROR_THRESHOLD */
const MEDIUM_ERROR_THRESHOLD = 0.75

/** 最低样本量：工具至少有这么多执行样本才纳入分析 */
const MIN_SAMPLES_FOR_ANALYSIS = 3

/** 连续周期高错误后升级 */
const CONSECUTIVE_HIGH_ERROR_CYCLES = 2

/** 工具名称 → 源码模块路径映射 */
const TOOL_TO_MODULE: Record<string, { module: string; description: string }> = {
  read_file: { module: 'tool', description: '文件读取工具' },
  write_file: { module: 'tool', description: '文件写入工具' },
  edit_file: { module: 'tool', description: '文件编辑工具' },
  grep: { module: 'tool', description: '代码搜索工具' },
  list_files: { module: 'tool', description: '文件浏览工具' },
  run_command: { module: 'tool', description: '命令执行工具' },
  remember_fact: { module: 'memory', description: '记忆存储工具' },
  analyze_codebase: { module: 'agent', description: '代码分析工具' },
  analyze_task: { module: 'agent', description: '任务分析工具' },
  create_dev_plan: { module: 'agent', description: '计划创建工具' },
  update_plan_progress: { module: 'agent', description: '计划进度更新工具' },
  generate_image: { module: 'creativity', description: '图像生成工具' },
  writing_system: { module: 'writing', description: '写作系统工具' },
  social_pipeline: { module: 'tool', description: '社交媒体发布工具' },
  query_trends: { module: 'tool', description: '趋势查询工具' },
  cicd_trigger: { module: 'cicd', description: 'CI/CD 触发工具' },
  memory_search: { module: 'memory', description: '记忆搜索工具' },
  memory_save: { module: 'memory', description: '记忆保存工具' },
  telegram_send: { module: 'telegram', description: 'Telegram 推送工具' },
  workflow_run: { module: 'tool', description: '工作流执行工具' },
}

/** 未映射工具的默认模块 */
const DEFAULT_MODULE = { module: 'agent', description: '通用工具' }

// ════════════════════════════════════════════════════════════════
//  UserErrorPatternCollector
// ════════════════════════════════════════════════════════════════

export class UserErrorPatternCollector implements SignalCollector {
  readonly name = 'user-error-pattern-collector'
  readonly source = 'behavior' as const

  /** 上次运行时间 */
  private lastRun = 0

  /** 跨周期错误追踪：工具名 → 连续高错误周期数 */
  private consecutiveErrorCycles = new Map<string, number>()

  /** 已生成的问题 ID 集合（用于去重 + 跨周期 occurrence 累计） */
  private seenProblemIds = new Map<string, number>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  getSkipReason(): string {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) {
      const remaining = Math.round((MIN_INTERVAL_MS - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    try {
      this.lastRun = Date.now()

      // 1. 获取 ToolFeedbackLoop 诊断数据
      const diagnostics = toolFeedbackLoop.getDiagnostics()
      const reports = diagnostics.reports

      if (reports.length === 0) {
        log('INFO', 'error_pattern_collector_no_data', { reason: 'no_tool_feedback_reports' })
        return []
      }

      // 2. 过滤出高/中错误率的工具
      const highErrorTools = reports.filter(
        (r) => r.sampleCount >= MIN_SAMPLES_FOR_ANALYSIS && r.emaSuccessRate < HIGH_ERROR_THRESHOLD,
      )

      const mediumErrorTools = reports.filter(
        (r) =>
          r.sampleCount >= MIN_SAMPLES_FOR_ANALYSIS &&
          r.emaSuccessRate >= HIGH_ERROR_THRESHOLD &&
          r.emaSuccessRate < MEDIUM_ERROR_THRESHOLD,
      )

      if (highErrorTools.length === 0 && mediumErrorTools.length === 0) {
        log('INFO', 'error_pattern_collector_no_high_error_tools', {
          totalToolsTracked: diagnostics.toolsTracked.length,
        })
        return []
      }

      log('INFO', 'error_pattern_collector_error_tools_found', {
        highErrorCount: highErrorTools.length,
        mediumErrorCount: mediumErrorTools.length,
      })

      // 3. 构建 Problem 列表
      const problems: Problem[] = []

      // 处理高错误工具（error 级）
      for (const tool of highErrorTools) {
        const moduleInfo = TOOL_TO_MODULE[tool.toolName] || DEFAULT_MODULE
        const problemId = `behavior:high_error:${tool.toolName}`

        // 更新连续错误周期计数
        const prevCycles = this.consecutiveErrorCycles.get(tool.toolName) ?? 0
        this.consecutiveErrorCycles.set(tool.toolName, prevCycles + 1)

        const isSeen = this.seenProblemIds.has(problemId)
        const occurrenceCount = isSeen ? (this.seenProblemIds.get(problemId) ?? 0) + 1 : 1
        this.seenProblemIds.set(problemId, occurrenceCount)

        problems.push({
          id: problemId,
          source: 'behavior',
          severity: 'error',
          title: `用户频繁在「${tool.toolName}」工具上出错`,
          description: this.buildErrorProblemDescription(tool, moduleInfo, prevCycles),
          estimatedCostChars: 400,
          lastSeen: Date.now(),
          occurrenceCount,
          context: {
            raw: this.buildErrorPatternRaw(tool, moduleInfo),
            metadata: {
              toolName: tool.toolName,
              emaSuccessRate: String(tool.emaSuccessRate),
              sampleCount: String(tool.sampleCount),
              errorPatterns: tool.errorPatterns.join(', ') || 'unknown',
              relatedModule: moduleInfo.module,
              consecutiveErrorCycles: String(prevCycles + 1),
              isSuppressed: String(tool.isSuppressed),
              optimizationType: 'improve_error',
            },
          },
        })
      }

      // 处理中等错误工具（warning 级）
      for (const tool of mediumErrorTools) {
        const moduleInfo = TOOL_TO_MODULE[tool.toolName] || DEFAULT_MODULE
        const problemId = `behavior:medium_error:${tool.toolName}`

        const isSeen = this.seenProblemIds.has(problemId)
        const occurrenceCount = isSeen ? (this.seenProblemIds.get(problemId) ?? 0) + 1 : 1
        this.seenProblemIds.set(problemId, occurrenceCount)

        if (!tool.isSuppressed) {
          problems.push({
            id: problemId,
            source: 'behavior',
            severity: 'warning',
            title: `工具「${tool.toolName}」错误率偏高`,
            description: this.buildMediumProblemDescription(tool, moduleInfo),
            estimatedCostChars: 300,
            lastSeen: Date.now(),
            occurrenceCount,
            context: {
              raw: this.buildErrorPatternRaw(tool, moduleInfo),
              metadata: {
                toolName: tool.toolName,
                emaSuccessRate: String(tool.emaSuccessRate),
                sampleCount: String(tool.sampleCount),
                errorPatterns: tool.errorPatterns.join(', ') || 'unknown',
                relatedModule: moduleInfo.module,
                optimizationType: 'improve_error',
              },
            },
          })
        }
      }

      log('INFO', 'error_pattern_collector_done', {
        problemsCreated: problems.length,
        highError: highErrorTools.length,
        mediumError: mediumErrorTools.length,
        topTool: highErrorTools[0]?.toolName ?? mediumErrorTools[0]?.toolName ?? 'none',
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'error_pattern_collector_error', { error: err.message })
      return []
    }
  }

  /** 重置跨周期状态（用于测试或手动清空） */
  resetState(): void {
    this.consecutiveErrorCycles.clear()
    this.seenProblemIds.clear()
    log('INFO', 'error_pattern_collector_state_reset')
  }

  // ==================== 内部方法 ====================

  /** 构建高错误工具问题的详细描述 */
  private buildErrorProblemDescription(
    tool: { toolName: string; emaSuccessRate: number; sampleCount: number; errorPatterns: string[] },
    moduleInfo: { module: string; description: string },
    consecutiveCycles: number,
  ): string {
    const rate = (tool.emaSuccessRate * 100).toFixed(0)
    const patterns = tool.errorPatterns.length > 0 ? tool.errorPatterns.join('、') : '未知'

    const lines: string[] = [
      `检测到工具「${tool.toolName}」存在高错误率（成功率 ${rate}%，${tool.sampleCount} 样本），`,
      `表明该工具的执行质量需要改进。`,
      ``,
      `关联模块: ${moduleInfo.module}（${moduleInfo.description}）`,
      `主导错误模式: ${patterns}`,
      `连续高错误周期: ${consecutiveCycles + 1}`,
      ``,
      `建议的改进方向：`,
      `1. 分析错误模式「${patterns}」的根本原因，改进错误处理逻辑`,
      `2. 优化错误提示信息，让用户更清楚失败原因`,
      `3. 对可重试操作增加自动重试机制（指数退避）`,
      `4. 对权限/配置类错误提供更具体的修复指引`,
    ]

    if (consecutiveCycles >= CONSECUTIVE_HIGH_ERROR_CYCLES) {
      lines.push(``, `⚠️  已持续 ${consecutiveCycles + 1} 个周期高错误，建议优先处理。`)
    }

    return lines.join('\n')
  }

  /** 构建中等错误工具问题的描述 */
  private buildMediumProblemDescription(
    tool: { toolName: string; emaSuccessRate: number; sampleCount: number; errorPatterns: string[] },
    moduleInfo: { module: string; description: string },
  ): string {
    const rate = (tool.emaSuccessRate * 100).toFixed(0)
    const patterns = tool.errorPatterns.length > 0 ? tool.errorPatterns.join('、') : '未知'

    return [
      `工具「${tool.toolName}」错误率处于中等水平（成功率 ${rate}%，${tool.sampleCount} 样本）。`,
      `主导错误模式: ${patterns}`,
      `关联模块: ${moduleInfo.module}（${moduleInfo.description}）`,
      ``,
      `建议：分析错误模式，评估是否需要改进该工具的健壮性。`,
    ].join('\n')
  }

  /** 构建错误模式的原始上下文文本 */
  private buildErrorPatternRaw(
    tool: { toolName: string; emaSuccessRate: number; sampleCount: number; errorPatterns: string[] },
    moduleInfo: { module: string; description: string },
  ): string {
    return [
      `用户错误模式分析:`,
      `工具: ${tool.toolName}`,
      `EMA 成功率: ${(tool.emaSuccessRate * 100).toFixed(1)}%`,
      `样本数: ${tool.sampleCount}`,
      `错误模式: ${tool.errorPatterns.join(', ') || '无'}`,
      `关联模块: ${moduleInfo.module}`,
      `模块描述: ${moduleInfo.description}`,
    ].join('\n')
  }
}

/** 模块级单例 */
export const userErrorPatternCollector = new UserErrorPatternCollector()
