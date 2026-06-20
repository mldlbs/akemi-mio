import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

let mainWindow: BrowserWindow | null = null

export function setUpdateWindow(win: BrowserWindow): void {
  mainWindow = win
}

function sendStatus(channel: string, payload: Record<string, unknown> = {}): void {
  mainWindow?.webContents.send('update:status', { channel, ...payload })
}

export function initUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true

  autoUpdater.on('checking-for-update', () => {
    log('INFO', 'update_checking')
    sendStatus('checking')
  })

  autoUpdater.on('update-available', (info) => {
    log('INFO', 'update_available', { version: info.version, releaseDate: info.releaseDate })
    sendStatus('available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: (info as any).releaseNotes,
    })
  })

  autoUpdater.on('update-not-available', () => {
    log('INFO', 'update_not_available')
    sendStatus('not-available')
  })

  autoUpdater.on('error', (err) => {
    log('WARN', 'update_error', { error: err.message })
    sendStatus('error', { message: err.message })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log('INFO', 'update_downloaded', { version: info.version })
    sendStatus('downloaded', { version: info.version })
  })

  // 延迟检查，避免启动时占用带宽
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log('WARN', 'update_check_failed', { error: err.message })
    })
  }, 10_000)
}

export async function checkForUpdates(): Promise<{ available: boolean; version?: string }> {
  try {
    const result = await autoUpdater.checkForUpdates()
    const available = result?.updateInfo?.version != null && result.updateInfo.version !== autoUpdater.currentVersion
    return { available, version: result?.updateInfo?.version }
  } catch {
    return { available: false }
  }
}

export async function downloadUpdate(): Promise<void> {
  // electron-updater 要求先 check 才能 download
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result?.updateInfo?.version && result.updateInfo.version !== autoUpdater.currentVersion) {
      autoUpdater.downloadUpdate()
    }
  } catch (err) {
    log('WARN', 'update_check_before_download_failed', { error: String(err) })
    throw err
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
