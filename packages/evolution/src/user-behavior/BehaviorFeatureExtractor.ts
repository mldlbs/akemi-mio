/**
 * BehaviorFeatureExtractor — 行为特征提取器
 *
 * 从 UserBehaviorAnalyzer 的运行时数据中提取高频行为序列和停顿模式，
 * 输出结构化特征供 Evolution 系统消费，驱动代码优化。
 *
 * ── 提取内容 ──
 * 1. 高频工具调用序列（2-3 阶 n-gram）→ 预加载/缓存优化
 * 2. 常见停顿点（工具间等待时间异常）→ 响应优化
 * 3. 工具调用频率分布 → 优先级调整
 * 4. 失败模式 → 容错优化
 *
 * ── 集成点 ──
 * - BehaviorCollector（evolution/automation）在管道的 collect 阶段调用 extract()
 * - extract() 读取 userBehaviorAnalyzer 的内存数据，无需额外 DB 查询
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import type { ToolCallRecord } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'

// =============================================================================
// 类型定义
// =============================================================================

/** 识别到的高频工具序列 */
export interface ToolSequence {
  /** 按顺序的工具名列表（长度 2-3） */
  tools: string[]
  /** 该序列出现次数 */
  frequency: number
  /** 序列平均间隔毫秒（最后一个调用的时间差） */
  avgGapMs: number
  /** 序列内是否有失败调用 */
  hasFailures: boolean
  /** 优化类型标签 */
  optimizationHint: 'preload' | 'combine' | 'cache' | 'parallel'
}

/** 停顿点 — 用户在某个工具后等待过长 */
export interface PausePoint {
  /** 停顿前的工具 */
  tool: string
  /** 平均等待时间 ms */
  avgWaitMs: number
  /** 该工具调用次数 */
  frequency: number
  /** 最近一次等待 ms */
  lastWaitMs: number
}

/** 高频工具统计 */
export interface FrequentToolStat {
  name: string
  callCount: number
  successRate: number
  avgDurationMs: number
}

/** 行为特征汇总 */
export interface BehavioralFeatures {
  /** 高频工具序列（按 frequency 降序） */
  frequentSequences: ToolSequence[]
  /** 停顿点（按 avgWaitMs 降序） */
  pausePoints: PausePoint[]
  /** 高频工具统计 */
  frequentTools: FrequentToolStat[]
  /** 优化建议 */
  suggestions: OptimizationSuggestion[]
  /** 是否具有足够的分析数据 */
  hasSufficientData: boolean
  /** 分析窗口内的总交互数 */
  totalToolCalls: number
  /** 特征提取时间戳 */
  extractedAt: number
}

/** 优化建议类型 */
export type OptimizationType =
  | 'preload_module' // 预加载模块 — 某序列频繁出现，可预加载
  | 'merge_tools' // 合并工具调用 — 连续调用可合并
  | 'increase_priority' // 提高工具/模块优先级
  | 'optimize_response' // 优化响应延迟 — 用户在某点等待过长
  | 'add_cache' // 添加缓存 — 相同工具被频繁调用
  | 'improve_error' // 改进错误处理 — 工具频繁失败

/** 优化建议 */
export interface OptimizationSuggestion {
  type: OptimizationType
  /** 建议标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 目标代码模块/工具 */
  target: string
  /** 预期的收益描述 */
  expectedBenefit: string
  /** 风险说明 */
  risk: string
  /** 建议优先级（0-100） */
  priority: number
  /** 预估实现成本（字符数） */
  estimatedCost: number
}

// =============================================================================
// 配置常量
// =============================================================================

/** n-gram 分析的最小序列长度 */
const MIN_NGRAM_LENGTH = 2
/** n-gram 分析的最大序列长度 */
const MAX_NGRAM_LENGTH = 3
/** 序列被认定为"高频"的最小出现次数 */
const MIN_SEQUENCE_FREQUENCY = 2
/** 停顿判定阈值 ms（超过视为用户等待） */
const PAUSE_THRESHOLD_MS = 3000
/** 分析窗口大小 */
const ANALYSIS_WINDOW = 48

// =============================================================================
// BehaviorFeatureExtractor
// =============================================================================

