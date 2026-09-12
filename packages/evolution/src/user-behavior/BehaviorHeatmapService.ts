/**
 * BehaviorHeatmapService — 模块热力图服务
 *
 * 职责：
 * - 将 UserBehaviorAnalyzer 的逐工具调用聚合为模块级统计
 * - 生成模块热力图：高频模块（hot）、错误模块（error）、低频模块（cold）
 * - 为 Evolution 系统提供优化优先级排序依据
 *
 * 模块定义：
 * 每个工具名通过 TOOL_MODULE_MAP 或 name pattern 映射到所属功能模块。
 * 模块热力图为 Evolution 提供以下信号：
 *   - hotModules: 高频使用模块 → 进化更关注，提升体验
 *   - errorModules: 高错误率模块 → 进化优先修复
 *   - coldModules: 低使用率模块 → 降低进化频率，节省计算
 *
 * 集成点：
 * - 通过 UserBehaviorLayer 的预处理钩子注入进化周期
 * - 消费 UserBehaviorAnalyzer 的运行时数据
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import type { ModuleHeatmap, ModuleHeatmapEntry, ModuleTrend } from './types'

// =============================================================================
// 工具 → 模块映射表
// =============================================================================

/**
 * 已知工具到功能模块的映射。
 * 一个工具只能属于一个模块。
 * 未列出的工具名将通过 inferModuleFromName() 自动推导。
 */
const TOOL_MODULE_MAP: Record<string, string> = {
  // === Agent 核心 ===
  read_file: 'agent',
  write_file: 'agent',
  edit_file: 'agent',
  grep: 'agent',
  list_files: 'agent',
  run_command: 'agent',
  analyze_codebase: 'agent',
  analyze_task: 'agent',
  create_dev_plan: 'agent',
  update_plan_progress: 'agent',
  remember_fact: 'agent',
  generate_image: 'agent',
  auto_schedule_workflow: 'agent',
  query_trends: 'agent',
  // 远程相关
  grep_centos: 'agent',
  read_file_centos: 'agent',
  write_file_centos: 'agent',
  exec_centos: 'agent',
  // 社交
  social_pipeline: 'agent',

  // === TTS（语音合成）===
  tts_speak: 'tts',
  tts: 'tts',
  tts_preference: 'tts',
  tts_typography: 'tts',
  tts_config_optimize: 'tts',

  // === ASR（语音识别）===
  asr_optimize: 'asr',
  asr_log_collect: 'asr',

  // === 进化系统 ===
  SelfEvolutionService: 'evolution',
  evolution_analyze: 'evolution',
  evolution_execute: 'evolution',
  evolution_review: 'evolution',
  evolution_strategize: 'evolution',

  // === 用户行为 ===
  userBehaviorAnalyzer: 'behavior',
  behavior_analyze: 'behavior',
  behavior_collect: 'behavior',
  behavior_optimize: 'behavior',

  // === 学习系统 ===
  plan_typescript: 'learning',
  learning_tts: 'learning',
  learning_adapter: 'learning',

  // === 壁纸系统 ===
  wallpaper: 'wallpaper',
  wallpaper_optimize: 'wallpaper',

  // === 创意系统 ===
  creativity: 'creativity',
  creativity_collect: 'creativity',

  // === 记忆系统 ===
  memory: 'memory',
  memory_analysis: 'memory',

  // === 工具系统 ===
  tool_evolution: 'tool',
  tool_stats: 'tool',

  // === 写作系统 ===
  writing_system: 'writing',
}

// =============================================================================
// 模块描述（用于热力图展示）
// =============================================================================

const MODULE_DESCRIPTIONS: Record<string, string> = {
  agent: 'Agent 核心工具（读/写/搜索/分析）',
  tts: '语音合成（TTS）',
  asr: '语音识别（ASR）',
  evolution: '自进化系统',
  behavior: '用户行为分析',
  learning: '学习系统',
  wallpaper: '壁纸系统',
  creativity: '创意引擎',
  memory: '记忆系统',
  tool: '工具系统',
  writing: '写作系统',
  other: '其他/未分类',
}

