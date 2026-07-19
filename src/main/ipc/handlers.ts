import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { AgentService } from '../agent/AgentService'
import { StateManager } from '../core/StateManager'
import { TtsService } from '../tts/TtsService'
import { SelfEvolutionService } from '../evolution'
import { EvolutionDashboardService, MemoryContextService, FileOrganizerProgressService } from '../wallpaper/WallpaperService'
import { credentialsManager } from '../credentials/CredentialsManager'
import { WAKE_WORDS, LLM_API_URL, LLM_CODE_API_URL, LLM_TEXT_API_URL, LLM_VISION_API_URL, WORKSPACE } from '../config'
import { monitorEventLoopDelay } from 'perf_hooks'
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../updater/UpdaterService'
import { MetricsCollector } from '../observability/MetricsCollector'
import { getRecentMessages, getSessions, getMessagesBySession } from '../db/messages'
import { planManager as planManagerImport } from '../evolution'
import { workflowStore } from '../workflow/WorkflowStoreV2'
import { getWorkflowScheduler } from '../workflow/WorkflowScheduler'
import { createAgentWindow, closeAgentWindow } from '../core/Lifecycle'
import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { eventBus } from '../core/EventBus'
import { VoiceToolOrchestrator } from '../tool/VoiceToolOrchestrator'
import { extractContextFromSummaries } from '../asr/AsrContextBuilder'
import { asrHotwordManager } from '../asr/AsrHotwordManager'
import { memoryAsrHybridPipeline } from '../asr/MemoryAsrHybridPipeline'
import { inspirationService } from '../writing/InspirationService'
import { voiceContinuationService } from '../writing/VoiceContinuationService'
import { audioFeatureExtractor } from '../audio/AudioFeatureExtractor'
import { atmosphereMapper } from '../audio/AtmosphereMapper'
import type { DecisionQueryService } from '../core/evaluation/DecisionQueryService'
import type { GuardrailMetricsQueryService } from '../core/evaluation/GuardrailMetricsQueryService'
import { typographyVerificationService } from '../typing/TypographyVerificationService'
import { quickTaskService } from '../behavior/QuickTaskService'
import type { QuickTaskStep } from '../behavior/QuickTaskTypes'
import { voiceRoleManager } from '../tts/VoiceRoleManager'
import type { VoiceBookmarkService } from '../memory/VoiceBookmarkService'

/** 打开的沙盒窗口表，防止重复打开 */
const sandboxWindows = new Map<string, BrowserWindow>()

/**
 * 在沙盒目录中打开一个独立窗口显示 HTML 页面。
 */
function openSandboxWindow(name: string, htmlPath: string): void {
  const existing = sandboxWindows.get(name)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  if (!existsSync(htmlPath)) {
    log('WARN', 'sandbox_html_not_found', { name, htmlPath })
    return
  }

  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: `星尘流韵 — Astral Flow`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  win.loadFile(htmlPath)
  sandboxWindows.set(name, win)

  win.on('closed', () => {
    sandboxWindows.delete(name)
  })
}

/**
 * 可变的服务引用容器 — 允许延迟初始化的服务绑定 IPC handler
 */
export interface ServiceRef<T> {
  current: T | null
}

export function createServiceRef<T>(): ServiceRef<T> {
  return { current: null }
}

