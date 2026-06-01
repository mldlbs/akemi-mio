import './ort-log'

import { join } from 'path'
import { readFileSync } from 'fs'
import { app } from 'electron'
import { log } from './logger/Logger'
import { StateManager } from './core/StateManager'
import { LlmService } from './llm/LlmService'
import { WhisperGpuEngine } from './asr/WhisperGpuEngine'
import { BaiduEngine } from './asr/BaiduEngine'
import { AsrService } from './asr/AsrService'
import { TtsService } from './tts/TtsService'
import { AgentService } from './agent/AgentService'
import { MemoryService } from './memory/MemoryService'
import { registerHandlers } from './ipc/handlers'
import {
  setupStartupLogging,
  loadEnvFile,
  setupTransformers,
  createWindow,
  initASRWithCache,
  setupWallpaperListener
} from './core/Lifecycle'

setupStartupLogging()
loadEnvFile()
setupTransformers()

const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY

const stateManager = new StateManager()
const llmService = new LlmService()
const gpuEngine = new WhisperGpuEngine()
const baiduEngine = new BaiduEngine()
const asrService = new AsrService(gpuEngine, baiduEngine)
const ttsService = new TtsService((state) => stateManager.update(state))
const agentService = new AgentService(llmService, asrService, ttsService)

log('INFO', 'model_config', {
  asr_model: 'whisper_gpu (Vulkan)',
  gpu: 'RTX 3060',
  vad: true,
  streaming: true,
  hotwords: ['贝斯', '音阶', '空弦', '指型', '把位', '小确幸', '巴赫', '轻音', '和弦', '旋律', '节奏'],
  llm_model: 'deepseek/deepseek-chat',
  llm_key_configured: !!apiKey
})

if (!apiKey) log('WARN', 'missing_api_key')
if (apiKey) llmService.setConfig(apiKey)

registerHandlers(agentService, stateManager, ttsService)

let memoryService: MemoryService | null = null

app.whenReady().then(() => {
  const win = createWindow(stateManager)
  agentService.setMainWindow(win)
  ttsService.setAudioSink((filePath) => {
    try {
      const buf = readFileSync(filePath)
      win.webContents.send('tts:play_audio_buffer', buf)
    } catch {
      win.webContents.send('tts:play_audio', filePath)
    }
  })

  const memoryPath = join(app.getPath('userData'), 'memories.json')
  memoryService = new MemoryService(memoryPath)
  agentService.setMemoryService(memoryService)

  setupWallpaperListener(stateManager)

  // 初始化 GPU Whisper（Vulkan 加速, RTX 3060）
  gpuEngine.initialize('small').then(() => {
    log('INFO', 'gpu_asr_ready')
    stateManager.update({ asr: 'ready', model: 'whisper_gpu (Vulkan)' })
  }).catch((err) => {
    log('WARN', 'gpu_asr_fallback', { error: String(err) })
    // GPU 失败时，回退到百度 ASR
    const baiduKey = process.env.BAIDU_ASR_API_KEY
    const baiduSecret = process.env.BAIDU_ASR_SECRET_KEY
    if (baiduKey && baiduSecret) {
      asrService.setBaiduCredentials(baiduKey, baiduSecret)
      log('INFO', 'baidu_asr_ready')
      stateManager.update({ asr: 'ready', model: 'baidu_asr (fallback)' })
    } else {
      stateManager.update({ error: 'GPU ASR 加载失败，未配置百度备用' })
    }
  })

  app.on('activate', () => {
    if (require('electron').BrowserWindow.getAllWindows().length === 0) {
      createWindow(stateManager)
    }
  })
})

app.on('before-quit', () => {
  memoryService?.flush()
  log('INFO', 'memory_flushed_on_quit')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
