/**
 * pipeline/stages/PlanParallelAdvancementStage — Plan:并行推进 Stage
 *
 * 将 ASR 语音识别输出作为输入，并行推进三个 Plan 任务：
 *   1. 雷达合并（Radar Merge）— 使用 ASR 文本关键词扫描创业信号
 *   2. 工业颂歌备份（Industrial Ode Backup）— 将 ASR 内容备份为工业颂歌格式
 *   3. 博客分析（Blog Analysis）— 基于 ASR 文本种子触发博客分析与策略调整
 *
 * 三个子任务通过 Promise.all 并发执行，互不阻塞。
 * 每个子任务均有独立的输入/输出 Schema，便于单独调优。
 *
 * 流水线定义示例（JSON）：
 * {
 *   "id": "plan-parallel",
 *   "stageType": "plan-parallel-advancement",
 *   "dependsOn": ["asr-process"],
 *   "config": {
 *     "sourceStage": "asr-process",
 *     "textField": "text",
 *     "enableRadarMerge": true,
 *     "enableSonggeBackup": true,
 *     "enableBlogAnalysis": true
 *   }
 * }
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

// ── 外部模块单例导入 ──
// Radar Merge (创业雷达)
import { startupRadarAdapter } from '@akemi-mio/intelligence-startup-radar/PlanStartupRadarAdapter'
import type { RadarScanInput } from '@akemi-mio/intelligence-startup-radar/types'

// Industrial Ode Backup (工业颂歌)
import { songgeCorrectionAdapter } from '@akemi-mio/blog-publish/gongye-songge/PlanSonggeCorrectionAdapter'
import type { CorrectionInput, CorrectionSeverity } from '@akemi-mio/blog-publish/gongye-songge/PlanSonggeCorrectionAdapter'

// Blog Analysis (博客分析)
import { blogAnalyticsTracker } from '@akemi-mio/intelligence/agent/blog/BlogAnalyticsTracker'
import type { AnalyticsReport, StrategyOutput } from '@akemi-mio/intelligence/agent/blog/types'

// ════════════════════════════════════════════════════════════════
//  子任务独立类型
// ════════════════════════════════════════════════════════════════

/** 雷达合并子任务输出 */
export interface RadarMergeOutput {
  success: boolean
  signalCount: number
  urgentCount: number
  compositeHeatIndex: number
  sourceDistribution: Record<string, number>
  categoryDistribution: Record<string, number>
  topSignals: Array<{
    id: string
    category: string
    title: string
    compositeScore: number
    urgency: string
    source: string
  }>
  error?: string
}

/** 工业颂歌备份子任务输出 */
export interface SonggeBackupOutput {
  success: boolean
  chaptersAnalyzed: number
  totalIssues: number
  chaptersNeedingFix: number
  compositeScore: number
  severity: CorrectionSeverity
  issueCategories: Record<string, number>
  error?: string
}

/** 博客分析子任务输出 */
export interface BlogAnalysisOutput {
  success: boolean
  totalPosts: number
  platforms: string[]
  overallAvgViews: number
  overallAvgEngagementRate: number
  hasSufficientData: boolean
  insights: string[]
  strategyRecommendedTopics: string[]
  topCategory: string
  bestPlatform: string
  error?: string
}

/** Plan:并行推进 合并输出 */
export interface PlanParallelOutput {
  /** 雷达合并结果 */
  radarMerge: RadarMergeOutput
  /** 工业颂歌备份结果 */
  songgeBackup: SonggeBackupOutput
  /** 博客分析结果 */
  blogAnalysis: BlogAnalysisOutput
  /** 各子任务耗时（毫秒） */
  durations: {
    radarMerge: number
    songgeBackup: number
    blogAnalysis: number
  }
  /** 总耗时（毫秒） */
  totalDurationMs: number
}

// ════════════════════════════════════════════════════════════════
//  StageExecutor 实现
// ════════════════════════════════════════════════════════════════

export class PlanParallelAdvancementStage implements StageExecutor {
  readonly stageType = 'plan-parallel-advancement'

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()

