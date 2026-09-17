import { log } from '@akemi-mio/core/logger/Logger'

interface CircuitBreakerState {
  failures: number
  lastFailureTime: number
  state: 'closed' | 'open' | 'half-open'
  openedAt: number | null
  /** half-open 状态下已放行、尚未回报结果的探测请求数 */
  halfOpenInFlight: number
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
        // 冷却结束 → 进入半开，放行探测请求。惰性切换，不依赖定时器。
        s.state = 'half-open'
        s.halfOpenInFlight = 0
        log('INFO', 'circuit_breaker_half_open', { circuit })
      } else {
        return `熔断: ${circuit} (open, ${Math.round((Date.now() - s.openedAt!) / 1000)}s ago)`
      }
    }

    if (s.state === 'half-open') {
      // 半开只放行有限个探测请求：否则恢复瞬间积压请求会一起涌入（惊群），
      // 把刚缓过来的服务再打垮。超出配额的直接拒绝，不进入下游。
      if (s.halfOpenInFlight >= this.halfOpenMax) {
        return `熔断: ${circuit} (half-open, 探测中 ${s.halfOpenInFlight}/${this.halfOpenMax})`
      }
      s.halfOpenInFlight++
      return null
    }

    return null
  }

  /** 记录成功 —— 重置状态 */
  onSuccess(circuit: string): void {
    const s = this.states.get(circuit)
    if (!s) return
    if (s.state !== 'closed') {
      log('INFO', 'circuit_breaker_reset', { circuit, from: s.state })
    }
    this.states.delete(circuit)
  }

  /** 记录失败 —— 达到阈值则熔断 */
  onFailure(circuit: string): void {
    let s = this.states.get(circuit)
    const now = Date.now()

    if (!s) {
      s = { failures: 0, lastFailureTime: now, state: 'closed', openedAt: null, halfOpenInFlight: 0 }
      this.states.set(circuit, s)
    }

    // 半开探测失败 → 立即重新打开，不必再累计到阈值
    if (s.state === 'half-open') {
      s.state = 'open'
      s.openedAt = now
      s.halfOpenInFlight = 0
      log('WARN', 'circuit_breaker_reopened', { circuit, reason: 'half_open_probe_failed' })
      return
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
    }
  }

  /** 重置所有电路状态（关闭电路） */
  reset(): void {
    this.states.clear()
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
