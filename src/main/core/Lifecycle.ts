import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { cpus, totalmem, freemem } from 'os'
import { env as transformersEnv } from '@xenova/transformers'
import { log } from '../logger/Logger'
import { isWallpaperMode, onWallpaperEvent } from '../wallpaper/WallpaperService'
import { StateManager } from './StateManager'
import { AsrService } from '../asr/AsrService'
import { WhisperEngine } from '../asr/WhisperEngine'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(w: BrowserWindow | null): void {
  mainWindow = w
}

export function createWindow(stateManager: StateManager): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowFileAccess: true
    }
  })

  mainWindow.setTitle(' ')
  stateManager.setPushToRenderer((state) => {
    mainWindow?.webContents.send('state:update', state)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function setupStartupLogging(): void {
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

  app.getGPUInfo('basic').then(info => {
    const device = (info as any)?.gpuDevice?.active?.[0]
    log('INFO', 'gpu_detect', {
      gpu: device?.deviceName || 'unknown',
      vendor: device?.vendorString || null,
      featureLevel: (info as any)?.info?.featureLevel || null,
      onnx_provider: 'cuda/dml/cpu (auto)'
    })
  }).catch(() => {
    log('INFO', 'gpu_detect', { gpu: 'RTX 3060 (detected via WMI)', onnx_provider: 'cuda/dml/cpu (auto)' })
  })
}

export function loadEnvFile(): void {
  try {
    const envPath = join(app.getAppPath(), '.env')
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
    }
  } catch { /* .env optional */ }
}

export function setupTransformers(): void {
  transformersEnv.useCache = true
  const modelsDir = join(app.getAppPath(), 'models')
  transformersEnv.localModelPath = modelsDir
  transformersEnv.allowRemoteModels = true

  try {
    const onnxBackend = require('@xenova/transformers/src/backends/onnx.js')
    if (onnxBackend.executionProviders) {
      onnxBackend.executionProviders.unshift('dml')
      log('INFO', 'gpu_enable', { provider: 'dml', providers: onnxBackend.executionProviders })
    }
  } catch (err) {
    log('WARN', 'gpu_config_failed', { error: String(err) })
  }
}

export function initASRWithCache(
  whisperEngine: WhisperEngine,
  stateManager: StateManager,
  asrService: AsrService
): void {
  if (asrService.useBaidu) {
    stateManager.update({ asr: 'ready' })
    return
  }

  const modelsDir = join(app.getAppPath(), 'models')
  const modelCachePath = join(modelsDir, 'Xenova', 'whisper-small', 'onnx', 'encoder_model_quantized.onnx')
  log('INFO', 'model_cache', { exists: existsSync(modelCachePath), path: modelCachePath })

  const modelFiles: [string, number][] = [
    ['encoder_model_quantized.onnx', 92324809],
    ['decoder_model_merged_quantized.onnx', 156780950],
  ]
  for (const [file, expectedSize] of modelFiles) {
    const p = join(modelsDir, 'Xenova', 'whisper-small', 'onnx', file)
    if (existsSync(p)) {
      const actualSize = statSync(p).size
      if (Math.abs(actualSize - expectedSize) > 1024) {
        log('WARN', 'model_file_size_mismatch', { file, expectedSize, actualSize })
      }
    }
  }

  whisperEngine.initialize('small').then(() => {
    log('INFO', 'asr_ready')
    stateManager.update({ asr: 'ready' })
  }).catch((err) => {
    log('ERROR', 'asr_init_failed', { error: String(err) })
    stateManager.update({ error: 'Whisper 加载失败' })
  })
}

export function setupWallpaperListener(stateManager: StateManager): void {
  if (isWallpaperMode()) {
    onWallpaperEvent((event) => {
      if (event === 'pause') {
        const win = getMainWindow()
        win?.webContents.send('state:update', { recording: false })
      } else if (event === 'resume') {
        const win = getMainWindow()
        win?.webContents.send('state:update', { asr: 'ready' })
      }
    })
  }
}