export class BehaviorFeatureExtractor {
  /**
   * 从 userBehaviorAnalyzer 的运行时数据中提取行为特征。
   * 纯内存运算，不依赖外部存储。
   */
  extract(windowSize = ANALYSIS_WINDOW): BehavioralFeatures {
    // 通过访问器获取最近工具调用记录
    const calls = this.getRecentToolCalls(windowSize)

    if (calls.length < 3) {
      return {
        frequentSequences: [],
        pausePoints: [],
        frequentTools: [],
        suggestions: [],
        hasSufficientData: false,
        totalToolCalls: calls.length,
        extractedAt: Date.now(),
      }
    }

    // 并行提取各维度特征
    const sequences = this.extractSequences(calls)
    const pausePoints = this.extractPausePoints(calls)
    const frequentTools = this.extractFrequentTools(calls)
    const suggestions = this.generateSuggestions(sequences, pausePoints, frequentTools)

    return {
      frequentSequences: sequences,
      pausePoints,
      frequentTools,
      suggestions,
      hasSufficientData: true,
      totalToolCalls: calls.length,
      extractedAt: Date.now(),
    }
  }

  // ==================== 工具调用序列分析（n-gram） ====================

  /**
   * 从工具调用记录中提取 2-3 阶高频序列。
   * 使用滑动窗口统计每对/每组工具的连续出现频率。
   */
  private extractSequences(calls: ToolCallRecord[]): ToolSequence[] {
    const ngCounts = new Map<string, { count: number; gaps: number[]; failures: boolean }>()

    for (let n = MIN_NGRAM_LENGTH; n <= MAX_NGRAM_LENGTH; n++) {
      for (let i = 0; i <= calls.length - n; i++) {
        const seq = calls.slice(i, i + n)
        // 检查时间间隔 — 超过 30s 的间隙不算连续调用
        const gapMs = seq[seq.length - 1].timestamp - seq[0].timestamp
        if (gapMs > 30_000) continue

        const key = seq.map((c) => c.name).join('→')
        const existing = ngCounts.get(key)
        const hasFailure = seq.some((c) => c.success === false)

        if (existing) {
          existing.count++
          existing.gaps.push(gapMs)
          if (hasFailure) existing.failures = true
        } else {
          ngCounts.set(key, { count: 1, gaps: [gapMs], failures: hasFailure })
        }
      }
    }

    // 过滤低频序列并转换为结果
    const sequences: ToolSequence[] = []
    for (const [key, data] of ngCounts) {
      if (data.count < MIN_SEQUENCE_FREQUENCY) continue

      const tools = key.split('→')
      const avgGap = data.gaps.reduce((a, b) => a + b, 0) / data.gaps.length
      const hint = this.inferOptimizationHint(tools, avgGap)

      sequences.push({
        tools,
        frequency: data.count,
        avgGapMs: Math.round(avgGap),
        hasFailures: data.failures,
        optimizationHint: hint,
      })
    }

    // 按 frequency 降序排列
    sequences.sort((a, b) => b.frequency - a.frequency)

    return sequences
  }

  /**
   * 根据序列特征推断优化类型。
   */
  private inferOptimizationHint(tools: string[], avgGapMs: number): ToolSequence['optimizationHint'] {
    // 搜索→读取→编辑 → 预加载
    if (
      tools.some((t) => t.includes('grep') || t.includes('search') || t.includes('find')) &&
      tools.some((t) => t.includes('read') || t.includes('Read'))
    ) {
      return 'preload'
    }
    // 连续修改 → 合并
    if (tools.filter((t) => t.includes('edit') || t.includes('write') || t.includes('Edit') || t.includes('Write')).length >= 2) {
      return 'combine'
    }
    // 短间隔重复 → 缓存
    if (avgGapMs < 1000 && new Set(tools).size < tools.length) {
      return 'cache'
    }
    // 长间隔 → 可并行
    if (tools.every((t) => t !== 'read' && t !== 'Write' && t !== 'Edit') && tools.length === 2) {
      return 'parallel'
    }
    return 'preload'
  }

  // ==================== 停顿点检测 ====================

