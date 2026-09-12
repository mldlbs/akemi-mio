/**
 * PiperBehaviorSidecar — PiperTTS 附属的 UserBehavior 边车
 *
 * ── 架构角色 ──
 *
 * 在 PiperTTS 请求进入 PiperOrchestrator 之前插入一层边车处理，
 * 实现横切关注点（监控、缓存、过滤、转换）与主逻辑的分离。
 *
 * ── 设计原则 ──
 *
 * 1. 无状态 — 边车不持有 UserBehavior 状态，通过 setBehavior() 从外部注入
 * 2. 无依赖 — 不引入 UserBehavior 的依赖库，定义轻量自有接口 BehaviorSidecarInput
 * 3. 可提取 — 接口设计支持未来提取为独立子进程（通过 ProcessManager）
 * 4. 零开销 — 无行为上下文时退化为纯透传模式（仅监控+缓存）
 *
 * ── 管道层 ──
 *
 *   Requester (TtsPiperBridge / PiperTtsPlugin / PiperSynthesisStage / PiperTtsTool)
 *       │
 *       ▼
 *   PiperBehaviorSidecar.synthesize()
 *       ├── ① 自动模式层：PiperBehaviorStateMachine 环境感知（时间/亮度/静音/会议）
 *       │   + 与显式 setBehavior() 参数合并
 *       ├── ② 缓存层：文本精确匹配 → 直接返回缓存结果
 *       ├── ③ 过滤层：UserBehavior silent/pauseTts → 返回阻塞结果
 *       ├── ④ 转换层：behavior rateSuggestion/pitchSuggestion → 调整请求参数
 *       ├── ⑤ 监控层：记录延迟、缓存命中、过滤/转换计数
 *       │
 *       ▼
 *   PiperOrchestrator.synthesize()（主逻辑，不变）
 *
 * ── 使用方式 ──
 *
 *   // TtsPiperBridge 在每次合成前设置行为上下文
 *   piperBehaviorSidecar.setBehavior({
 *     outputMode: 'minimal',
 *     pauseTts: false,
 *     rateSuggestion: -5,
 *     pitchSuggestion: 0,
 *     volumeSuggestion: 0.85,
 *   })
 *
 *   // 所有请求方统一通过边车入口
 *   const result = await piperBehaviorSidecar.synthesize(request)
 */

import { existsSync } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import { piperOrchestrator, type PiperSynthesizeRequest, type PiperSynthesizeResult, DEFAULT_PIPER_MODEL } from './PiperOrchestrator'
import type { PiperBehaviorStateMachine, PiperTtsState } from './PiperBehaviorStateMachine'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/**
 * 行为上下文输入 — 边车对 UserBehavior 的唯一契约。
 *
 * 这是边车与外部行为系统的边界接口：
 * - 外部（TtsPiperBridge / ChatExecutor）从 UserBehavior 系统读取状态后，
 *   通过此接口注入边车
 * - 边车不直接 import 任何 UserBehavior 模块
 * - 所有字段可选：不设置则边车按默认行为处理（透传、不缓存主要功能）
 *
 * outputMode 的含义（与 UserBehaviorTtsContract 保持一致）：
 * - silent:    不发声（过滤层拦截请求）
 * - minimal:   精简输出（转换层可加速）
 * - normal:    标准输出（不调整）
 * - expressive: 允许完整情感表达（不调整）
 * - gentle:    柔和输出（转换层减速降音调）
 * - efficient: 高效紧凑输出（转换层加速）
 */
export interface BehaviorSidecarInput {
  /** 输出模式（null = 无行为约束） */
  outputMode: string | null
  /** 是否暂停 TTS（过滤层拦截） */
  pauseTts: boolean
  /** 语速微调百分比（-50~+50，0=不指定） */
  rateSuggestion: number
  /** 音调微调（-20~+20，0=不指定） */
  pitchSuggestion: number
  /** 音量建议（0~1，0.85=默认） */
  volumeSuggestion: number
}

/** 默认行为上下文（无约束） */
const DEFAULT_BEHAVIOR_INPUT: BehaviorSidecarInput = {
  outputMode: null,
  pauseTts: false,
  rateSuggestion: 0,
  pitchSuggestion: 0,
  volumeSuggestion: 0.85,
}

// ══════════════════════════════════════════
//  缓存配置
// ══════════════════════════════════════════

