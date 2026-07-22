import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { extractContextFromSummaries } from '../../asr/AsrContextBuilder'
import { asrHotwordManager } from '../../asr/AsrHotwordManager'
import { memoryAsrHybridPipeline } from '../../asr/MemoryAsrHybridPipeline'
import { VoiceToolOrchestrator } from '../../tool/VoiceToolOrchestrator'
import { runVoiceMemoryShortcut } from '../../memory/VoiceMemoryShortcut'
import type { HandlerContext } from './context'

export function registerAsrHandlers({ agentService, ttsService }: HandlerContext): void {
  ipcMain.handle('asr:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const asr = agentService.getAsrService()
      if (!asr) throw new Error('ASR service not initialized')
      const memoryService = agentService.getMemoryService()
      let context: any = null
      if (memoryService) {
        const recentSummaries = memoryService.summary.getRecentFull(3)
        const lastUserText = memoryService.getLastUserText()
        context = extractContextFromSummaries(recentSummaries, lastUserText || undefined)
        asr.setConversationContext(context)
      }
      memoryAsrHybridPipeline.setAsrService(asr)
      if (memoryService) {
        memoryAsrHybridPipeline.setMemoryService(memoryService)
        try {
          const llm = agentService.getLlmService()
          memoryAsrHybridPipeline.setLlmProvider(llm)
        } catch { /* LLM not available */ }
      }
      const hybridResult = await memoryAsrHybridPipeline.run(audioBuffer, context, undefined, undefined)
      if (hybridResult.voiceEmotion) {
        const chatExecutor = agentService.getChatExecutor()
        if (chatExecutor) chatExecutor.setUserVoiceEmotion(hybridResult.voiceEmotion)
      }
      if (memoryService && hybridResult.text?.trim()) {
        memoryService.recordInteraction(hybridResult.text)
        memoryService.setLastUserText(hybridResult.text)
        asrHotwordManager.feedUserText(hybridResult.text)
        runVoiceMemoryShortcut(hybridResult.text.trim(), memoryService, ttsService)
          .catch((err: unknown) => log('WARN', 'voice_memory_shortcut_error', { error: String(err) }))
      }
      return {
        text: hybridResult.text,
        request_id: hybridResult.requestId,
        voiceEmotion: hybridResult.voiceEmotion,
        _hybrid: hybridResult.arbitrationTriggered ? {
          source: hybridResult.source, agreementLevel: hybridResult.agreementLevel, asrText: hybridResult.asrText,
        } : undefined,
      }
    } catch (err) {
      log('ERROR', 'asr_transcribe_failed', { error: String(err) })
      throw err
    }
  })

  // ASR hotwords
  ipcMain.handle('asr:toggle-hotwords', async (_event, enabled: boolean) => {
    const asr = agentService.getAsrService()
    if (asr) asr.toggleHotwordManager(enabled)
    asrHotwordManager.setEnabled(enabled)
    return { enabled: asrHotwordManager.isEnabled() }
  })

  ipcMain.handle('asr:hotword-state', async () => {
    const asr = agentService.getAsrService()
    if (asr) return asr.getHotwordManagerState()
    return { enabled: asrHotwordManager.isEnabled(), entryCount: 0, hotwords: [], totalInputs: 0 }
  })

  // ASR vocabulary
  ipcMain.handle('asr:vocabulary:list', async () => {
    const asr = agentService.getAsrService()
    if (!asr) return { words: [], domainStats: [], totalWords: 0 }
    return { words: asr.getLearnedVocabulary(), domainStats: asr.getVocabularyDomainStats(), totalWords: asrHotwordManager.getLongTermVocabSize(), enabled: asrHotwordManager.isEnabled() }
  })

  ipcMain.handle('asr:vocabulary:delete', async (_event, word: string) => {
    const asr = agentService.getAsrService()
    const removed = asr ? asr.deleteLearnedWord(word) : asrHotwordManager.deleteWord(word)
    if (removed && asr) asr.refreshContext()
    return { success: removed }
  })

  ipcMain.handle('asr:vocabulary:clear', async () => {
    const asr = agentService.getAsrService()
    if (asr) { asr.clearAllLearnedVocabulary(); asr.refreshContext() }
    else { asrHotwordManager.clearAllVocabulary() }
    return { success: true }
  })

  ipcMain.handle('asr:context:refresh', async () => {
    const asr = agentService.getAsrService()
    if (!asr) return { success: false, error: 'ASR not ready' }
    const memoryService = agentService.getMemoryService()
    if (memoryService) {
      const recentSummaries = memoryService.summary.getRecentFull(3)
      const lastUserText = memoryService.getLastUserText()
      asr.setConversationContext(extractContextFromSummaries(recentSummaries, lastUserText || undefined))
    } else { asr.refreshContext() }
    return { success: true }
  })

  // ASR hybrid pipeline
  ipcMain.handle('asr:hybrid:toggle', async (_event, enabled: boolean) => {
    memoryAsrHybridPipeline.setEnabled(enabled)
    log('INFO', 'asr_hybrid_toggle', { enabled })
    return { enabled: memoryAsrHybridPipeline.isReady() }
  })

  ipcMain.handle('asr:hybrid:state', async () => {
    const config = memoryAsrHybridPipeline.getConfig()
    return { enabled: config.enabled, ready: memoryAsrHybridPipeline.isReady(), config }
  })

  ipcMain.handle('asr:hybrid:updateConfig', async (_event, partial: Record<string, unknown>) => {
    memoryAsrHybridPipeline.updateConfig(partial as any)
    log('INFO', 'asr_hybrid_config_updated', { partial })
    return { success: true, config: memoryAsrHybridPipeline.getConfig() }
  })

  // Voice orchestrator
  const voiceOrchestrator = new VoiceToolOrchestrator()
  voiceOrchestrator.setToolCaller({
    callTool: async (name: string, args: Record<string, any>) => agentService.getMcpManager().callTool(name, args),
  })

  ipcMain.handle('voice:matchIntent', async (_event, text: string) => {
    try { return voiceOrchestrator.match({ text }) }
    catch (err) { log('ERROR', 'voice_match_intent_failed', { error: String(err) }); return { matched: false, fallbackText: text, error: String(err) } }
  })

  ipcMain.handle('voice:executeChain', async (_event, intent: string, slots: Record<string, string>) => {
    try { return await voiceOrchestrator.execute({ intent, slots }) }
    catch (err) { log('ERROR', 'voice_execute_chain_failed', { error: String(err) }); return { success: false, steps: [], summary: String(err) } }
  })
}