  /**
   * 检测工具调用间的异常等待时间。
   * 如果用户在某个工具后等待超过 PAUSE_THRESHOLD_MS 才发起下一次调用，
   * 说明这个工具可能存在响应延迟问题。
   */
  private extractPausePoints(calls: ToolCallRecord[]): PausePoint[] {
    const pauses = new Map<string, { waits: number[]; count: number }>()

    for (let i = 0; i < calls.length - 1; i++) {
      const current = calls[i]
      const next = calls[i + 1]
      const waitMs = next.timestamp - current.timestamp

      if (waitMs >= PAUSE_THRESHOLD_MS) {
        const existing = pauses.get(current.name)
        if (existing) {
          existing.waits.push(waitMs)
          existing.count++
        } else {
          pauses.set(current.name, { waits: [waitMs], count: 1 })
        }
      }
    }

    const results: PausePoint[] = []
    for (const [tool, data] of pauses) {
      const avgWait = Math.round(data.waits.reduce((a, b) => a + b, 0) / data.waits.length)
      results.push({
        tool,
        avgWaitMs: avgWait,
        frequency: data.count,
        lastWaitMs: data.waits[data.waits.length - 1],
      })
    }

    results.sort((a, b) => b.avgWaitMs - a.avgWaitMs)
    return results
  }

  // ==================== 高频工具统计 ====================

  private extractFrequentTools(calls: ToolCallRecord[]): FrequentToolStat[] {
    const toolMap = new Map<string, { count: number; successes: number }>()

    for (const c of calls) {
      const existing = toolMap.get(c.name)
      if (existing) {
        existing.count++
        if (c.success !== false) existing.successes++
      } else {
        toolMap.set(c.name, { count: 1, successes: c.success !== false ? 1 : 0 })
      }
    }

    const results: FrequentToolStat[] = []
    for (const [name, data] of toolMap) {
      results.push({
        name,
        callCount: data.count,
        successRate: data.count > 0 ? data.successes / data.count : 1,
        avgDurationMs: 0, // duration data requires ToolCallRecord with durationMs field
      })
    }

    results.sort((a, b) => b.callCount - a.callCount)
    return results
  }

  // ==================== 优化建议生成 ====================

  /**
   * 综合分析序列、停顿、频率数据，生成代码优化建议。
   * 每条建议对应一个可在 Evolution 管道中执行的优化任务。
   */
  private generateSuggestions(
    sequences: ToolSequence[],
    pausePoints: PausePoint[],
    frequentTools: FrequentToolStat[],
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = []

    // 1. 高频序列 → 预加载优化
    for (const seq of sequences.slice(0, 3)) {
      const firstTool = seq.tools[0]
      const subsequentTools = seq.tools.slice(1).join('、')

      suggestions.push({
        type: 'preload_module',
        title: `预加载「${firstTool}」后续路径`,
        description:
          `用户高频使用路径 ${seq.tools.join(' → ')}（${seq.frequency} 次）。` +
          `建议在 ${firstTool} 执行过程中预加载 ${subsequentTools} 所需的上下文，` +
          `减少序列总耗时。`,
        target: firstTool,
        expectedBenefit: `预计减少序列延迟 ${Math.round(seq.avgGapMs * 0.3)}ms（30%）`,
        risk: '预加载可能增加内存占用，低风险',
        priority: Math.min(100, seq.frequency * 25),
        estimatedCost: 300 + seq.frequency * 100,
      })
    }

    // 2. 停顿点 → 响应延迟优化
    for (const pp of pausePoints.slice(0, 3)) {
      suggestions.push({
        type: 'optimize_response',
        title: `优化「${pp.tool}」响应延迟`,
        description:
          `用户在 ${pp.tool} 后平均等待 ${Math.round(pp.avgWaitMs / 1000)}s（${pp.frequency} 次）。` +
          `建议优化 ${pp.tool} 的响应逻辑：添加流式输出、减少阻塞操作、或增加进度反馈。`,
        target: pp.tool,
        expectedBenefit: `预计减少等待时间 ${Math.round(pp.avgWaitMs * 0.3)}ms`,
        risk: '响应优化可能改变输出格式，需验证兼容性',
        priority: Math.min(100, Math.round(pp.avgWaitMs / 100)),
        estimatedCost: 500 + Math.round(pp.avgWaitMs / 50),
      })
    }

    // 3. 高频失败工具 → 错误处理优化
    const failedTools = frequentTools.filter((t) => t.successRate < 0.8 && t.callCount >= 2)
    for (const ft of failedTools) {
      suggestions.push({
        type: 'improve_error',
        title: `增强「${ft.name}」容错机制`,
        description:
          `${ft.name} 的成功率仅 ${Math.round(ft.successRate * 100)}%（共 ${ft.callCount} 次）。` +
          `建议增加重试逻辑、更好的错误提示、或更优雅的降级策略。`,
        target: ft.name,
        expectedBenefit: `将 ${ft.name} 成功率提升至 90%+`,
        risk: '增加重试逻辑可能引入延迟，但收益大于风险',
        priority: Math.min(100, Math.round((1 - ft.successRate) * 100)),
        estimatedCost: 400 + (1 - ft.successRate) * 500,
      })
    }

    // 4. 极高频率工具 → 缓存/优先级优化
    const topFreq = frequentTools.filter((t) => t.callCount >= 5).slice(0, 2)
    for (const ft of topFreq) {
      suggestions.push({
        type: 'add_cache',
        title: `缓存「${ft.name}」的频繁调用`,
        description: `${ft.name} 被调用了 ${ft.callCount} 次（高频工具）。` + `建议对 ${ft.name} 的结果添加 LRU 缓存，避免重复计算。`,
        target: ft.name,
        expectedBenefit: `预计减少 ${ft.name} 调用延迟 50%+`,
        risk: '缓存可能返回过期数据，需设置合理的 TTL',
        priority: Math.min(100, ft.callCount * 15),
        estimatedCost: 350 + ft.callCount * 50,
      })
    }

    // 按优先级降序排列
    suggestions.sort((a, b) => b.priority - a.priority)

    return suggestions
  }

