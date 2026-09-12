import { describe, expect, it, vi } from 'vitest'
import { IntentRouter } from '@akemi-mio/intelligence/agent/routing/IntentRouter'
import { buildRouteClassificationPrompt, buildRouteRuntimePrompt } from '@akemi-mio/intelligence/agent/routing/prompts'

const input = {
  userText: 'help me look at this repo',
  scene: 'unknown',
  hasProjectContext: true,
  recentToolNames: ['read_file'],
}

describe('IntentRouter', () => {
  it('parses a semantic classifier decision and forwards the request id', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"tool_first","confidence":0.91,"reason":"user asked to inspect code","suggestedTools":["grep"]}',
      }),
    }

    const result = await new IntentRouter(classifier).route(input, 'req-route')

    expect(result).toEqual({
      route: 'tool_first',
      confidence: 0.91,
      reason: 'user asked to inspect code',
      suggestedTools: ['grep'],
    })
    expect(classifier.classifyRouteIntent).toHaveBeenCalledWith(input, 'req-route')
  })

  it.each([
    ['invalid JSON', { reply: 'not json' }],
    ['missing reply', {}],
    ['unknown route', { reply: '{"route":"maybe","confidence":0.8,"reason":"unclear"}' }],
    ['out-of-range confidence', { reply: '{"route":"tool_first","confidence":1.8,"reason":"too high"}' }],
    ['missing reason', { reply: '{"route":"tool_first","confidence":0.8}' }],
  ])('falls back safely for %s', async (_label, response) => {
    const classifier = { classifyRouteIntent: vi.fn().mockResolvedValue(response) }

    await expect(new IntentRouter(classifier).route(input)).resolves.toMatchObject({
      route: 'observe_first',
      confidence: 0,
    })
  })

  it('parses fenced JSON and ignores malformed suggestedTools', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '```json\n{"route":"observe_first","confidence":0.62,"reason":"inspect first","suggestedTools":["read_file",42]}\n```',
      }),
    }

    await expect(new IntentRouter(classifier).route(input)).resolves.toEqual({
      route: 'observe_first',
      confidence: 0.62,
      reason: 'inspect first',
    })
  })

  it('parses successCriteria when present and drops invalid values', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply:
          '{"route":"tool_required","confidence":0.9,"reason":"fix the repo","successCriteria":["tests pass","file updated"],"suggestedTools":["run_command","edit_file"]}',
      }),
    }

    const result = await new IntentRouter(classifier).route(input)
    expect(result.successCriteria).toEqual(['tests pass', 'file updated'])

    const bad = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"tool_required","confidence":0.9,"reason":"x","successCriteria":[42,""],"suggestedTools":[]}',
      }),
    }
    const result2 = await new IntentRouter(bad).route(input)
    expect(result2.successCriteria).toBeUndefined()
  })

  it('upgrades explicit execution requests to tool_required even when the classifier is conservative', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"observe_first","confidence":0.55,"reason":"inspect first"}',
      }),
    }
    const executionInput = {
      userText: '\u6211\u8bd5\u7740\u6d4b\u4e00\u4e0b\u670d\u52a1\u5668\u8fde\u901a\u6027\uff0c\u7a0d\u7b49\u3002',
      scene: 'unknown',
      hasProjectContext: true,
      recentToolNames: [],
    }

    expect(executionInput.userText).toContain('\u670d\u52a1\u5668')
    expect(executionInput.userText).toContain('\u8fde\u901a\u6027')
    expect((new IntentRouter(classifier) as any).requiresExplicitToolExecution(executionInput)).toBe(true)

    await expect(new IntentRouter(classifier).route(executionInput)).resolves.toMatchObject({
      route: 'tool_required',
      reason: expect.stringContaining('explicit execution'),
    })
  })

  it('treats a direct startup request in project context as tool execution', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"observe_first","confidence":0.55,"reason":"inspect first"}',
      }),
    }
    const startupInput = {
      userText: '启动看看',
      scene: 'task_execution',
      hasProjectContext: true,
      recentToolNames: [],
    }

    await expect(new IntentRouter(classifier).route(startupInput)).resolves.toMatchObject({
      route: 'tool_required',
      reason: expect.stringContaining('explicit execution'),
    })
  })

  it.each([
    ['active project context', { hasProjectContext: true, recentToolNames: [] }],
    ['recent tool context', { hasProjectContext: false, recentToolNames: ['read_file'] }],
  ])('downgrades classifier chat_only to observe_first for %s', async (_label, context) => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"chat_only","confidence":0.88,"reason":"classifier thought it was casual"}',
      }),
    }

    await expect(new IntentRouter(classifier).route({ ...input, ...context })).resolves.toMatchObject({
      route: 'observe_first',
      confidence: 0.88,
      reason: expect.stringContaining('chat_only downgraded'),
    })
  })

  it('upgrades an information-seeking request misclassified as chat_only to tool_required', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"chat_only","confidence":0.7,"reason":"classifier thought it was casual"}',
      }),
    }
    const newsInput = {
      userText: '\u6709\u4ec0\u4e48\u65b0\u95fb\u5417',
      scene: 'unknown',
      hasProjectContext: false,
      recentToolNames: [],
    }

    expect((new IntentRouter(classifier) as any).requiresWebInformation(newsInput)).toBe(true)

    await expect(new IntentRouter(classifier).route(newsInput)).resolves.toMatchObject({
      route: 'tool_required',
      confidence: 0.7,
      reason: expect.stringContaining('information request upgraded'),
    })
  })

  it('falls back to tool_required for information requests when the classifier is unavailable', async () => {
    const classifier = { classifyRouteIntent: vi.fn().mockRejectedValue(new Error('network failure')) }
    const newsInput = {
      userText: '\u5e2e\u6211\u67e5\u4e00\u4e0b\u4eca\u5929\u7684\u65b0\u95fb',
      scene: 'unknown',
      hasProjectContext: false,
      recentToolNames: [],
    }

    await expect(new IntentRouter(classifier).route(newsInput)).resolves.toMatchObject({
      route: 'tool_required',
      confidence: 0,
    })
  })

  it('does not upgrade plain casual chat that mentions no actionable cue', async () => {
    const classifier = {
      classifyRouteIntent: vi.fn().mockResolvedValue({
        reply: '{"route":"chat_only","confidence":0.95,"reason":"casual"}',
      }),
    }
    const casualInput = {
      userText: '\u4eca\u5929\u5fc3\u60c5\u4e0d\u9519\uff0c\u4f60\u5462\uff1f',
      scene: 'casual_chat',
      hasProjectContext: false,
      recentToolNames: [],
    }

    await expect(new IntentRouter(classifier).route(casualInput)).resolves.toMatchObject({
      route: 'chat_only',
    })
  })

  it('falls back to observe_first when classifier throws in active project context', async () => {
    const classifier = { classifyRouteIntent: vi.fn().mockRejectedValue(new Error('network failure')) }

    await expect(new IntentRouter(classifier).route(input)).resolves.toMatchObject({
      route: 'observe_first',
      confidence: 0,
    })
  })

  it('does not let scene analysis authorize chat when classification fails', async () => {
    const classifier = { classifyRouteIntent: vi.fn().mockResolvedValue({ error: 'timeout' }) }

    await expect(
      new IntentRouter(classifier).route({ ...input, scene: 'casual_chat', hasProjectContext: false, recentToolNames: [] }),
    ).resolves.toMatchObject({ route: 'observe_first' })
  })

  it('defaults to observation when the classifier throws or context is uncertain', async () => {
    const classifier = { classifyRouteIntent: vi.fn().mockRejectedValue(new Error('network failure')) }

    await expect(new IntentRouter(classifier).route({ ...input, hasProjectContext: false, recentToolNames: [] })).resolves.toMatchObject({
      route: 'observe_first',
    })
  })
})

