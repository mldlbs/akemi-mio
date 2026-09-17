import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

function makeService() {
  const service = new LlmService()
  service.setConfig(
    'chat-key',
    'code-key',
    'chat-model',
    'code-model',
    'https://api.example.com/chat',
    'https://api.example.com/code',
  )
  return service
}

describe('LlmService chatWithTools 传输层异常的错误码', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('网络异常回传 NETWORK，而不是把原始异常报文当错误码', async () => {
    const service = makeService()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const result = await service.chatWithTools([{ role: 'user', content: 'hi' }] as any, 'req-net')

    expect(result.error).toBe('NETWORK')
  })

  it('回传的错误码必须是「码」形态，且不泄露底层异常细节', async () => {
    const service = makeService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNRESET 10.0.0.1:443')),
    )

    const result = await service.chatWithTools([{ role: 'user', content: 'hi' }] as any, 'req-net2')

    // 这个字段会经 ChatResult.error 跨 IPC 走到 renderer。若回传 String(err)，
    // 界面上就会出现「请求失败（connect ECONNRESET 10.0.0.1:443）」这种技术报文；
    // 而且 ErrorClassifier 认不出它 → 这类传输层失败不会计入熔断。
    expect(result.error).toBeTruthy()
    expect(result.error).not.toMatch(/\s/)
    expect(result.error).not.toContain('ECONNRESET')
    expect(result.error).not.toContain('10.0.0.1')
  })
})