  // ==================== 数据访问 ====================

  /**
   * 获取最近的工具调用记录。
   * 从 userBehaviorAnalyzer 的私有数据读取，通过公共 API 获取。
   */
  private getRecentToolCalls(windowSize: number): ToolCallRecord[] {
    // UserBehaviorAnalyzer 通过 getToolQualityMetrics 暴露部分数据，
    // 但不直接暴露 raw records。我们通过其 analyze() 方法获得摘要信息，
    // 同时通过 globalThis 上可能注入的钩子获取详细记录。

    // 优先尝试从全局钩子读取完整记录（若已注入）
    const globalRecords = (globalThis as any).__behaviorToolRecords
    if (Array.isArray(globalRecords)) {
      return globalRecords.slice(-windowSize)
    }

    // 降级：通过分析器获取信息
    const pattern = userBehaviorAnalyzer.analyze({ windowSize })
    const calls: ToolCallRecord[] = []

    // 从 toolCallCounts 重建调用记录（仅有名称和计数，无时间戳）
    for (const [name, count] of Object.entries(pattern.toolCallCounts)) {
      for (let i = 0; i < Math.min(count, 5); i++) {
        calls.push({ name, timestamp: Date.now() - i * 1000 })
      }
    }

    return calls
  }
}

// =============================================================================
// 全局钩子注册（可选增强）
// =============================================================================

/**
 * 向 globalThis 注入工具调用记录钩子。
 * 在 ChatExecutor 初始化的 toolLoop() 中调用此函数，
 * 使 BehaviorFeatureExtractor 能访问完整的时序数据。
 */
export function registerBehaviorRecordHook(): void {
  if ((globalThis as any).__behaviorToolRecords) return
  ;(globalThis as any).__behaviorToolRecords = []

  const originalRecord = userBehaviorAnalyzer.recordToolCall.bind(userBehaviorAnalyzer)
  userBehaviorAnalyzer.recordToolCall = (name: string) => {
    originalRecord(name)
    const records: ToolCallRecord[] = (globalThis as any).__behaviorToolRecords
    records.push({ name, timestamp: Date.now() })
    if (records.length > 96) {
      records.splice(0, records.length - 96)
    }
  }

  const originalRecordResult = userBehaviorAnalyzer.recordToolCallResult.bind(userBehaviorAnalyzer)
  userBehaviorAnalyzer.recordToolCallResult = (name: string, success: boolean, error?: string) => {
    originalRecordResult(name, success, error)
    const records: ToolCallRecord[] = (globalThis as any).__behaviorToolRecords
    // 找到最近该工具的同名记录，补充成功/失败状态
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].name === name && records[i].success === undefined) {
        records[i] = { ...records[i], success, error: error ? error.slice(0, 500) : undefined }
        break
      }
    }
  }

  // 也不要忘记写入原始 userBehaviorAnalyzer 上的私有数组
  // 以便 getToolQualityMetrics 也能正常工作
  log('INFO', 'behavior_record_hook_registered')
}

/** 单例 */
export const behaviorFeatureExtractor = new BehaviorFeatureExtractor()
