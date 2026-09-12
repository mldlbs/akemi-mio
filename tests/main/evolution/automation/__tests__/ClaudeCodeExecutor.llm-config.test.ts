import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ClaudeCodeExecutor runtime LLM config', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    delete process.env.LLM_KEY
  })

  it('uses packaged credential-backed code model and key instead of env fallback', async () => {
    process.env.LLM_KEY = 'env-chat-key'

    const queryMock = vi.fn(async function* () {
      yield { type: 'text', text: '<result>SUCCESS</result>' }
    })

    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: queryMock,
    }))

    vi.doMock('@akemi-mio/intelligence/llm/runtimeConfig', () => ({
      getRuntimeLlmConfig: vi.fn(() => ({
        chat: { apiKey: 'db-chat-key', apiUrl: 'https://db-chat.example/v1', model: 'db-chat-model' },
        code: { apiKey: 'db-code-key', apiUrl: 'https://db-code.example/v1', model: 'db-code-model' },
        text: { apiKey: 'db-text-key', apiUrl: 'https://db-text.example/v1', model: 'db-text-model' },
        vision: { apiKey: 'db-vision-key', apiUrl: 'https://db-vision.example/v1', model: 'db-vision-model' },
      })),
    }))

    const { ClaudeCodeExecutor } = await import('@akemi-mio/evolution/automation/ClaudeCodeExecutor')
    const executor = new ClaudeCodeExecutor()

    const result = await executor.execute({
      id: 'problem-1',
      source: 'tsc',
      severity: 'error',
      title: 'bad type',
      description: 'fix a type issue',
      file: 'src/example.ts',
      line: 3,
      estimatedCostChars: 10,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: '',
        snippet: '',
        metadata: {},
      },
    })

    expect(result.success).toBe(true)
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0]?.[0]).toMatchObject({
      options: {
        env: expect.objectContaining({
          ANTHROPIC_AUTH_TOKEN: 'db-code-key',
          ANTHROPIC_MODEL: 'db-code-model',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'db-code-model',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'db-code-model',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'db-code-model',
          CLAUDE_CODE_SUBAGENT_MODEL: 'db-code-model',
        }),
      },
    })
  })
})
