import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { isWallpaperMode, onWallpaperEvent } from './wallpaper'

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

ipcMain.handle('asr:transcribe', async (_event, _audio: Float32Array) => {
  return { text: '', duration: 0 }
})

ipcMain.handle('ai:chat', async (_event, _text: string) => {
  return { reply: '' }
})

ipcMain.handle('tts:speak', async (_event, _text: string) => {})
ipcMain.handle('tts:stop', async () => {})

ipcMain.handle('state:get', async () => {
  return { asr: 'unloaded' }
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
