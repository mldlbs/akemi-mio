/**
 * BehaviorMarkovPredictor — 操作类型马尔可夫链预测与预加载
 *
 * ## 职责
 * 1. 实时记录用户每个操作类型（查询、搜索、工具调用等）到 Memory 时间序列
 * 2. 每完成一个操作，使用马尔可夫链（基于最近 30 次转移频率）预测下一个最可能操作
 * 3. 如果预测概率 > 0.6，则异步预初始化该操作所需上下文
 * 4. 预测模型每 5 次操作更新一次
 *
 * ## 算法
 * - 一阶马尔可夫链：P(next | current) = count(current → next) / count(current → *)
 * - 基于最近 30 次转移（操作对）的频率统计
 * - 预测概率阈值 0.6 触发预加载回调
 *
 * ## 操作类型定义
 * - query:   用户提问 / 信息查询
 * - search:  搜索代码 / 文件（grep / list_files 等）
 * - tool_call:  调用任意 MCP 工具
 * - write:   编写 / 修改代码（write_file / edit_file 等）
 * - analyze: 请求分析 / 审查（analyze_codebase / code-review 等）
 * - learn:   请求学习 / 记住（learning_query / remember_fact 等）
 *
 * ## 与现有系统的关系
 * - BehaviorPredictor（mcp/）预测下一个工具名（工具级），基于序列模式匹配
 * - TopicTransitionPredictor（memory/）预测话题转移（话题级），用于记忆预取
 * - BehaviorMarkovPredictor 预测操作类型（操作级），用于上下文预初始化
 *
 * ## 资源保护
 * - 预加载有独立超时控制
 * - 低概率预测不触发预加载
 * - 转移矩阵基于最后 30 次转移，有界内存
 * - 矩阵定期裁剪低频条目
 * - 并发预加载任务受限
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 转移矩阵基于最近 N 次转移（操作对） */
const TRANSITION_WINDOW = 30

/** 触发预加载的最小概率 */
const PRELOAD_PROBABILITY_THRESHOLD = 0.6

/** 模型更新间隔（每 N 次操作更新一次） */
const MODEL_UPDATE_INTERVAL = 5

/** 时间序列最大长度（保留最近操作数，为转移窗口+冗余） */
const TIME_SERIES_MAX = 64

/** 矩阵裁剪：频率低于此值的转移条目被移除 */
const PRUNE_FREQUENCY_THRESHOLD = 1

/** 矩阵裁剪间隔（毫秒） */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

/** 最大并发预加载任务数 */
const MAX_CONCURRENT_PRELOADS = 2

/** 预加载超时（毫秒） */
const PRELOAD_TIMEOUT_MS = 8_000

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/**
 * 操作类型枚举。
 * 记录了用户当前交互的高层意图类别。
 */
export type OperationType = 'query' | 'search' | 'tool_call' | 'write' | 'analyze' | 'learn'

/** 时间序列中的单条操作记录 */
export interface OperationRecord {
  /** 操作类型 */
  type: OperationType
  /** 发生时间戳 */
  timestamp: number
  /** 操作详情（如工具名、查询摘要），用于日志 */
  detail?: string
}

/** 马尔可夫链预测结果 */
export interface MarkovPrediction {
  /** 预测的下一个操作类型 */
  operationType: OperationType
  /** 转移概率 P(next | current) */
  probability: number
  /** 该转移在窗口内的出现次数 */
  transitionCount: number
}

/** 预加载处理器签名：接收操作类型，返回 void promise */
export type PreloadHandler = (operationType: OperationType) => Promise<void>

/** 预测器统计信息 */
export interface MarkovPredictorStats {
  /** 总记录操作数 */
  totalOperations: number
  /** 时间序列当前长度 */
  sequenceLength: number
  /** 转移矩阵中的非零条目数 */
  matrixSize: number
  /** 最近一次预测结果 */
  lastPrediction: MarkovPrediction | null
  /** 模型版本号（每更新一次 +1） */
  modelVersion: number
  /** 上次模型更新时间戳 */
  lastModelUpdate: number
  /** 当前活跃的预加载任务数 */
  activePreloads: number
}

