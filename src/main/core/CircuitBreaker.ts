import { log } from '../logger/Logger'

interface CircuitBreakerState {
  failures: number
  lastFailureTime: number
  state: 'closed' | 'open' | 'half-open'
  openedAt: number | null
}

export class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>()

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30000,
    private readonly halfOpenMax = 1,
  ) {}

  /** 检查调用是否允许通过。不允许时返回 reason 字符串，允许返回 null */
  allow(circuit: string): string | null {
    const s = this.states.get(circuit)
    if (!s) return null

    if (s.state === 'open') {
      if (Date.now() - s.openedAt! >= this.cooldownMs) {
        s.state = 'half-open'
        log('INFO', 'circuit_breaker_half_open', { circuit })
        return null
      }
      return `熔断: ${circuit} (open, ${Math.round((Date.now() - s.openedAt!) / 1000)}s ago)`
    }

    return null
  }

  /** 记录成功 —— 重置状态 */
  onSuccess(circuit: string): void {
    const s = this.states.get(circuit)
    if (!s) return
    if (s.state === 'half-open') {
      log('INFO', 'circuit_breaker_reset', { circuit })
    }
    this.states.delete(circuit)
  }

  /** 记录失败 —— 达到阈值则熔断 */
  onFailure(circuit: string): void {
    let s = this.states.get(circuit)
    const now = Date.now()

    if (!s) {
      s = { failures: 0, lastFailureTime: now, state: 'closed', openedAt: null }
      this.states.set(circuit, s)
    }

    // 超过冷却窗口则重置计数（避免历史旧失败触发熔断）
    if (now - s.lastFailureTime >= this.cooldownMs && s.state === 'closed') {
      s.failures = 0
    }

    s.failures++
    s.lastFailureTime = now

    if (s.failures >= this.threshold && s.state === 'closed') {
      s.state = 'open'
      s.openedAt = now
      log('WARN', 'circuit_breaker_opened', { circuit, failures: s.failures, threshold: this.threshold })

      // 半开续传：先切 half-open，让一个请求尝试恢复
      setTimeout(() => {
        const current = this.states.get(circuit)
        if (current && current.state === 'open') {
          current.state = 'half-open'
          log('INFO', 'circuit_breaker_half_open_timeout', { circuit })
        }
      }, this.cooldownMs)
    }
  }

  /** 获取当前熔断器快照 */
  getSnapshot(): Record<string, { state: string; failures: number }> {
    const snap: Record<string, { state: string; failures: number }> = {}
    for (const [key, s] of this.states) {
      snap[key] = { state: s.state, failures: s.failures }
    }
    return snap
  }
}
