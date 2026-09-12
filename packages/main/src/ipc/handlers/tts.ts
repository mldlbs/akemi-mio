import { ipcMain, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { voiceRoleManager } from '@akemi-mio/audio/VoiceRoleManager'
import type { TaskRoleType } from '@akemi-mio/audio/VoiceRoleTypes'
import { emotionToneMap } from '@akemi-mio/audio/EmotionToneMap'
import { emotionalNarrativeService } from '@akemi-mio/audio/emotion/EmotionalNarrativeService'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import type { HandlerContext } from './context'

export function registerTtsHandlers({ agentService, ttsService }: HandlerContext): void {
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
      ttsService.recordImplicitFeedback('SKIP')
      ttsService.stop()
    } catch (err) {
      log('ERROR', 'tts_stop_failed', { error: String(err) })
    }
  })

  // Emotion
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
      const c = agentService.getChatExecutor()
      return c ? { success: true, ...c.getEmotionTtsState() } : { success: true, enabled: false, params: null }
    } catch (err) {
      log('ERROR', 'tts_emotion_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // Behavior emotion
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
      const c = agentService.getChatExecutor()
      return c ? { success: true, ...c.getBehaviorEmotionState() } : { success: true, enabled: false, result: null, metrics: null }
    } catch (err) {
      log('ERROR', 'tts_behavior_emotion_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  /** 记录一次撤回/重做操作（用户撤销消息、回退工具调用等），用于行为情绪推断 */
  ipcMain.handle('tts:behaviorEmotion:recordRetraction', async () => {
    try {
      const chatExecutor = agentService.getChatExecutor()
      if (!chatExecutor) return { success: false, error: 'chatExecutor not ready' }
      chatExecutor.recordBehaviorRetraction()
      log('INFO', 'behavior_emotion_retraction_recorded')
      return { success: true }
    } catch (err) {
      log('WARN', 'behavior_emotion_retraction_record_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // Implicit feedback
  ipcMain.handle('tts:implicitFeedback:recordAction', async (_event, action: string) => {
    try {
      const valid = ['REPLAY', 'SKIP', 'INTERRUPT_SPEECH', 'CONTINUE_CONVERSATION', 'MODIFY_REQUEST', 'COMPLETED_NATURALLY']
      if (!valid.includes(action)) return { success: false, error: '无效的反馈动作: ' + action }
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
      const c = agentService.getChatExecutor()
      return c
        ? { success: true, ...c.getImplicitFeedbackState() }
        : { success: true, enabled: false, recommendation: null, status: { modelInitialized: false, totalSamples: 0, historySize: 0 } }
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

  // Contextual TTS
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
      const c = agentService.getChatExecutor()
      return c ? { success: true, ...c.getContextualTtsState() } : { success: true, enabled: false, context: null }
    } catch (err) {
      log('ERROR', 'tts_contextual_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // Engine preference
  ipcMain.handle('tts:engine-preference:set', async (_event, pref: string) => {
    try {
      if (!['auto', 'cloud', 'local'].includes(pref)) return { success: false, error: '无效的引擎偏好: ' + pref }
      ttsService.setEnginePreference(pref as any)
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

  // Subtitle callback
  ttsService.setSubtitleCallback((data) => {
    const wins = BrowserWindow.getAllWindows()
    const emotionParams = ttsService.getEmotionParams()
    const voiceState = {
      state: 'speaking' as const,
      emotionParams,
      text: data.text,
      timestamp: Date.now(),
      estimatedDurationMs: data.estimatedDurationMs,
    }
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send('tts:subtitle', data)
        win.webContents.send('tts:voice-state', voiceState)
      }
    }
  })

  ipcMain.handle('tts:subtitle:getEnabled', async () => ({ enabled: credentialsManager.get('tts_subtitle_enabled') !== 'false' }))

  ipcMain.handle('tts:subtitle:setEnabled', async (_event, enabled: boolean) => {
    credentialsManager.set('tts_subtitle_enabled', enabled ? 'true' : 'false')
    log('INFO', 'tts_subtitle_enabled', { enabled })
    return { success: true, enabled }
  })

  ipcMain.handle('tts:router-state', async () => {
    try {
      return {
        success: true,
        preference: ttsService.getEnginePreference(),
        lastDecision: ttsService.getLastRoutingDecision(),
        weights: ttsService.getRoutingWeights(),
      }
    } catch (err) {
      log('ERROR', 'tts_router_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ══════════════════════════════════════════
  //  QoS 服务质量评估（混合引擎）
  // ══════════════════════════════════════════

  ipcMain.handle('tts:qos:status', async () => {
    try { return { success: true, status: ttsService.getQosFullStatus() } }
    catch (err) { log('ERROR', 'tts_qos_status_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:qos:refresh', async () => {
    try {
      const score = await ttsService.refreshQosScore()
      return { success: true, score }
    } catch (err) { log('ERROR', 'tts_qos_refresh_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:qos:toggle', async (_event, enabled: boolean) => {
    try { ttsService.setQosEnabled(enabled); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_qos_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:preload:status', async () => {
    try { return { success: true, state: ttsService.getPreloadBufferState() } }
    catch (err) { log('ERROR', 'tts_preload_status_failed', { error: String(err) }); return { success: false } }
  })

  // User context
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
      const c = agentService.getChatExecutor()
      return c ? { success: true, ...c.getUserContextState() } : { success: true, enabled: false, result: null }
    } catch (err) {
      log('ERROR', 'tts_user_context_state_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('tts:userContext:override', async (_event, mode: string) => {
    try {
      if (!['auto', 'manual_work', 'manual_leisure', 'manual_rest'].includes(mode))
        return { success: false, error: '无效的情境覆盖模式: ' + mode }
      agentService.getChatExecutor()?.setUserContextOverride(mode as any)
      log('INFO', 'tts_user_context_override_ipc', { mode })
      return { success: true, mode }
    } catch (err) {
      log('ERROR', 'tts_user_context_override_failed', { error: String(err) })
      return { success: false }
    }
  })

  // Scene adaptor
  ipcMain.handle('tts:scene:config', async () => {
    try {
      return {
        success: true,
        status: ttsService.getSceneAdaptorStatus(),
        learningData: ttsService.getSceneLearningData(),
        overrideMode: ttsService.getSceneOverride(),
      }
    } catch (err) {
      log('ERROR', 'tts_scene_config_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:scene:override', async (_event, mode: string) => {
    try {
      ttsService.setSceneOverride(mode)
      log('INFO', 'tts_scene_override_ipc', { mode })
      return { success: true, mode }
    } catch (err) {
      log('ERROR', 'tts_scene_override_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:scene:resetLearning', async () => {
    try {
      ttsService.resetSceneLearningData()
      log('INFO', 'tts_scene_learning_reset_ipc')
      return { success: true }
    } catch (err) {
      log('ERROR', 'tts_scene_learning_reset_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // Replay & loop
  ipcMain.handle('tts:replay', async () => {
    try {
      return { success: await ttsService.replay() }
    } catch (err) {
      log('ERROR', 'tts_replay_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:replay:hasContent', async () => ({ hasContent: ttsService.hasReplayContent() }))

  ipcMain.handle('tts:loop:set', async (_event, enabled: boolean, intervalMs?: number, maxCount?: number) => {
    try {
      ttsService.setLoopMode(enabled, intervalMs, maxCount)
      return { success: true, enabled, intervalMs, maxCount }
    } catch (err) {
      log('ERROR', 'tts_loop_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:loop:state', async () => ({ enabled: ttsService.isLoopMode(), hasReplayContent: ttsService.hasReplayContent() }))

  // Voice role
  ipcMain.handle('voice:role:schemes', async () => {
    try {
      return { success: true, schemes: voiceRoleManager.getSchemes(), activeSchemeId: voiceRoleManager.getActiveScheme().id }
    } catch (err) {
      log('ERROR', 'voice_role_schemes_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:role:setScheme', async (_event, schemeId: string) => {
    try {
      return await voiceRoleManager.setActiveScheme(schemeId)
    } catch (err) {
      log('ERROR', 'voice_role_setscheme_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:role:activeScheme', async () => {
    try {
      return { success: true, scheme: voiceRoleManager.getActiveScheme() }
    } catch (err) {
      log('ERROR', 'voice_role_activescheme_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:role:roles', async () => {
    try {
      return { success: true, roles: voiceRoleManager.getRoles() }
    } catch (err) {
      log('ERROR', 'voice_role_roles_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice:role:forTask', async (_event, taskType: string) => {
    try {
      const r = voiceRoleManager.getRoleForTask(taskType as TaskRoleType)
      return { success: true, ...r }
    } catch (err) {
      log('ERROR', 'voice_role_for_task_failed', { error: String(err) })
      return { success: false }
    }
  })

  // ══════════════════════════════════════════
  //  Emotion Mapping — 用户自定义情感映射
  // ══════════════════════════════════════════

  ipcMain.handle(
    'tts:emotionMapping:set',
    async (_event, key: string, params: { voice: string; rate: string; pitch: string; label: string }) => {
      try {
        emotionToneMap.setUserOverride(key, params)
        log('INFO', 'emotion_mapping_set_ipc', { key })
        return { success: true }
      } catch (err) {
        log('ERROR', 'emotion_mapping_set_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    },
  )

  ipcMain.handle('tts:emotionMapping:remove', async (_event, key: string) => {
    try {
      const removed = emotionToneMap.removeUserOverride(key)
      return { success: removed }
    } catch (err) {
      log('ERROR', 'emotion_mapping_remove_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:emotionMapping:getAll', async () => {
    try {
      const builtin = emotionToneMap.getAllMappings()
      const overrides = emotionToneMap.getAllUserOverrides()
      return { success: true, builtin, overrides }
    } catch (err) {
      log('ERROR', 'emotion_mapping_get_all_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('tts:emotionMapping:clear', async () => {
    try {
      emotionToneMap.clearUserOverrides()
      log('INFO', 'emotion_mapping_clear_ipc')
      return { success: true }
    } catch (err) {
      log('ERROR', 'emotion_mapping_clear_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ══════════════════════════════════════════
  //  情感记忆语音叙事
  // ══════════════════════════════════════════

  // 注册叙事事件回调 → 转发到渲染进程
  const notifyWindows = (channel: string, data: unknown) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  emotionalNarrativeService.setCallbacks({
    onStart: (event) => notifyWindows('emotional-narrative:start', event),
    onSegment: (event) => notifyWindows('emotional-narrative:segment', event),
    onEnd: (event) => notifyWindows('emotional-narrative:end', event),
    onCancel: () => notifyWindows('emotional-narrative:cancel', {}),
  })

  ipcMain.handle('emotional-narrative:trigger', async () => {
    try {
      const ms = getMemoryService()
      if (!ms) return { success: false, error: 'memory service not ready' }

      // 注入 TtsService（惰性注入，防止循环依赖）
      emotionalNarrativeService.setTtsService(ttsService)

      const result = await emotionalNarrativeService.triggerNarration(ms)
      log('INFO', 'emotional_narrative_trigger_ipc', { result })
      return { success: result.success, message: result.message }
    } catch (err) {
      log('ERROR', 'emotional_narrative_trigger_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('emotional-narrative:cancel', async () => {
    try {
      emotionalNarrativeService.cancel()
      log('INFO', 'emotional_narrative_cancel_ipc')
      return { success: true }
    } catch (err) {
      log('ERROR', 'emotional_narrative_cancel_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('emotional-narrative:state', async () => {
    try {
      return {
        success: true,
        state: emotionalNarrativeService.state,
        currentSegment: emotionalNarrativeService.currentSegment,
        totalSegments: emotionalNarrativeService.totalSegments,
        isActive: emotionalNarrativeService.isActive,
      }
    } catch (err) {
      log('ERROR', 'emotional_narrative_state_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('emotional-narrative:context', async () => {
    try {
      const ms = getMemoryService()
      if (!ms) return { success: false, error: 'memory service not ready' }
      const summary = emotionalNarrativeService.getContextSummary(ms)
      return { success: true, summary }
    } catch (err) {
      log('ERROR', 'emotional_narrative_context_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  log('INFO', 'emotional_narrative_handlers_registered')
}