/** 预加载上下文映射：每个操作类型对应的预加载动作描述 */
export const PRELOAD_CONTEXT_MAP: Record<OperationType, string> = {
  query: '预暖 LLM 推理上下文',
  search: '预加载搜索索引 / 知识库缓存',
  tool_call: '预建立 MCP 连接池',
  write: '预分配文件缓冲区',
  analyze: '预加载分析缓存',
  learn: '预载学习状态',
}

// ══════════════════════════════════════════
//  工具映射：工具名 → OperationType
// ══════════════════════════════════════════

/**
 * 工具名到操作类型的映射表。
 * 新增工具时在此添加映射。
 */
const TOOL_TO_OPERATION_MAP: Record<string, OperationType> = {
  // ── search ──
  grep: 'search',
  grep_centos: 'search',
  list_files: 'search',
  search_code: 'search',
  // ── write ──
  write_file: 'write',
  write_file_centos: 'write',
  edit_file: 'write',
  edit_file_centos: 'write',
  // ── analyze ──
  analyze_codebase: 'analyze',
  analyze_task: 'analyze',
  code_review: 'analyze',
  // ── learn ──
  learning_query: 'learn',
  remember_fact: 'learn',
  // ── tool_call (default for unlisted tools) ──
}

// ══════════════════════════════════════════
//  BehaviorMarkovPredictor
// ══════════════════════════════════════════

export class BehaviorMarkovPredictor {
  /** 操作时间序列 */
  private timeSeries: OperationRecord[] = []

  /**
   * 转移计数矩阵。
   * transitionMatrix[fromOp][toOp] = count
   */
  private transitionMatrix = new Map<OperationType, Map<OperationType, number>>()

  /** 总操作计数 */
  private totalOperations = 0

  /** 模型版本号 */
  private modelVersion = 0

  /** 上次模型更新时间 */
  private lastModelUpdate = 0

  /** 上次裁剪时间 */
  private lastPruneTime = 0

  /** 最近一次预测结果 */
  private lastPrediction: MarkovPrediction | null = null

  /** 注册的预加载处理器列表 */
  private preloadHandlers: PreloadHandler[] = []

  /** 当前活跃的预加载任务 */
  private activePreloads = new Set<OperationType>()

  /** 预加载跳过集：已处理过的操作类型（避免重复预加载同类型） */
  private skippedPreloads = new Set<OperationType>()

  constructor() {
    this.lastPruneTime = Date.now()
    this.lastModelUpdate = Date.now()
  }

  // ══════════════════════════════════════════
  //  核心 API
  // ══════════════════════════════════════════

  /**
   * 记录一次操作到时间序列。
   *
   * 1. 追加记录到时间序列
   * 2. 如果达到模型更新间隔，重建转移矩阵
   * 3. 执行预测
   * 4. 如果预测概率 > 阈值，触发预加载
   *
   * @param type 操作类型
   * @param detail 可选的操作详情
   */
  recordOperation(type: OperationType, detail?: string): MarkovPrediction | null {
    const now = Date.now()

    // 1. 记录到时间序列
    this.timeSeries.push({ type, timestamp: now, detail })
    this.totalOperations++

    // 维护序列上限
    if (this.timeSeries.length > TIME_SERIES_MAX) {
      this.timeSeries = this.timeSeries.slice(-TIME_SERIES_MAX)
    }

    log('INFO', 'markov_predictor_recorded', {
      type,
      detail: detail?.slice(0, 40),
      total: this.totalOperations,
      sequenceLen: this.timeSeries.length,
    })

    // 2. 每 MODEL_UPDATE_INTERVAL 次操作更新模型
    if (this.totalOperations % MODEL_UPDATE_INTERVAL === 0) {
      this.rebuildMatrix()
    }

    // 3. 执行预测
    const prediction = this.predict()
    this.lastPrediction = prediction

    if (prediction && prediction.probability > PRELOAD_PROBABILITY_THRESHOLD) {
      // 4. 触发预加载
      this.triggerPreload(prediction.operationType).catch((err) => {
        log('WARN', 'markov_predictor_preload_error', {
          type: prediction.operationType,
          error: String(err),
        })
      })
    }

    return prediction
  }