    // ── 解析配置 ──
    const sourceStage = (config.sourceStage as string) ?? ''
    const textField = (config.textField as string) ?? 'text'
    const processedTextField = (config.processedTextField as string) ?? 'processedText'
    const enableRadarMerge = config.enableRadarMerge !== false
    const enableSonggeBackup = config.enableSonggeBackup !== false
    const enableBlogAnalysis = config.enableBlogAnalysis !== false

    // ── 从上游 stage 获取 ASR 输出文本 ──
    const sourceData = sourceStage ? (ctx.inputs.get(sourceStage)?.data ?? {}) : ctx.pipelineInput

    const asrText =
      (sourceData[textField] as string) ??
      (sourceData[processedTextField] as string) ??
      (sourceData.text as string) ??
      (sourceData.processedText as string) ??
      ''

    if (!asrText) {
      log('WARN', 'plan_parallel_no_asr_text', {
        sourceStage,
        availableFields: Object.keys(sourceData).join(', '),
        traceId: ctx.traceId,
      })
    }

    log('INFO', 'plan_parallel_start', {
      asrTextLen: asrText.length,
      enableRadarMerge,
      enableSonggeBackup,
      enableBlogAnalysis,
      traceId: ctx.traceId,
    })

    // ── 从 ASR 文本中提取关键词（共享给各子任务） ──
    const keywords = extractKeywords(asrText)

    // ── 并发执行三个子任务 ──
    const taskPromises: Array<Promise<{ key: string; result: any; durationMs: number }>> = []

    // 子任务 1: 雷达合并
    if (enableRadarMerge) {
      taskPromises.push(
        timedTask('radarMerge', async () => {
          try {
            const r = await runRadarMerge(asrText, keywords, ctx.traceId)
            return { ...r, success: true }
          } catch (err: any) {
            return {
              ...createDefaultRadarOutput(),
              error: `RadarMerge failed: ${(err as Error).message ?? String(err)}`,
            }
          }
        }),
      )
    }

    // 子任务 2: 工业颂歌备份
    if (enableSonggeBackup) {
      taskPromises.push(
        timedTask('songgeBackup', async () => {
          try {
            const r = await runSonggeBackup(asrText, ctx.traceId)
            return { ...r, success: true }
          } catch (err: any) {
            return {
              ...createDefaultSonggeOutput(),
              error: `SonggeBackup failed: ${(err as Error).message ?? String(err)}`,
            }
          }
        }),
      )
    }

    // 子任务 3: 博客分析
    if (enableBlogAnalysis) {
      taskPromises.push(
        timedTask('blogAnalysis', async () => {
          try {
            const r = await runBlogAnalysis(asrText, keywords, ctx.traceId)
            return { ...r, success: true }
          } catch (err: any) {
            return {
              ...createDefaultBlogOutput(),
              error: `BlogAnalysis failed: ${(err as Error).message ?? String(err)}`,
            }
          }
        }),
      )
    }

    // 等待所有子任务完成
    const settled = await Promise.all(taskPromises)

    // 收集结果和耗时
    const radarResult: RadarMergeOutput = settled.find((t) => t.key === 'radarMerge')?.result ?? createDefaultRadarOutput()
    const songgeResult: SonggeBackupOutput = settled.find((t) => t.key === 'songgeBackup')?.result ?? createDefaultSonggeOutput()
    const blogResult: BlogAnalysisOutput = settled.find((t) => t.key === 'blogAnalysis')?.result ?? createDefaultBlogOutput()

    const getDuration = (key: string): number => settled.find((t) => t.key === key)?.durationMs ?? 0

    const totalDurationMs = Date.now() - t0

    const output: PlanParallelOutput = {
      radarMerge: radarResult,
      songgeBackup: songgeResult,
      blogAnalysis: blogResult,
      durations: {
        radarMerge: getDuration('radarMerge'),
        songgeBackup: getDuration('songgeBackup'),
        blogAnalysis: getDuration('blogAnalysis'),
      },
      totalDurationMs,
    }

