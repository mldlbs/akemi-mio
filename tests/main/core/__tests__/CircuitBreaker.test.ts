import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CircuitBreaker } from '@akemi-mio/core/core/CircuitBreaker'

const T0 = new Date('2026-09-17T00:00:00Z')

/** 把系统时间往前推 ms 毫秒（allow/onFailure 都读 Date.now） */
function advance(ms: number) {
  vi.setSystemTime(new Date(T0.getTime() + ms))
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('从未记录过失败的电路一律放行', () => {
    const cb = new CircuitBreaker(3, 1000)
    expect(cb.allow('llm')).toBeNull()
  })

  it('连续失败达到阈值后才熔断（未到阈值仍放行）', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.onFailure('llm')
    cb.onFailure('llm')
    expect(cb.allow('llm')).toBeNull()
    cb.onFailure('llm')
    expect(cb.allow('llm')).toMatch(/熔断/)
  })

  it('一次成功会重置失败计数（连续失败语义）', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.onFailure('llm')
    cb.onFailure('llm')
    cb.onSuccess('llm')
    cb.onFailure('llm')
    cb.onFailure('llm')
    // 计数已归零，此时只有 2 次 < 3
    expect(cb.allow('llm')).toBeNull()
  })

  it('冷却结束后进入半开并放行探测请求', () => {
    const cb = new CircuitBreaker(1, 1000)
    cb.onFailure('llm')
    expect(cb.allow('llm')).toMatch(/熔断/)
    advance(2000)
    expect(cb.allow('llm')).toBeNull()
  })

  it('半开状态只放行 halfOpenMax 个探测请求，其余直接拒绝（防惊群）', () => {
    const cb = new CircuitBreaker(1, 1000, 1)
    cb.onFailure('llm')
    advance(2000)

    // 第 1 个探测请求放行
    expect(cb.allow('llm')).toBeNull()
    // 第 2 个被拒 —— 旧实现没有这个限制，会把积压请求全部放过去
    expect(cb.allow('llm')).toMatch(/half-open/)
    expect(cb.allow('llm')).toMatch(/half-open/)
  })

  it('halfOpenMax=2 时放行两个、第三个被拒', () => {
    const cb = new CircuitBreaker(1, 1000, 2)
    cb.onFailure('llm')
    advance(2000)

    expect(cb.allow('llm')).toBeNull()
    expect(cb.allow('llm')).toBeNull()
    expect(cb.allow('llm')).toMatch(/half-open/)
  })

  it('半开探测失败 → 立即重新熔断，不必再累计到阈值', () => {
    const cb = new CircuitBreaker(5, 1000)
    for (let i = 0; i < 5; i++) cb.onFailure('llm')
    advance(2000)
    expect(cb.allow('llm')).toBeNull() // 半开，放行探测
    expect(cb.getSnapshot().llm.state).toBe('half-open')

    cb.onFailure('llm') // 探测失败
    // 必须真正回到 open（并重置冷却计时）。若只是继续累计失败数，
    // 电路会永远卡在 half-open —— 表面看也在拒绝请求，但冷却重试机制失效。
    expect(cb.getSnapshot().llm.state).toBe('open')
    // 断言是 (open ...) 而不是 (half-open ...)：后者会掩盖上面那个 bug
    expect(cb.allow('llm')).toMatch(/\(open/)
  })

  it('半开探测成功 → 完全复位', () => {
    const cb = new CircuitBreaker(1, 1000)
    cb.onFailure('llm')
    advance(2000)
    cb.allow('llm')
    cb.onSuccess('llm')

    expect(cb.getSnapshot()).toEqual({})
    expect(cb.allow('llm')).toBeNull()
  })

  it('冷却窗口之外的旧失败不计入累计', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.onFailure('llm')
    cb.onFailure('llm')
    advance(5000) // 超过冷却窗口，旧计数应被丢弃
    cb.onFailure('llm')
    expect(cb.allow('llm')).toBeNull()
  })

  it('不同电路互不影响', () => {
    const cb = new CircuitBreaker(1, 1000)
    cb.onFailure('llm')
    expect(cb.allow('llm')).toMatch(/熔断/)
    expect(cb.allow('tts')).toBeNull()
  })

  it('getSnapshot 反映状态，reset 清空', () => {
    const cb = new CircuitBreaker(2, 1000)
    cb.onFailure('llm')
    expect(cb.getSnapshot().llm).toEqual({ state: 'closed', failures: 1 })
    cb.onFailure('llm')
    expect(cb.getSnapshot().llm.state).toBe('open')
    cb.reset()
    expect(cb.getSnapshot()).toEqual({})
  })

  it('onSuccess / onFailure 对未知电路是安全的 no-op', () => {
    const cb = new CircuitBreaker(1, 1000)
    expect(() => cb.onSuccess('never-seen')).not.toThrow()
    // onFailure 会建立记录，这是预期行为
    cb.onFailure('fresh')
    expect(cb.getSnapshot().fresh).toBeDefined()
  })
})