  /**
   * 使用当前转移矩阵预测下一个最可能操作。
   *
   * @returns 预测结果，若无足够数据则返回 null
   */
  predict(): MarkovPrediction | null {
    if (this.timeSeries.length < 2) return null

    const currentType = this.timeSeries[this.timeSeries.length - 1].type
    const transitions = this.transitionMatrix.get(currentType)

    if (!transitions || transitions.size === 0) {
      log('DEBUG', 'markov_predictor_no_transitions', { current: currentType })
      return null
    }

    // 计算该状态的总转移数
    let totalFrom = 0
    for (const count of transitions.values()) {
      totalFrom += count
    }

    if (totalFrom === 0) return null

    // 找出概率最高的后继操作
    let bestType: OperationType | null = null
    let bestProb = 0
    let bestCount = 0

    for (const [nextType, count] of transitions) {
      // 跳过自环（相同操作类型连续出现不计入预测）
      if (nextType === currentType) continue

      const prob = count / totalFrom
      if (prob > bestProb) {
        bestProb = prob
        bestType = nextType
        bestCount = count
      }
    }

    if (!bestType || bestProb === 0) {
      log('DEBUG', 'markov_predictor_no_best_transition', { current: currentType })
      return null
    }

    const result: MarkovPrediction = {
      operationType: bestType,
      probability: Math.round(bestProb * 100) / 100,
      transitionCount: bestCount,
    }

    log('INFO', 'markov_predictor_prediction', {
      current: currentType,
      predicted: result.operationType,
      probability: result.probability,
      fromCount: totalFrom,
      matchCount: bestCount,
      modelVersion: this.modelVersion,
    })

    return result
  }

  /**
   * 从工具名推断操作类型。
   * 用于集成：当其他模块记录工具调用时，可调用此方法分类。
   *
   * @param toolName 工具名
   * @param args 工具参数（可选，用于更精确的分类）
   * @returns 推断的操作类型
   */
  classifyTool(toolName: string, _args?: Record<string, any>): OperationType {
    const mapped = TOOL_TO_OPERATION_MAP[toolName]
    if (mapped) return mapped

    // 启发式分类
    const lower = toolName.toLowerCase()

    if (lower.includes('grep') || lower.includes('search') || lower.includes('find') || lower.includes('list')) {
      return 'search'
    }
    if (lower.includes('write') || lower.includes('edit') || lower.includes('create') || lower.includes('patch')) {
      return 'write'
    }
    if (lower.includes('analyze') || lower.includes('review') || lower.includes('evaluate') || lower.includes('inspect')) {
      return 'analyze'
    }
    if (lower.includes('learn') || lower.includes('remember') || lower.includes('memor') || lower.includes('fact')) {
      return 'learn'
    }
    if (lower.includes('query') || lower.includes('ask') || lower.includes('chat') || lower.includes('generate')) {
      return 'query'
    }

    // 默认归为工具调用
    return 'tool_call'
  }

  // ══════════════════════════════════════════
  //  预加载管理
  // ══════════════════════════════════════════

  /**
   * 注册预加载处理器。
   * 当预测概率超过阈值时，会调用所有注册的处理器。
   *
   * @param handler 异步处理器函数
   * @returns 取消注册的函数
   */
  onPreload(handler: PreloadHandler): () => void {
    this.preloadHandlers.push(handler)
    return () => {
      const idx = this.preloadHandlers.indexOf(handler)
      if (idx >= 0) this.preloadHandlers.splice(idx, 1)
    }
  }

  /**
   * 清除指定操作类型的预加载跳过标记。
   * 用于在预加载资源真正被使用后重置，允许下一次同类预加载。
   *
   * @param type 操作类型
   */
  clearPreloadSkip(type: OperationType): void {
    this.skippedPreloads.delete(type)
  }