    // 发出事件供外部消费
    eventBus.emit('pipeline.stage.completed', {
      version: 1,
      stageId: 'plan-parallel-advancement',
      success: true,
      radarSignals: radarResult.signalCount,
      songgeIssues: songgeResult.totalIssues,
      blogInsights: blogResult.insights.length,
      durationMs: totalDurationMs,
      traceId: ctx.traceId,
      timestamp: Date.now(),
    } as any)

    log('INFO', 'plan_parallel_completed', {
      radarSignals: radarResult.signalCount,
      songgeIssues: songgeResult.totalIssues,
      blogInsights: blogResult.insights.length,
      totalDurationMs,
      traceId: ctx.traceId,
    })

    return {
      stageId: 'plan-parallel-advancement',
      data: output as unknown as Record<string, unknown>,
      durationMs: totalDurationMs,
      fromCache: false,
      timestamp: Date.now(),
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  子任务实现
// ════════════════════════════════════════════════════════════════

/**
 * 子任务 1: 雷达合并
 *
 * 使用 ASR 文本中提取的关键词作为 RadarScanInput 的关键词，
 * 对多个信息源进行扫描，返回合并后的创业信号。
 */
async function runRadarMerge(_asrText: string, keywords: string[], traceId: string): Promise<RadarMergeOutput> {
  const t0 = Date.now()

  const scanInput: RadarScanInput = {
    sources: ['hackernews', 'github_trending'],
    keywords: keywords.length > 0 ? keywords : undefined,
    limit: 15,
    focusArea: keywords.slice(0, 5).join(' '),
    minScore: 0.3,
  }

  const result = await startupRadarAdapter.scan(scanInput)

  if (!result || result.signals.length === 0) {
    return {
      ...createDefaultRadarOutput(),
      error: '雷达扫描未返回有效信号',
    }
  }

  const topSignals = result.signals.slice(0, 5).map((s) => ({
    id: s.id,
    category: s.category,
    title: s.title.slice(0, 100),
    compositeScore: s.compositeScore,
    urgency: s.urgency,
    source: s.source,
  }))

  log('INFO', 'plan_parallel_radar_done', {
    signalCount: result.signals.length,
    urgentCount: result.urgentCount,
    heatIndex: result.compositeHeatIndex.toFixed(3),
    durationMs: Date.now() - t0,
    traceId,
  })

  return {
    success: true,
    signalCount: result.signals.length,
    urgentCount: result.urgentCount,
    compositeHeatIndex: result.compositeHeatIndex,
    sourceDistribution: result.sourceDistribution,
    categoryDistribution: result.categoryDistribution,
    topSignals,
  }
}

/**
 * 子任务 2: 工业颂歌备份
 *
 * 将 ASR 文本作为工业颂歌内容进行备份分析：
 * - 将文本包装为模拟章节输入
 * - 评估内容风格一致性和结构准确性
 * - 返回备份分析结果
 */
async function runSonggeBackup(asrText: string, traceId: string): Promise<SonggeBackupOutput> {
  const t0 = Date.now()

  // 将 ASR 文本构造为备份输入（模拟工业颂歌章节）
  const backupChapters: Record<number, string> = {
    1: asrText || '(空内容)',
  }

  const correctionInput: CorrectionInput = {
    chapters: backupChapters,
    designDoc: '工业颂歌公众号排版风格 — ASR 语音内容备份',
    styleGuide: '工业颂歌公众号',
    formatOptions: {
      publishReady: false,
    },
  }

  const result = songgeCorrectionAdapter.evaluateChapters(correctionInput)

  if (!result || result.snapshots.length === 0) {
    return {
      ...createDefaultSonggeOutput(),
      error: '工业颂歌备份分析未返回结果',
    }
  }

  // 统计问题类别分布
  const issueCategories: Record<string, number> = {}
  for (const snap of result.snapshots) {
    for (const issue of snap.issues) {
      issueCategories[issue.category] = (issueCategories[issue.category] ?? 0) + 1
    }
  }

  log('INFO', 'plan_parallel_songge_done', {
    chaptersAnalyzed: result.snapshots.length,
    totalIssues: result.totalIssues,
    compositeScore: result.compositeScore.toFixed(3),
    severity: result.severity,
    durationMs: Date.now() - t0,
    traceId,
  })

  return {
    success: true,
    chaptersAnalyzed: result.snapshots.length,
    totalIssues: result.totalIssues,
    chaptersNeedingFix: result.chaptersNeedingFix,
    compositeScore: result.compositeScore,
    severity: result.severity,
    issueCategories,
  }
}

/**
 * 子任务 3: 博客分析
 *
 * 基于 ASR 文本中提取的关键词作为选题种子，
 * 触发博客效果分析和选题策略调整。
 */
async function runBlogAnalysis(_asrText: string, keywords: string[], traceId: string): Promise<BlogAnalysisOutput> {
  const t0 = Date.now()

  // 生成效果分析报告
  const report: AnalyticsReport = blogAnalyticsTracker.generateReport()

  // 基于 ASR 关键词作为话题种子进行策略调整
  const plannedTopics = keywords.length > 0 ? [...keywords.slice(0, 5)] : undefined
  const strategy: StrategyOutput = blogAnalyticsTracker.adjustStrategy(plannedTopics)

  log('INFO', 'plan_parallel_blog_done', {
    totalPosts: report.totalPosts,
    hasSufficientData: report.hasSufficientData,
    insights: report.insights.length,
    strategyTopics: strategy.recommendedTopics.length,
    durationMs: Date.now() - t0,
    traceId,
  })

  return {
    success: true,
    totalPosts: report.totalPosts,
    platforms: report.platforms,
    overallAvgViews: report.overallAvgViews,
    overallAvgEngagementRate: report.overallAvgEngagementRate,
    hasSufficientData: report.hasSufficientData,
    insights: report.insights,
    strategyRecommendedTopics: strategy.recommendedTopics,
    topCategory: report.topCategory,
    bestPlatform: report.bestPlatform,
  }
}

// ════════════════════════════════════════════════════════════════
//  辅助函数
// ════════════════════════════════════════════════════════════════

/**
 * 从 ASR 文本中提取关键词。
 * 供所有三个子任务共享使用。
 */
function extractKeywords(text: string): string[] {
  if (!text || text.trim().length === 0) return []

  const combined = text.trim()

  // 中文关键词：2字以上词汇
  const zhWords = combined.match(/[一-鿿]{2,}/g) || []

  // 英文关键词：3字母以上词汇
  const enWords = (combined.match(/[a-zA-Z]{3,}/g) || []).map((w) => w.toLowerCase())

  // 数字相关
  const numberWords = (combined.match(/\d+[a-zA-Z一-鿿]*/g) || []).slice(0, 3)

  // 去重，按长度排序取前 10
  const all = [...new Set([...zhWords, ...enWords, ...numberWords])]
  return all
    .sort((a, b) => b.length - a.length)
    .slice(0, 10)
    .filter(Boolean)
}

/**
 * 带计时包装的异步任务。
 * 执行 fn 并记录其耗时。不处理 fn 内部的异常（应在调用侧处理）。
 */
async function timedTask<T>(key: string, fn: () => Promise<T>): Promise<{ key: string; result: T; durationMs: number }> {
  const t0 = Date.now()
  const result = await fn()
  return { key, result, durationMs: Date.now() - t0 }
}

function createDefaultRadarOutput(): RadarMergeOutput {
  return {
    success: false,
    signalCount: 0,
    urgentCount: 0,
    compositeHeatIndex: 0,
    sourceDistribution: {},
    categoryDistribution: {},
    topSignals: [],
  }
}

function createDefaultSonggeOutput(): SonggeBackupOutput {
  return {
    success: false,
    chaptersAnalyzed: 0,
    totalIssues: 0,
    chaptersNeedingFix: 0,
    compositeScore: 0,
    severity: 'info',
    issueCategories: {},
  }
}

function createDefaultBlogOutput(): BlogAnalysisOutput {
  return {
    success: false,
    totalPosts: 0,
    platforms: [],
    overallAvgViews: 0,
    overallAvgEngagementRate: 0,
    hasSufficientData: false,
    insights: [],
    strategyRecommendedTopics: [],
    topCategory: '未知',
    bestPlatform: '未知',
  }
}