export function registerHandlers(
  agentService: AgentService,
  stateManager: StateManager,
  ttsService: TtsService,
  evolutionRef?: ServiceRef<SelfEvolutionService>,
  metricsCollector?: MetricsCollector,
  dashboardRef?: ServiceRef<EvolutionDashboardService>,
  memoryContextRef?: ServiceRef<MemoryContextService>,
  decisionQueryRef?: ServiceRef<DecisionQueryService>,
  metricsQueryRef?: ServiceRef<GuardrailMetricsQueryService>,
  organizerRef?: ServiceRef<FileOrganizerProgressService>,
  voiceBookmarkRef?: ServiceRef<VoiceBookmarkService>,
): void {
  ipcMain.handle('window:close', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false }
    try {
      // 关闭前保存所有状态
      agentService.pause()
      await agentService.stopConversation().catch(() => {})
      eventBus.emit('agent.session.flush' as any, {})
      agentService.saveRecoverySnapshot?.('window_close' as any)
    } catch (err) {
      log('WARN', 'window_close_save_failed', { error: String(err) })
    }
    win.hide() // 隐藏到托盘而非关闭窗口
    return { success: true }
  })

  ipcMain.handle('window:minimize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false }
    win.minimize()
    return { success: true }
  })

  ipcMain.handle('window:maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, isMaximized: false }
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    return { success: true, isMaximized: win.isMaximized() }
  })

  ipcMain.handle('window:isMaximized', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { isMaximized: false }
    return { isMaximized: win.isMaximized() }
  })

  ipcMain.handle('window:fullscreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, isFullScreen: false }
    win.setFullScreen(!win.isFullScreen())
    return { success: true, isFullScreen: win.isFullScreen() }
  })

  ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string, sessionId?: string, noTts?: boolean) => {
    try {
      if (agentService.isPaused()) return { reply: '', error: 'PAUSED' }
      return await agentService.processTextInput(text, requestId, 'electron', undefined, sessionId, noTts)
    } catch (err) {
      log('ERROR', 'ai_chat_failed', { error: String(err), requestId })
      throw err
    }
  })

  ipcMain.handle('agent:pause', async () => {
    agentService.pause()
    return { success: true }
  })

  ipcMain.handle('agent:resume', async () => {
    agentService.resume()
    return { success: true }
  })

  ipcMain.handle('agent:status', async () => {
    return { paused: agentService.isPaused(), busy: agentService.isBusy() }
  })

  ipcMain.handle('asr:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const asr = agentService.getAsrService()
      if (!asr) throw new Error('ASR service not initialized')

      // 1. 从 Memory 获取最近对话上下文
      const memoryService = agentService.getMemoryService()
      let context: import('../asr/types').AsrConversationContext | null = null

      if (memoryService) {
        const recentSummaries = memoryService.summary.getRecentFull(3)
        const lastUserText = memoryService.getLastUserText()
        context = extractContextFromSummaries(recentSummaries, lastUserText || undefined)
        asr.setConversationContext(context)
      }

      // 2. 配置混合流水线
      memoryAsrHybridPipeline.setAsrService(asr)
      if (memoryService) {
        memoryAsrHybridPipeline.setMemoryService(memoryService)
        // 注入 LLM 仲裁提供者（可选，用于深度语义仲裁）
        try {
          const llm = agentService.getLlmService()
          memoryAsrHybridPipeline.setLlmProvider(llm)
        } catch {
          // LLM 不可用时不影响主流程
        }
      }

      // 3. 执行混合流水线（Path A: ASR + Path B: Memory 预测 + 交叉验证 + 仲裁）
      const hybridResult = await memoryAsrHybridPipeline.run(audioBuffer, context, undefined, undefined)

      // 4. 将语音情感分析结果传递给 ChatExecutor（用于 TTS 情感自适应）
      if (hybridResult.voiceEmotion) {
        const chatExecutor = agentService.getChatExecutor()
        if (chatExecutor) {
          chatExecutor.setUserVoiceEmotion(hybridResult.voiceEmotion)
        }
      }

      // 5. 识别后新文本并入 Memory（记录交互、提取主题）
      if (memoryService && hybridResult.text && hybridResult.text.trim()) {
        memoryService.recordInteraction(hybridResult.text)
        memoryService.setLastUserText(hybridResult.text)
        // ASR热词增强：将识别结果回灌到频率热词管理器
        asrHotwordManager.feedUserText(hybridResult.text)
      }

      return {
        text: hybridResult.text,
        request_id: hybridResult.requestId,
        voiceEmotion: hybridResult.voiceEmotion,
        _hybrid: hybridResult.arbitrationTriggered ? {
          source: hybridResult.source,
          agreementLevel: hybridResult.agreementLevel,
          asrText: hybridResult.asrText,
        } : undefined,
      }
    } catch (err) {
      log('ERROR', 'asr_transcribe_failed', { error: String(err) })
      throw err
    }
  })

  // ── ASR 热词管理 IPC ──

  ipcMain.handle('asr:toggle-hotwords', async (_event, enabled: boolean) => {
    const asr = agentService.getAsrService()
    if (asr) {
      asr.toggleHotwordManager(enabled)
    }
    asrHotwordManager.setEnabled(enabled)
    return { enabled: asrHotwordManager.isEnabled() }
  })

  ipcMain.handle('asr:hotword-state', async () => {
    const asr = agentService.getAsrService()
    if (asr) {
      return asr.getHotwordManagerState()
    }
    return { enabled: asrHotwordManager.isEnabled(), entryCount: 0, hotwords: [], totalInputs: 0 }
  })

  // ── ASR 词汇管理 IPC（长时个性化词表 ──

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
    // 删除后刷新 ASR 上下文
    if (removed && asr) {
      asr.refreshContext()
    }
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
    // 1. 从 Memory 获取最新上下文
    const memoryService = agentService.getMemoryService()
    if (memoryService) {
      const recentSummaries = memoryService.summary.getRecentFull(3)
      const lastUserText = memoryService.getLastUserText()
      const context = extractContextFromSummaries(recentSummaries, lastUserText || undefined)
      asr.setConversationContext(context)
    } else {
      asr.refreshContext()
    }
    return { success: true }
  })

  // ── Memory-ASR 混合流水线 IPC ──

  ipcMain.handle('asr:hybrid:toggle', async (_event, enabled: boolean) => {
    memoryAsrHybridPipeline.setEnabled(enabled)
    log('INFO', 'asr_hybrid_toggle', { enabled })
    return { enabled: memoryAsrHybridPipeline.isReady() }
  })

  ipcMain.handle('asr:hybrid:state', async () => {
    const config = memoryAsrHybridPipeline.getConfig()
    return {
      enabled: config.enabled,
      ready: memoryAsrHybridPipeline.isReady(),
      config,
    }
  })

  ipcMain.handle('asr:hybrid:updateConfig', async (_event, partial: Record<string, unknown>) => {
    memoryAsrHybridPipeline.updateConfig(partial as any)
    log('INFO', 'asr_hybrid_config_updated', { partial })
    return { success: true, config: memoryAsrHybridPipeline.getConfig() }
  })

  // ── 语音工具编排 IPC ──

  const voiceOrchestrator = new VoiceToolOrchestrator()
  voiceOrchestrator.setToolCaller({
    callTool: async (name: string, args: Record<string, any>) => {
      return agentService.getMcpManager().callTool(name, args)
    },
  })

  ipcMain.handle('voice:matchIntent', async (_event, text: string) => {
    try {
      const result = voiceOrchestrator.match({ text })
      return result
    } catch (err) {
      log('ERROR', 'voice_match_intent_failed', { error: String(err) })
      return { matched: false, fallbackText: text, error: String(err) }
    }
  })

  ipcMain.handle('voice:executeChain', async (_event, intent: string, slots: Record<string, string>) => {
    try {
      const result = await voiceOrchestrator.execute({ intent, slots })
      return result
    } catch (err) {
      log('ERROR', 'voice_execute_chain_failed', { error: String(err) })
      return { success: false, steps: [], summary: String(err) }
    }
  })

  ipcMain.handle('tts:speak', async (_event, text: string) => {
    try {
      log('PERF', 'tts_speak', { char_count: text.length })
      await ttsService.speak(text)
    } catch (err) {
      log('ERROR', 'tts_speak_failed', { error: String(err) })
      throw err
    }
  })

  ipcMain.handle('tts:stop', async () => {
    try {
      // 记录隐式反馈：用户主动停止 TTS → SKIP
      ttsService.recordImplicitFeedback('SKIP')
      ttsService.stop()
    } catch (err) {
      log('ERROR', 'tts_stop_failed', { error: String(err) })
    }
  })

  // ── 情感自适应语音 IPC ──
  ipcMain.handle('tts:emotion:toggle', async (_event, enabled: boolean) => {
    try {
      agentService.getChatExecutor()?.toggleEmotionTts(enabled)
      log('INFO', 'tts_emotion_toggle_ipc', { enabled })
      return { success: true, enabled }
    } catch (err) {
      log('ERROR', 'tts_emotion_toggle_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:emotion:state', async () => {
    try {
      const chatExec = agentService.getChatExecutor()
      if (chatExec) {
        return { success: true, ...chatExec.getEmotionTtsState() }
      }
      return { success: true, enabled: false, params: null }
    } catch (err) {
      log('ERROR', 'tts_emotion_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── 行为情绪检测 IPC ──
  ipcMain.handle('tts:behaviorEmotion:toggle', async (_event, enabled: boolean) => {
    try {
      agentService.getChatExecutor()?.toggleBehaviorEmotion(enabled)
      log('INFO', 'tts_behavior_emotion_toggle_ipc', { enabled })
      return { success: true, enabled }
    } catch (err) {
      log('ERROR', 'tts_behavior_emotion_toggle_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:behaviorEmotion:state', async () => {
    try {
      const chatExec = agentService.getChatExecutor()
      if (chatExec) {
        return { success: true, ...chatExec.getBehaviorEmotionState() }
      }
      return { success: true, enabled: false, result: null, metrics: null }
    } catch (err) {
      log('ERROR', 'tts_behavior_emotion_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── 隐式反馈驱动的语音自适应 IPC ──
  ipcMain.handle('tts:implicitFeedback:recordAction', async (_event, action: string) => {
    try {
      const valid = ['REPLAY', 'SKIP', 'INTERRUPT_SPEECH', 'CONTINUE_CONVERSATION', 'MODIFY_REQUEST', 'COMPLETED_NATURALLY']
      if (!valid.includes(action)) return { success: false, error: `无效的反馈动作: ${action}` }
      ttsService.recordImplicitFeedback(action as any)
      return { success: true }
    } catch (err) {
      log('ERROR', 'tts_implicit_feedback_record_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:implicitFeedback:toggle', async (_event, enabled: boolean) => {
    try {
      agentService.getChatExecutor()?.toggleImplicitFeedback(enabled)
      log('INFO', 'tts_implicit_feedback_toggle_ipc', { enabled })
      return { success: true, enabled }
    } catch (err) {
      log('ERROR', 'tts_implicit_feedback_toggle_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:implicitFeedback:state', async () => {
    try {
      const chatExec = agentService.getChatExecutor()
      if (chatExec) {
        return { success: true, ...chatExec.getImplicitFeedbackState() }
      }
      return { success: true, enabled: false, recommendation: null, status: { modelInitialized: false, totalSamples: 0, historySize: 0 } }
    } catch (err) {
      log('ERROR', 'tts_implicit_feedback_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:implicitFeedback:updateModel', async () => {
    try {
      agentService.getChatExecutor()?.triggerImplicitFeedbackUpdate()
      return { success: true }
    } catch (err) {
      log('ERROR', 'tts_implicit_feedback_update_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:implicitFeedback:reset', async () => {
    try {
      agentService.getChatExecutor()?.resetImplicitFeedback()
      return { success: true }
    } catch (err) {
      log('ERROR', 'tts_implicit_feedback_reset_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── 交互情境自适应语音 IPC ──
  ipcMain.handle('tts:contextual:toggle', async (_event, enabled: boolean) => {
    try {
      agentService.getChatExecutor()?.toggleContextualTts(enabled)
      log('INFO', 'tts_contextual_toggle_ipc', { enabled })
      return { success: true, enabled }
    } catch (err) {
      log('ERROR', 'tts_contextual_toggle_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:contextual:state', async () => {
    try {
      const chatExec = agentService.getChatExecutor()
      if (chatExec) {
        return { success: true, ...chatExec.getContextualTtsState() }
      }
      return { success: true, enabled: false, context: null }
    } catch (err) {
      log('ERROR', 'tts_contextual_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── TTS 引擎偏好（混合路由） ──
  ipcMain.handle('tts:engine-preference:set', async (_event, pref: string) => {
    try {
      const valid = pref === 'auto' || pref === 'cloud' || pref === 'local'
      if (!valid) return { success: false, error: `无效的引擎偏好: ${pref}` }
      ttsService.setEnginePreference(pref as 'auto' | 'cloud' | 'local')
      // 同步写入凭据，持久化偏好
      credentialsManager.set('tts_mode', pref)
      return { success: true, preference: pref }
    } catch (err) {
      log('ERROR', 'tts_engine_preference_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:engine-preference:get', async () => {
    try {
      return { success: true, preference: ttsService.getEnginePreference() }
    } catch (err) {
      log('ERROR', 'tts_engine_preference_get_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── TTS 语音字幕 IPC ──

  // 注册字幕回调：TTS 合成时推送字幕到所有窗口
  ttsService.setSubtitleCallback((data) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send('tts:subtitle', data)
      }
    }
  })

  ipcMain.handle('tts:subtitle:getEnabled', async () => {
    const enabled = credentialsManager.get('tts_subtitle_enabled')
    return { enabled: enabled !== 'false' }
  })

  ipcMain.handle('tts:subtitle:setEnabled', async (_event, enabled: boolean) => {
    credentialsManager.set('tts_subtitle_enabled', enabled ? 'true' : 'false')
    log('INFO', 'tts_subtitle_enabled', { enabled })
    return { success: true, enabled }
  })

  ipcMain.handle('tts:router-state', async () => {
    try {
      const decision = ttsService.getLastRoutingDecision()
      const weights = ttsService.getRoutingWeights()
      return {
        success: true,
        preference: ttsService.getEnginePreference(),
        lastDecision: decision,
        weights,
      }
    } catch (err) {
      log('ERROR', 'tts_router_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ══════════════════════════════════════════
  //  用户情境自适应语音
  // ══════════════════════════════════════════

  ipcMain.handle('tts:userContext:toggle', async (_event, enabled: boolean) => {
    try {
      agentService.getChatExecutor()?.toggleUserContextClassifier(enabled)
      log('INFO', 'tts_user_context_toggle_ipc', { enabled })
      return { success: true, enabled }
    } catch (err) {
      log('ERROR', 'tts_user_context_toggle_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:userContext:state', async () => {
    try {
      const chatExec = agentService.getChatExecutor()
      if (chatExec) {
        return { success: true, ...chatExec.getUserContextState() }
      }
      return { success: true, enabled: false, result: null }
    } catch (err) {
      log('ERROR', 'tts_user_context_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:userContext:override', async (_event, mode: string) => {
    try {
      const valid = mode === 'auto' || mode === 'manual_work' || mode === 'manual_leisure' || mode === 'manual_rest'
      if (!valid) return { success: false, error: `无效的情境覆盖模式: ${mode}` }
      agentService.getChatExecutor()?.setUserContextOverride(mode as any)
      log('INFO', 'tts_user_context_override_ipc', { mode })
      return { success: true, mode }
    } catch (err) {
      log('ERROR', 'tts_user_context_override_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── TTS 重听与循环播放 IPC ──
  ipcMain.handle('tts:replay', async () => {
    try {
      const success = await ttsService.replay()
      return { success }
    } catch (err) {
      log('ERROR', 'tts_replay_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:replay:hasContent', async () => {
    return { hasContent: ttsService.hasReplayContent() }
  })

  ipcMain.handle('tts:loop:set', async (_event, enabled: boolean, intervalMs?: number, maxCount?: number) => {
    try {
      ttsService.setLoopMode(enabled, intervalMs, maxCount)
      return { success: true, enabled, intervalMs, maxCount }
    } catch (err) {
      log('ERROR', 'tts_loop_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:loop:state', async () => {
    return {
      enabled: ttsService.isLoopMode(),
      hasReplayContent: ttsService.hasReplayContent(),
    }
  })

  // ── 学习查询 IPC ──
  ipcMain.handle('learning:query', async (_event, transcribedText: string) => {
    try {
      const { learningAsrBridge } = await import('../learning/LearningAsrBridge')
      const result = learningAsrBridge.matchQuery(transcribedText)
      return result
    } catch (err) {
      log('ERROR', 'learning_query_failed', { error: String(err) })
      return { matched: false, items: [], categories: [], explanation: String(err), query: transcribedText }
    }
  })

  ipcMain.handle('learning:summary', async () => {
    try {
      const { learningAsrBridge } = await import('../learning/LearningAsrBridge')
      return { summary: learningAsrBridge.getLearningSummary() }
    } catch (err) {
      log('ERROR', 'learning_summary_failed', { error: String(err) })
      return { summary: '' }
    }
  })

  // ── 口述代码 IPC ──
  ipcMain.handle('oral:code', async (_event, description: string) => {
    try {
      const { oralCodeService } = await import('../learning/OralCodeService')
      const result = oralCodeService.process({ description })
      return result
    } catch (err) {
      log('ERROR', 'oral_code_failed', { error: String(err) })
      return { success: false, pattern: 'unknown', code: '', explanation: String(err), label: '错误', verification: 'failed' }
    }
  })

  ipcMain.handle('oral:patterns', async () => {
    try {
      const { oralCodeService } = await import('../learning/OralCodeService')
      const patterns = oralCodeService.getSupportedPatterns()
      return { patterns }
    } catch (err) {
      log('ERROR', 'oral_patterns_failed', { error: String(err) })
      return { patterns: [] }
    }
  })

  ipcMain.handle('conversation:stop', async () => {
    try {
      await agentService.stopConversation()
      return { success: true }
    } catch (err) {
      log('ERROR', 'conversation_stop_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('state:get', async () => {
    try {
      return stateManager.get()
    } catch (err) {
      log('ERROR', 'state_get_failed', { error: String(err) })
      return { error: String(err) }
    }
  })

  // Evolution handlers 通过可变的 ref 延迟绑定
  if (evolutionRef) {
    // 始终注册 handler，内部解引用
    ipcMain.handle('evolution:trigger', async () => {
      const svc = evolutionRef.current
      if (!svc) return { success: false, error: 'evolution not ready' }
      try {
        await svc.triggerNow()
        return { success: true }
      } catch (err) {
        log('ERROR', 'evolution_trigger_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('evolution:status', async () => {
      const svc = evolutionRef.current
      if (!svc) return { lastRun: null, consecutiveFailures: 0, isBusy: false }
      return {
        lastRun: svc.getLastRun(),
        consecutiveFailures: svc.getConsecutiveFailures(),
        isBusy: agentService.isBusy(),
      }
    })
  }

  // Evolution Dashboard toggle
  if (dashboardRef) {
    ipcMain.handle('evolution:dashboard:toggle', async () => {
      const svc = dashboardRef.current
      if (!svc) return { success: false, visible: false }
      const visible = svc.toggleVisibility()
      return { success: true, visible }
    })
  }

  // ── 自进化实时仪表盘配置（高频 Canvas 仪表盘） ──
  ipcMain.handle('evolution:dashboard:live:getConfig', async () => {
    const enabled = credentialsManager.get('evo_dashboard_live_enabled')
    const opacity = credentialsManager.get('evo_dashboard_live_opacity')
    return {
      enabled: enabled !== 'false', // 默认启用
      opacity: opacity ? parseFloat(opacity) : 0.85,
    }
  })

  ipcMain.handle('evolution:dashboard:live:setConfig', async (_event, config: { enabled?: boolean; opacity?: number }) => {
    try {
      if (config.enabled !== undefined) {
        credentialsManager.set('evo_dashboard_live_enabled', String(config.enabled))
      }
      if (config.opacity !== undefined) {
        credentialsManager.set('evo_dashboard_live_opacity', String(config.opacity))
      }
      return { success: true }
    } catch (err: any) {
      return { success: false }
    }
  })

  ipcMain.handle('credentials:list', async () => {
    return credentialsManager.list()
  })

  ipcMain.handle('credentials:getAll', async () => {
    return credentialsManager.getAll()
  })

  ipcMain.handle('credentials:get', async (_event, name: string) => {
    return credentialsManager.get(name)
  })

  ipcMain.handle('credentials:set', async (_event, name: string, value: string) => {
    credentialsManager.set(name, value)
    // LLM 配置变更时实时同步到运行时的 LlmService
    if (name.startsWith('llm_')) {
      try {
        const llm = agentService.getLlmService()
        llm.refreshFromCredentials((k) => credentialsManager.get(k))
        log('INFO', 'llm_config_refreshed_from_ui', { changed: name })
      } catch (err) {
        log('WARN', 'llm_config_refresh_failed', { error: String(err) })
      }
    }
    // TTS 引擎偏好变更时实时同步到 TtsRouter
    if (name === 'tts_mode') {
      const pref = value === 'cloud' ? 'cloud' : value === 'local' ? 'local' : 'auto'
      ttsService.setEnginePreference(pref as 'auto' | 'cloud' | 'local')
      log('INFO', 'tts_mode_credential_synced', { value, preference: pref })
    }
    return true
  })

  ipcMain.handle('credentials:delete', async (_event, name: string) => {
    credentialsManager.delete(name)
    return true
  })

  ipcMain.handle('config:getWakeWords', async () => {
    return WAKE_WORDS
  })

  ipcMain.handle('health:check', async () => {
    const mem = process.memoryUsage()
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024)
    const rssMB = Math.round(mem.rss / 1024 / 1024)

    const state = stateManager.get()
    const mcpServers = agentService
      .getMcpManager()
      .listServers()
      .map((s) => ({
        name: s.name,
        initialized: s.initialized,
      }))

    let eventLoopLag = -1
    try {
      const t0 = Date.now()
      await new Promise((resolve) => setImmediate(resolve))
      eventLoopLag = Date.now() - t0
    } catch {}

    return {
      status: 'ok',
      uptime: process.uptime(),
      memory: {
        heapUsedMB,
        heapTotalMB,
        rssMB,
      },
      asr: state.asr || 'unknown',
      llm: {
        keyConfigured: !!(process.env.LLM_KEY || credentialsManager.get('llm_key')),
        chatUrl: LLM_API_URL,
        chatModel: process.env.LLM_CHAT_MODEL,
        codeUrl: LLM_CODE_API_URL,
        codeModel: process.env.LLM_CODE_MODEL,
        textUrl: LLM_TEXT_API_URL,
        textModel: process.env.LLM_TEXT_MODEL,
        visionUrl: LLM_VISION_API_URL,
        visionModel: process.env.LLM_VISION_MODEL,
      },
      mcp: {
        serverCount: mcpServers.length,
        servers: mcpServers,
      },
      eventLoopLagMs: eventLoopLag,
      metrics: metricsCollector?.getSnapshot() ?? null,
      timestamp: Date.now(),
    }
  })

  ipcMain.handle('messages:getHistory', async (_event, limit?: number) => {
    try {
      return await getRecentMessages(limit ?? 200)
    } catch (err) {
      log('ERROR', 'get_history_failed', { error: String(err) })
      return []
    }
  })

  ipcMain.handle('messages:getSessions', async () => {
    try {
      return await getSessions()
    } catch (err) {
      log('ERROR', 'get_sessions_failed', { error: String(err) })
      return []
    }
  })

  ipcMain.handle('messages:getBySession', async (_event, sessionId: string) => {
    try {
      return await getMessagesBySession(sessionId)
    } catch (err) {
      log('ERROR', 'get_by_session_failed', { error: String(err), sessionId })
      return []
    }
  })

  // === Auto-update handlers ===
  ipcMain.handle('update:check', async () => {
    try {
      return await checkForUpdates()
    } catch (err) {
      log('ERROR', 'update_check_ipc_failed', { error: String(err) })
      return { available: false, error: String(err) }
    }
  })

  ipcMain.handle('update:download', async () => {
    try {
      downloadUpdate()
      return { success: true }
    } catch (err) {
      log('ERROR', 'update_download_ipc_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('update:install', async () => {
    quitAndInstall()
    return { success: true }
  })

  // ── Coding Agent UI ──

  ipcMain.handle('agent:getActivePlan', async () => {
    try {
      const plan = planManagerImport.getActivePlan()
      return plan ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('agent:listPlans', async () => {
    try {
      return planManagerImport.listPlans()
    } catch {
      return []
    }
  })

  ipcMain.handle('agent:openWindow', async () => {
    try {
      createAgentWindow()
      return { success: true }
    } catch (err) {
      log('ERROR', 'agent_open_window_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('agent:closeWindow', async () => {
    try {
      closeAgentWindow()
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  // ── Workflow System ──

  ipcMain.handle('workflow:listDefinitions', async () => {
    try {
      return workflowStore.listDefinitions()
    } catch {
      return []
    }
  })

  ipcMain.handle('workflow:getDefinition', async (_event, id: string) => {
    try {
      return workflowStore.getDefinition(id)
    } catch {
      return null
    }
  })

  ipcMain.handle('workflow:listRuns', async (_event, limit?: number) => {
    try {
      return workflowStore.listRuns(limit)
    } catch {
      return []
    }
  })

  ipcMain.handle('workflow:getRun', async (_event, runId: string) => {
    try {
      return workflowStore.getRun(runId)
    } catch {
      return null
    }
  })

  ipcMain.handle('workflow:deleteDefinition', async (_event, id: string) => {
    try {
      return { success: workflowStore.deleteDefinition(id) }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('workflow:saveDefinition', async (_event, def: any) => {
    try {
      workflowStore.saveDefinition(def)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('workflow:startWorkflow', async (_event, id: string, userInput?: string) => {
    try {
      log('INFO', 'workflow_startWorkflow_called', { id, userInput })
      const def = workflowStore.getDefinition(id)
      if (!def) return { success: false, error: '工作流不存在' }
      if (def.enabled === false) return { success: false, error: '工作流已停用，请先启用' }
      const scheduler = getWorkflowScheduler()
      log('INFO', 'workflow_scheduler_got', { schedulerExists: !!scheduler })
      const run = scheduler.startRun(def, userInput)
      return { success: true, runId: run.runId }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('workflow:stopRun', async (_event, runId: string) => {
    try {
      const scheduler = getWorkflowScheduler()
      const ok = scheduler.stopRun(runId)
      return { success: ok, error: ok ? undefined : '运行未找到或已结束' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('workflow:enableDefinition', async (_event, id: string) => {
    try {
      const existing = workflowStore.getDefinition(id)
      if (!existing) return { success: false, error: '工作流不存在' }
      if (existing.enabled !== false) return { success: false, error: '已经是启用状态' }
      workflowStore.saveDefinition({ ...existing, enabled: true, updatedAt: Date.now() })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('workflow:disableDefinition', async (_event, id: string) => {
    try {
      const existing = workflowStore.getDefinition(id)
      if (!existing) return { success: false, error: '工作流不存在' }
      if (existing.enabled === false) return { success: false, error: '已经是停用状态' }
      workflowStore.saveDefinition({ ...existing, enabled: false, updatedAt: Date.now() })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('workflow:duplicateDefinition', async (_event, id: string) => {
    try {
      const copy = workflowStore.duplicateDefinition(id)
      if (!copy) return { success: false, error: '工作流不存在' }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('workflow:deleteRun', async (_event, runId: string) => {
    try {
      const ok = workflowStore.deleteRun(runId)
      return { success: ok, error: ok ? undefined : '运行记录不存在' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // V2: 审批 Gate
  ipcMain.handle('workflow:approveGate', async (_event, runId: string, stepId: string, decision: string, modifiedInput?: string) => {
    try {
      const scheduler = getWorkflowScheduler()
      const ok = scheduler.approveGate(runId, stepId, decision, modifiedInput)
      return { success: ok, error: ok ? undefined : '审批请求不存在' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Desktop Toolbar (桌面任务控制浮层) ──

  const desktopToolMap: Record<string, (args: any) => Promise<any>> = {}

  // 延迟加载 DesktopTools，避免循环依赖
  import('../tool/definitions/DesktopTools')
    .then(({ desktopTools }) => {
      for (const tool of desktopTools) {
        desktopToolMap[tool.name] = tool.handler
      }
      log('INFO', 'desktop_tools_loaded', { count: desktopTools.length })
    })
    .catch((err) => {
      log('WARN', 'desktop_tools_load_failed', { error: String(err) })
    })

  ipcMain.handle('desktop:invokeTool', async (_event, toolName: string, args: Record<string, any>) => {
    try {
      const handler = desktopToolMap[toolName]
      if (!handler) {
        return { success: false, error: `未知工具: ${toolName}` }
      }
      const result = await handler(args)
      // MCPToolResult 格式: { content: [{ type: 'text', text: string }], isError: boolean }
      if (result && typeof result === 'object' && 'content' in result) {
        const text = result.content?.[0]?.text || ''
        return { success: !result.isError, result: text, error: result.isError ? text : undefined }
      }
      return { success: true, result: String(result) }
    } catch (err: any) {
      log('ERROR', 'desktop_invoke_tool_failed', { toolName, error: String(err) })
      return { success: false, error: err.message || String(err) }
    }
  })

  // ── Writing API status ──

  ipcMain.handle('writing:getStatus', async () => {
    const writingApi = credentialsManager.get('writing_api_url') || process.env.WRITING_API_URL || 'https://www.crlkcloud.cyou/writing/api'
    try {
      const res = await fetch(`${writingApi}/stories`)
      const stories: any[] = await res.json()
      const withScenes = await Promise.all(
        stories.slice(0, 20).map(async (s) => {
          try {
            const sr = await fetch(`${writingApi}/scenes?storyId=${s.id}`)
            const scenes = await sr.json()
            return {
              id: s.id,
              title: s.title,
              genre: s.genre,
              sceneCount: Array.isArray(scenes) ? scenes.length : 0,
              createdAt: s.createdAt,
            }
          } catch {
            return { id: s.id, title: s.title, genre: s.genre, sceneCount: 0, createdAt: s.createdAt }
          }
        }),
      )
      return {
        stories: withScenes,
        totalStories: withScenes.length,
        totalScenes: withScenes.reduce((a: number, b: any) => a + b.sceneCount, 0),
      }
    } catch {
      return { stories: [], totalStories: 0, totalScenes: 0 }
    }
  })

  // ── 音频特征提取与氛围映射 ──

  ipcMain.handle('audio:analyzeFeatures', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const samples = new Int16Array(audioBuffer)
      if (samples.length < 512) {
        return { success: false, error: '音频过短，无法提取特征' }
      }
      const features = audioFeatureExtractor.extract(samples)
      const atmosphere = atmosphereMapper.map(features)
      return { success: true, features, atmosphere }
    } catch (err) {
      log('ERROR', 'audio_analyze_features_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ── 语音灵感捕获与情节引导 ──

  ipcMain.handle('writing:inspiration:process', async (_event, text: string) => {
    try {
      const result = await inspirationService.process(text)
      return result
    } catch (err) {
      log('ERROR', 'writing_inspiration_process_failed', { error: String(err) })
      return {
        rawText: text,
        entities: { characters: [], events: [], emotions: [], plotTurns: [] },
        guidedPrompt: text,
        processingMs: 0,
        hasContent: false,
      }
    }
  })

  ipcMain.handle('writing:inspiration:hotwords', async () => {
    try {
      return { hotwords: inspirationService.getWritingHotwords() }
    } catch (err) {
      log('ERROR', 'writing_inspiration_hotwords_failed', { error: String(err) })
      return { hotwords: [] }
    }
  })

  // ── 语音引导的剧情续写 ──

  ipcMain.handle(
    'writing:continuation:execute',
    async (
      _event,
      params: {
        storyName: string
        chapterNum: number
        userVoiceText?: string
        atmosphere?: import('../audio/types').StoryAtmosphere | null
      },
    ) => {
      try {
        const result = await voiceContinuationService.execute(params.storyName, params.chapterNum, params.userVoiceText, params.atmosphere)
        return result
      } catch (err) {
        log('ERROR', 'continuation_execute_failed', { error: String(err), storyName: params.storyName })
        return {
          success: false,
          chapterTitle: `第${params.chapterNum}章`,
          content: '',
          sceneId: null,
          userVoiceText: params.userVoiceText || '',
          atmosphere: params.atmosphere || null,
          error: String(err),
          processingMs: 0,
        }
      }
    },
  )

  ipcMain.handle(
    'writing:continuation:init',
    async (
      _event,
      params: {
        storyName: string
        chapterNum: number
      },
    ) => {
      try {
        const ctx = await voiceContinuationService.initializeContext(params.storyName, params.chapterNum)
        return ctx
      } catch (err) {
        log('ERROR', 'continuation_init_failed', { error: String(err), storyName: params.storyName })
        return {
          storyName: params.storyName,
          chapterNum: params.chapterNum,
          storyId: null,
          previousChapter: null,
          totalChapters: 0,
          readerExpectations: '',
        }
      }
    },
  )

  // ── 行为感知壁纸配置 ──

  ipcMain.handle('wallpaper:getConfig', async () => {
    const getNum = (key: string, fallback: number) => {
      const v = credentialsManager.get(key)
      if (v === null || v === undefined) return fallback
      const n = parseFloat(v)
      return isNaN(n) ? fallback : n
    }

    return {
      enabled: credentialsManager.get('wp_enabled') !== 'false',
      idleOverlay: credentialsManager.get('wp_idle_overlay') !== 'false',
      adaptiveOpacity: credentialsManager.get('wp_adaptive_opacity') !== 'false',
      normalOpacity: getNum('wp_normal_opacity', 0.95),
      codeOpacity: getNum('wp_code_opacity', 0.25),
      fullscreenOpacity: getNum('wp_fullscreen_opacity', 0.15),
      idleOpacity: getNum('wp_idle_opacity', 0.55),
      evoLocked: credentialsManager.get('wp_evo_locked') === 'true',
    }
  })

  ipcMain.handle('wallpaper:setConfig', async (_event, config: Record<string, unknown>) => {
    try {
      for (const [key, value] of Object.entries(config)) {
        const credKey = key
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
          .replace(/^/, 'wp_')
        credentialsManager.set(credKey, String(value))
      }
      return { success: true }
    } catch (err: any) {
      log('WARN', 'wallpaper_config_set_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ── 自进化壁纸锁定 ──
  ipcMain.handle('wallpaper:getEvoLock', async () => {
    const locked = credentialsManager.get('wp_evo_locked') === 'true'
    return { locked }
  })

  ipcMain.handle('wallpaper:setEvoLock', async (_event, locked: boolean) => {
    credentialsManager.set('wp_evo_locked', locked ? 'true' : 'false')
    log('INFO', 'wallpaper_evo_lock_set', { locked })
    return { success: true, locked }
  })

  // ── 壁纸 CSS 热重载 ──
  ipcMain.handle('wallpaper:reloadStyles', async (_event, css: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('wallpaper:styles-updated', css)
    }
    return { success: true }
  })

  // ── 进化计划进度查询 ──
  ipcMain.handle('evolution:planStatus', async () => {
    try {
      const plan = planManagerImport.getActivePlan()
      if (!plan) {
        return { hasActivePlan: false, planTitle: '', totalSteps: 0, completedSteps: 0, percentComplete: 0, currentStep: '' }
      }
      const completedSteps = plan.steps.filter((s: any) => s.status === 'done' || s.status === 'completed').length
      const totalSteps = plan.steps.length
      const currentStep = plan.steps.find((s: any) => s.status === 'in_progress')
      return {
        hasActivePlan: true,
        planTitle: plan.title,
        totalSteps,
        completedSteps,
        percentComplete: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
        currentStep: currentStep?.description || '',
      }
    } catch {
      return { hasActivePlan: false, planTitle: '', totalSteps: 0, completedSteps: 0, percentComplete: 0, currentStep: '' }
    }
  })

  // ══════════════════════════════════════════
  //  排版内容语音校验与预览
  // ══════════════════════════════════════════

  ipcMain.handle('typing:verify', async (_event, formattedText: string) => {
    try {
      const asr = agentService.getAsrService()

      typographyVerificationService.setTranscribeFn(async (pcmInt16: Int16Array) => {
        const result = await asr.transcribe(pcmInt16.buffer as ArrayBuffer)
        return result.text
      })

      const report = await typographyVerificationService.verify(formattedText)

      // 播放合成音频到渲染进程，10s 后清理临时文件
      if (report.audioFile) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('tts:play_audio', report.audioFile)
        }
        const tempFile = report.audioFile
        setTimeout(() => {
          try {
            unlinkSync(tempFile)
          } catch {
            /* already cleaned */
          }
        }, 10000)
      }

      return { success: true, report }
    } catch (err) {
      log('ERROR', 'typing_verify_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('typing:readAloud', async (_event, text: string) => {
    try {
      const result = await typographyVerificationService.readAloud(text)
      if (result.success && result.audioFile) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('tts:play_audio', result.audioFile)
        }
        const tempFile = result.audioFile
        setTimeout(() => {
          try {
            unlinkSync(tempFile)
          } catch {
            /* already cleaned */
          }
        }, 10000)
      }
      return result
    } catch (err) {
      log('ERROR', 'typing_read_aloud_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ── 系统资源监控（由 MonitoringService 定时 push，这里注册 invoke 供按需查询） ──
  ipcMain.handle('health:metrics', async () => {
    const mem = process.memoryUsage()
    return {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      uptime: Math.round(process.uptime()),
      timestamp: Date.now(),
    }
  })

  // ── 桌面记忆浮窗配置 ──
  ipcMain.handle('wallpaper:memoryContextConfig:get', async () => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true }
      return svc.getConfig()
    } catch (err: any) {
      log('WARN', 'memory_context_config_get_failed', { error: String(err) })
      return { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true }
    }
  })

  ipcMain.handle('wallpaper:memoryContextConfig:set', async (_event, patch: Record<string, unknown>) => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { success: false, error: 'MemoryContextService not initialized' }
      svc.saveConfig(patch as any)
      // 配置变更后刷新推送间隔
      svc.stop()
      svc.start()
      return { success: true }
    } catch (err: any) {
      log('WARN', 'memory_context_config_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('wallpaper:memoryContext:refresh', async () => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { success: false, error: 'MemoryContextService not initialized' }
      svc.refresh()
      return { success: true }
    } catch (err: any) {
      log('WARN', 'memory_context_refresh_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ── Evaluation Decision Query API (M5.3) ──

  if (decisionQueryRef) {
    ipcMain.handle('evaluation:getDecision', async (_event, decisionId: string) => {
      const svc = decisionQueryRef.current
      if (!svc) return { state: 'UNAVAILABLE' }
      return svc.getDecision(decisionId)
    })

    ipcMain.handle('evaluation:listByTrace', async (_event, traceId: string) => {
      const svc = decisionQueryRef.current
      if (!svc) return []
      return svc.listByTrace(traceId)
    })
  }

  // ── 文件整理进度可视化控制 ──

  if (organizerRef) {
    ipcMain.handle('organizer:pause', async () => {
      const svc = organizerRef.current
      if (!svc) return { success: false }
      svc.pause()
      return { success: true }
    })

    ipcMain.handle('organizer:resume', async () => {
      const svc = organizerRef.current
      if (!svc) return { success: false }
      svc.resume()
      return { success: true }
    })

    ipcMain.handle('organizer:skip', async () => {
      const svc = organizerRef.current
      if (!svc) return { success: false }
      svc.skipCurrent()
      return { success: true }
    })
  }

  // ── M6.3 Guardrail Metrics Query API ──

  if (metricsQueryRef) {
    ipcMain.handle('guardrail:metrics:summary', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return emptyMetricsSummary()
      return svc.getSummary()
    })

    ipcMain.handle('guardrail:metrics:query', async (_event, since: number, until: number) => {
      const svc = metricsQueryRef.current
      if (!svc) return { windows: [], totalWindows: 0, queryRangeMs: until - since }
      const windows = await svc.queryTimeRange(since, until)
      return { windows, totalWindows: windows.length, queryRangeMs: until - since }
    })

    ipcMain.handle('guardrail:metrics:latest', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return null
      return svc.getLatest()
    })

    // ── 独立的状态 API ──
    ipcMain.handle('guardrail:metrics:state', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return { status: 'UNAVAILABLE', reason: 'GuardrailMetricsQueryService not initialized' }
      return svc.getProjectionState()
    })
  }

  // ══════════════════════════════════════════
  //  快捷任务编排（QuickTask）
  // ══════════════════════════════════════════

  ipcMain.handle('quickTask:getAll', async () => {
    try {
      return { success: true, tasks: quickTaskService.getAllTasks() }
    } catch (err: any) {
      log('ERROR', 'quick_task_get_all_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })

  ipcMain.handle('quickTask:recommendNow', async () => {
    try {
      const tasks = quickTaskService.recommendNow()
      return { success: true, tasks }
    } catch (err: any) {
      log('ERROR', 'quick_task_recommend_now_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })

  ipcMain.handle('quickTask:execute', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'executed')
      if (!task) return { success: false, error: '任务未找到' }
      return { success: true, task }
    } catch (err: any) {
      log('ERROR', 'quick_task_execute_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:dismiss', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'dismissed')
      if (!task) return { success: false, error: '任务未找到' }
      return { success: true, task }
    } catch (err: any) {
      log('ERROR', 'quick_task_dismiss_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:snooze', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'snoozed')
      if (!task) return { success: false, error: '任务未找到' }
      return { success: true, task }
    } catch (err: any) {
      log('ERROR', 'quick_task_snooze_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:edit', async (_event, taskId: string, steps: QuickTaskStep[]) => {
    try {
      const task = quickTaskService.editTask(taskId, steps)
      if (!task) return { success: false, error: '任务未找到' }
      return { success: true, task }
    } catch (err: any) {
      log('ERROR', 'quick_task_edit_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:getSnapshot', async () => {
    try {
      return { success: true, snapshot: quickTaskService.getSnapshot() }
    } catch (err: any) {
      log('ERROR', 'quick_task_snapshot_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:setSensitivity', async (_event, threshold: number) => {
    try {
      quickTaskService.setSensitivityThreshold(threshold)
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_set_sensitivity_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:analyze', async () => {
    try {
      const tasks = quickTaskService.analyze()
      return { success: true, tasks }
    } catch (err: any) {
      log('ERROR', 'quick_task_analyze_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })

  // ── 快捷任务启动入口 ──
  ipcMain.handle('quickTask:start', async () => {
    try {
      quickTaskService.startAutoRecommend()
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_start_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('quickTask:stop', async () => {
    try {
      quickTaskService.stopAutoRecommend()
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_stop_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ══════════════════════════════════════════
  //  角色化语音引擎 IPC
  // ══════════════════════════════════════════

  ipcMain.handle('voice:role:schemes', async () => {
    try {
      const schemes = voiceRoleManager.getSchemes()
      const active = voiceRoleManager.getActiveScheme()
      return { success: true, schemes, activeSchemeId: active.id }
    } catch (err) {
      log('ERROR', 'voice_role_schemes_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:role:setScheme', async (_event, schemeId: string) => {
    try {
      const result = await voiceRoleManager.setActiveScheme(schemeId)
      return result
    } catch (err) {
      log('ERROR', 'voice_role_set_scheme_failed', { error: String(err) })
      return { success: false, message: String(err) }
    }
  })

  ipcMain.handle('voice:role:activeScheme', async () => {
    try {
      const active = voiceRoleManager.getActiveScheme()
      return { success: true, scheme: active }
    } catch (err) {
      log('ERROR', 'voice_role_active_scheme_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('voice:role:roles', async () => {
    try {
      const roles = voiceRoleManager.getRoles()
      return { success: true, roles }
    } catch (err) {
      log('ERROR', 'voice_role_roles_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('voice:role:forTask', async (_event, taskType: string) => {
    try {
      const role = voiceRoleManager.getRoleForTask(taskType as any)
      const params = voiceRoleManager.getTtsParamsForTask(taskType as any)
      return { success: true, role, params }
    } catch (err) {
      log('ERROR', 'voice_role_for_task_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ══════════════════════════════════════════
  //  语音记忆书签 (Voice Bookmark)
  // ══════════════════════════════════════════

  // VoiceBookmarkService 是全局单例，通过 voiceBookmarkServiceRef 访问
  // 在 AppRuntime 中初始化后注入
  if (voiceBookmarkRef) {
    ipcMain.handle('voice-bookmark:create', async (_event, summary: string, conversationContext: any[], options?: any) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
        const bookmark = await svc.createBookmark(summary, conversationContext, options)
        if (!bookmark) return { success: false, error: '创建书签失败' }
        return {
          success: true,
          bookmark: {
            id: bookmark.id,
            summary: bookmark.summary,
            audioPath: bookmark.audioPath,
            tags: bookmark.tags,
            bookmarkedAt: bookmark.bookmarkedAt,
          },
        }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_create_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:list', async (_event, limit?: number, offset?: number) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, bookmarks: [], error: 'VoiceBookmarkService not initialized' }
        const bookmarks = svc.listBookmarks(limit, offset)
        return { success: true, bookmarks }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_list_failed', { error: String(err) })
        return { success: false, bookmarks: [], error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:search', async (_event, query: string) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, bookmarks: [], error: 'VoiceBookmarkService not initialized' }
        const bookmarks = svc.searchBookmarks(query)
        return { success: true, bookmarks }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_search_failed', { error: String(err) })
        return { success: false, bookmarks: [], error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:get', async (_event, id: string) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
        const bookmark = svc.getBookmark(id)
        if (!bookmark) return { success: false, error: '书签未找到' }
        return { success: true, bookmark }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_get_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:delete', async (_event, id: string) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
        const deleted = await svc.deleteBookmark(id)
        return { success: deleted, error: deleted ? undefined : '删除失败或书签未找到' }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_delete_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:audioPath', async (_event, id: string) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
        const audioPath = svc.getAudioPath(id)
        if (!audioPath) return { success: false, error: '音频文件未找到' }
        return { success: true, audioPath }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_audiopath_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:toggleFavorite', async (_event, id: string) => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
        const toggled = svc.toggleFavorite(id)
        return { success: toggled, isFavorite: toggled ? svc.getBookmark(id)?.isFavorite : undefined }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_toggle_favorite_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('voice-bookmark:favorites', async () => {
      try {
        const svc = voiceBookmarkRef.current
        if (!svc) return { success: false, bookmarks: [], error: 'VoiceBookmarkService not initialized' }
        const bookmarks = svc.getFavorites()
        return { success: true, bookmarks }
      } catch (err: any) {
        log('ERROR', 'voice_bookmark_favorites_failed', { error: String(err) })
        return { success: false, bookmarks: [], error: String(err) }
      }
    })
  }
}

function emptyMetricsSummary(): any {
  return {
    totalChecked: 0,
    totalWarning: 0,
    totalTerminated: 0,
    totalContinue: 0,
    totalSignalsHealthy: 0,
    totalSignalsDegrading: 0,
    totalSignalsStalled: 0,
    windowCount: 0,
  }
}
