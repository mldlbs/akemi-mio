import { BrowserWindow } from 'electron'
import { log, createRequestId } from '../logger/Logger'
import { LlmService } from '../llm/LlmService'
import { AsrService } from '../asr/AsrService'
import { TtsService } from '../tts/TtsService'
import { ConversationContext } from './context'
import { MemoryService } from '../memory/MemoryService'
import { ChatResult } from '../llm/types'
import { IntentResult, IntentHandler } from './intent/types'

export class AgentService {
  private llmService: LlmService
  private asrService: AsrService
  private ttsService: TtsService
  private memoryService: MemoryService | null = null
  private context: ConversationContext
  private mainWindow: BrowserWindow | null = null
  private intentHandlers: Map<string, IntentHandler> = new Map()

  constructor(llmService: LlmService, asrService: AsrService, ttsService: TtsService) {
    this.llmService = llmService
    this.asrService = asrService
    this.ttsService = ttsService
    this.context = new ConversationContext()
    this.registerDefaultHandlers()
  }

  registerIntentHandler(handler: IntentHandler): void {
    this.intentHandlers.set(handler.intent, handler)
  }

  private registerDefaultHandlers(): void {
    this.registerIntentHandler({
      intent: 'open_pump',
      description: '开启泵站',
      execute: (slots) => `已开启${slots.pump_id || '指定泵站'}`
    })
    this.registerIntentHandler({
      intent: 'close_pump',
      description: '关闭泵站',
      execute: (slots) => `已关闭${slots.pump_id || '指定泵站'}`
    })
    this.registerIntentHandler({
      intent: 'query_status',
      description: '查询状态',
      execute: (slots) => `${slots.target || '系统'}运行正常，各项指标在正常范围内。`
    })
    this.registerIntentHandler({
      intent: 'report_alarm',
      description: '报告报警',
      execute: (slots) => `收到${slots.alarm_type || '报警'}${slots.location ? '，位置：' + slots.location : ''}，已通知值班人员处理。`
    })
  }

  private async classifyIntent(text: string, requestId?: string): Promise<IntentResult | null> {
    const result = await this.llmService.classifyIntent(text, requestId)
    if (result.error || !result.reply) return null
    try {
      const parsed = JSON.parse(result.reply) as IntentResult
      log('INFO', 'intent_parsed', { intent: parsed.intent, slots: parsed.slots })
      if (!parsed.intent || typeof parsed.intent !== 'string') return null
      parsed.slots = parsed.slots || {}
      return parsed
    } catch {
      log('WARN', 'intent_parse_failed', { raw: result.reply })
      return null
    }
  }

  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService
    const memCtx = memoryService.getFormattedContext()
    if (memCtx) {
      this.context = new ConversationContext(memCtx)
      log('INFO', 'memory_injected', { memory: memCtx })
    }
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  getContext(): ConversationContext {
    return this.context
  }

  clearContext(): void {
    this.memoryService?.flush()
    this.context.clear()
  }

  getLlmService(): LlmService {
    return this.llmService
  }

  getAsrService(): AsrService {
    return this.asrService
  }

  getTtsService(): TtsService {
    return this.ttsService
  }

  getMemoryService(): MemoryService | null {
    return this.memoryService
  }

  private async executeIntentCommand(intent: IntentResult, requestId: string): Promise<ChatResult> {
    const handler = this.intentHandlers.get(intent.intent)
    if (!handler) return { error: 'UNKNOWN_INTENT' }
    const reply = await handler.execute(intent.slots)
    this.mainWindow?.webContents.send('ai:chunk', reply)
    log('INFO', 'intent_executed', { request_id: requestId, intent: intent.intent, slots: intent.slots, reply })
    return { reply }
  }

  async processTextInput(text: string, requestId?: string): Promise<ChatResult> {
    const rid = requestId || createRequestId()
    const t0 = Date.now()
    try {
      this.memoryService?.recordInteraction()

      const result = await this.llmService.chatStream(text, this.context, (chunk) => {
        this.mainWindow?.webContents.send('ai:chunk', chunk)
        this.ttsService.addChunk(chunk)
      }, rid)
      this.ttsService.flushBuffer()
      // LLM 失败时自动重试一次
      if (result.error && !result.reply) {
        log('WARN', 'llm_retry', { request_id: rid, error: result.error })
        const retry = await this.llmService.chatStream(text, this.context, (chunk) => {
          this.mainWindow?.webContents.send('ai:chunk', chunk)
          this.ttsService.addChunk(chunk)
        }, rid)
        this.ttsService.flushBuffer()
        log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: retry.reply?.length || 0, retried: true })
        return retry
      }
      log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: result.reply?.length || 0 })
      return result
    } catch (err) {
      log('ERROR', 'chat_handler_error', { request_id: rid, error: String(err) })
      return { error: 'INTERNAL' }
    }
  }
}
