import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

describe('LlmService route classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the route prompt and returns the JSON reply', async () => {
    const service = new LlmService()
    service.setConfig('chat-key', 'code-key', 'chat-model', 'code-model', 'https://api.example.com/chat', 'https://api.example.com/code')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"route":"tool_first","confidence":0.91,"reason":"user asked to fix code"}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const result = await service.classifyRouteIntent(
      {
        userText: 'fix this bug',
        scene: 'code_debugging',
        hasProjectContext: true,
        recentToolNames: ['read_file'],
      },
      'req-route',
    )

    expect(result.reply).toContain('"route":"tool_first"')
    expect((fetch as any).mock.calls[0][0]).toBe('https://api.example.com/code')
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe('Bearer code-key')
    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.model).toBe('code-model')
    expect(body.stream).toBe(false)
    expect(body.temperature).toBe(0.1)
    expect(body.messages[0].content).toContain('JSON only')
    expect(body.messages[0].content).toContain('"scene":"code_debugging"')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'fix this bug' })
  })

  it('requires code credentials for route classification', async () => {
    const service = new LlmService()
    service.setConfig('chat-key', 'code-key', 'chat-model', 'code-model', 'https://api.example.com/chat', 'https://api.example.com/code')
    ;(service as any).codeApiKey = null
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await service.classifyRouteIntent(
      {
        userText: 'fix this bug',
        scene: 'code_debugging',
        hasProjectContext: true,
        recentToolNames: ['read_file'],
      },
      'req-no-code-key',
    )

    expect(result).toEqual({ error: 'NO_KEY' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps required tool choice to auto at the HTTP layer (non-stream)', async () => {
    const service = new LlmService()
    service.setConfig('chat-key', 'code-key', 'chat-model', 'code-model', 'https://api.example.com/chat', 'https://api.example.com/code')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await service.chatWithTools([{ role: 'user', content: 'fix it' } as any], 'req', 1000, undefined, undefined, undefined, {
      toolChoiceMode: 'required',
    })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.tool_choice).toBe('auto')
    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tools.length).toBeGreaterThan(0)
  })

  it('maps required tool choice to auto at the HTTP layer (stream)', async () => {
    const service = new LlmService()
    service.setConfig('chat-key', 'code-key', 'chat-model', 'code-model', 'https://api.example.com/chat', 'https://api.example.com/code')
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    await service.chatWithTools([{ role: 'user', content: 'fix it' } as any], 'req-stream', 1000, vi.fn(), undefined, undefined, {
      toolChoiceMode: 'required',
    })

    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.tool_choice).toBe('auto')
    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tools.length).toBeGreaterThan(0)
  })

  it('returns a clear error when required tool choice has no available tools', async () => {
    const service = new LlmService()
    service.setConfig('chat-key', 'code-key', 'chat-model', 'code-model', 'https://api.example.com/chat', 'https://api.example.com/code')
    service.setSchemaProvider({ getSchemas: () => [] } as any)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await service.chatWithTools(
      [{ role: 'user', content: 'fix it' } as any],
      'req-empty',
      1000,
      undefined,
      undefined,
      undefined,
      {
        toolChoiceMode: 'required',
      },
    )

    expect(result).toEqual({ error: 'NO_TOOLS_AVAILABLE' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
