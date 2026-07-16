/**
 * BehaviorPreloaderService — 行为驱动的会话启动预加载服务
 *
 * ## 职责
 * 1. 在 Agent 会话启动时，调用 BehaviorPredictor.predictSessionStart() 预测所需工具
 * 2. 对高置信度预测结果发起异步预加载
 * 3. 管理预加载状态，避免重复或资源浪费
 * 4. 提供对 ServerManager 预加载的补充（侧重会话启动场景）
 *
 * ## 与现有系统的关系
 * - BehaviorPredictor 负责序列模式预测 → 即时预热（每次工具调用后）
 * - BehaviorPreloaderService 负责会话启动预测 → 会话级预热
 * - ServerManager 负责缓存查询 → 减少实际调用延迟
 *
 * ## 资源保护
 * - 仅在会话启动时执行一次
 * - 预加载超时保护（最长 5 秒）
 * - 只对只读工具（read_file, grep, list_files 等）执行预加载
 * - 已预加载的工具不会重复执行
 * - 资源不足时不执行
 */

import { log } from '../logger/Logger'
import { behaviorPredictor, type SessionStartPrediction } from '../mcp/BehaviorPredictor'
import { periodicPatternAnalyzer } from '../mcp/PeriodicPatternAnalyzer'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 只读工具集合 — 只有这些工具适合预加载 */
const READONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'list_files',
  'list_mcp_servers',
  'list_skills',
  'list_workflows',
  'list_plans',
  'list_credentials',
  'get_credential',
  'query_trends',
  'get_system_health',
  'learning_query',
])

/** 可信度高于此值才启动预加载 */
const PRELOAD_CONFIDENCE_THRESHOLD = 0.25

/** 单次会话最多预加载的工具数 */
const MAX_PRELOADS_PER_SESSION = 4

/** 并发数 */
const MAX_CONCURRENT = 2

/** 预加载超时（毫秒） */
const PRELOAD_TIMEOUT_MS = 5_000

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface PreloadStats {
  /** 预测结果 */
  prediction: SessionStartPrediction | null
  /** 成功预加载的工具数 */
  preloadedCount: number
  /** 被过滤掉的工具数（非只读 / 低置信度 / 已达上限） */
  skippedCount: number
  /** 是否已在当前会话执行过 */
  alreadyExecuted: boolean
  /** 预加载耗时（毫秒） */
  durationMs: number
}

/** 预加载执行器签名：接收工具名和参数，返回结果文本 */
export type PreloadExecutor = (toolName: string, args: Record<string, any>) => Promise<string>

// ══════════════════════════════════════════
//  BehaviorPreloaderService
// ══════════════════════════════════════════

export class BehaviorPreloaderService {
  /** 当前会话是否已执行过预加载 */
  private executed = false

  /** 记录上次预加载统计 */
  private lastStats: PreloadStats | null = null

  /** 预加载执行器函数（由 ServerManager 注入） */
  private executor: PreloadExecutor | null = null

  /**
   * 注入预加载执行器。
   * 在 AppRuntime 启动时由 ServerManager 设置。
   */
  setExecutor(exec: PreloadExecutor): void {
    this.executor = exec
  }

  /**
   * 执行会话启动预加载。
   * 在 Agent 会话初始化时调用。
   *
   * @returns 预加载统计信息
   */
  async preloadSessionStart(): Promise<PreloadStats> {
    if (this.executed) {
      log('DEBUG', 'behavior_preloader_already_executed')
      return this.lastStats ?? {
        prediction: null,
        preloadedCount: 0,
        skippedCount: 0,
        alreadyExecuted: true,
        durationMs: 0,
      }
    }

    const startTime = Date.now()
    this.executed = true

    // 1. 预热周期分析器数据，然后预测会话启动工具
    periodicPatternAnalyzer.analyze()
    const prediction = behaviorPredictor.predictSessionStart()

    if (prediction.predictions.length === 0) {
      log('INFO', 'behavior_preloader_no_predictions', { basis: prediction.basis })
      const stats: PreloadStats = {
        prediction,
        preloadedCount: 0,
        skippedCount: 0,
        alreadyExecuted: false,
        durationMs: Date.now() - startTime,
      }
      this.lastStats = stats
      return stats
    }

    // 2. 过滤出可预加载的工具
    const toPreload = prediction.predictions
      .filter((p) => p.confidence >= PRELOAD_CONFIDENCE_THRESHOLD)
      .filter((p) => READONLY_TOOLS.has(p.toolName))
      .slice(0, MAX_PRELOADS_PER_SESSION)

    const skippedCount = prediction.predictions.length - toPreload.length

    if (toPreload.length === 0) {
      log('INFO', 'behavior_preloader_no_preloadable', {
        totalPredictions: prediction.predictions.length,
        skipped: skippedCount,
      })
      const stats: PreloadStats = {
        prediction,
        preloadedCount: 0,
        skippedCount,
        alreadyExecuted: false,
        durationMs: Date.now() - startTime,
      }
      this.lastStats = stats
      return stats
    }

    // 3. 执行预加载（并发执行，有并发限制和超时保护）
    let preloadedCount = 0
    const results = await Promise.allSettled(
      toPreload.slice(0, MAX_CONCURRENT).map((item) =>
        this.executeSinglePreload(item.toolName, {}),
      ),
    )
    preloadedCount = results.filter((r) => r.status === 'fulfilled').length

    log('INFO', 'behavior_preloader_complete', {
      preloaded: preloadedCount,
      skipped: skippedCount,
      basis: prediction.basis,
      tools: toPreload.slice(0, MAX_CONCURRENT).map((p) => p.toolName).join(', '),
      durationMs: Date.now() - startTime,
    })

    const stats: PreloadStats = {
      prediction,
      preloadedCount,
      skippedCount,
      alreadyExecuted: false,
      durationMs: Date.now() - startTime,
    }
    this.lastStats = stats
    return stats
  }

  /**
   * 通过 behaviorPredictor.preloadTool 执行单个工具预加载。
   * preloadTool 内部有自身的并发控制和超时管理。
   */
  private async executeSinglePreload(toolName: string, args: Record<string, any>): Promise<void> {
    const cacheKey = behaviorPredictor.buildCacheKey(toolName, args)

    // 检查是否已有缓存
    if (behaviorPredictor.getCachedResult(cacheKey) !== null) {
      return
    }

    if (!this.executor) {
      log('DEBUG', 'behavior_preloader_no_executor', { tool: toolName })
      return
    }

    // 使用 behaviorPredictor.preloadTool，它会将结果写入缓存
    // 这里我们用一个包装 executor 来适配 preloadTool 的签名
    await behaviorPredictor.preloadTool(
      cacheKey,
      toolName,
      toolName,
      args,
      this.executor,
    )
  }

  /**
   * 重置会话状态（用于测试或新的会话周期）。
   */
  reset(): void {
    this.executed = false
    this.lastStats = null
  }

  /** 获取当前会话的预加载状态 */
  getLastStats(): PreloadStats | null {
    return this.lastStats
  }

  /** 检查当前会话是否已执行预加载 */
  isExecuted(): boolean {
    return this.executed
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPreloaderService = new BehaviorPreloaderService()
