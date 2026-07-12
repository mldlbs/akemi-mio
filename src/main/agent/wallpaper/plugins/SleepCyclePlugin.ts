/**
 * SleepCyclePlugin — Agent SleepCycle 的 Wallpaper 插件实现
 *
 * 将 Agent 的 SleepCycle（低负载后台维护循环）替换为 Wallpaper 插件。
 * 这是 Agent 模块 Wallpaper 化改造的 Phase 2 成果。
 *
 * ── 迁移目的 ──
 * SleepCycle 是独立的后台任务（记忆固化、失败模式挖掘），
 * 不依赖 Chat/Task 执行路径，适合作为 Wallpaper 的定期维护插件。
 *
 * ── 替换策略 ──
 * 1. 本插件注册到 WallpaperPluginRegistry，声明 sleep_maintenance 能力
 * 2. AgentWallpaperBridge 检测到本插件后，标记 SleepCycle 为「已替换」
 * 3. 原 AgentService 中的 SleepCycle 实例变为可选回退
 * 4. 新代码通过 WallpaperPluginRegistry 获取睡眠维护服务
 *
 * ── 向后兼容 ──
 * 保留原 SleepCycle 类（不删除），作为回退路径。
 * 通过 wallpaperReplacements.sleepMaintenance 标志控制路径选择。
 *
 * @see SleepCycle — 原 Agent 子模块（保留作回退）
 * @see AgentWallpaperBridge — 增量迁移桥梁
 * @see wallpaperReplacements — 替换锚点标志
 */

import { log } from '../../../logger/Logger'
import { eventBus, SubscriptionTracker } from '../../../core/EventBus'
import type { IWallpaperPlugin, WallpaperPluginManifest } from '../../../wallpaper/plugin/types'
import { WallpaperPluginRegistry } from '../../../wallpaper/plugin/WallpaperPluginRegistry'
import type { MemoryService } from '../../../memory/MemoryService'
import type { FailureAnalyzer } from '../../FailureAnalyzer'
import type { MetaController } from '../../../memory/MetaController'

// ════════════════════════════════════════════════════════════
//  睡眠维护状态
// ════════════════════════════════════════════════════════════

/** 最后一次维护时间戳 */
let lastMaintenanceTime = 0
/** 是否正在运行维护 */
let isMaintenanceRunning = false
/** 维护计数器 */
let maintenanceCount = 0

// ════════════════════════════════════════════════════════════
//  SleepCyclePlugin 实现
// ════════════════════════════════════════════════════════════

export class SleepCyclePlugin implements IWallpaperPlugin {
  readonly manifest: WallpaperPluginManifest = {
    name: 'agent-sleep-cycle',
    version: '1.0.0',
    description: '低负载后台维护：记忆固化、失败模式持久化',
    capabilities: ['sleep_maintenance'],
  }

  /** EventBus 订阅跟踪 */
  private subs = new SubscriptionTracker()

  /** Memory 服务引用（由 AgentService 在就绪后注入） */
  private memoryService: MemoryService | null = null

  /** FailureAnalyzer 引用 */
  private failureAnalyzer: FailureAnalyzer | null = null

  /** MetaController 引用 */
  private metaController: MetaController | null = null

  /** 繁忙检测函数（由 AgentService 提供） */
  private isBusyFn: (() => boolean) | null = null

  // ═════════════════════════════════════════════════════════════
  //  依赖注入
  // ═════════════════════════════════════════════════════════════

  /**
   * 设置依赖（由 AgentService 在就绪后调用）。
   *
   * @param deps 依赖集合
   */
  setDeps(deps: {
    memoryService?: MemoryService | null
    failureAnalyzer?: FailureAnalyzer | null
    metaController?: MetaController | null
    isBusyFn?: () => boolean
  }): void {
    if (deps.memoryService !== undefined) this.memoryService = deps.memoryService
    if (deps.failureAnalyzer !== undefined) this.failureAnalyzer = deps.failureAnalyzer
    if (deps.metaController !== undefined) this.metaController = deps.metaController
    if (deps.isBusyFn !== undefined) this.isBusyFn = deps.isBusyFn
  }

  // ═════════════════════════════════════════════════════════════
  //  生命周期
  // ═════════════════════════════════════════════════════════════

  async onLoad(): Promise<void> {
    log('INFO', 'sleep_cycle_plugin_loaded', {
      hasMemory: !!this.memoryService,
      hasFailureAnalyzer: !!this.failureAnalyzer,
      hasMetaController: !!this.metaController,
    })
  }

  async onUnload(): Promise<void> {
    this.subs.dispose()
    log('INFO', 'sleep_cycle_plugin_unloaded')
  }

  // ═════════════════════════════════════════════════════════════
  //  维护执行
  // ═════════════════════════════════════════════════════════════

