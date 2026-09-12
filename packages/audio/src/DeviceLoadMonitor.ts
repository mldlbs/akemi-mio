/**
 * DeviceLoadMonitor — 设备负载（CPU / 内存）监测器
 *
 * 通过轮询方式采集当前 CPU 和内存使用率，供 QoSEvaluator 评估整体服务质量。
 *
 * 设计原则：
 * - 轻量级：使用 Node.js `os` 模块，无外部依赖
 * - 惰性轮询：仅在首次查询后启动定时器
 * - 容错：采样失败不抛异常，返回上次有效值
 * - 可配置：监测间隔可由调用方设定
 *
 * CPU 使用率计算逻辑：
 *   1. 记录当前 CPU ticks（user + nice + sys + idle + irq）
 *   2. 休眠采样间隔（默认 1s）
 *   3. 再次记录 CPU ticks
 *   4. CPU 使用率 = (deltaTotal - deltaIdle) / deltaTotal * 100
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { cpus, freemem, totalmem } from 'os'
import type { DeviceLoadInfo } from './types'

export class DeviceLoadMonitor {
  /** 最近一次采集的设备负载信息 */
  private lastLoad: DeviceLoadInfo | null = null

  /** 监测定时器引用 */
  private monitorTimer: ReturnType<typeof setInterval> | null = null

  /** 监测间隔（毫秒） */
  private intervalMs: number

  /** 是否正在运行 */
  private running = false

  /** 上一次 CPU ticks 快照（计算 delta 用） */
  private previousCpuTicks: { idle: number; total: number } | null = null

  /**
   * 在 Windows 上获取 CPU 使用率需要一次 delta 采样，
   * 所以首次调用返回 -1，第二次开始返回真实值。
   */
  private firstSampleComplete = false

  constructor(intervalMs = 10000) {
    this.intervalMs = intervalMs
  }

  /**
   * 启动周期性监测。
   * 在首次调用后立即采集一次样本。
   */
  start(): void {
    if (this.running) return
    this.running = true

    // 立即采集一次（CPU 采样需要延迟，所以首次可能为 -1）
    this.sampleNow()

    this.monitorTimer = setInterval(() => {
      this.sampleNow()
    }, this.intervalMs)

    // 允许定时器在空闲时运行
    if (this.monitorTimer && typeof this.monitorTimer === 'object' && 'unref' in this.monitorTimer) {
      this.monitorTimer.unref()
    }

    log('INFO', 'device_load_monitor_started', { intervalMs: this.intervalMs })
  }

  /**
   * 停止周期性监测。
   */
  stop(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    this.running = false
    this.previousCpuTicks = null
    this.firstSampleComplete = false
    log('INFO', 'device_load_monitor_stopped')
  }

  /**
   * 获取最近一次采集的设备负载信息。
   * 如果尚未采集过，立即采集一次。
   */
  async getLoad(): Promise<DeviceLoadInfo> {
    if (!this.lastLoad) {
      this.sampleNow()
    }
    return this.lastLoad ?? { cpuPercent: 0, memoryPercent: 0, timestamp: Date.now() }
  }

  /**
   * 获取缓存的设备负载信息（同步，不发起新采集）。
   * 如果尚未采集过或采集失败，返回 null。
   * 与 NetworkMonitor.getCachedStatus() 模式一致。
   */
  getCachedLoad(): DeviceLoadInfo | null {
    return this.lastLoad ? { ...this.lastLoad } : null
  }

  /**
   * 更新监测间隔。
   */
  setInterval(ms: number): void {
    this.intervalMs = ms
    if (this.running) {
      this.stop()
      this.start()
    }
  }

  /**
   * 获取监测器是否正在运行。
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * 立即执行一次采样。
   */
  private sampleNow(): void {
    try {
      const memoryPercent = this.sampleMemory()
      const cpuPercent = this.sampleCpu()

      this.lastLoad = {
        cpuPercent,
        memoryPercent,
        timestamp: Date.now(),
      }

      if (cpuPercent >= 0) {
        this.firstSampleComplete = true
      }
    } catch (err) {
      log('WARN', 'device_load_sample_failed', { error: String(err) })
    }
  }

  /**
   * 采集内存使用率。
   */
  private sampleMemory(): number {
    const free = freemem()
    const total = totalmem()
    if (total === 0) return 0
    return Math.round(((total - free) / total) * 100)
  }

  /**
   * 采集 CPU 使用率（需要两次采样计算 delta）。
   * 首次返回 -1（表示正在预热）。
   */
  private sampleCpu(): number {
    const currentTicks = this.getCpuTicks()

    if (!this.previousCpuTicks) {
      this.previousCpuTicks = currentTicks
      return -1
    }

    const deltaIdle = currentTicks.idle - this.previousCpuTicks.idle
    const deltaTotal = currentTicks.total - this.previousCpuTicks.total
    this.previousCpuTicks = currentTicks

    if (deltaTotal === 0) return 0
    return Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 100)
  }

  /**
   * 获取当前 CPU ticks（所有核心合计）。
   */
  private getCpuTicks(): { idle: number; total: number } {
    const cores = cpus()
    let idle = 0
    let total = 0

    for (const core of cores) {
      const { times } = core
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }

    return { idle, total }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 QoSEvaluator 使用 */
export const deviceLoadMonitor = new DeviceLoadMonitor()
