import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}))

import { AgentService } from '../agent/AgentService'
import { LlmService } from '../llm/LlmService'
import { AsrService } from '../asr/AsrService'
import { TtsService } from '../tts/TtsService'
import { WhisperGpuEngine } from '../asr/WhisperGpuEngine'
import { BaiduEngine } from '../asr/BaiduEngine'
import { initDatabase, closeDatabase } from '../db/connection'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'

describe('AgentService integration', () => {
  let agent: AgentService
  let ttsService: TtsService
  let llmService: LlmService
  let ttsState: Record<string, unknown>

  beforeEach(async () => {
    await initDatabase()
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

  afterEach(() => {
    closeDatabase()
    const dbFile = join(process.cwd(), 'test-user-data', 'akemi-mio.db')
    if (existsSync(dbFile)) unlinkSync(dbFile)
  })

  it('full pipeline: tool loop → TTS flush', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({
      reply: '你好，今天过得怎么样？',
    })

    const result = await agent.processTextInput('测试')

    expect(result.reply).toBe('你好，今天过得怎么样？')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(1)
    expect(ttsService.flushBuffer).toHaveBeenCalledTimes(1)
  })

  it('LLM error via tool loop', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ error: 'NETWORK' })

    const result = await agent.processTextInput('测试')

    // toolLoop returns immediately on LLM error (retry is inside chatWithTools)
    expect(result.reply).toContain('遇到错误')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(1)
  })

  it('handles tool call loop', async () => {
    let calls = 0
    vi.spyOn(llmService, 'chatWithTools').mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return {
          toolCalls: [
            {
              id: 'call_1',
              name: 'list_files' as const,
              arguments: { path: '.' },
            },
          ],
        }
      }
      return { reply: '文件已列出' }
    })

    const result = await agent.processTextInput('列出文件')

    expect(result.reply).toBe('文件已列出')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(2)
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