export interface SidecarCacheConfig {
  /** 是否启用文本缓存 */
  enabled: boolean
  /** 缓存 TTL（毫秒） */
  ttlMs: number
  /** 最大缓存条目数 */
  maxEntries: number
}

const DEFAULT_CACHE_CONFIG: SidecarCacheConfig = {
  enabled: true,
  ttlMs: 5 * 60 * 1000, // 5 分钟
  maxEntries: 100,
}

/** 缓存条目 */
interface CacheEntry {
  result: PiperSynthesizeResult
  timestamp: number
}

// ══════════════════════════════════════════
//  监控统计
// ══════════════════════════════════════════

export interface SidecarStats {
  /** 总请求数 */
  totalRequests: number
  /** 缓存命中数 */
  cacheHits: number
  /** 被过滤拦截的请求数 */
  filteredRequests: number
  /** 被转换的请求数（参数被行为上下文调整） */
  transformedRequests: number
  /** 当前缓存大小 */
  cacheSize: number
  /** 平均合成延迟（毫秒，仅经过 Orchestrator 的请求） */
  avgSynthesisDurationMs: number
  /** 成功率（经过 Orchestrator 的请求） */
  successRate: number
  /** 错误计数 */
  errorCount: number
}

// ══════════════════════════════════════════
//  PiperBehaviorSidecar
// ══════════════════════════════════════════

export class PiperBehaviorSidecar {
  /** 包裹的 PiperOrchestrator 实例（惰性访问，避免 bundler 加载时序问题） */
  private get orchestrator() {
    return piperOrchestrator
  }

  /** 当前行为上下文（从外部注入） */
  private behaviorInput: BehaviorSidecarInput = { ...DEFAULT_BEHAVIOR_INPUT }

  /** 缓存配置 */
  private readonly cacheConfig: SidecarCacheConfig

  /** ── 自动模式检测 ── */

  /** 行为状态机实例（由外部注入） */
  private stateMachine: PiperBehaviorStateMachine | null = null

  /** 是否启用自动模式检测（启用后，无显式 setBehavior 时自动根据环境决定行为参数） */
  private autoModeEnabled = false

  /** 最近一次自动模式检测到的状态 */
  private autoDetectedState: PiperTtsState | null = null

  /** 文本 → 缓存条目 */
  private readonly cache = new Map<string, CacheEntry>()

  // ── 监控统计 ──
  private totalRequests = 0
  private cacheHits = 0
  private filteredRequests = 0
  private transformedRequests = 0
  private totalSynthesisDurationMs = 0
  private synthesisCount = 0
  private errorCount = 0