  /**
   * 清除所有预加载跳过标记。
   * 用于会话切换或长时间空闲后重置状态。
   */
  clearAllPreloadSkips(): void {
    this.skippedPreloads.clear()
  }

  // ══════════════════════════════════════════
  //  状态查询
  // ══════════════════════════════════════════

  /** 获取预测器统计信息 */
  getStats(): MarkovPredictorStats {
    let matrixSize = 0
    for (const [, tos] of this.transitionMatrix) {
      matrixSize += tos.size
    }

    return {
      totalOperations: this.totalOperations,
      sequenceLength: this.timeSeries.length,
      matrixSize,
      lastPrediction: this.lastPrediction,
      modelVersion: this.modelVersion,
      lastModelUpdate: this.lastModelUpdate,
      activePreloads: this.activePreloads.size,
    }
  }

  /** 获取当前时间序列的快照 */
  getTimeSeries(): OperationRecord[] {
    return [...this.timeSeries]
  }

  /** 获取最近一次预测结果 */
  getLastPrediction(): MarkovPrediction | null {
    return this.lastPrediction
  }

  /** 获取指定操作类型的转移概率分布 */
  getTransitionProbabilities(fromType: OperationType): Array<{ toType: OperationType; probability: number; count: number }> {
    const transitions = this.transitionMatrix.get(fromType)
    if (!transitions || transitions.size === 0) return []

    let totalFrom = 0
    for (const count of transitions.values()) {
      totalFrom += count
    }

    if (totalFrom === 0) return []

    return [...transitions.entries()]
      .map(([toType, count]) => ({
        toType,
        probability: count / totalFrom,
        count,
      }))
      .sort((a, b) => b.probability - a.probability)
  }

