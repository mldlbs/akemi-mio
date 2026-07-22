import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../../logger/Logger'
import { credentialsManager } from '../../credentials/CredentialsManager'
import { voiceRoleManager } from '../../tts/VoiceRoleManager'
import type { HandlerContext } from './context'

export function registerTtsHandlers({ agentService, ttsService }: HandlerContext): void {
  ipcMain.handle('tts:speak', async (_event, text: string) => {
    try { log('PERF', 'tts_speak', { char_count: text.length }); await ttsService.speak(text) }
    catch (err) { log('ERROR', 'tts_speak_failed', { error: String(err) }); throw err }
  })

  ipcMain.handle('tts:stop', async () => {
    try { ttsService.recordImplicitFeedback('SKIP'); ttsService.stop() }
    catch (err) { log('ERROR', 'tts_stop_failed', { error: String(err) }) }
  })

  // Emotion
  ipcMain.handle('tts:emotion:toggle', async (_event, enabled: boolean) => {
    try { agentService.getChatExecutor()?.toggleEmotionTts(enabled); log('INFO', 'tts_emotion_toggle_ipc', { enabled }); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_emotion_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:emotion:state', async () => {
    try { const c = agentService.getChatExecutor(); return c ? { success: true, ...c.getEmotionTtsState() } : { success: true, enabled: false, params: null } }
    catch (err) { log('ERROR', 'tts_emotion_state_failed', { error: String(err) }); return { success: false } }
  })

  // Behavior emotion
  ipcMain.handle('tts:behaviorEmotion:toggle', async (_event, enabled: boolean) => {
    try { agentService.getChatExecutor()?.toggleBehaviorEmotion(enabled); log('INFO', 'tts_behavior_emotion_toggle_ipc', { enabled }); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_behavior_emotion_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:behaviorEmotion:state', async () => {
    try { const c = agentService.getChatExecutor(); return c ? { success: true, ...c.getBehaviorEmotionState() } : { success: true, enabled: false, result: null, metrics: null } }
    catch (err) { log('ERROR', 'tts_behavior_emotion_state_failed', { error: String(err) }); return { success: false } }
  })

  // Implicit feedback
  ipcMain.handle('tts:implicitFeedback:recordAction', async (_event, action: string) => {
    try {
      const valid = ['REPLAY','SKIP','INTERRUPT_SPEECH','CONTINUE_CONVERSATION','MODIFY_REQUEST','COMPLETED_NATURALLY']
      if (!valid.includes(action)) return { success: false, error: '无效的反馈动作: ' + action }
      ttsService.recordImplicitFeedback(action as any); return { success: true }
    } catch (err) { log('ERROR', 'tts_implicit_feedback_record_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:implicitFeedback:toggle', async (_event, enabled: boolean) => {
    try { agentService.getChatExecutor()?.toggleImplicitFeedback(enabled); log('INFO', 'tts_implicit_feedback_toggle_ipc', { enabled }); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_implicit_feedback_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:implicitFeedback:state', async () => {
    try {
      const c = agentService.getChatExecutor()
      return c ? { success: true, ...c.getImplicitFeedbackState() } : { success: true, enabled: false, recommendation: null, status: { modelInitialized: false, totalSamples: 0, historySize: 0 } }
    } catch (err) { log('ERROR', 'tts_implicit_feedback_state_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:implicitFeedback:updateModel', async () => {
    try { agentService.getChatExecutor()?.triggerImplicitFeedbackUpdate(); return { success: true } }
    catch (err) { log('ERROR', 'tts_implicit_feedback_update_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:implicitFeedback:reset', async () => {
    try { agentService.getChatExecutor()?.resetImplicitFeedback(); return { success: true } }
    catch (err) { log('ERROR', 'tts_implicit_feedback_reset_failed', { error: String(err) }); return { success: false } }
  })

  // Contextual TTS
  ipcMain.handle('tts:contextual:toggle', async (_event, enabled: boolean) => {
    try { agentService.getChatExecutor()?.toggleContextualTts(enabled); log('INFO', 'tts_contextual_toggle_ipc', { enabled }); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_contextual_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:contextual:state', async () => {
    try { const c = agentService.getChatExecutor(); return c ? { success: true, ...c.getContextualTtsState() } : { success: true, enabled: false, context: null } }
    catch (err) { log('ERROR', 'tts_contextual_state_failed', { error: String(err) }); return { success: false } }
  })

  // Engine preference
  ipcMain.handle('tts:engine-preference:set', async (_event, pref: string) => {
    try {
      if (!['auto','cloud','local'].includes(pref)) return { success: false, error: '无效的引擎偏好: ' + pref }
      ttsService.setEnginePreference(pref as any)
      credentialsManager.set('tts_mode', pref)
      return { success: true, preference: pref }
    } catch (err) { log('ERROR', 'tts_engine_preference_set_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:engine-preference:get', async () => {
    try { return { success: true, preference: ttsService.getEnginePreference() } }
    catch (err) { log('ERROR', 'tts_engine_preference_get_failed', { error: String(err) }); return { success: false } }
  })

  // Subtitle callback
  ttsService.setSubtitleCallback((data) => {
    const wins = BrowserWindow.getAllWindows()
    const emotionParams = ttsService.getEmotionParams()
    const voiceState = { state: 'speaking' as const, emotionParams, text: data.text, timestamp: Date.now(), estimatedDurationMs: data.estimatedDurationMs }
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
    try { return { success: true, preference: ttsService.getEnginePreference(), lastDecision: ttsService.getLastRoutingDecision(), weights: ttsService.getRoutingWeights() } }
    catch (err) { log('ERROR', 'tts_router_state_failed', { error: String(err) }); return { success: false } }
  })

  // User context
  ipcMain.handle('tts:userContext:toggle', async (_event, enabled: boolean) => {
    try { agentService.getChatExecutor()?.toggleUserContextClassifier(enabled); log('INFO', 'tts_user_context_toggle_ipc', { enabled }); return { success: true, enabled } }
    catch (err) { log('ERROR', 'tts_user_context_toggle_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:userContext:state', async () => {
    try { const c = agentService.getChatExecutor(); return c ? { success: true, ...c.getUserContextState() } : { success: true, enabled: false, result: null } }
    catch (err) { log('ERROR', 'tts_user_context_state_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('tts:userContext:override', async (_event, mode: string) => {
    try {
      if (!['auto','manual_work','manual_leisure','manual_rest'].includes(mode)) return { success: false, error: '无效的情境覆盖模式: ' + mode }
      agentService.getChatExecutor()?.setUserContextOverride(mode as any); log('INFO', 'tts_user_context_override_ipc', { mode }); return { success: true, mode }
    } catch (err) { log('ERROR', 'tts_user_context_override_failed', { error: String(err) }); return { success: false } }
  })

  // Scene adaptor
  ipcMain.handle('tts:scene:config', async () => {
    try { return { success: true, status: ttsService.getSceneAdaptorStatus(), learningData: ttsService.getSceneLearningData(), overrideMode: ttsService.getSceneOverride() } }
    catch (err) { log('ERROR', 'tts_scene_config_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:scene:override', async (_event, mode: string) => {
    try { ttsService.setSceneOverride(mode); log('INFO', 'tts_scene_override_ipc', { mode }); return { success: true, mode } }
    catch (err) { log('ERROR', 'tts_scene_override_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:scene:resetLearning', async () => {
    try { ttsService.resetSceneLearningData(); log('INFO', 'tts_scene_learning_reset_ipc'); return { success: true } }
    catch (err) { log('ERROR', 'tts_scene_learning_reset_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  // Replay & loop
  ipcMain.handle('tts:replay', async () => {
    try { return { success: await ttsService.replay() } }
    catch (err) { log('ERROR', 'tts_replay_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:replay:hasContent', async () => ({ hasContent: ttsService.hasReplayContent() }))

  ipcMain.handle('tts:loop:set', async (_event, enabled: boolean, intervalMs?: number, maxCount?: number) => {
    try { ttsService.setLoopMode(enabled, intervalMs, maxCount); return { success: true, enabled, intervalMs, maxCount } }
    catch (err) { log('ERROR', 'tts_loop_set_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('tts:loop:state', async () => ({ enabled: ttsService.isLoopMode(), hasReplayContent: ttsService.hasReplayContent() }))

  // Voice role
  ipcMain.handle('voice:role:schemes', async () => {
    try { return { success: true, schemes: voiceRoleManager.getSchemes(), activeSchemeId: voiceRoleManager.getActiveScheme().id } }
    catch (err) { log('ERROR', 'voice_role_schemes_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('voice:role:setScheme', async (_event, schemeId: string) => {
    try { return await voiceRoleManager.setActiveScheme(schemeId) }
    catch (err) { log('ERROR', 'voice_role_setscheme_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('voice:role:activeScheme', async () => {
    try { return { success: true, scheme: voiceRoleManager.getActiveScheme() } }
    catch (err) { log('ERROR', 'voice_role_activescheme_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('voice:role:roles', async () => {
    try { return { success: true, roles: voiceRoleManager.getRoles() } }
    catch (err) { log('ERROR', 'voice_role_roles_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('voice:role:forTask', async (_event, taskType: string) => {
    try { const r = voiceRoleManager.selectRoleForTask(taskType); return { success: true, ...r } }
    catch (err) { log('ERROR', 'voice_role_for_task_failed', { error: String(err) }); return { success: false } }
  })
}
