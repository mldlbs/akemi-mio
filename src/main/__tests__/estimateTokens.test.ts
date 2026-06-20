import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../agent/context'

describe('estimateTokens (CJK-aware)', () => {
  it('estimates pure ASCII text at bytes/4', () => {
    expect(estimateTokens('hello')).toBe(2)       // 5/4 = 2
    expect(estimateTokens('hello world')).toBe(3)  // 11/4 = 3
    expect(estimateTokens('a'.repeat(40))).toBe(10) // 40/4 = 10
  })

  it('estimates pure CJK text at bytes/2', () => {
    // 每个 CJK 字符 3 字节, '你好世界' = 12 bytes, 12/2 = 6
    expect(estimateTokens('你好世界')).toBe(6)
    expect(estimateTokens('中文')).toBe(3)  // 6/2 = 3
  })

  it('estimates mixed text based on CJK ratio', () => {
    // 'hello你好世界' = 4 CJK/9 chars ≈ 0.44 > 0.3 → bytes/2 = 18/2 = 9
    expect(estimateTokens('hello你好世界')).toBe(9)
  })

  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('handles null and undefined', () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })

  it('handles text with mixed CJK punctation', () => {
    // 全角标点也算 CJK 范围
    const text = '你好！今天天气真好。'
    const result = estimateTokens(text)
    expect(result).toBeGreaterThan(0)
  })
})