// =============================================================================
// 配置常量
// =============================================================================

/** 热力图分析窗口（最近多少条工具调用记录） */
const HEATMAP_WINDOW = 48

/** 高频模块阈值：模块调用次数 >= 总调用数 * 此比例 */
const HOT_MODULE_RATIO_THRESHOLD = 0.15

/** 错误模块阈值：模块错误率 >= 此值 */
const ERROR_MODULE_THRESHOLD = 0.2

/** 低频模块阈值：模块调用次数 <= 总调用数 * 此比例 */
const COLD_MODULE_RATIO_THRESHOLD = 0.05

/** 趋势分析所需的最少调用次数 */
const TREND_MIN_CALLS = 5

/** 趋势历史窗口（上次窗口占比） */
const TREND_HISTORY_SIZE = 3

/** 趋势历史缓存：模块名 → 历史占比数组 */
const trendHistory = new Map<string, number[]>()

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 根据工具名推断所属模块。
 * 优先查表，失败则按命名模式推导。
 */
function inferModuleFromName(toolName: string): string {
  // 1. 精确查表
  if (TOOL_MODULE_MAP[toolName]) return TOOL_MODULE_MAP[toolName]

  // 2. 按前缀/关键词推断
  const lower = toolName.toLowerCase()

  if (lower.startsWith('tts') || lower.includes('tts')) return 'tts'
  if (lower.startsWith('asr') || lower.includes('asr')) return 'asr'
  if (lower.includes('wallpaper')) return 'wallpaper'
  if (lower.includes('evolution') || lower === 'self_evolution') return 'evolution'
  if (lower.includes('creativity') || lower.includes('creative')) return 'creativity'
  if (lower.includes('memory') || lower.includes('remember')) return 'memory'
  if (lower.includes('behavior')) return 'behavior'
  if (lower.includes('learning') || lower.includes('learn')) return 'learning'
  if (lower.includes('write') || lower.includes('writing') || lower.includes('writing_system')) return 'writing'
  if (lower.includes('tool')) return 'tool'

  // 3. Agent 默认工具（读/写/搜索/分析）
  const agentPatterns = [
    /^read/,
    /^write/,
    /^edit/,
    /^grep/,
    /^list/,
    /^run_/,
    /^analyze/,
    /^create_/,
    /^update_/,
    /^remember/,
    /^generate_/,
    /^auto_/,
    /^query_/,
    /^social_/,
  ]
  if (agentPatterns.some((p) => p.test(lower))) return 'agent'

  return 'other'
}

/**
 * 截断优先级别名：高/中/低
 */
function classifyPriority(usageCount: number, totalCalls: number, errorRate: number): 'high' | 'medium' | 'low' {
  const usageRatio = totalCalls > 0 ? usageCount / totalCalls : 0

  if (usageRatio >= HOT_MODULE_RATIO_THRESHOLD || errorRate >= ERROR_MODULE_THRESHOLD) return 'high'
  if (usageRatio >= COLD_MODULE_RATIO_THRESHOLD && errorRate < ERROR_MODULE_THRESHOLD) return 'medium'
  return 'low'
}

// =============================================================================
// BehaviorHeatmapService
// =============================================================================

