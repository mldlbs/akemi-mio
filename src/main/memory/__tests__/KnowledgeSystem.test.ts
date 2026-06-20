import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UnifiedMemoryQuery } from '../UnifiedMemoryQuery'
import { LLMKnowledgeExtractor } from '../extractors/LLMKnowledgeExtractor'

describe('UnifiedMemoryQuery', () => {
  let umq: UnifiedMemoryQuery

  beforeEach(() => {
    umq = new UnifiedMemoryQuery()
  })

  it('should register and query a store', async () => {
    const mockStore = {
      search: vi.fn().mockResolvedValue([{ content: 'test result', confidence: 0.9, updatedAt: Date.now() }]),
    }
    umq.register('test', mockStore)
    const results = await umq.query('test')
    expect(results.length).toBe(1)
    expect(results[0].store).toBe('test')
  })

  it('should return empty array if no stores registered', async () => {
    const results = await umq.query('test')
    expect(results).toEqual([])
  })

  it('should filter by type', async () => {
    const mockStore = { search: vi.fn().mockResolvedValue([{ content: 'result', confidence: 0.9 }]) }
    umq.register('engineering', mockStore)
    umq.register('memory', mockStore)
    const results = await umq.query('test', { types: ['engineering'] })
    expect(results.length).toBe(1)
    expect(results[0].store).toBe('engineering')
  })

  it('should handle store with query method', async () => {
    const mockStore = { query: vi.fn().mockResolvedValue([{ entity: 'user', attribute: 'prefers', value: 'ts', confidence: 0.8 }]) }
    umq.register('kg', mockStore)
    const results = await umq.query('user')
    expect(results.length).toBe(1)
    expect(results[0].content).toBe('ts')
  })

  it('should handle store with getFormattedContext method', async () => {
    const mockStore = { getFormattedContext: vi.fn().mockResolvedValue('ctx') }
    umq.register('summary', mockStore)
    const results = await umq.query('')
    expect(results.length).toBe(1)
  })

  it('should sort results by score descending', async () => {
    const store = {
      search: vi.fn().mockResolvedValue([
        { content: 'a', confidence: 0.3 },
        { content: 'b', confidence: 0.9 },
      ]),
    }
    umq.register('store', store)
    const results = await umq.query('test', { topK: 5 })
    expect(results[0].score).toBe(0.9)
    expect(results[1].score).toBe(0.3)
  })
})

describe('LLMKnowledgeExtractor', () => {
  it('should return empty when LLM is not set', async () => {
    const extractor = new LLMKnowledgeExtractor()
    expect(await extractor.extract('test')).toEqual([])
  })

  it('should return empty for empty content', async () => {
    const extractor = new LLMKnowledgeExtractor()
    extractor.setLlm({ chatJson: vi.fn() })
    expect(await extractor.extract('')).toEqual([])
  })

  it('should parse valid LLM response', async () => {
    const mockLlm = { chatJson: vi.fn().mockResolvedValue([{ entity: 'user', attribute: 'language', value: 'ts', confidence: 0.95 }]) }
    const extractor = new LLMKnowledgeExtractor()
    extractor.setLlm(mockLlm)
    const result = await extractor.extract('user uses typescript')
    expect(result.length).toBe(1)
    expect(result[0].entity).toBe('user')
  })

  it('should filter invalid triples', async () => {
    const mockLlm = {
      chatJson: vi.fn().mockResolvedValue([
        { entity: 'user', attribute: 'lang', value: 'ts', confidence: 0.9 },
        { entity: '', attribute: 'bad', value: 'data', confidence: 0.5 },
      ]),
    }
    const extractor = new LLMKnowledgeExtractor()
    extractor.setLlm(mockLlm)
    const result = await extractor.extract('test')
    expect(result.length).toBe(1)
  })

  it('should handle LLM errors gracefully', async () => {
    const mockLlm = { chatJson: vi.fn().mockRejectedValue(new Error('LLM unavailable')) }
    const extractor = new LLMKnowledgeExtractor()
    extractor.setLlm(mockLlm)
    expect(await extractor.extract('test')).toEqual([])
  })
})
