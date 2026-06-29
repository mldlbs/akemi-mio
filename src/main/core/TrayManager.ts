import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

// 32×32 RGBA PNG 托盘图标（紫色渐变圆）
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADGElEQVR4nNWX60uTYRjG94dpmVqKdninbnMz52FrirpRZi6VsANFRRRU1If6EkHQp/4Nbc0OzhyZrCzpXBRhBMEVv+d9J1tlWCTPeuGGZ/fhup778Dx7X5/vf3v8VVNqqZ5W66bbZYIO24aQOlVThiRQk1Foyx2112YVrssq4glrdNjwwdf5V5sBLFiTUbg2q476GXVuvauuhnvqbrivnkZXWKPDhg++QW8jf01MOQObMyaz3fUuaW/jA8WbZpVozqlvOzLnSc7osOGDLzHEgvHHrfFXT5sMKG90m0u8pzmn/h1zGtj5UEPOvJL+vFKesEaHDR98iSEWDLDAXHfmLvmMySTWNGuyHNw1b8j2tT7S/rYFjQQe60DQFdbosOGDLzHEggGW2cR6KkHJ2DWBlJSMko5LDFE6tKixcEHjkYImIk+MsEaHDR98iSE2vroJtx2/JWdo6BulixXJ/XkNty1oNLSo8XBBhzqearJzSUeiz3S0yxXW6LDhgy8xxIIBFphgrzmYjld6hof+UUKyAIjMyBSSY93PdaJ3WSdjL3Qq7gprdNjwwTdd3ISTN1hggg3HL48oO+P4UC6GiD5SylGP/HB0Scd7lg3hmcQrne17rXP9b4ywRocNH3yJIRYMsMAEO7xWFbhAOMPslLIxTPSTkpIVwKfjLw3Z+YG3ujj0XpeSrrBGhw0ffIkhFoyU1wqw4YDrp8nnFuMiYWg4TuycMtJXSkt2EFwYfKfLqQ+6svejrg5/MsIaHTZ88CWG2LRXBTDBhgOushPBPd7ulZ8LhTPNsRrzsqe/lJgsIYL02shnXR9dMcIaHTZ88CWGWDDAAjPhtQGultJ7wfS/LmuuVG61ZLH8kYKZcIaMzCg12UJ44+AX3Zz4aoQ1Omz44EsMsWCABSbYcMBVNgf84JxyrzOx9IwLhkHimFFSho1+kylZQ3xr8psR1uiw4YMvMcSCAVbK754GOCIVuQGrLbA+hNaPofWLqCKuYut/Rj7bf8ers2DzhcRXCa9kPtsvpaWVsPZaXvpY+zApfax+mv34WPk43cjnO0s9T+ZGIpj7AAAAAElFTkSuQmCC'

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