  constructor(cacheConfig?: Partial<SidecarCacheConfig>) {
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...cacheConfig }
  }

  // ══════════════════════════════════════════
  //  行为上下文注入（外部调用）
  // ══════════════════════════════════════════

  /**
   * 设置当前行为上下文。
   *
   * 外部行为系统（如 TtsPiperBridge）应在每次合成前调用此方法，
   * 将最新的 UserBehavior 状态注入边车。
   * 传入 null 则重置为默认（无约束）状态。
   */
  setBehavior(input: BehaviorSidecarInput | null): void {
    this.behaviorInput = input ? { ...DEFAULT_BEHAVIOR_INPUT, ...input } : { ...DEFAULT_BEHAVIOR_INPUT }
  }

  /**
   * 获取当前行为上下文的只读快照。
   */
  getBehavior(): Readonly<BehaviorSidecarInput> {
    return Object.freeze({ ...this.behaviorInput })
  }

  // ══════════════════════════════════════════
  //  自动模式检测（可选）
  // ══════════════════════════════════════════

  /**
   * 设置行为状态机实例，用于自动模式检测。
   *
   * 当 autoMode 启用时，sidecar 在每次 synthesize 前自动调用
   * stateMachine.evaluate() 获取环境感知的行为参数，
   * 并与显式 setBehavior() 注入的参数合并（显式参数优先级更高）。
   *
   * @param sm PiperBehaviorStateMachine 实例
   */
  setStateMachine(sm: PiperBehaviorStateMachine | null): void {
    this.stateMachine = sm
    log('INFO', 'piper_sidecar_state_machine_set', { hasSm: !!sm })
  }

  /**
   * 启用或禁用自动模式检测。
   *
   * 启用后，sidecar 会在每次 synthesize 前自动评估环境状态，
   * 将状态机的结果作为行为参数的基线。
   * 显式通过 setBehavior() 注入的参数会叠加在状态机结果之上。
   *
   * @param enabled 是否启用
   */
  setAutoMode(enabled: boolean): void {
    this.autoModeEnabled = enabled
    log('INFO', 'piper_sidecar_auto_mode', { enabled })
  }

  /**
   * 获取自动模式是否启用。
   */
  isAutoMode(): boolean {
    return this.autoModeEnabled
  }

  /**
   * 获取最近一次自动检测的状态。
   * 仅在有状态机且启用 autoMode 时有效。
   */
  getAutoDetectedState(): PiperTtsState | null {
    return this.autoDetectedState
  }

  /**
   * 运行自动模式检测，返回合并后的行为上下文。
   *
   * 规则：状态机的参数作为基线，显式 setBehavior() 的参数叠加覆盖。
   * 叠加规则：
   * - outputMode: 状态机的 mode 优先级低于显式设置（除非显式是 null/normal）
   * - pauseTts: 任一 true → true
   * - rateSuggestion/pitchSuggestion: 显式非零覆盖状态机
   * - volumeSuggestion: 显式值覆盖状态机
   */
  private async resolveAutoBehavior(): Promise<BehaviorSidecarInput> {
    if (!this.autoModeEnabled || !this.stateMachine) {
      return { ...this.behaviorInput }
    }

    // 运行状态机获取环境感知参数
    const smOutput = await this.stateMachine.evaluate()
    this.autoDetectedState = smOutput.state
    const smInput = smOutput.behaviorInput

    // 如果显式行为是全默认（无约束），直接使用状态机结果
    const explicit = this.behaviorInput
    const isExplicitDefault =
      explicit.outputMode === null &&
      !explicit.pauseTts &&
      explicit.rateSuggestion === 0 &&
      explicit.pitchSuggestion === 0 &&
      Math.abs(explicit.volumeSuggestion - 0.85) < 0.01

    if (isExplicitDefault) {
      return { ...smInput }
    }

    // 合并显式 + 状态机（显式覆盖）
    return {
      outputMode: explicit.outputMode ?? smInput.outputMode,
      pauseTts: explicit.pauseTts || smInput.pauseTts,
      rateSuggestion: explicit.rateSuggestion !== 0 ? explicit.rateSuggestion : smInput.rateSuggestion,
      pitchSuggestion: explicit.pitchSuggestion !== 0 ? explicit.pitchSuggestion : smInput.pitchSuggestion,
      volumeSuggestion: Math.abs(explicit.volumeSuggestion - 0.85) >= 0.01
        ? explicit.volumeSuggestion
        : smInput.volumeSuggestion,
    }
  }

  // ══════════════════════════════════════════
  //  缓存管理
  // ══════════════════════════════════════════

  /**
   * 生成缓存键。
   * 基于文本内容和请求参数的组合，确保相同文本+参数命中相同缓存。
   */
  private buildCacheKey(request: PiperSynthesizeRequest): string {
    return `${request.text}|${request.model ?? ''}|${request.speed ?? ''}|${request.pitch ?? ''}|${request.taskTag ?? ''}`
  }

  /**
   * 尝试从缓存获取结果。
   * 返回 null 表示缓存缺失或已过期。
   */
  private getFromCache(key: string): PiperSynthesizeResult | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // TTL 检查
    if (Date.now() - entry.timestamp > this.cacheConfig.ttlMs) {
      this.cache.delete(key)
      return null
    }

    // 文件存在性检查（临时文件可能已被清理）
    try {
      if (entry.result.audioFile && !existsSync(entry.result.audioFile)) {
        this.cache.delete(key)
        return null
      }
    } catch {
      // fs 操作失败时不阻断，返回缓存结果
    }

    return entry.result
  }

  /**
   * 将结果存入缓存。
   * 超出最大条目数时淘汰最旧的条目。
   */
  private setCache(key: string, result: PiperSynthesizeResult): void {
    if (!this.cacheConfig.enabled) return

    // 只缓存成功的合成结果
    if (!result.success) return

    // 淘汰最旧条目
    if (this.cache.size >= this.cacheConfig.maxEntries) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp
          oldestKey = k
        }
      }
      if (oldestKey) this.cache.delete(oldestKey)
    }

    this.cache.set(key, { result, timestamp: Date.now() })
  }

  /**
   * 清空缓存。
   */
  clearCache(): void {
    this.cache.clear()
    log('INFO', 'piper_sidecar_cache_cleared', { size: this.cache.size })
  }

  // ══════════════════════════════════════════
  //  过滤层
  // ══════════════════════════════════════════

  /**
   * 检查请求是否应被过滤（拦截）。
   *
   * 当行为上下文指示 silent 或 pauseTts 时，返回一个"被阻塞"的结果，
   * 避免请求到达 PiperOrchestrator。
   *
   * @returns 被拦截时的合成结果，null 表示放行
   */
  private filterIfNeeded(request: PiperSynthesizeRequest): PiperSynthesizeResult | null {
    const { outputMode, pauseTts } = this.behaviorInput

    // 暂停 TTS → 直接返回静默结果
    if (pauseTts) {
      this.filteredRequests++
      log('INFO', 'piper_sidecar_filtered_pause', {
        text_len: request.text.length,
        reason: 'pauseTts=true',
      })
      return {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: 'BehaviorSidecar: 已暂停 TTS (pauseTts)',
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    // 静默模式 → 拦截
    if (outputMode === 'silent') {
      this.filteredRequests++
      log('INFO', 'piper_sidecar_filtered_silent', {
        text_len: request.text.length,
        reason: 'outputMode=silent',
      })
      return {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: 'BehaviorSidecar: 静默模式已拦截 (outputMode=silent)',
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    return null // 放行
  }

  // ══════════════════════════════════════════
  //  转换层
  // ══════════════════════════════════════════

  /**
   * 根据行为上下文转换请求参数。
   *
   * 在请求到达 PiperOrchestrator 之前，根据 outputMode 和
   * rateSuggestion/pitchSuggestion 调整 speed/pitch。
   *
   * @returns 转换后的请求（可能与原请求相同）
   */
  private transformIfNeeded(request: PiperSynthesizeRequest): PiperSynthesizeRequest {
    const { outputMode, rateSuggestion, pitchSuggestion } = this.behaviorInput

    // 无行为约束 → 原样透传
    if (!outputMode && rateSuggestion === 0 && pitchSuggestion === 0) {
      return request
    }

    const transformed = { ...request }
    let changed = false

    // outputMode → speed/pitch 映射
    if (outputMode) {
      switch (outputMode) {
        case 'efficient':
          // 高效模式：加速
          transformed.speed = (request.speed ?? 1.0) * 1.1
          changed = true
          break
        case 'gentle':
          // 轻柔模式：减速、降音调
          transformed.speed = (request.speed ?? 1.0) * 0.85
          transformed.pitch = (request.pitch ?? 1.0) * 0.9
          changed = true
          break
        case 'minimal':
          // 精简模式：微加速
          transformed.speed = (request.speed ?? 1.0) * 1.05
          changed = true
          break
        case 'silent':
        case 'normal':
        case 'expressive':
          // 不调整 speed/pitch
          break
      }
    }

    // rateSuggestion / pitchSuggestion 微调
    if (rateSuggestion !== 0) {
      const rateFactor = 1 + rateSuggestion / 100
      transformed.speed = (transformed.speed ?? 1.0) * rateFactor
      changed = true
    }
    if (pitchSuggestion !== 0) {
      const pitchFactor = 1 + pitchSuggestion / 100
      transformed.pitch = (transformed.pitch ?? 1.0) * pitchFactor
      changed = true
    }

    if (changed) {
      this.transformedRequests++
    }

    return transformed
  }

  // ══════════════════════════════════════════
  //  监控层
  // ══════════════════════════════════════════

  /**
   * 记录一次经过 Orchestrator 合成的统计。
   */
  private recordSynthesis(durationMs: number, success: boolean): void {
    this.totalSynthesisDurationMs += durationMs
    this.synthesisCount++
    if (!success) {
      this.errorCount++
    }
  }

  // ══════════════════════════════════════════
  //  主入口
  // ══════════════════════════════════════════

  /**
   * 合成语音 — 边车处理的主入口。
   *
   * 所有 PiperTTS 请求应通过此方法，而非直接调用 PiperOrchestrator.synthesize()。
   * 内部依次经过自动模式检测层 → 缓存层 → 过滤层 → 转换层 → PiperOrchestrator → 监控层。
   *
   * 行为上下文由外部通过 setBehavior() 注入，边车内部不感知 UserBehavior 系统。
   * 当 autoMode 启用时，自动模式检测层在缓存/过滤/转换之前运行，
   * 将环境感知参数（时间/亮度/静音等）与显式 setBehavior() 参数合并。
   */
  async synthesize(request: PiperSynthesizeRequest): Promise<PiperSynthesizeResult> {
    this.totalRequests++

    // ── ① 自动模式检测（可选）──
    // 在缓存/过滤/转换之前运行，将环境感知参数与显式行为合并
    const effectiveBehavior = await this.resolveAutoBehavior()
    const savedInput = this.behaviorInput
    if (this.autoModeEnabled && this.stateMachine) {
      // 临时替换为合并后的行为，用于后续的 filter/transform
      this.behaviorInput = effectiveBehavior
    }

    // ── ② 缓存层 ──
    if (this.cacheConfig.enabled) {
      const cacheKey = this.buildCacheKey(request)
      const cached = this.getFromCache(cacheKey)
      if (cached) {
        this.cacheHits++
        // 恢复原始行为输入
        if (this.autoModeEnabled && this.stateMachine) {
          this.behaviorInput = savedInput
        }
        log('DEBUG', 'piper_sidecar_cache_hit', {
          text_len: request.text.length,
          cache_size: this.cache.size,
        })
        return cached
      }
    }

    // ── ③ 过滤层 ──
    const filtered = this.filterIfNeeded(request)
    if (filtered) {
      // 恢复原始行为输入
      if (this.autoModeEnabled && this.stateMachine) {
        this.behaviorInput = savedInput
      }
      return filtered
    }

    // ── ④ 转换层 ──
    const transformedRequest = this.transformIfNeeded(request)

    // 恢复原始行为输入（避免泄漏到后续请求）
    if (this.autoModeEnabled && this.stateMachine) {
      this.behaviorInput = savedInput
    }

    // ── ⑤ 委托给 PiperOrchestrator（主逻辑） ──
    const t0 = Date.now()
    let result: PiperSynthesizeResult
    try {
      result = await this.orchestrator.synthesize(transformedRequest)
    } catch (err: any) {
      // Orchestrator 不应抛异常（内部已 try-catch），此处防御
      this.recordSynthesis(Date.now() - t0, false)
      result = {
        success: false,
        model: transformedRequest.model || DEFAULT_PIPER_MODEL,
        error: `BehaviorSidecar: PiperOrchestrator 抛异常: ${err.message}`,
        durationMs: Date.now() - t0,
        fallbackUsed: false,
      }
    }

    const elapsed = Date.now() - t0
    this.recordSynthesis(elapsed, result.success)

    // ── ⑥ 写入缓存（仅成功结果） ──
    if (this.cacheConfig.enabled && result.success) {
      const cacheKey = this.buildCacheKey(request)
      this.setCache(cacheKey, result)
    }

    return result
  }

  // ══════════════════════════════════════════
  //  统计查询
  // ══════════════════════════════════════════

  /**
   * 获取边车运行统计。
   */
  getStats(): SidecarStats {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      filteredRequests: this.filteredRequests,
      transformedRequests: this.transformedRequests,
      cacheSize: this.cache.size,
      avgSynthesisDurationMs: this.synthesisCount > 0 ? Math.round(this.totalSynthesisDurationMs / this.synthesisCount) : 0,
      successRate: this.synthesisCount > 0 ? (this.synthesisCount - this.errorCount) / this.synthesisCount : 1,
      errorCount: this.errorCount,
    }
  }

  /**
   * 重置所有统计计数。
   */
  resetStats(): void {
    this.totalRequests = 0
    this.cacheHits = 0
    this.filteredRequests = 0
    this.transformedRequests = 0
    this.totalSynthesisDurationMs = 0
    this.synthesisCount = 0
    this.errorCount = 0
    log('INFO', 'piper_sidecar_stats_reset')
  }

  /**
   * 获取包裹的 Orchestrator 实例（供直接访问 Orchestrator 特有方法）。
   *
   * 边车主要代理 synthesize() 方法，对于模型管理、队列状态等操作，
   * 调用方仍可直接通过 Orchestrator 访问。
   */
  getOrchestrator(): typeof piperOrchestrator {
    return this.orchestrator
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 所有 PiperTTS 请求方统一通过此单例进入边车处理管道。
 * 行为上下文由 TtsPiperBridge 在每次合成前通过 setBehavior() 注入。
 *
 * 配置说明：
 * - enabled: true — 默认启用缓存
 * - ttlMs: 5 * 60 * 1000 — 缓存 5 分钟
 * - maxEntries: 100 — 最多 100 个缓存条目
 */
export const piperBehaviorSidecar = new PiperBehaviorSidecar({
  enabled: true,
  ttlMs: 5 * 60 * 1000,
  maxEntries: 100,
})
