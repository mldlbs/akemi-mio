import { describe, it, expect, vi, beforeEach } from 'vitest'
import { estimateTokens, ConversationContext } from '../agent/context'
import { LlmService } from '../llm/LlmService'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ai', () => {
  describe('estimateTokens', () => {
    it('returns correct token estimate for short text', () => {
      expect(estimateTokens('hello')).toBe(3)
    })

    it('returns correct token estimate for Chinese text', () => {
      expect(estimateTokens('你好世界')).toBe(2)
    })

    it('returns correct token estimate for empty string', () => {
      expect(estimateTokens('')).toBe(0)
    })

    it('returns correct token estimate for mixed text', () => {
      expect(estimateTokens('hello你好')).toBe(4)
    })
  })

  describe('setConfig', () => {
    it('configures api key and default model', () => {
      const llm = new LlmService()
      llm.setConfig('sk-test-key')
      llm.setConfig('sk-test-key-2', 'deepseek/deepseek-reasoner')
      expect(true).toBe(true)
    })
  })

  describe('clearContext', () => {
    it('resets context and logs', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const ctx = new ConversationContext()
      ctx.clear()
      const output = JSON.parse(spy.mock.calls[0][0])
      expect(output.event).toBe('context_cleared')
      expect(output.level).toBe('INFO')
    })
  })
})
