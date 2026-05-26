import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { isWallpaperMode, onWallpaperEvent } from './wallpaper'
import { decodeWebMToPCM } from './audio'
import { initASR, transcribe as asrTranscribe, getASRStatus } from './whisper'
import { chat as aiChat, clearContext, setConfig } from './ai'
import { speak as ttsSpeak, stop as ttsStop } from './tts'

const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY
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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('asr:transcribe', async (_event, audioData: ArrayBuffer) => {
  try {
    const pcm = await decodeWebMToPCM(audioData)
    const result = await asrTranscribe(pcm)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'timeout') return { text: '', duration: -1 }
    return { text: '', duration: -2, error: message }
  }
})

ipcMain.handle('ai:chat', async (_event, text: string) => {
  try {
    return await aiChat(text)
  } catch (err) {
    return { error: 'INTERNAL' }
  }
})

ipcMain.handle('tts:speak', async (_event, text: string) => {
  await ttsSpeak(text)
})
ipcMain.handle('tts:stop', async () => {
  ttsStop()
})

ipcMain.handle('state:get', async () => {
  return { asr: getASRStatus().loaded ? 'ready' : 'loading' }
})

app.whenReady().then(() => {
  if (isWallpaperMode()) {
    onWallpaperEvent((event) => {
      if (event === 'pause') {
        mainWindow?.webContents.send('state:update', { recording: false })
      } else if (event === 'resume') {
        mainWindow?.webContents.send('state:update', { asr: 'ready' })
      }
    })
  }

  initASR('tiny').catch(() => {
    mainWindow?.webContents.send('state:update', { error: 'ASR init failed' })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
