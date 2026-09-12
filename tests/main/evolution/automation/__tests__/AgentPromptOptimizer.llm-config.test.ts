import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
const writeFileSyncMock = vi.fn()

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: writeFileSyncMock,
}))

vi.mock('@akemi-mio/intelligence/llm/runtimeConfig', () => ({
  getRuntimeLlmConfig: vi.fn(() => ({
    chat: { apiKey: 'db-chat-key', apiUrl: 'https://db-chat.example/v1', model: 'db-chat-model' },
    code: { apiKey: 'db-code-key', apiUrl: 'https://db-code.example/v1', model: 'db-code-model' },
    text: { apiKey: 'db-text-key', apiUrl: 'https://db-text.example/v1', model: 'db-text-model' },
    vision: { apiKey: 'db-vision-key', apiUrl: 'https://db-vision.example/v1', model: 'db-vision-model' },
  })),
}))

describe('AgentPromptOptimizer runtime LLM config', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
    delete process.env.LLM_KEY
  })

  it('uses resolved runtime code config for optimizer analysis requests', async () => {
    process.env.LLM_KEY = 'env-chat-key'

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n{"analysis":"ok","optimizations":[],"autoPatch":false}\n```',
            },
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { AgentPromptOptimizer } = await import('@akemi-mio/evolution/automation/AgentPromptOptimizer')
    const optimizer = new AgentPromptOptimizer()

    const result = await optimizer.execute({
      id: 'agent-problem-1',
      source: 'agent',
      severity: 'medium',
      title: 'agent degraded',
      description: 'success rate dropped',
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: 'detected degradation',
        snippet: '',
        metadata: {
          type: 'success_rate_drop',
          currentSuccessRate: '0.5',
          previousSuccessRate: '0.9',
        },
      },
    } as any)

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://db-code.example/v1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer db-code-key',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"model":"db-code-model"'),
      }),
    )
  })
})
