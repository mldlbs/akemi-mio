import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('@akemi-mio/capabilities/tool/deps', () => ({
  getCredentialsManager: vi.fn(() => null),
}))

vi.mock('@akemi-mio/intelligence/llm/runtimeConfig', () => ({
  getRuntimeLlmConfig: vi.fn(() => ({
    chat: { apiKey: 'db-chat-key', apiUrl: 'https://db-chat.example/v1', model: 'db-chat-model' },
    code: { apiKey: 'db-code-key', apiUrl: 'https://db-code.example/v1', model: 'db-code-model' },
    text: { apiKey: 'db-text-key', apiUrl: 'https://db-text.example/v1', model: 'db-text-model' },
    vision: { apiKey: 'db-vision-key', apiUrl: 'https://db-vision.example/v1', model: 'db-vision-model' },
  })),
}))

describe('PolishTools runtime LLM config', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    delete process.env.LLM_KEY
  })

  it('uses resolved runtime text config for deep analysis', async () => {
    process.env.LLM_KEY = 'env-chat-key'

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"score":100,"issues":[],"suggestions":[]}' } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { polishStyleScanTool } = await import('@akemi-mio/capabilities/tool/definitions/PolishTools')
    const result = await polishStyleScanTool.handler({
      text: '测试文本',
      mode: 'deep',
    })

    expect(result.isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://db-text.example/v1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer db-text-key',
        }),
        body: expect.stringContaining('"model":"db-text-model"'),
      }),
    )
  })
})