  /**
   * 执行一次后台维护循环。
   * 由 Wallpaper 系统在空闲时调用（或由 AgentService.runSelfTask() 完成后触发）。
   *
   * @returns 维护摘要
   */
  async run(): Promise<{ ok: boolean; summary: string; durationMs: number }> {
    const t0 = Date.now()

    if (isMaintenanceRunning) {
      return { ok: false, summary: '维护已在运行', durationMs: 0 }
    }

    if (this.isBusyFn && this.isBusyFn()) {
      log('INFO', 'sleep_cycle_plugin_skipped_busy')
      return { ok: false, summary: '系统忙碌，跳过维护', durationMs: 0 }
    }

    isMaintenanceRunning = true

    try {
      log('INFO', 'sleep_cycle_plugin_start')
      const t1 = Date.now()

      const tasks: Promise<void>[] = []

      // 1. MetaController 背景优化（P1→P2 提纯）
      if (this.metaController) {
        tasks.push(this.metaController.backgroundOptimization())
      }

      // 2. 记忆固化
      if (this.memoryService) {
        tasks.push(this.consolidateMemory())
      }

      // 3. 失败模式持久化
      if (this.failureAnalyzer) {
        tasks.push(this.mineFailurePatterns())
      }

      const results = await Promise.allSettled(tasks)
      const ok = results.filter((r) => r.status === 'fulfilled').length
      maintenanceCount++
      lastMaintenanceTime = Date.now()

      const durationMs = Date.now() - t0
      log('INFO', 'sleep_cycle_plugin_done', {
        elapsedMs: durationMs,
        ok,
        total: results.length,
        maintenanceCount,
      })

      // 发布维护完成事件（供监控系统消费）
      eventBus.emit('wallpaper.sleep_maintenance.completed', {
        ok,
        total: results.length,
        durationMs,
        maintenanceCount,
      } as any)

      return {
        ok: ok === tasks.length,
        summary: `维护完成：${ok}/${tasks.length} 子任务成功`,
        durationMs,
      }
    } finally {
      isMaintenanceRunning = false
    }
  }

  /** 获取维护统计 */
  getStats(): { count: number; lastRun: number; isRunning: boolean } {
    return {
      count: maintenanceCount,
      lastRun: lastMaintenanceTime,
      isRunning: isMaintenanceRunning,
    }
  }

  // ═════════════════════════════════════════════════════════════
  //  私有维护方法
  // ═════════════════════════════════════════════════════════════

  /**
   * 记忆固化：去重、低置信度清理、提升。
   * 与原 SleepCycle.consolidateMemory() 逻辑一致。
   */
  private async consolidateMemory(): Promise<void> {
    if (!this.memoryService) return

    const entries = this.memoryService.getEntries()
    if (entries.length === 0) return

    const seen = new Map<string, string[]>()
    for (const e of entries) {
      const key = `${e.type}|${e.content}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push(e.id)
    }

    let merged = 0
    for (const [, ids] of seen) {
      if (ids.length > 1) {
        const keep = entries.find((e) => e.id === ids[0])
        const rest = ids.slice(1)
        if (keep) {
          for (const id of rest) {
            const idx = entries.findIndex((e) => e.id === id)
            if (idx >= 0) entries.splice(idx, 1)
          }
          keep.reinforceCount += rest.length
          merged += rest.length
        }
      }
    }

    const beforeClean = entries.length
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].confidence < 0.3 && entries[i].tier !== 'permanent') {
        entries.splice(i, 1)
      }
    }

    for (const e of entries) {
      this.memoryService['tryPromote']?.(e)
    }

    this.memoryService.flush()

    log('INFO', 'wallpaper_memory_consolidated', {
      merged,
      cleaned: beforeClean - entries.length,
      remaining: entries.length,
    })
  }

  /**
   * 失败模式持久化。
   * 与原 SleepCycle.mineFailurePatterns() 逻辑一致。
   */
  private async mineFailurePatterns(): Promise<void> {
    if (!this.failureAnalyzer) return
    const saved = this.failureAnalyzer.persistHotPatterns()
    if (saved > 0) {
      log('INFO', 'wallpaper_failure_patterns_persisted', { patterns: saved })
    }
  }
}

// =============================================================================
//  注册辅助
// =============================================================================

/**
 * 工厂函数 — 创建并注册 SleepCyclePlugin 到 WallpaperPluginRegistry。
 *
 *   const sleepPlugin = registerSleepCyclePlugin()
 *   sleepPlugin.setDeps({ memoryService, failureAnalyzer, metaController, isBusyFn })
 *   // 注册后，AgentWallpaperBridge 自动检测替换
 *
 * @returns SleepCyclePlugin 实例（供后续依赖注入）
 */
export function registerSleepCyclePlugin(): SleepCyclePlugin {
  const registry = WallpaperPluginRegistry.getInstance()
  const existing = registry.getByCapability('sleep_maintenance')

  if (existing.length > 0) {
    log('INFO', 'sleep_cycle_plugin_already_registered', {
      name: existing[0].manifest.name,
    })
    return existing[0] as SleepCyclePlugin
  }

  const plugin = new SleepCyclePlugin()
  registry.register(plugin)
  log('INFO', 'sleep_cycle_plugin_registered')

  return plugin
}