export class BehaviorHeatmapService {
  /**
   * 生成模块热力图。
   * 读取 UserBehaviorAnalyzer 的最近工具调用记录，按模块聚合后生成热力图。
   *
   * @param windowSize 分析窗口大小（工具调用记录数），默认 48
   * @returns ModuleHeatmap 热力图数据
   */
  generate(windowSize = HEATMAP_WINDOW): ModuleHeatmap {
    const calls = this.getRecentCalls(windowSize)

    if (calls.length < 3) {
      return {
        entries: [],
        hotModules: [],
        errorModules: [],
        coldModules: [],
        hasSufficientData: false,
        totalToolCalls: calls.length,
        generatedAt: Date.now(),
      }
    }

    // 1. 按模块聚合
    const moduleStats = this.aggregateByModule(calls)

    // 2. 转为热力条目并按使用量排序
    const totalCalls = calls.length
    const entries: ModuleHeatmapEntry[] = Array.from(moduleStats.entries())
      .map(([module, stats]) => this.buildEntry(module, stats, totalCalls))
      .sort((a, b) => b.usageCount - a.usageCount)

    // 3. 抽取子集
    const hotModules = entries
      .filter((e) => e.priority === 'high')
      .slice()
      .sort((a, b) => b.usageCount - a.usageCount)

    const errorModules = entries
      .filter((e) => e.errorCount > 0)
      .slice()
      .sort((a, b) => b.errorCount / Math.max(b.usageCount, 1) - a.errorCount / Math.max(a.usageCount, 1))

    const coldModules = entries
      .filter((e) => e.priority === 'low')
      .slice()
      .sort((a, b) => a.usageCount - b.usageCount)

    log('INFO', 'heatmap_generated', {
      modules: entries.length,
      hot: hotModules.length,
      error: errorModules.length,
      cold: coldModules.length,
      totalCalls,
    })

    return {
      entries,
      hotModules,
      errorModules,
      coldModules,
      hasSufficientData: true,
      totalToolCalls: calls.length,
      generatedAt: Date.now(),
    }
  }

  /**
   * 检查某个模块是否被归类为"冷模块"。
   * 用于 SelfEvolutionService 的判断：冷模块降低分析频率。
   */
  isModuleCold(module: string, heatmap: ModuleHeatmap): boolean {
    return heatmap.coldModules.some((e) => e.module === module)
  }

  /**
   * 获取热力图的摘要文本（供 LLM 分析上下文使用）。
   */
  formatHeatmapSummary(heatmap: ModuleHeatmap): string {
    if (!heatmap.hasSufficientData || heatmap.entries.length === 0) {
      return '【模块热力图】数据不足，尚未生成。'
    }

    const lines: string[] = [
      '【模块热力图 — 用户行为驱动的进化优先级】',
      `基于最近 ${heatmap.totalToolCalls} 次工具调用的模块级聚合分析：`,
      '',
    ]

    // 高频模块
    if (heatmap.hotModules.length > 0) {
      lines.push('🔴 高频模块（高优先级进化目标）：')
      for (const m of heatmap.hotModules) {
        const pct = ((m.usageCount / heatmap.totalToolCalls) * 100).toFixed(0)
        const errRate = m.usageCount > 0 ? ((m.errorCount / m.usageCount) * 100).toFixed(0) : '0'
        lines.push(`   · ${m.module}：${m.usageCount} 次调用（${pct}%），错误率 ${errRate}% — ${m.description}`)
      }
      lines.push('')
    }

    // 错误模块
    const errModules = heatmap.errorModules.filter((m) => m.errorCount > 0 && !heatmap.hotModules.some((h) => h.module === m.module))
    if (errModules.length > 0) {
      lines.push('🟡 高错误模块（进化修复候选人）：')
      for (const m of errModules) {
        const errRate = m.usageCount > 0 ? ((m.errorCount / m.usageCount) * 100).toFixed(0) : '0'
        lines.push(`   · ${m.module}：${m.errorCount} 次错误（${errRate}%），共 ${m.usageCount} 次调用`)
      }
      lines.push('')
    }

    // 低频模块
    if (heatmap.coldModules.length > 0) {
      lines.push('⚪ 低频模块（降低进化频率）：')
      for (const m of heatmap.coldModules) {
        lines.push(`   · ${m.module}：仅 ${m.usageCount} 次调用 — ${m.description}`)
      }
      lines.push('')
    }

    // 总结
    lines.push('📌 进建议：')
    if (heatmap.hotModules.length > 0) {
      const topModule = heatmap.hotModules[0]
      lines.push(`   - 优先分析「${topModule.module}」模块，用户最常使用的功能区域`)
    }
    if (heatmap.errorModules.length > 0) {
      const worstModule = heatmap.errorModules[0]
      const worstRate = worstModule.usageCount > 0 ? ((worstModule.errorCount / worstModule.usageCount) * 100).toFixed(0) : '0'
      lines.push(`   - 修复「${worstModule.module}」模块的错误（错误率 ${worstRate}%）`)
    }
    if (heatmap.coldModules.length > 0) {
      const coldList = heatmap.coldModules.map((e) => `「${e.module}」`).join('、')
      lines.push(`   - 降低 ${coldList} 等低频模块的分析频率，节省计算资源`)
    }

    return lines.join('\n')
  }

