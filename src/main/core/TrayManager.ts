import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

// 32×32 PNG 托盘图标（深色圆形底衬 + 居中应用图标，确保在所有托盘背景下可见）
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADvUlEQVR4nL1X3W4bRRQ+P7N/tpMYYgIhQUlDaKEEoSKKVFRVSIgb6A3iDeAaCXHHM/ACPAlvgIS4KxcRICJFpaIVqWMnsb3r3Zlz0GyJmlaxd93UnKvR7JnzfedvzizCjLK+frU/7fu9e7vtWezh8wC9CBmaF3jdszgP4FmiQf8H+DSb+CzgqoqqWq6J6NHiGSOBs4B7YFFh4jDgIGFAJtFC1FmRIs2Z2M5KwszCXhHDqLkSMRtUFfBBMBgxADA1l4N02C3Q5aNZbFJd751IkCyuxoiIIoWPhqcEj4g4KIpM4+ZyIBg0qkDPYlEdcFXBZGm14ez4ad4lEQQEIkZbZNpY6AROHNclQVWKJQiZiBDBOe+xAtHj0kmiQJ0I+O9EhCIOOGoldezWJKAQJUuhtRbiiPXWB1ekkcTgnICowjdf3YbldksHowwQCUAFwniRfdRqEVivUflIhIV18NGNq7BzeVVXOy0ZpmN4Y6Mj13YuwY33NuXK1sviRMGJA0T05GqlAasIiDiOFl9pvdppSJ4d25PhAD68/i4nzUU86vXkz/19saJme+M13d3r8WA0UuYIB/37GSOMKyMAFaJIhpAhign7/ZOid2hgmBp6aSmGh92u3d/v234vFmcLycYZfPvlbd1c64BTrtXippIhB+Tz/+BghJ9/ejM66Ia68/YqfPbJNTzsH5mVFzdle2ML/j78g0UP4Tgd41/3H0IUJqR2UEkAq/vfcdh4oVE4ppvvX9Lvvv4Cd7Zfh5/v/CbtRgOPsyH2+kf6/Q8/wt7dA/TFGUcRZIN/aqUA69z9ngRyECIQvLm9ph/fum7eubxFvujv7O65n375VX6/exjkaSYcGMyzkUPJU0TU50Jgsnj7WN4NZbdg2Xl+AXWFqhQEORZxT+j5HlfiyIOvrbwVEBL6qeg9ngXcS6k9KQreq3ChsyDiNB90R0zsRITCVrvJJqbs6MGx4YicFOU+BlGo4gAQQW1uq6ajn4qVXZCnxxZsngbJUtOOB3nYakfFsD/IKYg9+9SmhgGVgiTWIvXXofrMBMli02UnQ8Tp7wWqDBGxz63K+GRAJmIP7o0imzJ6hoNSTUWUiIWQ1KfD5qkt51SF0GkophH4bwVgx+mpR4xUnkVkP5pKKAEInTjjRIyJWsG0LjjFxLOb59WCL0Dv2aR9ESkL0HNwoqcp9bVofTSmgXupvgnPAT+7//hNiMCEtZ5kT9iBCczmJU9jUJXCPMHPJTAvEpNsYtXBi/6kVDlDFzVw0bOzXdxz+D3/FydqA+vh1II2AAAAAElFTkSuQmCC'

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
