import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

const dsmlCall = [
  'Let me check that.',
  '<||DSML||tool_calls>',
  '<||DSML||invoke name="search">',
  '<||DSML||parameter name="query" string="true">bond fields</||DSML||parameter>',
  '</||DSML||invoke>',
  '</||DSML||tool_calls>',
].join('')

const dsmlDoubleFullwidthBars = [
  'Let me run that.',
  '<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>',
  '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="run_command">',
  '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="command" string="true">echo ok</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
  '</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
  '</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>',
].join('')

const dsmlToolOnly = [
  '<||DSML||tool_calls>',
  '<||DSML||invoke name="search">',
  '<||DSML||parameter name="query" string="true">bond fields</||DSML||parameter>',
  '</||DSML||invoke>',
  '</||DSML||tool_calls>',
].join('')

describe('LlmService DSML tool-call compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('converts a non-stream DSML response into executable tool calls', () => {
    const service = new LlmService()
    const messages: any[] = [{ role: 'user', content: 'check something' }]

    const result = (service as any)._parseToolResponse(
      {
        choices: [
          {
            message: {
              content: dsmlCall,
            },
          },
        ],
      },
      messages,
      'req-non-stream',
      0,
    )

    expect(result.reply).toBe('Let me check that.')
    expect(result.toolCalls).toEqual([
      {
        id: 'dsml_req-non-stream_0',
        name: 'search',
        arguments: { query: 'bond fields' },
      },
    ])
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].tool_calls[0].function.name).toBe('search')
  })

  it('returns a fallback reply when non-stream DSML tool calls are fully filtered and no text remains', () => {
    const service = new LlmService()
    const messages: any[] = [{ role: 'user', content: 'check something' }]

    const result = (service as any)._parseToolResponse(
      {
        choices: [
          {
            message: {
              content: dsmlToolOnly,
            },
          },
        ],
      },
      messages,
      'req-non-stream-filtered-empty',
      0,
      ['read_file'],
    )

    expect(result.toolCalls).toBeUndefined()
    expect(result.reply).toBe('（工具调用被过滤）')
  })

  it('preserves reasoning content on assistant tool-call messages', () => {
    const service = new LlmService()
    const messages: any[] = [{ role: 'user', content: 'run something' }]

    const result = (service as any)._parseToolResponse(
      {
        choices: [
          {
            message: {
              content: 'I will call a tool first.',
              reasoning_content: 'step-by-step reasoning',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'run_command', arguments: '{"command":"echo ok"}' },
                },
              ],
            },
          },
        ],
      },
      messages,
      'req-reasoning',
      0,
    )

    expect(result.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'run_command',
        arguments: { command: 'echo ok' },
      },
    ])
    expect(messages[1].reasoning_content).toBe('step-by-step reasoning')
  })

  it('falls back to a plain assistant reply when native tool calls are filtered out', () => {
    const service = new LlmService()
    const messages: any[] = [{ role: 'user', content: 'take a look' }]

    const result = (service as any)._parseToolResponse(
      {
        choices: [
          {
            message: {
              content: 'I should explain this first.',
              reasoning_content: 'keep this reasoning',
              tool_calls: [
                {
                  id: 'call-2',
                  type: 'function',
                  function: { name: 'run_command', arguments: '{"command":"echo ok"}' },
                },
              ],
            },
          },
        ],
      },
      messages,
      'req-native-filtered',
      0,
      ['search'],
    )

    expect(result.toolCalls).toBeUndefined()
    expect(result.reply).toBe('I should explain this first.')
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'I should explain this first.',
      reasoning_content: 'keep this reasoning',
    })
  })

  it('converts streamed DSML content into tool calls before exposing it as a reply', async () => {
    const service = new LlmService()
    service.setConfig('test-key', 'test-key')
    const messages: any[] = [{ role: 'user', content: 'check something' }]
    const onChunk = vi.fn()
    const encoder = new TextEncoder()
    const body = [`data: ${JSON.stringify({ choices: [{ delta: { content: dsmlCall } }] })}\n\n`, 'data: [DONE]\n\n'].join('')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const result = await service.chatWithTools(messages, 'req-stream', 1000, onChunk)

    expect(result.reply).toBe('Let me check that.')
    expect(result.toolCalls?.[0]).toEqual({
      id: 'dsml_req-stream_0',
      name: 'search',
      arguments: { query: 'bond fields' },
    })
    expect(onChunk).toHaveBeenCalledWith('Let me check that.')
    expect(onChunk).not.toHaveBeenCalledWith(expect.stringContaining('DSML'))
  })

  it('drops DSML tool calls that are not allowed by the current tool filter', async () => {
    const service = new LlmService()
    service.setConfig('test-key', 'test-key')
    const messages: any[] = [{ role: 'user', content: 'show me' }]
    const onChunk = vi.fn()
    const encoder = new TextEncoder()
    const body = [`data: ${JSON.stringify({ choices: [{ delta: { content: dsmlDoubleFullwidthBars } }] })}\n\n`, 'data: [DONE]\n\n'].join(
      '',
    )

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const result = await service.chatWithTools(messages, 'req-filtered', 1000, onChunk, undefined, ['search'])

    expect(result.toolCalls).toBeUndefined()
    expect(result.reply).toBe('Let me run that.')
  })

  it('returns a fallback reply when streamed DSML tool calls are fully filtered and no text remains', async () => {
    const service = new LlmService()
    service.setConfig('test-key', 'test-key')
    const messages: any[] = [{ role: 'user', content: 'show me' }]
    const encoder = new TextEncoder()
    const body = [`data: ${JSON.stringify({ choices: [{ delta: { content: dsmlToolOnly } }] })}\n\n`, 'data: [DONE]\n\n'].join('')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const result = await service.chatWithTools(messages, 'req-filtered-empty', 1000, vi.fn(), undefined, ['read_file'])

    expect(result.toolCalls).toBeUndefined()
    expect(result.reply).toBe('（工具调用被过滤）')
  })

  it('converts real double-fullwidth-bar DSML content into tool calls', () => {
    const service = new LlmService()
    const messages: any[] = [{ role: 'user', content: 'run something' }]

    const result = (service as any)._parseToolResponse(
      {
        choices: [
          {
            message: {
              content: dsmlDoubleFullwidthBars,
            },
          },
        ],
      },
      messages,
      'req-real-dsml',
      0,
    )

    expect(result.reply).toBe('Let me run that.')
    expect(result.toolCalls).toEqual([
      {
        id: 'dsml_req-real-dsml_0',
        name: 'run_command',
        arguments: { command: 'echo ok' },
      },
    ])
  })
})
