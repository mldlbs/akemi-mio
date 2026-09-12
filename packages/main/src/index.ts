import './ort-log'
import { app } from 'electron'
import { AppRuntime } from './bootstrap/AppRuntime'

// 禁用 GPU 加速 — 新版本 Electron/Chrome 的 GPU 进程有兼容性问题
app.disableHardwareAcceleration()

// 单实例锁：只允许启动一个实例
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// 远程调试端口 — 用于抓取渲染进程控制台日志
app.commandLine.appendSwitch('remote-debugging-port', '9224')

// 透明窗口：阻止 Chromium 在失焦时暂停合成渲染，防止 DWM 刷白
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// 禁用 GPU 加速避免渲染进程崩溃（Windows 上 GPU 驱动兼容性问题）
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
// 允许 Playwright MCP 启动子进程 Chromium（无头浏览器）
app.commandLine.appendSwitch('no-sandbox')

// 全局崩溃防护
import { log } from '@akemi-mio/core/logger/Logger'
const crashGuard = { flushMemory: null as (() => void) | null }

process.on('uncaughtException', (error) => {
  try {
    log('ERROR', 'crash_uncaught_exception', { error: String(error), stack: error.stack?.slice(0, 500) })
  } catch {}
  try {
    crashGuard.flushMemory?.()
  } catch {}
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  try {
    log('ERROR', 'crash_unhandled_rejection', { reason: String(reason) })
  } catch {}
})

// 启动
const runtime = new AppRuntime(crashGuard)
runtime.start()
