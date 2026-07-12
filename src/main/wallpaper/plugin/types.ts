/**
 * Wallpaper Plugin 契约定义
 *
 * ── 设计哲学 ──
 * Wallpaper 的能力接口定义为一组插件契约，外部模块（如 UserBehavior）
 * 作为插件实现接入。Wallpaper 在运行时通过 ServiceLoader 发现并加载插件，
 * 插件专注于实现契约而不需关心 Wallpaper 的内部调度。
 *
 * ── 插件 API 稳定性 ──
 * 插件 API 的稳定性直接影响生态建设，变更前请评估兼容性。
 *
 * ── 架构关系 ──
 * WallpaperPluginManifest + IWallpaperPlugin ← 插件实现（如 UserBehavior）
 *                            ↑
 *                   WallpaperPluginRegistry (ServiceLoader)
 *                            ↑
 *             Wallpaper 系统消费者（如 WallpaperEventBridge）
 *
 * ── 使用示例 ──
 * ```ts
 * // 插件端（如 UserBehavior）
 * class UserBehaviorPlugin implements IWallpaperPlugin {
 *   manifest = { name: 'user-behavior', capabilities: ['behavior_provider'] }
 *   behaviorProvider = { getBehaviorSnapshot: ..., onBehaviorChange: ... }
 * }
 *
 * // Wallpaper 端
 * const registry = WallpaperPluginRegistry.getInstance()
 * registry.register(plugin)
 * const provider = registry.getBehaviorProvider()
 * const state = provider?.getBehaviorSnapshot()
 * ```
 */

import type { ServiceManifest } from '../../core/patterns/ServiceRegistry'

// ═══════════════════════════════════════════
//  Wallpaper 插件能力类型
// ═══════════════════════════════════════════

/**
 * Wallpaper 插件能力标识。
 * 每个能力对应一种插件契约，插件通过 manifest.capabilities 声明自己支持的能力。
 *
 * # Agent 模块 Wallpaper 化能力
 *
 * 以下能力标识对应 Agent 模块中可被 Wallpaper 替换的子模块。
 * 详见 src/main/agent/wallpaper-mapping.ts 的完整迁移计划。
 *
 * ## 能力清单
 *
 * - behavior_provider:      提供用户行为状态（模式、情境、空闲状态等）
 * - content_classifier:     消息内容类型分类（Agent ContentClassifier 的替代）
 * - sleep_maintenance:      低负载后台维护（Agent SleepCycle 的替代）
 * - error_classifier:       LLM 错误分类（Agent ErrorClassifier 的替代）
 * - checkpoint_scheduler:   检查点调度决策（Agent CheckpointScheduler 的替代）
 * - execution_governor:     工具执行批次的决策门（Agent ExecutionGovernor 的替代）
 * - progress_guardrail:     跨轮进度停滞检测（Agent ProgressGuardrail 的替代）
 * - procedural_memory:      流程记忆记录（Agent ProceduralMemory 的替代）
 * - failure_analyzer:       失败模式分析（Agent FailureAnalyzer 的替代）
 * - reflect_loop:           交互后反思（Agent ReflectLoop 的替代）
 * - behavior_analyzer:      用户行为模式分析（Agent UserBehaviorAnalyzer 的替代）
 * - guardrail_provider:     安全护栏规则（Agent Guardrail 的替代）
 * - persona_manager:        人格仲裁管理（Agent PersonaStateManager 的替代）
 * - drift_control:          人格漂移控制（Agent PersonaDriftControlSystem 的替代）
 */
export type WallpaperPluginCapability =
  | 'behavior_provider'
  | 'content_classifier'
  | 'sleep_maintenance'
  | 'error_classifier'
  | 'checkpoint_scheduler'
  | 'execution_governor'
  | 'progress_guardrail'
  | 'procedural_memory'
  | 'failure_analyzer'
  | 'reflect_loop'
  | 'behavior_analyzer'
  | 'guardrail_provider'
  | 'persona_manager'
  | 'drift_control'

// ═══════════════════════════════════════════
//  Wallpaper 行为快照
// ═══════════════════════════════════════════

