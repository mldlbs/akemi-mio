import { ipcMain, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { extractContextFromSummaries } from '@akemi-mio/audio/AsrContextBuilder'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'
import { memoryAsrHybridPipeline } from '@akemi-mio/audio/MemoryAsrHybridPipeline'
import { VoiceToolOrchestrator } from '@akemi-mio/capabilities/tool/VoiceToolOrchestrator'
import { voiceConfirmationSession } from '@akemi-mio/capabilities/tool/VoiceConfirmationSession'
import { voiceIntentLlmParser } from '@akemi-mio/capabilities/tool/VoiceIntentLlmParser'
import { runVoiceMemoryShortcut } from '@akemi-mio/intelligence-memory/VoiceMemoryShortcut'
import { voiceOdeSession, McpOdeSolverInvoker } from '@akemi-mio/audio/VoiceOdeSession'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { userSpeechProfileTracker } from '@akemi-mio/audio/UserSpeechProfileTracker'
import type { HandlerContext } from './context'

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
        } catch {
          /* LLM not available */
        }
      }
      const hybridResult = await memoryAsrHybridPipeline.run(audioBuffer, context, undefined, undefined)

      // ── 记录语音交互特征（用户语速画像 + 声学画像） ──
      // 从 PCM Int16 @ 16kHz 计算音频时长
      let audioDurationMs = 0
      if (hybridResult.text?.trim()) {
        const pcmSamples = new Int16Array(audioBuffer)
        audioDurationMs = Math.round((pcmSamples.length / 16000) * 1000)
        // 传入 VoiceEmotion 声学特征（如可用），用于声学画像追踪
        userSpeechProfileTracker.recordInteraction(
          hybridResult.text.trim(),
          audioDurationMs,
          hybridResult.voiceEmotion
            ? {
                energy: hybridResult.voiceEmotion.features.energy,
                pitchHz: hybridResult.voiceEmotion.features.pitchHz,
                speechRate: hybridResult.voiceEmotion.features.speechRate,
                silenceRatio: hybridResult.voiceEmotion.features.silenceRatio,
              }
            : undefined,
        )
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
        runVoiceMemoryShortcut(hybridResult.text.trim(), memoryService, ttsService).catch((err: unknown) =>
          log('WARN', 'voice_memory_shortcut_error', { error: String(err) }),
        )

        // 3. 检测热词命中 — 在 ASR 识别文本中搜索记忆实体和热词
        hotwordHits = asr.detectHotwordHits(hybridResult.text)

        // 4. 当有热词命中时，触发 Memory 检索和回放
        if (hotwordHits.length > 0) {
          const hitWords = hotwordHits.map((h) => h.hotword)

          // 4a. 生成带标记的文本：在热词前后添加标记
          hotwordTaggedText = hybridResult.text
          for (const hw of hitWords) {
            const escaped = hw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            hotwordTaggedText = hotwordTaggedText.replace(new RegExp(escaped, 'gi'), (match) => `[[MEM:${match}]]`)
          }

          // 4b. 从 VectorMemory 检索相关记忆
          try {
            const queryText = hitWords.join(' ')
            const vectorResults = memoryService.vector.querySync(queryText, 5)

            // 从 user_fact 记忆中搜索匹配的内容
            const entryResults = memoryService
              .getEntries()
              .filter((e) => e.type === 'user_fact')
              .filter((e) =>
                hitWords.some(
                  (hw) =>
                    e.content.toLowerCase().includes(hw.toLowerCase()) ||
                    (e.topics || []).some((t) => t.toLowerCase().includes(hw.toLowerCase())),
                ),
              )
              .sort((a, b) => b.behaviorScore - a.behaviorScore)
              .slice(0, 3)

            // 4c. 收集检索结果
            memoryRecallResults = [...vectorResults.slice(0, 3), ...entryResults.map((e) => e.content)].filter(Boolean).slice(0, 5)

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
        _hybrid: hybridResult.arbitrationTriggered
          ? {
              source: hybridResult.source,
              agreementLevel: hybridResult.agreementLevel,
              asrText: hybridResult.asrText,
            }
          : undefined,
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
    return {
      words: asr.getLearnedVocabulary(),
      domainStats: asr.getVocabularyDomainStats(),
      totalWords: asrHotwordManager.getLongTermVocabSize(),
      enabled: asrHotwordManager.isEnabled(),
    }
  })

  ipcMain.handle('asr:vocabulary:delete', async (_event, word: string) => {
    const asr = agentService.getAsrService()
    const removed = asr ? asr.deleteLearnedWord(word) : asrHotwordManager.deleteWord(word)
    if (removed && asr) asr.refreshContext()
    return { success: removed }
  })

  ipcMain.handle('asr:vocabulary:clear', async () => {
    const asr = agentService.getAsrService()
    if (asr) {
      asr.clearAllLearnedVocabulary()
      asr.refreshContext()
    } else {
      asrHotwordManager.clearAllVocabulary()
    }
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
    } else {
      asr.refreshContext()
    }
    return { success: true }
  })

  // Voice orchestrator
  const voiceOrchestrator = new VoiceToolOrchestrator()
  voiceOrchestrator.setToolCaller({
    callTool: async (name: string, args: Record<string, any>) => agentService.getMcpManager().callTool(name, args),
  })

  ipcMain.handle('voice:matchIntent', async (_event, text: string) => {
    try {
      return voiceOrchestrator.match({ text })
    } catch (err) {
      log('ERROR', 'voice_match_intent_failed', { error: String(err) })
      return { matched: false, fallbackText: text, error: String(err) }
    }
  })

  ipcMain.handle('voice:executeChain', async (_event, intent: string, slots: Record<string, string>) => {
    try {
      return await voiceOrchestrator.execute({ intent, slots })
    } catch (err) {
      log('ERROR', 'voice_execute_chain_failed', { error: String(err) })
      return { success: false, steps: [], summary: String(err) }
    }
  })

  // ══════════════════════════════════════════════════════════════════
  //  语音编排：LLM 意图解析 / 多轮语音确认 / 一站式编排
  //
  //  这 7 个通道的 preload API（llmParseIntent / voiceConfirm* / orchestrator*）
  //  与 capabilities 层实现（VoiceIntentLlmParser / VoiceConfirmationSession）
  //  都早已写好，唯独主进程从未注册 handler。ipcRenderer.invoke 遇未注册通道
  //  直接 reject，调用方 catch{} 一吞，表现就是「按钮没反应、控制台无错」。
  // ══════════════════════════════════════════════════════════════════

  // VoiceToolOrchestrator 的 _autoTtsFeedback 默认为 true，但不接 speaker
  // 时永远不会播报 —— 属于「设了开关却没有执行者」。这里补上。
  if (ttsService) {
    voiceOrchestrator.setTtsSpeaker(async (text: string) => {
      await ttsService.speak(text)
    })
  }

  /** 惰性取 LlmService —— LLM 未就绪时 AgentService 可能拿不到实例 */
  function safeLlm(): any {
    try {
      return agentService.getLlmService() || null
    } catch {
      return null
    }
  }

  // 注入 LLM 调用器（VoiceIntentLlmParser 的 fallback 依赖它；未注入时 parse() 会静默返回未命中）
  voiceIntentLlmParser.setLlmCaller(async (userText: string, systemPrompt: string) => {
    const llm = safeLlm()
    if (!llm) return { error: 'LLM_NOT_AVAILABLE' }
    return llm.chatJson(userText, { system: systemPrompt, temperature: 0.2 })
  })

  ipcMain.handle('voice:llmParseIntent', async (_event, text: string) => {
    try {
      return await voiceIntentLlmParser.parse(text || '')
    } catch (err) {
      log('ERROR', 'voice_llm_parse_intent_failed', { error: String(err) })
      return { success: false, parsed: null, fallbackText: text || '', error: String(err) }
    }
  })

  ipcMain.handle(
    'voice:confirm:start',
    async (
      _event,
      params: {
        intentName: string
        confirmMessage: string
        slots: Record<string, string>
        tools: Array<{ tool: string; args: Record<string, string> }>
        timeoutMs?: number
      },
    ) => {
      try {
        if (!params?.intentName) {
          return { success: false, error: 'intentName is required' }
        }
        if (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) {
          voiceConfirmationSession.updateConfig({ timeoutMs: params.timeoutMs })
        }
        voiceConfirmationSession.start({
          intentName: params.intentName,
          confirmMessage: params.confirmMessage || `将执行: ${params.intentName}`,
          slots: params.slots || {},
          tools: params.tools || [],
        })
        return {
          success: true,
          sessionId: voiceConfirmationSession.sessionId,
          state: voiceConfirmationSession.state,
        }
      } catch (err) {
        log('ERROR', 'voice_confirm_start_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    },
  )

  ipcMain.handle('voice:confirm:feed', async (_event, text: string) => {
    try {
      if (!voiceConfirmationSession.isActive) {
        return {
          success: false,
          state: voiceConfirmationSession.state,
          error: 'no active confirm session',
        }
      }
      voiceConfirmationSession.feed(text || '')
      const state = voiceConfirmationSession.state
      // 只有会话真正结束（确认/拒绝/超时）才给出 result；
      // 仍在等待确认或转修改时 result 必须是 undefined —— 否则调用方会把
      // 「还没确认」当成「已确认」直接执行。
      const result = state === 'confirmed' || state === 'rejected' || state === 'timeout' ? state : undefined
      return {
        success: true,
        state,
        result,
        slots: voiceConfirmationSession.slots,
      }
    } catch (err) {
      log('ERROR', 'voice_confirm_feed_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:confirm:state', async () => ({
    active: voiceConfirmationSession.isActive,
    state: voiceConfirmationSession.state,
    sessionId: voiceConfirmationSession.sessionId,
    intentName: voiceConfirmationSession.intentName,
    confirmMessage: voiceConfirmationSession.confirmMessage,
    slots: voiceConfirmationSession.slots,
    elapsedMs: voiceConfirmationSession.elapsedMs,
  }))

  ipcMain.handle('voice:confirm:reset', async () => {
    voiceConfirmationSession.reset()
    return { success: true }
  })

  /**
   * 一站式语音编排：关键词匹配 → （可选 LLM fallback）→ 确认 / 执行。
   *
   * 需要确认时只「开启确认会话」并把意图回传，真正执行由调用方在用户确认后
   * 调 voice:orchestrate:confirmAndExecute —— 主进程不在这里挂起等待。
   */
  ipcMain.handle(
    'voice:orchestrate:full',
    async (
      _event,
      text: string,
      options?: {
        useLlmFallback?: boolean
        autoTts?: boolean
        requireConfirm?: boolean
        confirmTimeoutMs?: number
      },
    ) => {
      const opts = options || {}
      const prevAutoTts = voiceOrchestrator.autoTtsFeedback
      voiceOrchestrator.setAutoTtsFeedback(opts.autoTts !== false)

      try {
        /** 命中意图后的统一出口：需要确认则开会话，否则直接执行 */
        const runIntent = async (intent: {
          name: string
          description: string
          confirmMessage: string
          tools: Array<{ tool: string; args: Record<string, string> }>
          slots: Record<string, string>
          requireConfirmation: boolean
        }) => {
          const intentPayload = {
            name: intent.name,
            description: intent.description,
            confirmMessage: intent.confirmMessage,
            toolSequence: intent.tools,
            slots: intent.slots,
          }

          const needConfirm = opts.requireConfirm !== false && intent.requireConfirmation !== false
          if (needConfirm) {
            if (typeof opts.confirmTimeoutMs === 'number' && opts.confirmTimeoutMs > 0) {
              voiceConfirmationSession.updateConfig({ timeoutMs: opts.confirmTimeoutMs })
            }
            voiceConfirmationSession.start({
              intentName: intent.name,
              confirmMessage: intent.confirmMessage,
              slots: intent.slots,
              tools: intent.tools,
            })
            return {
              matched: true,
              awaitingConfirm: true,
              intent: intentPayload,
              sessionId: voiceConfirmationSession.sessionId,
              state: voiceConfirmationSession.state,
            }
          }

          // 显式序列执行：LLM 解析出的意图不在静态意图表里，execute() 会报「未知意图」
          const result = await voiceOrchestrator.executeSequence({
            tools: intent.tools,
            slots: intent.slots,
            intent: intent.name,
          })
          return { matched: true, awaitingConfirm: false, intent: intentPayload, result }
        }

        const matched = voiceOrchestrator.match({ text: text || '' })

        if (!matched.matched || !matched.intent) {
          // 关键词未命中 → 可选走 LLM fallback（纯闲聊时 LLM 也会返回 matched=false）
          if (!opts.useLlmFallback) {
            return { matched: false, text: text || '' }
          }
          const llmResult = await voiceIntentLlmParser.parse(text || '')
          if (!llmResult.success || !llmResult.parsed) {
            return { matched: false, text: text || '', error: llmResult.error }
          }
          const p = llmResult.parsed
          return await runIntent({
            name: p.intent,
            description: p.description,
            confirmMessage: p.confirmMessage,
            tools: p.tools,
            slots: p.slots,
            requireConfirmation: p.requireConfirmation,
          })
        }

        return await runIntent({
          name: matched.intent.name,
          description: matched.intent.description,
          confirmMessage: matched.intent.confirmMessage,
          tools: matched.intent.toolSequence,
          slots: matched.intent.slots,
          // 尊重意图定义里的 requireConfirmation（缺省 true —— 关键词意图多为破坏性操作）
          requireConfirmation: matched.intent.requireConfirmation,
        })
      } catch (err) {
        log('ERROR', 'voice_orchestrate_full_failed', { error: String(err) })
        return { matched: false, text: text || '', error: String(err) }
      } finally {
        voiceOrchestrator.setAutoTtsFeedback(prevAutoTts)
      }
    },
  )

  ipcMain.handle(
    'voice:orchestrate:confirmAndExecute',
    async (_event, intentName: string, slots: Record<string, string>) => {
      try {
        // 确认可能由 UI 按钮触发而非语音 feed —— 同步结束确认会话，
        // 否则会话会一直停在 awaiting_confirm 直到超时，并播报一句
        // 莫名其妙的「确认超时，操作已取消」。
        // 只在会话的意图与被执行的意图一致时才代为确认，避免误确认别的意图。
        if (voiceConfirmationSession.isActive && voiceConfirmationSession.intentName === intentName) {
          voiceConfirmationSession.confirm()
        }
        const result = await voiceOrchestrator.execute({ intent: intentName, slots: slots || {} })
        return { success: result.success, result }
      } catch (err) {
        log('ERROR', 'voice_orchestrate_confirm_and_execute_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    },
  )

  // ── ODE 求解会话 ──

  /** 向所有渲染进程发送 ODE 状态事件 */
  function emitOdeState(): void {
    const wins = BrowserWindow.getAllWindows()
    const data = {
      sessionId: voiceOdeSession.sessionId,
      state: voiceOdeSession.state,
      hasSolution: voiceOdeSession.lastSolution !== null,
      solution: voiceOdeSession.lastSolution
        ? {
            xFinal: voiceOdeSession.lastSolution.xFinal,
            yFinal: voiceOdeSession.lastSolution.yFinal,
            method: voiceOdeSession.lastSolution.method,
            steps: voiceOdeSession.lastSolution.steps,
          }
        : undefined,
    }
    for (const win of wins) {
      try {
        win.webContents.send('ode:state-change', data)
      } catch {
        /* ignore */
      }
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
          try {
            ttsService.speak(prompt)
          } catch {
            /* TTS not available */
          }
        }
        break
      case 'solve_complete': {
        log('INFO', 'ode_session_solve_complete', { yFinal: event.yFinal, xFinal: event.xFinal })
        emitOdeState()
        // 通过 TTS 播报关键结果
        if (ttsService) {
          const ttsText = `求解完成。当 x 等于 ${event.xFinal} 时，y 约等于 ${event.yFinal.toFixed(4)}。`
          try {
            ttsService.speak(ttsText)
          } catch {
            /* TTS not available */
          }
        }
        break
      }
      case 'solve_error':
        log('ERROR', 'ode_session_solve_error', { error: event.error })
        emitOdeState()
        if (ttsService) {
          const ttsText = `求解出错：${event.error.slice(0, 60)}`
          try {
            ttsService.speak(ttsText)
          } catch {
            /* TTS not available */
          }
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
        solution: lastSolution
          ? {
              xFinal: lastSolution.xFinal,
              yFinal: lastSolution.yFinal,
              method: lastSolution.method,
              steps: lastSolution.steps,
              plotPath: lastSolution.plotPath,
              analyticalNote: lastSolution.analyticalNote,
            }
          : null,
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
