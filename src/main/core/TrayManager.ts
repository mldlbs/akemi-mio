import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

// 32×32 PNG 托盘图标（与 build/icon.ico 一致，取自同一图标文件）
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAFYUlEQVR4nO1XfUwURxQ/OK3Waqo1FUXkbmb3dmf2Dq2Fgpx3O7N3qFRAqXZjCsS0JcXamrRGlGKKSxRrGkwrikRoDFAV9QxaabU2qaI1jZGatIm0SS2N/YjxEwWsIhx30+x94Nn+U77+afwl87k77/3ee7NvZg2GxxgUVKPBwKKCfS06WAz6ODQ3sojqbwkZ9eijfjIjB55PHyPaSBKw0qVQICs5rBQi5BZiYuY9FUFuZEioqmoUZ7qXcpjUASS3mQW5ByLiB6J8D4jyLbMgHzJZ7M+F3jYOo2otYJGUmO6AmLYAUfZCRBgQZQZEZ6glfk5y6e19EybZkeuGDTyiRzmsK3F6gSj7gCj7I4tZkHshogyK9DYU5YTQsqGSUAOuhJi8yUlKWLmuMGS5zMzCwz4QnF4OK8yMaFNIwJC+jCi9ioub8yRA9EeIKTMLTp/J4ohQ7mSizdXHY/oIKYiIjxMV+xBDoQasB0ieF455vMXxQFVf77XNnh8Yx4JU/+bSTT3J9iz/lPgUXbFOyhvYD4h8GBQz2A1Jgt85h0khL7nZNHOqb/3a9XdPfnag0+5c7H966vMsOTWr+8rFs73VFdv+SkzJ6J7BOxhEcp8eBijKZ//pzYEiSq9QQtp2IFLmJIt6SorWdpSuL7q+dXPZndycgp6ykg2d28s/6Cp8953OrWUb7znJS/5Yc6ovQESUb8VJc54ZJAEtELcXHNkCFMkZweZieXnL76cvXFw5/lnh3Nsr3uqr3lb+oK5q20+zk0nd2EmwqyD/jctOmuXNzVnRnZdT4I2JT/HjmfNSIuUNmIAtKZ1ATNv1nT5/QTb7psnTuCq/9tLm97f4zny+n33VuLt1U9G+xjUr69qPHaxtE2yENe6p7S0uLO6bPD2ZSbPm5wbE/Stt/0cCCUkL0ixW1+561hNsxLd3V8Xd00c8N89/fbSn72rrg6P7Puk6dcRzreXEsdsbiovvmyzOvozM3D6LRH1mi9PLY5of1D9gAoaocO7nJWU1b3XdjAWO3mXL8r2/XjjF/HfaWNcfP3i9HW3+q63fstazx3tzXinojgV233RurhdiF+MwPQltJCnSoEEhMbFgtAXRDB7THdNhalVGVm7pFq3MU1+18/zuyspzn+7aWZOXW1BjkZQ/zaJ8nsf0OyA6jyObO1XThpyOVaMo2ieEBtGMRRzHBsNEvc3MvDIOTMmPiTHNMoviogkmExkbcRgNMhOqQQEcJtkQEwYl8lrwQfoYvUYz094TEtzdcQjZGney2rry3tX6fHX1hdGSpD6hkxhM3PsRXgytdB2QaBcnKXc4iawKzElKCSfRDijRzhmifVHWQu3VzPRidxw3J523Kj8DTC8CRPTU3QIkV3JQ4gBDQUIEACalAMlfQonoR3E7L9FmXqLXRKtih4i0AIm8HC+kNpoE+ybemvYFh+lG/SQ0WWXMWV0NELv2BiUOMB2TEAEzIiUAk9MByzF1AyT/ErYKYPkiRPISKNGDUFLKgESPQyy/GJYBES2CWDkUGg7OA7wtTeNtrubgbOAiGhSkqkbe6m61WNOW8Fb3YV5yaZyk7IfYdQJiug6IdA1ndX0PsbIj/P6ACBhCMdOt5pBcEGFF/+0XiHPXAOQQzEhebkYOwlsVDmC5ASDi4STlMES0yiSRqaG1Q7sxezzMWF/fOXlfVcckT+X18R7VY2SMRUeUKMZYwEq9bxg2aME7f0XFpTEHqu8qDdX3Uhp2dSQ1NbFxNduvgobKWyn1VTdm7/noxrS6ynZrTflv4GPt8sSIMA4fGVX1GDWNRTONRWuh0tzcPCrsAY8n4JWR/DlhUQ//iB7jf4K/AT09F6/5lgHaAAAAAElFTkSuQmCC'

let tray: Tray | null = null

export function initTray(mainWindow: () => BrowserWindow | null): void {
  if (tray) return

  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
  tray = new Tray(icon)

  tray.setToolTip('秋山澪 AI Voice Assistant')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const win = mainWindow()
          if (win && !win.isDestroyed()) {
            win.show()
            win.focus()
          }
        },
      },
      {
        label: '隐藏主窗口',
        click: () => {
          const win = mainWindow()
          if (win && !win.isDestroyed()) win.hide()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          tray?.destroy()
          tray = null
          app.exit(0)
        },
      },
    ]),
  )

  tray.on('double-click', () => {
    const win = mainWindow()
    if (win && !win.isDestroyed()) {
      win.isVisible() ? win.hide() : win.show()
    }
  })

  log('INFO', 'tray_init_done')
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
