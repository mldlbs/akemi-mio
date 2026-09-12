import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'

// 32×32 PNG 托盘图标（深色圆形底衬 + 居中应用图标，确保在所有托盘背景下可见）
const TRAY_ICON_BASE64 =
  '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'

let tray: Tray | null = null
let dashboardToggleCb: (() => void) | null = null
let contextualTtsToggleCb: (() => void) | null = null
let userContextOverrideCb: ((mode: string) => void) | null = null
let organizerPauseCb: (() => void) | null = null
let organizerResumeCb: (() => void) | null = null
let organizerSkipCb: (() => void) | null = null
let taskPanelToggleCb: (() => void) | null = null

/** 语音字幕切换回调 */
let subtitleToggleCb: (() => void) | null = null

/** 语音便签切换回调 */
let voiceNoteToggleCb: (() => void) | null = null

/** 语音便签保存回调 */
let voiceNoteSaveCb: (() => void) | null = null

// ── TTS 引擎偏好 ──
let enginePreferenceCb: ((pref: 'auto' | 'cloud' | 'local') => void) | null = null
let currentEnginePreference: 'auto' | 'cloud' | 'local' = 'auto'

// ── 角色方案切换 ──
let voiceRoleSchemeCb: ((schemeId: string) => void) | null = null

/** 注册角色方案切换回调（由 AppRuntime 在 VoiceRoleManager 就绪后调用） */
export function setVoiceRoleSchemeSwitch(cb: (schemeId: string) => void): void {
  voiceRoleSchemeCb = cb
}

/** 注册仪表盘切换回调（由 AppRuntime 在仪表盘服务就绪后调用） */
export function setDashboardToggle(cb: () => void): void {
  dashboardToggleCb = cb
}

/** 注册交互情境语音切换回调（由 AppRuntime 调用） */
export function setContextualTtsToggle(cb: () => void): void {
  contextualTtsToggleCb = cb
}

/** 注册用户情境语音覆盖回调（由 AppRuntime 调用） */
export function setUserContextOverride(cb: (mode: string) => void): void {
  userContextOverrideCb = cb
}

/** 注册文件整理暂停回调 */
export function setOrganizerPause(cb: () => void): void {
  organizerPauseCb = cb
}

/** 注册文件整理继续回调 */
export function setOrganizerResume(cb: () => void): void {
  organizerResumeCb = cb
}

/** 注册文件整理跳过当前文件回调 */
export function setOrganizerSkip(cb: () => void): void {
  organizerSkipCb = cb
}

/** 注册语音字幕切换回调 */
export function setSubtitleToggle(cb: () => void): void {
  subtitleToggleCb = cb
}

/** 注册桌面任务面板切换回调 */
export function setTaskPanelToggle(cb: () => void): void {
  taskPanelToggleCb = cb
}

/** 注册语音便签切换回调 */
export function setVoiceNoteToggle(cb: () => void): void {
  voiceNoteToggleCb = cb
}

/** 注册语音便签保存回调 */
export function setVoiceNoteSave(cb: () => void): void {
  voiceNoteSaveCb = cb
}

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
        label: '切换自进化仪表盘',
        click: () => {
          dashboardToggleCb?.()
        },
      },
      {
        label: '切换任务面板',
        click: () => {
          taskPanelToggleCb?.()
        },
      },
      { type: 'separator' },
      {
        label: '文件整理：暂停',
        click: () => organizerPauseCb?.(),
      },
      {
        label: '文件整理：继续',
        click: () => organizerResumeCb?.(),
      },
      {
        label: '文件整理：跳过当前',
        click: () => organizerSkipCb?.(),
      },
      { type: 'separator' },
      {
        label: '切换语音字幕',
        click: () => {
          subtitleToggleCb?.()
        },
      },
      { type: 'separator' },
      {
        label: '语音便签：切换',
        click: () => {
          voiceNoteToggleCb?.()
        },
      },
      {
        label: '语音便签：保存',
        click: () => {
          voiceNoteSaveCb?.()
        },
      },
      { type: 'separator' },
      {
        label: '语音模式：自动/手动',
        click: () => {
          contextualTtsToggleCb?.()
        },
      },
      {
        label: '语音情境覆盖',
        submenu: [
          {
            label: '自动(自适应)',
            click: () => userContextOverrideCb?.('auto'),
          },
          {
            label: '工作模式',
            click: () => userContextOverrideCb?.('manual_work'),
          },
          {
            label: '休闲模式',
            click: () => userContextOverrideCb?.('manual_leisure'),
          },
          {
            label: '休息模式',
            click: () => userContextOverrideCb?.('manual_rest'),
          },
        ],
      },
      { type: 'separator' },
      {
        label: '角色方案',
        submenu: [
          {
            label: '默认方案',
            click: () => voiceRoleSchemeCb?.('default'),
          },
          {
            label: '极客方案',
            click: () => voiceRoleSchemeCb?.('geek'),
          },
          {
            label: '柔和方案',
            click: () => voiceRoleSchemeCb?.('gentle'),
          },
        ],
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

export function setEnginePreferenceToggle(cb: (pref: 'auto' | 'cloud' | 'local') => void): void {
  enginePreferenceCb = cb
}

export function updateEnginePreference(pref: 'auto' | 'cloud' | 'local'): void {
  currentEnginePreference = pref
}
