import { describe, it, expect, vi } from 'vitest'
import { validateToolCallChain, rollbackToLastKnownGood } from '@akemi-mio/intelligence/agent/ContextIntegrityChecker'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

function makeMsg(role: string, overrides: Record<string, any> = {}) {
  return { role, content: null, ...overrides } as any
}

describe('ContextIntegrityChecker', () => {
  // ======= validateToolCallChain =======

  it('合法链: user→assistant(tool_call)→tool→assistant → valid', () => {
    const msgs = [
      makeMsg('user', { content: 'hello' }),
      makeMsg('assistant', { tool_calls: [{ id: 'call1', type: 'function', function: { name: 'foo', arguments: '{}' } }] }),
      makeMsg('tool', { tool_call_id: 'call1', content: 'result' }),
      makeMsg('assistant', { content: 'done' }),
    ]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(true)
    expect(r.issues).toHaveLength(0)
  })

  it('合法链: 无 tool 调用 → valid', () => {
    const msgs = [makeMsg('user', { content: 'hi' }), makeMsg('assistant', { content: 'hello' })]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(true)
  })

  it('合法链: 多轮 tool 调用 → valid', () => {
    const msgs = [
      makeMsg('user', { content: 'u1' }),
      makeMsg('assistant', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'f1', arguments: '{}' } }] }),
      makeMsg('tool', { tool_call_id: 'a', content: 'r1' }),
      makeMsg('assistant', { tool_calls: [{ id: 'b', type: 'function', function: { name: 'f2', arguments: '{}' } }] }),
      makeMsg('tool', { tool_call_id: 'b', content: 'r2' }),
      makeMsg('assistant', { content: 'done' }),
    ]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(true)
  })

  it('孤儿 tool_call → ORPHANED_TOOL_CALL', () => {
    const msgs = [
      makeMsg('user', { content: 'u1' }),
      makeMsg('assistant', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }] }),
    ]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(false)
    expect(r.issues[0].type).toBe('ORPHANED_TOOL_CALL')
  })

  it('tool 消息无前置 assistant(tool_calls) → MISSING_TOOL_RESPONSE', () => {
    const msgs = [makeMsg('tool', { tool_call_id: 'x', content: 'orphan' })]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(false)
    expect(r.issues[0].type).toBe('MISSING_TOOL_RESPONSE')
  })

  it('空 tool_call id → EMPTY_TOOL_CALL_ID', () => {
    const msgs = [
      makeMsg('assistant', { tool_calls: [{ id: '', type: 'function', function: { name: 'foo', arguments: '{}' } }] }),
      makeMsg('tool', { tool_call_id: '', content: 'r' }),
      makeMsg('assistant', { content: 'done' }),
    ]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(false)
    expect(r.issues.some((i) => i.type === 'EMPTY_TOOL_CALL_ID')).toBe(true)
  })

  it('user 消息插在 tool_call 和 tool 之间 → INTERLEAVED_USER_MESSAGE', () => {
    const msgs = [
      makeMsg('user', { content: 'u1' }),
      makeMsg('assistant', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }] }),
      makeMsg('user', { content: 'u2' }),
      makeMsg('tool', { tool_call_id: 'c1', content: 'r' }),
    ]
    const r = validateToolCallChain(msgs)
    expect(r.valid).toBe(false)
    expect(r.issues[0].type).toBe('INTERLEAVED_USER_MESSAGE')
  })

  it('空数组 → valid', () => {
    const r = validateToolCallChain([])
    expect(r.valid).toBe(true)
  })

  // ======= rollbackToLastKnownGood =======

  function makeMsgWithContent(role: string, content: string) {
    return { role, content } as any
  }

  it('带有效 STM pair 和 lastUserMessage → 重建上下文', () => {
    const msgs = [makeMsgWithContent('system', 'sys'), makeMsgWithContent('user', 'u1'), makeMsgWithContent('assistant', 'a1')]
    const stm = [{ user: 'u2', assistant: 'a2' }]
    rollbackToLastKnownGood(msgs, stm, 'u3')
    expect(msgs[0].content).toBe('sys')
    expect(msgs[1].content).toBe('u2')
    expect(msgs[1].role).toBe('user')
    expect(msgs[2].content).toBe('a2')
    expect(msgs[2].role).toBe('assistant')
    expect(msgs[3].content).toBe('u3')
    expect(msgs[3].role).toBe('user')
    expect(msgs).toHaveLength(4)
  })

  it('空 STM 和 lastUser → 只剩 system', () => {
    const msgs = [makeMsgWithContent('system', 'sys'), makeMsgWithContent('user', 'u1'), makeMsgWithContent('assistant', 'a1')]
    rollbackToLastKnownGood(msgs, [])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('sys')
  })

  it('无 system prompt → fallback 空的 system', () => {
    const msgs = [makeMsgWithContent('user', 'u1')]
    rollbackToLastKnownGood(msgs, [])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe('')
  })

  it('STM 中 user 为空字符串时不推入', () => {
    const msgs = [makeMsgWithContent('system', 'sys')]
    const stm = [{ user: '', assistant: 'a1' }]
    rollbackToLastKnownGood(msgs, stm)
    expect(msgs).toHaveLength(2) // system + assistant(a1)
    expect(msgs[1].role).toBe('assistant')
  })

  it('mutate 原数组（验证 in-place 修改）', () => {
    const original = [makeMsgWithContent('system', 'sys'), makeMsgWithContent('user', 'u1')]
    const ref = original
    rollbackToLastKnownGood(original, [])
    expect(ref).toBe(original)
    expect(original).toHaveLength(1)
    expect(original[0].content).toBe('sys')
  })
})
