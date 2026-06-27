import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { AgentService } from '../agent/AgentService'
import { StateManager } from '../core/StateManager'
import { TtsService } from '../tts/TtsService'
import { SelfEvolutionService } from '../evolution'
import { credentialsManager } from '../credentials/CredentialsManager'
import { WAKE_WORDS, LLM_API_URL, LLM_CODE_API_URL, LLM_TEXT_API_URL, LLM_VISION_API_URL, WORKSPACE } from '../config'
import { monitorEventLoopDelay } from 'perf_hooks'
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../updater/UpdaterService'
import { MetricsCollector } from '../observability/MetricsCollector'
import { getRecentMessages } from '../db/messages'
import { planManager as planManagerImport } from '../evolution'
import { createAgentWindow, closeAgentWindow } from '../core/Lifecycle'
import { join } from 'path'
import { existsSync } from 'fs'

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
): void {
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string) => {
    try {
      if (agentService.isPaused()) return { reply: '', error: 'PAUSED' }
      return await agentService.processTextInput(text, requestId)
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
      return await asr.transcribe(audioBuffer)
    } catch (err) {
      log('ERROR', 'asr_transcribe_failed', { error: String(err) })
      throw err
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
      ttsService.stop()
    } catch (err) {
      log('ERROR', 'tts_stop_failed', { error: String(err) })
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

  ipcMain.handle('credentials:list', async () => {
    return credentialsManager.list()
  })

  ipcMain.handle('credentials:get', async (_event, name: string) => {
    return credentialsManager.get(name)
  })

  ipcMain.handle('credentials:set', async (_event, name: string, value: string) => {
    credentialsManager.set(name, value)
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
}
