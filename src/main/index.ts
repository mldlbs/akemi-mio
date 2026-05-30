// ← MUST BE FIRST: ONNX Runtime log severity (3=ERROR, suppresses "Removing initializer" warnings)
import './ort-log'

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { cpus, totalmem, freemem } from 'os'
import { isWallpaperMode, onWallpaperEvent } from './wallpaper'
import { initASR, transcribe as asrTranscribe, getASRStatus, getModelInfo } from './whisper'
import { chatStream, clearContext, setConfig } from './ai'
import { speak as ttsSpeak, stop as ttsStop, setMainWindow as ttsSetWindow, addTTSChunk, flushTTSBuffer } from './tts'
import { env as transformersEnv } from '@xenova/transformers'
import { log, createRequestId } from './logger'

log('INFO', 'startup', {
  project: 'akemi-mio',
  version: '1.0.0',
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch
})

const cpuInfo = cpus()
log('INFO', 'system_info', {
  cpu: cpuInfo[0]?.model?.trim() || 'unknown',
  cores: cpuInfo.length,
  memory_gb: parseFloat((totalmem() / (1024 ** 3)).toFixed(1)),
  free_memory_gb: parseFloat((freemem() / (1024 ** 3)).toFixed(1))
})

// GPU detection (async, best-effort)
app.getGPUInfo('basic').then(info => {
  const device = (info as any)?.gpuDevice?.active?.[0]
  log('INFO', 'gpu_detect', {
    gpu: device?.deviceName || null,
    vendor: device?.vendorString || null,
    featureLevel: (info as any)?.info?.featureLevel || null,
    onnx_provider: 'CPU' // CUDA/DirectML not installed
  })
}).catch(() => {
  log('INFO', 'gpu_detect', { gpu: null, onnx_provider: 'CPU', note: 'GPU info unavailable' })
})

const modelsDir = join(app.getAppPath(), 'models')
transformersEnv.localModelPath = modelsDir
transformersEnv.allowRemoteModels = false

try {
  const envPath = join(app.getAppPath(), '.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
} catch { /* .env optional */ }

const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY

log('INFO', 'model_config', {
  asr_model: 'whisper-medium',
  quantized: 'int8',
  execution_provider: 'CPU',
  vad: true,
  streaming: true,
  hotwords: ['Agent', 'MCP', 'LangGraph', 'Claude', 'Cursor', 'OpenRouter', 'GitHub', 'API'],
  llm_model: 'deepseek/deepseek-chat',
  llm_key_configured: !!apiKey
})

if (!apiKey) log('WARN', 'missing_api_key')
if (apiKey) setConfig(apiKey)

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: isWallpaperMode(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  ttsSetWindow(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string) => {
  const t0 = Date.now()
  const rid = requestId || createRequestId()
  try {
    const result = await chatStream(text, (chunk) => {
      mainWindow?.webContents.send('ai:chunk', chunk)
      addTTSChunk(chunk)
    }, rid)
    log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: result.reply?.length || 0 })
    return result
  } catch (err) {
    log('ERROR', 'chat_handler_error', { request_id: rid, error: String(err) })
    return { error: 'INTERNAL' }
  }
})

ipcMain.handle('tts:speak', async (_event, text: string) => {
  log('PERF', 'tts_speak', { char_count: text.length })
  await ttsSpeak(text)
})

ipcMain.handle('tts:stop', async () => {
  ttsStop()
})

ipcMain.handle('state:get', async () => {
  const s = getASRStatus()
  return { asr: s.loaded ? 'ready' : s.loading ? 'loading' : 'unloaded', model: getModelInfo() }
})

let pendingRequests = 0

ipcMain.handle('asr:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
  const rid = createRequestId()
  pendingRequests++
  if (pendingRequests > 1) {
    log('WARN', 'queue_status', { request_id: rid, pending_requests: pendingRequests, warning: 'concurrent ASR requests detected' })
  }

  const status = getASRStatus()
  if (!status.loaded) {
    if (status.loading) { pendingRequests--; return { text: '', error: '模型加载中...' } }
    try {
      log('INFO', 'asr_lazy_init_start', { request_id: rid })
      await initASR('medium')
    } catch (err) {
      pendingRequests--
      log('ERROR', 'asr_lazy_init_failed', { request_id: rid, error: String(err) })
      return { text: '', error: `Whisper 加载失败: ${err}` }
    }
  }

  try {
    const samples = new Int16Array(audioBuffer)
    const float32 = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 32768
    log('INFO', 'asr_audio_prepared', {
      request_id: rid,
      sample_count: samples.length,
      audio_len_s: parseFloat((float32.length / 16000).toFixed(1))
    })
    const result = await asrTranscribe(float32, 30000, rid)
    pendingRequests--
    return { text: result.text, request_id: result.request_id }
  } catch (err) {
    pendingRequests--
    const msg = err instanceof Error ? err.message : String(err)
    log('ERROR', 'asr_transcribe_error', { request_id: rid, error: msg })
    return { text: '', error: msg }
  }
})

app.whenReady().then(() => {
  if (isWallpaperMode()) {
    onWallpaperEvent((event) => {
      if (event === 'pause') mainWindow?.webContents.send('state:update', { recording: false })
      else if (event === 'resume') mainWindow?.webContents.send('state:update', { asr: 'ready' })
    })
  }

  createWindow()

  const modelCachePath = join(modelsDir, 'Xenova', 'whisper-medium', 'onnx', 'encoder_model_quantized.onnx')
  log('INFO', 'model_cache', { exists: existsSync(modelCachePath), path: modelCachePath })

  initASR('medium').then(() => {
    log('INFO', 'asr_ready')
    mainWindow?.webContents.send('state:update', { asr: 'ready' })
  }).catch((err) => {
    log('ERROR', 'asr_init_failed', { error: String(err) })
    mainWindow?.webContents.send('state:update', { error: 'Whisper 加载失败' })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
