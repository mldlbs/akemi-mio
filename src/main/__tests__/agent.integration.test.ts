import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentService } from '../agent/AgentService'
import { LlmService } from '../llm/LlmService'
import { AsrService } from '../asr/AsrService'
import { TtsService } from '../tts/TtsService'
import { WhisperGpuEngine } from '../asr/WhisperGpuEngine'
import { BaiduEngine } from '../asr/BaiduEngine'

describe('AgentService integration', () => {
  let agent: AgentService
  let ttsService: TtsService
  let llmService: LlmService
  let ttsState: Record<string, unknown>

  beforeEach(() => {
    ttsState = {}
    ttsService = new TtsService((s) => Object.assign(ttsState, s))
    vi.spyOn(ttsService as any, 'speakInternal').mockResolvedValue(undefined)
    vi.spyOn(ttsService, 'flushBuffer')

    llmService = new LlmService()
    llmService.setConfig('test-key')

    const gpuEngine = new WhisperGpuEngine()
    const baiduEngine = new BaiduEngine()
    const asrService = new AsrService(gpuEngine, baiduEngine)
    agent = new AgentService(llmService, asrService, ttsService)
  })

  it('full pipeline: LLM stream → TTS flush', async () => {
    // Mock chatStream that calls onChunk for each piece AND adds to context
    vi.spyOn(llmService, 'chatStream').mockImplementation(async (_text, ctx, onChunk) => {
      ctx.addUser(_text)
      onChunk?.('你')
      onChunk?.('好')
      onChunk?.('，')
      onChunk?.('今')
      onChunk?.('天')
      onChunk?.('过')
      onChunk?.('得')
      onChunk?.('怎')
      onChunk?.('么')
      onChunk?.('样')
      const reply = '你好，今天过得怎么样？'
      ctx.addAssistant(reply)
      return { reply }
    })

    const result = await agent.processTextInput('测试')

    expect(result.reply).toBe('你好，今天过得怎么样？')
    expect(llmService.chatStream).toHaveBeenCalledTimes(1)
    expect(ttsService.flushBuffer).toHaveBeenCalledTimes(1)
  })

  it('LLM retry works with onChunk mock', async () => {
    let calls = 0
    vi.spyOn(llmService, 'chatStream').mockImplementation(async (_text, ctx, onChunk) => {
      calls++
      if (calls === 1) return { error: 'NETWORK' }
      ctx.addUser(_text)
      const reply = '重试成功'
      ctx.addAssistant(reply)
      return { reply }
    })

    const result = await agent.processTextInput('测试')

    expect(result.reply).toBe('重试成功')
    expect(llmService.chatStream).toHaveBeenCalledTimes(2)
  })

  it('context management: add and trim', () => {
    const ctx = agent.getContext()
    ctx.addUser('消息1')
    ctx.addAssistant('回复1')
    ctx.addUser('消息2')
    ctx.addAssistant('回复2')
    const msgs = ctx.getMessages()
    expect(msgs.length).toBeGreaterThan(2)
    expect(msgs[0].role).toBe('system')
  })
})
