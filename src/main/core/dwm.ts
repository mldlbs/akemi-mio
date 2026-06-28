import koffi from 'koffi'
import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

const DWMWA_NCRENDERING_POLICY = 2
const DWMNCRP_DISABLED = 1

let dwmFunc: ((hwnd: Buffer, attr: number, value: Buffer, size: number) => number) | null = null

function getDwmFunc(): (hwnd: Buffer, attr: number, value: Buffer, size: number) => number {
  if (!dwmFunc) {
    const lib: any = koffi.load('dwmapi.dll')
    lib.func('DwmSetWindowAttribute', 'long', ['void*', 'int', 'void*', 'int'])
    dwmFunc = lib.DwmSetWindowAttribute as (hwnd: Buffer, attr: number, value: Buffer, size: number) => number
  }
  return dwmFunc
}

/**
 * 调用 DwmSetWindowAttribute 禁用 DWM 非客户区渲染策略
 * 从根本上阻止 Windows 11 透明无边框窗口失焦时绘制白边
 */
export function disableNCRendering(win: BrowserWindow): void {
  if (process.platform !== 'win32') return

  try {
    const fn = getDwmFunc()
    const hwnd = win.getNativeWindowHandle() as Buffer
    const policy = Buffer.alloc(4)
    policy.writeInt32LE(DWMNCRP_DISABLED, 0)

    const ret = fn(hwnd, DWMWA_NCRENDERING_POLICY, policy, 4)

    if (ret !== 0) {
      log('WARN', 'DwmSetWindowAttribute_failed', { error: `HRESULT: 0x${(ret >>> 0).toString(16)}` })
    } else {
      log('INFO', 'DwmSetWindowAttribute_ok', {})
    }
  } catch (err) {
    log('ERROR', 'DwmSetWindowAttribute_exception', { error: String(err) })
  }
}