/**
 * Wallpaper 需要的标准化行为快照。
 *
 * 插件（如 UserBehavior）通过 IBehaviorProvider 提供此数据结构。
 * Wallpaper 系统消费此数据驱动 Overlay 透明度、隐私淡入、装饰显示等行为。
 */
export interface WallpaperBehaviorSnapshot {
  /** 行为模式：专注 / 多任务 / 休息 */
  mode: 'focus' | 'multitasking' | 'break'

  /** 活动情境：编程 / 浏览 / 休息 */
  context: 'coding' | 'browsing' | 'resting'

  /** 活动状态：活跃 / 空闲 / 离开 */
  activityState: 'active' | 'idle' | 'away'

  /** 前台窗口类别 */
  appCategory: string

  /** 是否全屏 */
  fullscreen: boolean

  /** 窗口是否聚焦 */
  focused: boolean

  /** 距上次活动毫秒数 */
  idleTimeMs: number

  /** 模式持续时长（毫秒） */
  modeDurationMs: number

  /** 模式置信度 0-1 */
  confidence: number

  /** 快照创建时间戳 */
  timestamp: number
}

// ═══════════════════════════════════════════
//  行为提供者插件契约
// ═══════════════════════════════════════════

/**
 * 行为提供者插件契约 — IBehaviorProvider
 *
 * 实现此接口 = 成为 Wallpaper 可识别的行为数据源。
 * UserBehavior 通过此接口向 Wallpaper 提供行为状态，
 * 不需要了解 Wallpaper 如何处理这些数据。
 *
 * ── 契约保证 ──
 * 1. getBehaviorSnapshot() 必须轻量、同步，不涉及异步 I/O
 * 2. onBehaviorChange() 注册的回调在每次行为状态变化时触发
 * 3. markActive() 由 Wallpaper 在收到用户交互时调用
 */
export interface IBehaviorProvider {
  /** 提供者标识（用于日志和去重） */
  readonly name: string

  /**
   * 获取当前行为快照。
   * @returns WallpaperBehaviorSnapshot | null（暂不可用时返回 null）
   */
  getBehaviorSnapshot(): WallpaperBehaviorSnapshot | null

  /**
   * 订阅行为变化。
   * @param callback 行为变化时的回调，参数为当前行为快照
   * @returns 取消订阅函数
   */
  onBehaviorChange(callback: (snapshot: WallpaperBehaviorSnapshot) => void): () => void

  /** 标记用户活动 */
  markActive(): void
}

// ═══════════════════════════════════════════
//  插件元数据
// ═══════════════════════════════════════════

/**
 * Wallpaper 插件元数据（扩展 ServiceManifest）。
 * 包含唯一标识、版本、描述以及能力集合。
 */
export interface WallpaperPluginManifest extends ServiceManifest {
  /** 插件提供的能力集合 */
  capabilities: WallpaperPluginCapability[]
}

// ═══════════════════════════════════════════
//  插件主接口
// ═══════════════════════════════════════════

/**
 * Wallpaper 插件主接口 — IWallpaperPlugin
 *
 * 实现此接口 = 成为 Wallpaper 可识别的插件。
 * 插件只需关注自己的领域逻辑（如提供行为数据），
 * 不需要了解 Wallpaper 的内部调度或 Overlay 渲染。
 *
 * ── 实现须知 ──
 * - manifest.capabilities 声明插件能力，决定了哪些可选属性存在
 * - capability = 'behavior_provider' → 必须提供 behaviorProvider
 * - onLoad / onUnload 是可选生命周期钩子
 */
export interface IWallpaperPlugin {
  /** 插件元数据 */
  readonly manifest: WallpaperPluginManifest

  /**
   * 行为提供者。
   * 当 manifest.capabilities 包含 'behavior_provider' 时必选。
   */
  readonly behaviorProvider?: IBehaviorProvider

  /** 生命周期：加载（可选） */
  onLoad?(): Promise<void>

  /** 生命周期：卸载（可选） */
  onUnload?(): Promise<void>
}