describe('buildRouteClassificationPrompt', () => {
  it('requests concise JSON-only semantic route decisions', () => {
    const prompt = buildRouteClassificationPrompt(input)

    expect(prompt).toContain('JSON only')
    expect(prompt).toContain('chat_only')
    expect(prompt).toContain('observe_first')
    expect(prompt).toContain('tool_first')
    expect(prompt).toContain('tool_required')
    expect(prompt).toContain('testing connectivity')
    expect(prompt).toContain(input.userText)
    expect(prompt).toContain('"scene":"unknown"')
    expect(prompt).toContain('"hasProjectContext":true')
    expect(prompt).toContain('"recentToolNames":["read_file"]')
  })

  it('tells the classifier that tool-needing requests must not be chat_only', () => {
    const prompt = buildRouteClassificationPrompt(input)

    expect(prompt).toContain('news, weather, prices, stocks')
    expect(prompt).toContain('If any tool could help fulfill the request, do not choose chat_only')
    expect(prompt).toContain('web search')
  })
})

describe('buildRouteRuntimePrompt', () => {
  it('returns null for chat_only so tools stay optional', () => {
    expect(buildRouteRuntimePrompt({ route: 'chat_only', reason: 'casual' })).toBeNull()
  })

  it('instructs observe_first to call a read-only tool before answering', () => {
    const prompt = buildRouteRuntimePrompt({ route: 'observe_first', reason: 'inspect first' })

    expect(prompt).toContain('observe_first')
    expect(prompt).toContain('read-only tool')
  })

  it('instructs tool routes to actually call a tool instead of promising', () => {
    const prompt = buildRouteRuntimePrompt({ route: 'tool_required', reason: 'news search' })

    expect(prompt).toContain('tool_required')
    expect(prompt).toContain('MUST actually call a tool')
    expect(prompt).toContain('Do not just promise to do something')
  })
  it('lets information requests exceed the TTS length limit and prefer suggested tools', () => {
    const prompt = buildRouteRuntimePrompt({
      route: 'tool_required',
      reason: 'news search',
      suggestedTools: ['web_search', 'web_fetch'],
    })

    expect(prompt).toContain('information request')
    expect(prompt).toContain('exceed the usual 80-character TTS limit')
    expect(prompt).toContain('Prefer the most relevant tools among: web_search, web_fetch')
  })

  it('does not mention the TTS exception for non-information tool routes', () => {
    const prompt = buildRouteRuntimePrompt({ route: 'tool_required', reason: 'run build' })

    expect(prompt).not.toContain('information request')
  })
})
