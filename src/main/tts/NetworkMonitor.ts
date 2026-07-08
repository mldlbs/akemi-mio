/**
 * NetworkMonitor — 轻量级网络延迟检测器
 *
 * 用于 TTS 路由决策：检测云端 TTS 服务的网络可达性和延迟。
 *
 * 设计原则：
 * - 低开销：使用 Node.js DNS 解析 + TCP 连接试探，不依赖外部 ping 命令
 * - 缓存：检测结果有 TTL，避免每次 TTS 请求都检测网络
 * - 容错：检测失败不抛异常，返回不可用状态
 * - 异步非阻塞：所有检测方法都是 async
 */

import { log } from '../logger/Logger'
import { lookup } from 'dns/promises'
import { createConnection } from 'net'

/** 检测目标：使用常见的高可用端点 */
const PING_HOSTS = [
  { host: 'speech.microsoft.com', port: 443 },  // Azure Speech (edge-tts 后端)
  { host: 'api.github.com', port: 443 },        // 通用互联网可达性
]

export interface NetworkStatus {
  /** 网络是否可用 */
  available: boolean
  /** 当前延迟（毫秒），-1 表示不可用 */
  latencyMs: number
  /** 检测时间戳 */
  checkedAt: number
  /** 使用的检测目标 */
  target: string
}

export class NetworkMonitor {
  /** 缓存的网络状态 */
  private lastStatus: NetworkStatus | null = null

  /** 缓存 TTL（毫秒） */
  private cacheTtlMs: number

  /** 检测超时（毫秒） */
  private timeoutMs: number

  /** 进行中的检测 Promise（防止并发检测） */
  private pendingCheck: Promise<NetworkStatus> | null = null

  constructor(cacheTtlMs = 5000, timeoutMs = 3000) {
    this.cacheTtlMs = cacheTtlMs
    this.timeoutMs = timeoutMs
  }

  /**
   * 获取当前网络状态。
   * 如果缓存有效则直接返回，否则发起检测。
   */
  async getStatus(): Promise<NetworkStatus> {
    const now = Date.now()
    if (this.lastStatus && (now - this.lastStatus.checkedAt) < this.cacheTtlMs) {
      return this.lastStatus
    }

    // 防止并发检测
    if (this.pendingCheck) {
      return this.pendingCheck
    }

    this.pendingCheck = this.checkNetwork()
    try {
      const result = await this.pendingCheck
      this.lastStatus = result
      return result
    } finally {
      this.pendingCheck = null
    }
  }

  /**
   * 强制刷新网络状态（忽略缓存）。
   */
  async refresh(): Promise<NetworkStatus> {
    this.lastStatus = null
    return this.getStatus()
  }

  /** 获取缓存的状态（不发起新检测） */
  getCachedStatus(): NetworkStatus | null {
    return this.lastStatus
  }

  /** 网络是否可用（便捷方法） */
  async isAvailable(): Promise<boolean> {
    const status = await this.getStatus()
    return status.available
  }

  /** 获取当前延迟（便捷方法） */
  async getLatency(): Promise<number> {
    const status = await this.getStatus()
    return status.latencyMs
  }

  /** 清除缓存 */
  clearCache(): void {
    this.lastStatus = null
  }

  // ── 私有：网络检测 ──

  /**
   * 检测网络可达性和延迟。
   *
   * 策略：依次尝试多个目标，测量 DNS 解析 + TCP 连接的总延迟。
   * 第一个成功的目标即返回其延迟。
   */
  private async checkNetwork(): Promise<NetworkStatus> {
    for (const target of PING_HOSTS) {
      try {
        const t0 = Date.now()

        // DNS 解析
        await lookup(target.host, { family: 4 })

        // TCP 连接试探
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({
            host: target.host,
            port: target.port,
            timeout: this.timeoutMs,
          })

          const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error('TCP connect timeout'))
          }, this.timeoutMs)

          socket.on('connect', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve()
          })

          socket.on('error', (err) => {
            clearTimeout(timer)
            socket.destroy()
            reject(err)
          })
        })

        const latencyMs = Date.now() - t0

        log('DEBUG', 'network_monitor_check', {
          target: `${target.host}:${target.port}`,
          latencyMs,
        })

        return {
          available: true,
          latencyMs,
          checkedAt: Date.now(),
          target: `${target.host}:${target.port}`,
        }
      } catch (err) {
        log('DEBUG', 'network_monitor_target_failed', {
          target: `${target.host}:${target.port}`,
          error: String(err).slice(0, 100),
        })
        // 尝试下一个目标
        continue
      }
    }

    // 所有目标都不可达
    log('WARN', 'network_monitor_all_unavailable', {
      targets: PING_HOSTS.map((t) => t.host).join(', '),
    })

    return {
      available: false,
      latencyMs: -1,
      checkedAt: Date.now(),
      target: 'none',
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const networkMonitor = new NetworkMonitor()
