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
      const result = applyHotwords('agent and mcp and cursor')
      expect(result.text).toBe('Agent and MCP and Cursor')
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

    it('matches Chinese hotword with exact characters', () => {
      const result = applyHotwords('我会弹贝斯')
      expect(result.text).toBe('我会弹贝斯')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toEqual({ hotword: '贝斯', count: 1 })
    })

    it('matches Chinese hotword by pinyin (homophone)', () => {
      const result = applyHotwords('我会弹北四')
      expect(result.text).toBe('我会弹贝斯')
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toEqual({ hotword: '贝斯', count: 1 })
    })

    it('matches 秋山澪 by pinyin (秋山零)', () => {
      const result = applyHotwords('秋山零')
      expect(result.text).toBe('秋山澪')
      expect(result.hits).toHaveLength(1)
    })

    it('matches 秋山澪 by pinyin (秋山令)', () => {
      const result = applyHotwords('秋山令')
      expect(result.text).toBe('秋山澪')
      expect(result.hits).toHaveLength(1)
    })

    it('matches 秋山澪 by pinyin (秋山灵)', () => {
      const result = applyHotwords('秋山灵')
      expect(result.text).toBe('秋山澪')
      expect(result.hits).toHaveLength(1)
    })

    it('matches mixed Chinese pinyin and exact English', () => {
      const result = applyHotwords('使用 mcp 和 北四 协议')
      expect(result.text).toBe('使用 MCP 和 贝斯 协议')
      expect(result.hits).toHaveLength(2)
    })

    it('does not over-match partial pinyin', () => {
      const result = applyHotwords('东南西北方向')
      // '北' has same pinyin as in '贝斯', but '斯' wants 'si' and '方向' is 'fang xiang'
      // '北' alone at end shouldn't match '贝斯' (needs 2 chars)
      expect(result.hits).toHaveLength(0)
    })

    it('matches 秋山林 with in→ing normalization', () => {
      const result = applyHotwords('秋山林')
      expect(result.text).toBe('秋山澪')
      expect(result.hits).toHaveLength(1)
    })

    it('matches 邱善霖 with in→ing + 善 shan', () => {
      const result = applyHotwords('邱善霖')
      expect(result.text).toBe('秋山澪')
      expect(result.hits).toHaveLength(1)
    })

    it('does not match 修三灵 (xiu≠qiu, ASR hallucination)', () => {
      const result = applyHotwords('修三灵')
      expect(result.hits).toHaveLength(0)
    })

    it('does not match 祝杀临 (ASR hallucination)', () => {
      const result = applyHotwords('祝杀临')
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
