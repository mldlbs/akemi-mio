/**
 * 形态切换器 —— 从主界面唤起三种桌面形态。
 *
 * 为什么放在顶栏：形态切换是"把 Mio 送到桌面上"的出口，
 * 属于全局动作，与"工作区切换"（slot tabs）同级，所以放在同一行右侧。
 *
 * 实现上刻意不引入任何下拉组件库：一个受控的展开状态 + 点击外部关闭即可，
 * 三形态是固定的小集合，不需要通用 Popover 的复杂度。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { FORM_KINDS, FORM_REGISTRY, type FormKind } from '../forms/types'
import { isFormVisible, toggleForm } from '../forms/runtime'

const FORM_ICONS: Record<FormKind, string> = {
  pet: 'ri-emotion-happy-line',
  chat: 'ri-chat-smile-2-line',
  wallpaper: 'ri-image-2-line',
}

/**
 * 快捷键提示文案。
 * 与主进程 `packages/core/src/core/Lifecycle.ts` 的 FORM_SHORTCUTS 保持同步 ——
 * 那边是真正的注册源，这里只是展示，改键位时两处都要改。
 */
const FORM_SHORTCUT_HINTS: Record<FormKind, string> = {
  pet: 'Ctrl+Shift+P',
  chat: 'Ctrl+Shift+L',
  wallpaper: 'Ctrl+Shift+W',
}

export function FormSwitcher() {
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState<Record<FormKind, boolean>>({ pet: false, chat: false, wallpaper: false })
  const rootRef = useRef<HTMLDivElement>(null)

  // 展开时刷新各形态的真实可见状态 —— 用户可能已通过宠物上的 ✕ 关掉了它，
  // 这里必须以后端实际状态为准，不能靠本地记忆。
  const refresh = useCallback(async () => {
    const entries = await Promise.all(FORM_KINDS.map(async (kind) => [kind, await isFormVisible(kind)] as const))
    setVisible(Object.fromEntries(entries) as Record<FormKind, boolean>)
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, refresh])

  const handleToggle = useCallback(async (kind: FormKind) => {
    const nowVisible = await toggleForm(kind)
    setVisible((prev) => ({ ...prev, [kind]: nowVisible }))
  }, [])

  const anyVisible = FORM_KINDS.some((k) => visible[k])

  return (
    <div className="form-switcher" ref={rootRef}>
      <button
        className={`topbar-btn${anyVisible ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="桌面形态"
        aria-label="切换桌面形态"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <i className="ri-shape-2-line" />
      </button>

      {open && (
        <div className="form-switcher-menu" role="menu">
          <p className="form-switcher-title">桌面形态</p>
          {FORM_KINDS.map((kind) => {
            const desc = FORM_REGISTRY[kind]
            const on = visible[kind]
            return (
              <button
                key={kind}
                role="menuitemcheckbox"
                aria-checked={on}
                className={`form-switcher-item${on ? ' is-on' : ''}`}
                onClick={() => void handleToggle(kind)}
              >
                <i className={FORM_ICONS[kind]} aria-hidden="true" />
                <span className="form-switcher-item-text">
                  <span className="form-switcher-item-label">{desc.label}</span>
                  <span className="form-switcher-item-desc">{desc.description}</span>
                </span>
                <kbd className="form-switcher-kbd">{FORM_SHORTCUT_HINTS[kind]}</kbd>
                <span className={`form-switcher-dot${on ? ' is-on' : ''}`} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
