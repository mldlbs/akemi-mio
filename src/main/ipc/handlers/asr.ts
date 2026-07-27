import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../../logger/Logger'
import { extractContextFromSummaries, getEntityExtractorStats } from '../../asr/AsrContextBuilder'
import { asrHotwordManager } from '../../asr/AsrHotwordManager'
import { memoryAsrHybridPipeline } from '../../asr/MemoryAsrHybridPipeline'
import { VoiceToolOrchestrator } from '../../tool/VoiceToolOrchestrator'
import { runVoiceMemoryShortcut } from '../../memory/VoiceMemoryShortcut'
import { voiceOdeSession, McpOdeSolverInvoker } from '../../audio/VoiceOdeSession'
import { eventBus } from '../../core/EventBus'
import { userSpeechProfileTracker } from '../../tts/UserSpeechProfileTracker'
import type { HandlerContext } from './context'
import { asrBehaviorPredictor } from '../../asr/AsrBehaviorPredictor'

export function registerAsrHandlers({ agentService, ttsService }: HandlerContext): void {
  ipcMain.handle('asr:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      // 发射语音录制事件（供 BehaviorActionCounter 计数）
      eventBus.emit('voice.recording.started', {})

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

      // ── 记录语音交互特征（用户语速画像） ──
      // 从 PCM Int16 @ 16kHz 计算音频时长
      let audioDurationMs = 0
      if (hybridResult.text?.trim()) {
        const pcmSamples = new Int16Array(audioBuffer)
        audioDurationMs = Math.round((pcmSamples.length / 16000) * 1000)
        userSpeechProfileTracker.recordInteraction(hybridResult.text.trim(), audioDurationMs)
      }

      if (hybridResult.voiceEmotion) {
        const chatExecutor = agentService.getChatExecutor()
        if (chatExecutor) chatExecutor.setUserVoiceEmotion(hybridResult.voiceEmotion)
      }

      // ══════════════════════════════════════════
      //  记忆唤醒语音热词检测
      // ══════════════════════════════════════════

      let hotwordHits: Array<{ hotword: string; count: number }> = []
      let memoryRecallResults: string[] = []
      let hotwordTaggedText = hybridResult.text

      if (memoryService && hybridResult.text?.trim()) {
        // 1. 记录交互
        memoryService.recordInteraction(hybridResult.text)
        memoryService.setLastUserText(hybridResult.text)
        asrHotwordManager.feedUserText(hybridResult.text)

        // 2. 执行语音记忆快捷操作（原有流程）
        runVoiceMemoryShortcut(hybridResult.text.trim(), memoryService, ttsService)
          .catch((err: unknown) => log('WARN', 'voice_memory_shortcut_error', { error: String(err) }))

        // 3. 检测热词命中 — 在 ASR 识别文本中搜索记忆实体和热词
        hotwordHits = asr.detectHotwordHits(hybridResult.text)

        // 4. 当有热词命中时，触发 Memory 检索和回放
        if (hotwordHits.length > 0) {
          const hitWords = hotwordHits.map(h => h.hotword)

          // 4a. 生成带标记的文本：在热词前后添加标记
          hotwordTaggedText = hybridResult.text
          for (const hw of hitWords) {
            const escaped = hw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            hotwordTaggedText = hotwordTaggedText.replace(
              new RegExp(escaped, 'gi'),
              (match) => `[[MEM:${match}]]`,
            )
          }

          // 4b. 从 VectorMemory 检索相关记忆
          try {
            const queryText = hitWords.join(' ')
            const vectorResults = memoryService.vector.querySync(queryText, 5)

            // 从 user_fact 记忆中搜索匹配的内容
            const entryResults = memoryService.getEntries()
              .filter(e => e.type === 'user_fact')
              .filter(e => hitWords.some(hw =>
                e.content.toLowerCase().includes(hw.toLowerCase()) ||
                (e.topics || []).some(t => t.toLowerCase().includes(hw.toLowerCase())),
              ))
              .sort((a, b) => b.behaviorScore - a.behaviorScore)
              .slice(0, 3)

            // 4c. 收集检索结果
            memoryRecallResults = [
              ...vectorResults.slice(0, 3),
              ...entryResults.map(e => e.content),
            ].filter(Boolean).slice(0, 5)

            log('INFO', 'asr_hotword_memory_recall', {
              hotword_hits: hitWords,
              vector_results: vectorResults.length,
              entry_results: entryResults.length,
              recall_count: memoryRecallResults.length,
            })

            // 4d. 通过 TTS 播报记忆回放（简短提示）
            if (memoryRecallResults.length > 0 && ttsService) {
              const ttsHint = `我想起来了，关于${hitWords.slice(0, 2).join('和')}，我记得${memoryRecallResults[0].slice(0, 60)}。`
              ttsService.speak(ttsHint).catch(() => {})
            }
          } catch (recallErr) {
            log('WARN', 'asr_hotword_memory_recall_failed', {
              error: String(recallErr),
              hotwords: hitWords,
            })
          }
        }
      }

      return {
        text: hybridResult.text,
        request_id: hybridResult.requestId,
        voiceEmotion: hybridResult.voiceEmotion,
        hotwordHits,
        hotwordTaggedText: hotwordHits.length > 0 ? hotwordTaggedText : undefined,
        memoryRecallResults: memoryRecallResults.length > 0 ? memoryRecallResults : undefined,
        hasHotwordTrigger: hotwordHits.length > 0,
        audioDurationMs,
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

  // ══════════════════════════════════════════
  //  记忆实体提取器
  // ══════════════════════════════════════════

  ipcMain.handle('asr:entities:stats', async () => {
    try {
      return { stats: getEntityExtractorStats() }
    } catch (err) {
      return { stats: null, error: String(err) }
    }
  })

  ipcMain.handle('asr:entities:feed', async () => {
    const asr = agentService.getAsrService()
    const memoryService = agentService.getMemoryService()
    if (!asr || !memoryService) return { success: false, error: 'ASR or Memory not ready' }
    const entries = memoryService.getEntries()
    const interactions = memoryService.interactionTracker?.getAll()
    asr.feedMemoryEntries(entries, interactions)
    return { success: true, entriesCount: entries.length, interactionCount: interactions?.length ?? 0 }
  })

  ipcMain.handle('asr:hotword:recall', async (_event, text: string) => {
    // 手动触发热词 Memory 回放（供 UI 使用）
    const asr = agentService.getAsrService()
    const memoryService = agentService.getMemoryService()
    if (!asr || !memoryService || !text?.trim()) {
      return { hits: [], recalled: [] }
    }
    const hits = asr.detectHotwordHits(text)
    const hitWords = hits.map(h => h.hotword)
    let recalled: string[] = []
    if (hitWords.length > 0) {
      recalled = memoryService.vector.querySync(hitWords.join(' '), 5).slice(0, 5)
      log('INFO', 'asr_hotword_manual_recall', {
        hits: hitWords,
        recalled: recalled.length,
      })
    }
    return { hits, recalled }
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

  // ASR behavior prediction
  ipcMain.handle('asr:behavior:prediction', async () => {
    try {
      const prediction = asrBehaviorPredictor.getPrediction()
      if (!prediction.isValid) {
        return {
          isValid: false,
          note: '样本不足，正在收集用户语音特征...',
          sampleCount: prediction.hesitation.sampleCount,
        }
      }
      return {
        isValid: true,
        hesitation: {
          overallFillerRatio: prediction.hesitation.overallFillerRatio,
          isHighHesitation: prediction.hesitation.isHighHesitation,
          topFillers: prediction.hesitation.topFillers,
          recommendedConfidenceAdjust: prediction.hesitation.recommendedConfidenceAdjust,
          sampleCount: prediction.hesitation.sampleCount,
        },
        boostedTerms: prediction.boostedTerms,
        promptBoosts: prediction.promptBoosts,
        globalConfidenceAdjust: prediction.globalConfidenceAdjust,
        failurePatterns: prediction.failurePatterns.slice(0, 10),
        description: asrBehaviorPredictor.getHesitationDescription(),
        timestamp: prediction.timestamp,
      }
    } catch (err) {
      log('ERROR', 'asr_behavior_prediction_failed', { error: String(err) })
      return { isValid: false, error: String(err) }
    }
  })

  ipcMain.handle('asr:behavior:stats', async () => {
    const stats = asrBehaviorPredictor.getStats()
    const optimization = asrBehaviorPredictor.getAsrOptimization()
    return {
      totalRecords: stats.totalRecords,
      hasValidPrediction: stats.hasValidPrediction,
      hesitationMode: optimization.hesitationMode,
      hotwordBoosts: optimization.hotwordBoosts.length,
      promptBoost: optimization.promptBoost.slice(0, 100),
      confidenceAdjust: optimization.confidenceAdjust,
      description: asrBehaviorPredictor.getHesitationDescription(),
    }
  })

  ipcMain.handle('asr:behavior:reset', async () => {
    asrBehaviorPredictor.reset()
    log('INFO', 'asr_behavior_predictor_reset_by_ipc')
    return { success: true }
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

  // ── ODE 求解会话 ──

  /** 向所有渲染进程发送 ODE 状态事件 */
  function emitOdeState(): void {
    const wins = BrowserWindow.getAllWindows()
    const data = {
      sessionId: voiceOdeSession.sessionId,
      state: voiceOdeSession.state,
      hasSolution: voiceOdeSession.lastSolution !== null,
      solution: voiceOdeSession.lastSolution ? {
        xFinal: voiceOdeSession.lastSolution.xFinal,
        yFinal: voiceOdeSession.lastSolution.yFinal,
        method: voiceOdeSession.lastSolution.method,
        steps: voiceOdeSession.lastSolution.steps,
      } : undefined,
    }
    for (const win of wins) {
      try { win.webContents.send('ode:state-change', data) } catch { /* ignore */ }
    }
  }

  // 初始化 ODE 会话求解器（通过 MCP 调用 solve_ode 工具）
  const odeSolverInvoker = new McpOdeSolverInvoker({
    callTool: async (name: string, args: Record<string, any>) => agentService.getMcpManager().callTool(name, args),
  })
  voiceOdeSession.setSolver(odeSolverInvoker)

  // 注册 ODE 会话事件监听（日志 + TTS 回调 + 渲染进程通知）
  voiceOdeSession.on((event) => {
    switch (event.type) {
      case 'state_change':
        log('INFO', 'ode_session_state_change', { from: event.from, to: event.to })
        emitOdeState()
        break
      case 'clarify_needed':
        log('INFO', 'ode_session_clarify', { prompts: event.prompts, missing: event.missingFields })
        // 通过 TTS 播报追问
        if (event.prompts.length > 0 && ttsService) {
          const prompt = event.prompts[0]
          try { ttsService.speak(prompt) } catch { /* TTS not available */ }
        }
        break
      case 'solve_complete': {
        log('INFO', 'ode_session_solve_complete', { yFinal: event.yFinal, xFinal: event.xFinal })
        emitOdeState()
        // 通过 TTS 播报关键结果
        if (ttsService) {
          const ttsText = `求解完成。当 x 等于 ${event.xFinal} 时，y 约等于 ${event.yFinal.toFixed(4)}。`
          try { ttsService.speak(ttsText) } catch { /* TTS not available */ }
        }
        break
      }
      case 'solve_error':
        log('ERROR', 'ode_session_solve_error', { error: event.error })
        emitOdeState()
        if (ttsService) {
          const ttsText = `求解出错：${event.error.slice(0, 60)}`
          try { ttsService.speak(ttsText) } catch { /* TTS not available */ }
        }
        break
      case 'session_end':
        log('INFO', 'ode_session_end', { reason: event.reason })
        emitOdeState()
        break
    }
  })

  /**
   * 语音 ODE 求解：启动/续传会话。
   * 将 ASR 转写文本送入 ODE 会话，自动解析并执行求解。
   * 返回会话状态和可能的求解结果/TTS 文本。
   */
  ipcMain.handle('voice:ode:feed', async (_event, text: string) => {
    try {
      if (!text || !text.trim()) {
        return { active: voiceOdeSession.isActive, state: voiceOdeSession.state }
      }

      // 如果会话未激活，检查文本是否匹配 ODE 意图
      if (!voiceOdeSession.isActive) {
        const matchResult = voiceOrchestrator.match({ text })
        if (!matchResult.matched || matchResult.intent?.name !== 'solve_ode') {
          return { active: false, matched: false }
        }
        // 启动 ODE 会话
        voiceOdeSession.start(text)
      } else {
        // 会话已激活，继续输入
        voiceOdeSession.feed(text)
      }

      const sessionState = voiceOdeSession.state
      const parsed = voiceOdeSession.parsed
      const lastSolution = voiceOdeSession.lastSolution

      return {
        active: voiceOdeSession.isActive,
        state: sessionState,
        parsed: {
          equation: parsed.equation,
          initialCondition: parsed.initialCondition,
          interval: parsed.interval,
          method: parsed.method,
          stepSize: parsed.stepSize,
        },
        solution: lastSolution ? {
          xFinal: lastSolution.xFinal,
          yFinal: lastSolution.yFinal,
          method: lastSolution.method,
          steps: lastSolution.steps,
          plotPath: lastSolution.plotPath,
          analyticalNote: lastSolution.analyticalNote,
        } : null,
        sessionId: voiceOdeSession.sessionId,
      }
    } catch (err) {
      log('ERROR', 'ode_session_feed_failed', { error: String(err) })
      return { active: false, error: String(err) }
    }
  })

  /**
   * 语音 ODE 求解：获取会话状态。
   */
  ipcMain.handle('voice:ode:state', async () => {
    return {
      active: voiceOdeSession.isActive,
      state: voiceOdeSession.state,
      sessionId: voiceOdeSession.sessionId,
      parsed: voiceOdeSession.parsed,
      hasSolution: voiceOdeSession.lastSolution !== null,
    }
  })

  /**
   * 语音 ODE 求解：重置/取消会话。
   */
  ipcMain.handle('voice:ode:reset', async () => {
    voiceOdeSession.reset()
    log('INFO', 'ode_session_reset_by_ipc')
    return { success: true }
  })
}