  /** 获取完整的转移矩阵（用于调试和可视化） */
  getTransitionMatrix(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {}
    for (const [fromType, tos] of this.transitionMatrix) {
      result[fromType] = {}
      for (const [toType, count] of tos) {
        result[fromType][toType] = count
      }
    }
    return result
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 重置所有状态（时间序列、转移矩阵、预测缓存）。
   * 用于会话切换或测试。
   */
  reset(): void {
    this.timeSeries = []
    this.transitionMatrix.clear()
    this.totalOperations = 0
    this.modelVersion = 0
    this.lastModelUpdate = Date.now()
    this.lastPrediction = null
    this.activePreloads.clear()
    this.skippedPreloads.clear()
    this.lastPruneTime = Date.now()

    log('INFO', 'markov_predictor_reset')
  }

  // ══════════════════════════════════════════
  //  内部：转移矩阵
  // ══════════════════════════════════════════

  /**
   * 从时间序列重建转移矩阵。
   * 从最近最多 TRANSITION_WINDOW+1 条记录中提取转移对。
   * 每对相邻操作 (op[i], op[i+1]) 构成一次转移。
   */
  private rebuildMatrix(): void {
    const records = this.timeSeries
    if (records.length < 2) {
      log('DEBUG', 'markov_predictor_rebuild_skip', { reason: 'insufficient_records' })
      return
    }

    // 取最近 TRANSITION_WINDOW+1 条记录以提取 TRANSITION_WINDOW 次转移
    const window = records.slice(-(TRANSITION_WINDOW + 1))
    if (window.length < 2) return

    // 清空并重建矩阵
    this.transitionMatrix.clear()

    // 提取相邻操作对
    const transitions: Array<{ from: OperationType; to: OperationType }> = []
    for (let i = 0; i < window.length - 1; i++) {
      const from = window[i].type
      const to = window[i + 1].type
      transitions.push({ from, to })
    }

    // 只取最近 TRANSITION_WINDOW 次转移
    const recentTransitions = transitions.slice(-TRANSITION_WINDOW)

    // 填充矩阵
    for (const { from, to } of recentTransitions) {
      if (!this.transitionMatrix.has(from)) {
        this.transitionMatrix.set(from, new Map())
      }
      const tos = this.transitionMatrix.get(from)!
      tos.set(to, (tos.get(to) || 0) + 1)
    }

    this.modelVersion++
    this.lastModelUpdate = Date.now()

    // 裁剪低频条目
    this.tryPruneMatrix()

    log('INFO', 'markov_predictor_rebuilt', {
      version: this.modelVersion,
      timeSeriesLen: records.length,
      windowLen: window.length,
      transitionsUsed: recentTransitions.length,
      matrixSize: this.getMatrixSize(),
    })
  }

  /** 获取转移矩阵中的非零条目总数 */
  private getMatrixSize(): number {
    let size = 0
    for (const [, tos] of this.transitionMatrix) {
      size += tos.size
    }
    return size
  }

  /**
   * 定期裁剪低频转移条目。
   * 防止低频噪音条目长期占据矩阵。
   */
  private tryPruneMatrix(): void {
    const now = Date.now()
    if (now - this.lastPruneTime < PRUNE_INTERVAL_MS) return
    this.lastPruneTime = now

    let removedFrom = 0
    let removedTo = 0

    for (const [fromType, tos] of this.transitionMatrix) {
      const toDelete: OperationType[] = []
      for (const [toType, count] of tos) {
        if (count <= PRUNE_FREQUENCY_THRESHOLD) {
          toDelete.push(toType)
        }
      }
      for (const t of toDelete) {
        tos.delete(t)
        removedTo++
      }
      if (tos.size === 0) {
        this.transitionMatrix.delete(fromType)
        removedFrom++
      }
    }

    if (removedFrom > 0 || removedTo > 0) {
      log('INFO', 'markov_predictor_pruned', {
        removedFromEntries: removedFrom,
        removedToEntries: removedTo,
        remainingSize: this.getMatrixSize(),
      })
    }
  }

  // ══════════════════════════════════════════
  //  内部：预加载执行
  // ══════════════════════════════════════════

  /**
   * 触发异步预加载。
   * 调用所有注册的预加载处理器，带并发控制和超时保护。
   * 同一操作类型在同一轮次内不会重复触发。
   */
  private async triggerPreload(type: OperationType): Promise<void> {
    // 已经跳过或正在进行的同类预加载
    if (this.skippedPreloads.has(type)) {
      log('DEBUG', 'markov_predictor_preload_skipped', { type, reason: 'already_skipped' })
      return
    }
    if (this.activePreloads.has(type)) {
      log('DEBUG', 'markov_predictor_preload_skipped', { type, reason: 'already_active' })
      return
    }

    // 并发控制
    if (this.activePreloads.size >= MAX_CONCURRENT_PRELOADS) {
      log('DEBUG', 'markov_predictor_preload_throttled', {
        type,
        activeCount: this.activePreloads.size,
      })
      return
    }

    // 没有注册处理器
    if (this.preloadHandlers.length === 0) {
      log('DEBUG', 'markov_predictor_preload_no_handlers', { type })
      return
    }

    this.activePreloads.add(type)
    this.skippedPreloads.add(type)

    const contextDesc = PRELOAD_CONTEXT_MAP[type] || type

    log('INFO', 'markov_predictor_preload_start', {
      type,
      context: contextDesc,
      modelVersion: this.modelVersion,
    })

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Preload timeout after ${PRELOAD_TIMEOUT_MS}ms`)), PRELOAD_TIMEOUT_MS)
    })

    try {
      // 并发执行所有注册的处理器，带超时保护
      await Promise.race([Promise.all(this.preloadHandlers.map((handler) => handler(type))), timeoutPromise])

      log('INFO', 'markov_predictor_preload_complete', {
        type,
        context: contextDesc,
        durationMs: Date.now() - (this.timeSeries[this.timeSeries.length - 1]?.timestamp ?? Date.now()),
      })
    } catch (err: any) {
      log('WARN', 'markov_predictor_preload_failed', {
        type,
        context: contextDesc,
        error: err.message?.slice(0, 200) || String(err),
      })
    } finally {
      this.activePreloads.delete(type)
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

/** 全局单例，供行为系统和其他模块使用 */
export const behaviorMarkovPredictor = new BehaviorMarkovPredictor()
