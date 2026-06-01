import { describe, it, expect } from 'vitest'
import { applyHotwords, WhisperEngine } from '../asr/WhisperEngine'

describe('whisper', () => {
  describe('applyHotwords', () => {
    it('corrects "agent" to "Agent"', () => {
      const result = applyHotwords('hello agent')
      expect(result.text).toBe('hello Agent')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toEqual({ hotword: 'Agent', count: 1 })
    })

    it('corrects "mcp" to "MCP"', () => {
      const result = applyHotwords('use mcp protocol')
      expect(result.text).toBe('use MCP protocol')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toEqual({ hotword: 'MCP', count: 1 })
    })

    it('handles multiple hotwords in one string', () => {
      const result = applyHotwords('agent and mcp and claude')
      expect(result.text).toBe('Agent and MCP and Claude')
      expect(result.hits).toHaveLength(3)
    })

    it('handles repeated hotword', () => {
      const result = applyHotwords('agent agent agent')
      expect(result.text).toBe('Agent Agent Agent')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0].count).toBe(3)
    })

    it('does not modify non-matching text', () => {
      const result = applyHotwords('你好世界 hello world')
      expect(result.text).toBe('你好世界 hello world')
      expect(result.hits).toHaveLength(0)
    })

    it('hotwords list includes Chinese terms without breaking', () => {
      const result = applyHotwords('今天心情真好')
      expect(result.hits).toHaveLength(0)
    })
  })

  describe('getASRStatus', () => {
    it('returns correct initial state (not loaded)', () => {
      const engine = new WhisperEngine()
      const status = engine.getStatus()
      expect(status.loaded).toBe(false)
      expect(status.loading).toBe(false)
      expect(status.error).toBeNull()
    })
  })

  describe('getModelInfo', () => {
    it('returns "not loaded" before init', () => {
      const engine = new WhisperEngine()
      expect(engine.getModelInfo()).toBe('not loaded')
    })
  })
})
