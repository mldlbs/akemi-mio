import { describe, expect, it, vi } from 'vitest'

import { EvaluationStore, QUERY_NO_LIMIT } from '@akemi-mio/core/core/evaluation/EvaluationStore'

describe('EvaluationStore strict query', () => {
  it('rejects read failures while query remains forgiving', async () => {
    const readFailure = new Error('evaluation_read_failed')
    const rawDb = {
      run: vi.fn(),
      query: vi.fn(() => {
        throw readFailure
      }),
    }
    const store = new EvaluationStore({} as any, rawDb)

    await expect(store.queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })).rejects.toBe(readFailure)
    await expect(store.query({ since: 0 }, { limit: QUERY_NO_LIMIT })).resolves.toEqual([])
  })

  it('rejects strict reads before initialization', async () => {
    const store = new EvaluationStore()

    await expect(store.queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })).rejects.toThrow('not initialized')
  })

  it('propagates deserialization failures while query remains forgiving', async () => {
    const rawDb = {
      run: vi.fn(),
      query: vi.fn(() => [
        {
          id: 'invalid-payload',
          timestamp: 1,
          trace_id: 'trace',
          session_id: 'session',
          source: 'test',
          type: 'tool.completed',
          payload: '{invalid-json',
        },
      ]),
    }
    const store = new EvaluationStore({} as any, rawDb)

    await expect(store.queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })).rejects.toThrow(SyntaxError)
    await expect(store.query({ since: 0 }, { limit: QUERY_NO_LIMIT })).resolves.toEqual([])
  })

  it('propagates flush failures while query remains forgiving', async () => {
    const flushFailure = new Error('evaluation_flush_failed')
    const createStore = () => {
      const store = new EvaluationStore({} as any, {
        run: vi.fn(() => {
          throw flushFailure
        }),
        query: vi.fn(() => []),
      })
      store.append({
        id: 'pending-event',
        timestamp: 1,
        traceId: 'trace',
        sessionId: 'session',
        source: 'test',
        type: 'tool.completed',
        payload: { type: 'tool.completed', toolName: 'search', durationMs: 1 },
      })
      return store
    }

    await expect(createStore().queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })).rejects.toBe(flushFailure)
    await expect(createStore().query({ since: 0 }, { limit: QUERY_NO_LIMIT })).resolves.toEqual([])
  })
})