  // ==================== 内部方法 ====================

  /**
   * 从 UserBehaviorAnalyzer 获取最近 N 条工具调用记录。
   */
  private getRecentCalls(windowSize: number): Array<{ name: string; success?: boolean; timestamp: number }> {
    // 优先从全局钩子读取
    const globalRecords = (globalThis as any).__behaviorToolRecords
    if (Array.isArray(globalRecords) && globalRecords.length > 0) {
      return globalRecords.slice(-windowSize)
    }

    // 降级：通过 analyze() 获取摘要
    const pattern = userBehaviorAnalyzer.analyze({ windowSize })
    const calls: Array<{ name: string; success?: boolean; timestamp: number }> = []

    for (const [name, count] of Object.entries(pattern.toolCallCounts)) {
      for (let i = 0; i < Math.min(count, 5); i++) {
        calls.push({ name, timestamp: Date.now() - i * 1000 })
      }
    }

    return calls
  }

  /**
   * 按模块聚合工具调用记录。
   */
  private aggregateByModule(
    calls: Array<{ name: string; success?: boolean; timestamp: number }>,
  ): Map<string, { total: number; errors: number }> {
    const map = new Map<string, { total: number; errors: number }>()

    for (const call of calls) {
      const module = inferModuleFromName(call.name)
      const existing = map.get(module)
      if (existing) {
        existing.total++
        if (call.success === false) existing.errors++
      } else {
        map.set(module, { total: 1, errors: call.success === false ? 1 : 0 })
      }
    }

    return map
  }

  /**
   * 由聚合统计构建 ModuleHeatmapEntry。
   */
  private buildEntry(module: string, stats: { total: number; errors: number }, totalCalls: number): ModuleHeatmapEntry {
    const usageCount = stats.total
    const errorCount = stats.errors
    const successRate = usageCount > 0 ? (usageCount - errorCount) / usageCount : 1
    const errorRate = usageCount > 0 ? errorCount / usageCount : 0
    const priority = classifyPriority(usageCount, totalCalls, errorRate)
    const trend = this.computeTrend(module, usageCount, totalCalls)

    return {
      module,
      usageCount,
      errorCount,
      successRate,
      errorRate,
      trend,
      priority,
      description: MODULE_DESCRIPTIONS[module] || `${module} 模块`,
    }
  }

  /**
   * 计算模块使用趋势（与历史相比）。
   * 如果模块占比上升 => rising，下降 => declining，稳定 => stable。
   */
  private computeTrend(module: string, currentCount: number, totalCalls: number): ModuleTrend {
    const currentRatio = totalCalls > 0 ? currentCount / totalCalls : 0

    let history = trendHistory.get(module)
    if (!history) {
      history = []
      trendHistory.set(module, history)
    }

    history.push(currentRatio)
    if (history.length > TREND_HISTORY_SIZE) {
      history.shift()
    }

    // 需要足够的历史数据
    if (history.length < 2) return 'stable'

    const prevRatio = history[history.length - 2]
    const change = currentRatio - prevRatio
    const threshold = 0.03 // 3% 的变化视为有意义

    if (change > threshold) return 'rising'
    if (change < -threshold) return 'declining'
    return 'stable'
  }
}

/** 全局单例 */
export const behaviorHeatmapService = new BehaviorHeatmapService()
