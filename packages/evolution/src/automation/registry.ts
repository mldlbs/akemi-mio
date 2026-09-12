/**
 * Evolution Automation Registry — MCP 设计模式迁移
 *
 * 迁移自 tool/index.ts (getAllTools) + tool/types.ts (buildTool) 的设计模式：
 * - buildCollector() / buildExecutor() → 统一工厂方法（对应 buildTool()）
 * - getAllCollectors() / getAllExecutors() → 集中发现（对应 getAllTools()）
 * - registerCollector() / registerExecutor() → 运行时注册
 *
 * 解决的问题：
 * - PipelineOrchestrator.initDefaults() 中手动 new 各个 Collector/Executor
 * - 新增 Collector/Executor 需要修改 OR 修改 PipelineOrchestrator 代码
 * - 没有统一的注册/发现机制（PluginServiceLoader 仅面向外部插件）
 *
 * 新架构：
 *   1. 各 Collector/Executor 在自己的模块中通过 buildCollector/buildExecutor 工厂创建
 *   2. 在 registry.ts 中统一注册（或自动发现）
 *   3. PipelineOrchestrator 通过 getAllCollectors() / getAllExecutors() 获取所有实现
 *   4. 支持运行时动态注册（第三方扩展）
 *
 * 【模式抽取】
 * 通用工厂逻辑已迁移到 core/patterns：
 * - buildCollector / buildExecutor 使用 core/patterns 的 applyDefaults
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { applyDefaults } from '@akemi-mio/core/core/patterns'
import type { SignalCollector, FixExecutor, ProblemSource } from './types'

// ==============================================================================
// CollectorDef — Collector 定义接口（对应 ToolDef）
// ==============================================================================

export interface CollectorDef {
  /** 采集器唯一标识名 */
  name: string
  /** 可读描述 */
  description: string
  /** 问题来源类型 */
  source: ProblemSource
  /** 采集实现 */
  collect: () => Promise<import('./types').Problem[]>
  /** 是否应该运行（跳过条件） */
  shouldRun: () => boolean
}

// ==============================================================================
// ExecutorDef — Executor 定义接口（对应 ToolDef）
// ==============================================================================

export interface ExecutorDef {
  /** 执行器唯一标识名 */
  name: string
  /** 可读描述 */
  description: string
  /** 支持的来源类型 */
  supportedSources: ProblemSource[]
  /** 执行实现 */
  execute: (problem: import('./types').AssignedProblem) => Promise<import('./types').FixResult>
  /** 当前是否可用 */
  isAvailable: () => boolean
  /** 单次执行超时 */
  timeoutMs: number
}

// ==============================================================================
// buildCollector() — 工厂函数（对应 buildTool()）
// ==============================================================================

/**
 * 从 CollectorDef 构建 SignalCollector 实例
 * 作用同 buildTool()：补全默认值，统一创建
 * 使用 core/patterns 的 applyDefaults 补全默认值。
 */
export function buildCollector(def: CollectorDef): SignalCollector {
  return applyDefaults(def as SignalCollector, {
    // SignalCollector 没有需要补全的默认字段
  })
}

// ==============================================================================
// buildExecutor() — 工厂函数（对应 buildTool()）
// ==============================================================================

/**
 * 从 ExecutorDef 构建 FixExecutor 实例
 * 作用同 buildTool()：补全默认值，统一创建
 * 使用 core/patterns 的 applyDefaults 补全默认值。
 */
export function buildExecutor(def: ExecutorDef): FixExecutor {
  return applyDefaults(def as FixExecutor, {
    // FixExecutor 没有需要补全的默认字段
  })
}

// ==============================================================================
// CollectorRegistry — 中央采集器注册表
// ==============================================================================

class CollectorRegistry {
  private collectors = new Map<string, SignalCollector>()

  /** 注册一个采集器 */
  register(collector: SignalCollector): void {
    const name = collector.name
    if (this.collectors.has(name)) {
      log('WARN', 'collector_already_registered', { name })
      return
    }
    this.collectors.set(name, collector)
    log('INFO', 'collector_registered', { name, source: collector.source })
  }

  /** 获取所有已注册的采集器 */
  getAll(): SignalCollector[] {
    return Array.from(this.collectors.values())
  }

  /** 按名称获取采集器 */
  get(name: string): SignalCollector | undefined {
    return this.collectors.get(name)
  }

  /** 按来源类型获取采集器 */
  getBySource(source: ProblemSource): SignalCollector[] {
    return this.getAll().filter((c) => c.source === source)
  }

  /** 移除一个采集器 */
  unregister(name: string): boolean {
    return this.collectors.delete(name)
  }

  /** 获取注册数量 */
  get size(): number {
    return this.collectors.size
  }

  /** 清空注册表 */
  clear(): void {
    this.collectors.clear()
  }
}

// ==============================================================================
// ExecutorRegistry — 中央执行器注册表
// ==============================================================================

class ExecutorRegistry {
  private executors = new Map<string, FixExecutor>()

  /** 注册一个执行器 */
  register(executor: FixExecutor): void {
    const name = executor.name
    if (this.executors.has(name)) {
      log('WARN', 'executor_already_registered', { name })
      return
    }
    this.executors.set(name, executor)
    log('INFO', 'executor_registered', {
      name,
      supportedSources: executor.supportedSources,
      timeoutMs: executor.timeoutMs,
    })
  }

  /** 获取所有已注册的执行器 */
  getAll(): FixExecutor[] {
    return Array.from(this.executors.values())
  }

  /** 按名称获取执行器 */
  get(name: string): FixExecutor | undefined {
    return this.executors.get(name)
  }

  /** 获取支持指定来源类型的执行器（按优先级排序） */
  getBySource(source: ProblemSource): FixExecutor[] {
    return this.getAll().filter((e) => (e.supportedSources as string[]).includes(source))
  }

  /** 移除一个执行器 */
  unregister(name: string): boolean {
    return this.executors.delete(name)
  }

  /** 获取注册数量 */
  get size(): number {
    return this.executors.size
  }

  /** 清空注册表 */
  clear(): void {
    this.executors.clear()
  }
}

// ==============================================================================
// 全局单例
// ==============================================================================

/** 全局采集器注册表 */
export const collectorRegistry = new CollectorRegistry()

/** 全局执行器注册表 */
export const executorRegistry = new ExecutorRegistry()

// ==============================================================================
// 便捷函数（对应 getAllTools() 风格的统一访问）
// ==============================================================================

/** 获取所有已注册的采集器 */
export function getAllCollectors(): SignalCollector[] {
  return collectorRegistry.getAll()
}

/** 获取所有已注册的执行器 */
export function getAllExecutors(): FixExecutor[] {
  return executorRegistry.getAll()
}

/** 注册一个采集器 */
export function registerCollector(collector: SignalCollector): void {
  collectorRegistry.register(collector)
}

/** 注册一个执行器 */
export function registerExecutor(executor: FixExecutor): void {
  executorRegistry.register(executor)
}

/** 按来源类型获取执行器 */
export function getExecutorsBySource(source: ProblemSource): FixExecutor[] {
  return executorRegistry.getBySource(source)
}

/** 按来源类型获取采集器 */
export function getCollectorsBySource(source: ProblemSource): SignalCollector[] {
  return collectorRegistry.getBySource(source)
}
