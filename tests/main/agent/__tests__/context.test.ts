import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  estimateTokens,
  estimateMessageTokens,
  ConversationContext,
  trimOrphanedToolCallsFrom,
  type Message,
} from '@akemi-mio/intelligence/agent/context'

// ─── buildSystemPrompt ───

describe('buildSystemPrompt', () => {
  it('无参数时返回含身份提示的完整 prompt', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('秋山澪')
    expect(p).toContain('TTS')
  })

  it('memoryContext 插入长期记忆段', () => {
    const p = buildSystemPrompt('主人喜欢喝咖啡')
    expect(p).toContain('【长期记忆】')
    expect(p).toContain('主人喜欢喝咖啡')
  })

  it('extraModules 拼接额外模块', () => {
    const p = buildSystemPrompt(undefined, ['模块A', '模块B'])
    expect(p).toContain('模块A')
    expect(p).toContain('模块B')
  })

  it('reflectionContext 追加反思上下文', () => {
    const p = buildSystemPrompt(undefined, undefined, '反思内容')
    expect(p).toContain('反思内容')
  })

  it('identityContext 替换默认身份', () => {
    const p = buildSystemPrompt(undefined, undefined, undefined, '自定义身份')
    expect(p).toContain('自定义身份')
    expect(p).not.toContain('PROMPT_IDENTITY')
  })
})

// ─── estimateTokens ───

describe('estimateTokens', () => {
  it('null/undefined 返回 0', () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯 ASCII 按 bytes/4 估算', () => {
    expect(estimateTokens('hello world')).toBe(3)
  })

  it('CJK 占比 >30% 时按 bytes/2 估算', () => {
    const t = '你好世界啊abc'
    expect(estimateTokens(t)).toBe(9)
  })
})

// ─── estimateMessageTokens ───

describe('estimateMessageTokens', () => {
  it('纯文本消息只估算 content', () => {
    const m: Message = { role: 'user', content: 'hello' }
    expect(estimateMessageTokens(m)).toBe(estimateTokens('hello'))
  })

  it('含 tool_calls 时累加每个 call 的字段', () => {
    const m: Message = {
      role: 'assistant',
      content: 'doing',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    }
    const expected = estimateTokens('doing') + estimateTokens('call_1') + estimateTokens('read_file') + estimateTokens('{}')
    expect(estimateMessageTokens(m)).toBe(expected)
  })

  it('含 tool_call_id 时累加', () => {
    const m: Message = { role: 'tool', content: 'result', tool_call_id: 'call_1' }
    const expected = estimateTokens('result') + estimateTokens('call_1')
    expect(estimateMessageTokens(m)).toBe(expected)
  })
})

// ─── ConversationContext ───

