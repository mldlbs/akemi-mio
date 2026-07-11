/**
 * Engine Service — Agent/PiperTTS 统一抽象层
 *
 * 从 AgentService 和 PiperOrchestrator 的对外接口中提取的
 * 语义相似操作，抽象为共用接口。
 *
 * ── 模式来源 ──
 *
 * 通过分析 AgentService 和 PiperOrchestrator 的对外接口，
 * 发现以下通用模式：
 *
 * 1. 状态/健康查询: AgentService.isBusy() / PiperOrchestrator.getQueueStatus()
 * 2. 性能指标: AgentService.getSubAgentStatus() / PiperOrchestrator.getSynthesisStats()
 * 3. 生命周期控制: AgentService.stopConversation() / PiperOrchestrator.stop()
 * 4. 暂停/恢复: AgentService.pause()/resume() / PiperOrchestrator.stop()/reset()
 *
 * ── 设计原则 ──
 *
 * 1. 只读接口（查询类）与写接口（变更类）分离，调用方按需依赖
 * 2. 先提取只读接口（IEngineQueryable），再扩展到写接口（IEngineService）
 * 3. 两套实现共存于统一接口之后，可通过 IStrategyProvider 策略模式
 *    在运行时选择具体实现
 * 4. 每个接口只暴露调用方真正需要的方法，不暴露内部实现细节
 * 5. 与现有统一抽象层（src/main/plugin/registry/types.ts）互补：
 *    - IService: 通用服务生命周期
 *    - IEngineQueryable / IEngineService: 引擎级状态+控制，有队列感知
 *
 * ── 预期收益 ──
 *
 * - 统一监控/健康检查通用代码可同时处理 Agent 和 PiperTTS
 * - 调用方（如 IPC handler、调试面板）只需 IEngineQueryable 即可获取状态
 * - 新引擎（EdgeTTS、Whisper 等）可遵循相同接口模式
 *
 * ── 风险控制 ──
 *
 * - 接口仅覆盖 Agent 和 PiperTTS 共有的语义操作，不暴露模块特有行为
 * - 模块特有功能（Agent 的 processTextInput、Piper 的 switchModel）
 *   仍直接通过模块类型访问，不在接口中抽象
 */

import type { IService, ServiceStatus } from '../plugin/registry/types'

// ════════════════════════════════════════════
//  只读接口（查询类）
// ════════════════════════════════════════════

/** 引擎运行状态 */
export interface EngineStatus {
  /** 引擎名称 */
  readonly name: string

  /** 运行状态标签 */
  readonly state: 'idle' | 'running' | 'paused' | 'error'

  /** 是否忙碌（正在处理任务） */
  readonly busy: boolean

  /** 队列中待处理的任务数 */
  readonly queueSize: number

  /** 是否正在主动处理 */
  readonly processing: boolean

  /** 引擎启动时间戳 */
  readonly startedAt?: number

  /** 运行时长（毫秒） */
  readonly uptimeMs?: number

  /** 错误信息（state=error 时有意义） */
  readonly error?: string

  /** 当前活跃模型/模式（引擎特有信息） */
  readonly activeModel?: string
}

/** 引擎性能指标 */
export interface EngineMetrics {
  /** 总请求数 */
  readonly totalRequests: number

  /** 成功数 */
  readonly successCount: number

  /** 失败数 */
  readonly failureCount: number

  /** 平均延迟（毫秒，有数据时） */
  readonly avgLatencyMs?: number

  /** 可靠率（成功/总请求，0-1） */
  readonly reliability?: number

  /** 引擎特有扩展属性 */
  readonly extra?: Record<string, unknown>
}

/**
 * 引擎只读查询接口。
 *
 * 调用方通过此接口查询引擎状态和性能数据，
 * 无需了解底层是 AgentService 还是 PiperOrchestrator。
 *
 * 查询与写操作分离：只需要读权限的调用方（如健康检查、监控面板）
 * 应依赖此接口而非 IEngineService。
 *
 * 示例用法：
 *   function displayEngineStatus(engine: IEngineQueryable) {
 *     const status = engine.getStatus()
 *     console.log(`${engine.name}: ${status.state} (busy=${status.busy})`)
 *   }
 */
export interface IEngineQueryable {
  /** 引擎唯一标识名 */
  readonly name: string

  /**
   * 获取引擎运行状态。
   * @returns 包含 state/busy/queueSize 等的状态快照
   */
  getStatus(): EngineStatus

  /**
   * 获取引擎性能指标。
   * @returns 包含 total/success/failure/avgLatency 的统计快照
   */
  getMetrics(): EngineMetrics

  /**
   * 获取引擎描述/模型信息（供调试 UI 展示）。
   * @returns 人类可读的描述字符串
   */
  getInfo(): string
}

// ════════════════════════════════════════════
//  写接口（变更类）
// ════════════════════════════════════════════

/**
 * 引擎服务接口（读 + 写）。
 *
 * 扩展 IEngineQueryable，增加生命周期控制操作。
 * 需要写权限的调用方（如 IPC handler、调试面板）使用此接口。
 *
 * 与 IService 的关系：
 * - IService 是通用服务生命周期接口（start/stop/destroy）
 * - IEngineService 是引擎级接口，增加 pause/resume/isPaused/queue 感知
 * - 实现 IEngineService 的类应同时兼容 IService 接口
 */
export interface IEngineService extends IEngineQueryable {
  /**
   * 停止当前引擎处理。
   * 等效于 AgentService.stopConversation() / PiperOrchestrator.stop()
   */
  stop(): void | Promise<void>

  /**
   * 重置引擎状态。
   * 等效于 AgentService.clearContext() + stop / PiperOrchestrator.reset()
   * 将引擎恢复到初始状态。
   */
  reset(): void | Promise<void>

  /**
   * 暂停处理（保留上下文）。
   * 等效于 AgentService.pause()
   * PiperOrchestrator: 通过 stop 实现暂停效果
   */
  pause(): void

  /**
   * 恢复处理。
   * 等效于 AgentService.resume()
   * PiperOrchestrator: 通过 reset 实现恢复效果
   */
  resume(): void

  /**
   * 是否处于暂停状态。
   * 等效于 AgentService.isPaused()
   */
  isPaused(): boolean
}

// ════════════════════════════════════════════
//  策略模式 — 运行时选择引擎实现
// ════════════════════════════════════════════

/**
 * 引擎策略提供者 — 在运行时选择具体引擎实现。
 *
 * 当系统有多个引擎注册在同一接口下时（如本地 PiperTTS vs 云端 EdgeTTS），
 * 可通过此策略提供者在运行时切换。
 *
 * 示例：
 *   const provider: IEngineStrategyProvider = ...
 *   const engine = provider.getActive()
 *   const status = engine.getStatus()
 *   // 切换到另一个引擎
 *   provider.setActive('edge_tts')
 *
 * 兼容 IStrategyProvider 接口，可配合 StrategySelector 使用。
 */
export interface IEngineStrategyProvider {
  /**
   * 获取当前活跃的引擎实例。
   * @returns 当前引擎，无可用引擎时返回 null
   */
  getActive(): IEngineService | null

  /**
   * 获取所有可用引擎。
   * @returns 全部已注册的引擎实例列表
   */
  getAll(): IEngineService[]

  /**
   * 设置活跃引擎。
   * @param name 引擎名称（对应 name 属性）
   * @returns 是否设置成功
   */
  setActive(name: string): boolean
}