describe('ConversationContext', () => {
  it('构造后 context 包含一条 system 消息', () => {
    const ctx = new ConversationContext()
    expect(ctx.context).toHaveLength(1)
    expect(ctx.context[0].role).toBe('system')
    expect(ctx.context[0].content).toBeTruthy()
  })

  it('customSystemPrompt 替换自动生成的 system prompt', () => {
    const ctx = new ConversationContext(undefined, 2000, undefined, '自定义提示词')
    expect(ctx.context[0].content).toBe('自定义提示词')
  })

  it('addUser 追加 user 消息', () => {
    const ctx = new ConversationContext()
    ctx.addUser('你好')
    expect(ctx.context).toHaveLength(2)
    expect(ctx.context[1]).toEqual({ role: 'user', content: '你好' })
  })

  it('addAssistant 追加 assistant 消息（纯文本）', () => {
    const ctx = new ConversationContext()
    ctx.addAssistant('回复')
    expect(ctx.context[1]).toEqual({ role: 'assistant', content: '回复' })
  })

  it('addAssistant 追加含 tool_calls 的 assistant 消息', () => {
    const ctx = new ConversationContext()
    const calls = [{ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } }]
    ctx.addAssistant('处理中', calls)
    expect(ctx.context[1].role).toBe('assistant')
    expect((ctx.context[1] as any).tool_calls).toHaveLength(1)
  })

  it('addToolCall 追加 tool 消息', () => {
    const ctx = new ConversationContext()
    ctx.addToolCall({ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' }, result: 'ok' })
    expect(ctx.context[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' })
  })

  it('getMessages 返回 context 引用', () => {
    const ctx = new ConversationContext()
    expect(ctx.getMessages()).toBe(ctx.context)
  })

  // ─── short term memory ───

  it('saveToShortTermMemory 提取最近的 user-assistant 对', () => {
    const ctx = new ConversationContext()
    ctx.addUser('你好')
    ctx.addAssistant('嗨')
    ctx.addUser('天气如何')
    ctx.addAssistant('很好')
    ctx.saveToShortTermMemory(3)
    const stm = ctx.getShortTermMemoryContext()
    expect(stm).toContain('用户: 天气如何')
    expect(stm).toContain('你: 很好')
    expect(stm).toContain('用户: 你好')
    expect(stm).toContain('你: 嗨')
  })

  it('无记忆时 getShortTermMemoryContext 返回空', () => {
    const ctx = new ConversationContext()
    expect(ctx.getShortTermMemoryContext()).toBe('')
  })

  it('saveToShortTermMemory 保留上限 keep 条', () => {
    const ctx = new ConversationContext()
    for (let i = 0; i < 10; i++) {
      ctx.addUser(`q${i}`)
      ctx.addAssistant(`a${i}`)
    }
    ctx.saveToShortTermMemory(3)
    expect(ctx.getShortTermMemoryContext().split('\n\n').length).toBeLessThanOrEqual(3)
  })

  // ─── trimToTokenBudget ───

  it('trimToTokenBudget 在预算内不裁剪', () => {
    const ctx = new ConversationContext(undefined, 99999)
    ctx.addUser('hi')
    ctx.addAssistant('hello')
    const beforeLen = ctx.context.length
    ctx.trimToTokenBudget(99999)
    expect(ctx.context.length).toBe(beforeLen)
  })

  it('trimToTokenBudget 超预算时丢弃最旧的 user 轮次', () => {
    const ctx = new ConversationContext(undefined, 50)
    for (let i = 0; i < 10; i++) {
      ctx.addUser('a'.repeat(100))
      ctx.addAssistant('b'.repeat(100))
    }
    const before = ctx.context.length
    ctx.trimToTokenBudget(50)
    expect(ctx.context.length).toBeLessThan(before)
    expect(ctx.context[0].role).toBe('system')
  })

  // ─── rebuildSystemPrompt ───

  it('rebuildSystemPrompt 更新 system prompt 但保留历史', () => {
    const ctx = new ConversationContext()
    ctx.addUser('你好')
    ctx.addAssistant('嗨')
    ctx.rebuildSystemPrompt('新记忆')
    expect(ctx.context[0].content).toContain('新记忆')
    expect(ctx.context[1].role).toBe('user')
    expect(ctx.context[2].role).toBe('assistant')
  })

  // ─── clear ───

  it('clear 清空 context（保留 short term memory）', () => {
    const ctx = new ConversationContext()
    ctx.addUser('你好')
    ctx.addAssistant('嗨')
    ctx.saveToShortTermMemory(5)
    ctx.clear(true)
    expect(ctx.context).toHaveLength(1)
    expect(ctx.getShortTermMemoryContext()).not.toBe('')
  })

  it('clear(false) 同时清空 short term memory', () => {
    const ctx = new ConversationContext()
    ctx.addUser('你好')
    ctx.addAssistant('嗨')
    ctx.saveToShortTermMemory(5)
    ctx.clear(false)
    expect(ctx.getShortTermMemoryContext()).toBe('')
  })

  // ─── trimOrphanedToolCalls ───

  describe('trimOrphanedToolCalls', () => {
    it('正常配对的 tool_calls 不被裁剪', () => {
      const ctx = new ConversationContext()
      ctx.addUser('查一下')
      ctx.addAssistant('查', [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }])
      ctx.addToolCall({ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' }, result: '结果' })
      ctx.trimOrphanedToolCalls()
      expect(ctx.context.length).toBe(4)
    })

    it('完全孤立的 assistant(tool_calls) 被移除', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '处理中', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      ]
      trimOrphanedToolCallsFrom(msgs)
      expect(msgs).toHaveLength(2)
      expect(msgs[1].role).toBe('user')
    })

    it('部分孤立的 tool_calls 被移除', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ]
      trimOrphanedToolCallsFrom(msgs)
      expect(msgs).toHaveLength(3)
      expect(msgs[1].tool_calls).toHaveLength(1)
      expect(msgs[1].tool_calls![0].id).toBe('c1')
    })

    it('部分孤立后 tool_calls 为空时删除整条', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: 'ok' },
      ]
      trimOrphanedToolCallsFrom(msgs)
      expect(msgs).toHaveLength(2)
    })
  })
})

describe('ConversationContext reasoning_content regressions', () => {
  it('estimateMessageTokens counts reasoning_content', () => {
    const m: Message = {
      role: 'assistant',
      content: 'visible reply',
      reasoning_content: 'hidden reasoning',
    }
    expect(estimateMessageTokens(m)).toBe(estimateTokens('visible reply') + estimateTokens('hidden reasoning'))
  })

  it('addAssistant preserves reasoning_content', () => {
    const ctx = new ConversationContext()
    ctx.addAssistant('reply', undefined, 'step-by-step reasoning')
    expect(ctx.context[1]).toEqual({
      role: 'assistant',
      content: 'reply',
      reasoning_content: 'step-by-step reasoning',
    })
  })
})

describe('buildSystemPrompt routing guidance', () => {
  it('teaches task requests to inspect or use tools before replying', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('task, code, file, log')
    expect(p).toContain('inspect or use tools before answering')
    expect(p).not.toContain('can answer directly, answer immediately')
  })
})
