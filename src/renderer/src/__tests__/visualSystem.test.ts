import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readStyle = (file: string) => readFileSync(join(process.cwd(), 'src/renderer/src/styles', file), 'utf8')
const readSource = (file: string) => readFileSync(join(process.cwd(), 'src/renderer/src', file), 'utf8')

describe('nocturnal atelier v2 (warm paper) visual system', () => {
  it('defines the Warm Paper direction in shared styles', () => {
    const tokens = readStyle('tokens.css')
    const base = readStyle('base.css')
    const layout = readStyle('layout.css')

    expect(tokens).toContain('--font-display')
    expect(tokens).toContain('--font-body')
    expect(tokens).toContain('--surface-paper')
    expect(tokens).toContain('--accent-ink')
    expect(tokens).toContain('--bg-base: oklch(0.26')
    expect(base).toContain('var(--font-body)')
    expect(base).not.toContain("'Inter'")
    expect(base).not.toContain('ambient-grid')
    expect(layout).toContain('.main-area-inner')
    expect(layout).toContain('.chat-slot')
  })

  it('carries the warm paper language into secondary work surfaces', () => {
    const tokens = readStyle('tokens.css')
    const settings = readStyle('settings.css')
    const components = readStyle('components.css')

    expect(tokens).toContain('--surface-modal')
    expect(settings).toContain('.settings-panel')
    expect(settings).toContain('.settings-tab-bar')
    expect(components).toContain('.blog-editor::before')
    expect(components).toContain('.blog-review::before')
    expect(components).toContain('.workflow-slot::before')
    expect(components).toContain('.qt-edit-modal::before')
    expect(components).toContain('atelier-panel-rise')
  })

  it('keeps the refined UI accessible and calm across input modes', () => {
    const base = readStyle('base.css')
    const layout = readStyle('layout.css')
    const components = readStyle('components.css')

    expect(base).toContain(':focus-visible')
    expect(layout).toContain('@media (prefers-reduced-motion: reduce)')
    expect(components).toContain('@media (prefers-reduced-motion: reduce)')
    expect(layout).toContain('@media (max-width: 640px)')
    expect(components).toContain('.status-health.health-ok')
    expect(components).toContain('.status-health.health-error')
  })

  it('extends the warm paper treatment to high-frequency controls', () => {
    const tokens = readStyle('tokens.css')
    const components = readStyle('components.css')

    expect(tokens).toContain('--control-ring')
    expect(components).toContain('.status-bar::before')
    expect(components).toContain('.btn-voice::before')
    expect(components).toContain('.rp-tool-btn::after')
    expect(components).toContain('.bookmark-item::before')
    expect(components).toContain('atelier-control-glint')
  })

  it('gives rendered writing and code a deliberate paper typography treatment', () => {
    const tokens = readStyle('tokens.css')
    const components = readStyle('components.css')

    expect(tokens).toContain('--surface-code')
    expect(components).toContain('.markdown-body::before')
    expect(components).toContain('.md-code-block::before')
    expect(components).toContain('.md-blockquote::before')
    expect(components).toContain('.blog-editor-textarea:focus')
    expect(components).toContain('.br-para-code::before')
    expect(components).toContain('atelier-text-reveal')
  })

  it('keeps dense progress and metric indicators aligned with the warm workbench', () => {
    const tokens = readStyle('tokens.css')
    const components = readStyle('components.css')
    const theme = readStyle('themes/theme-cyber.css')

    expect(tokens).toContain('--metric-track')
    expect(tokens).toContain('--metric-fill')
    expect(components).toContain('.wf-progress-bar::before')
    expect(components).toContain('.rp-mon-bar::before')
    expect(components).toContain('.sd-mon-bar::before')
    expect(components).toContain('.tv-summary-stat::before')
    expect(theme).toContain('--accent')
  })

  it('treats conversational traces and empty states like crafted paper artifacts', () => {
    const tokens = readStyle('tokens.css')
    const layout = readStyle('layout.css')
    const components = readStyle('components.css')

    expect(tokens).toContain('--surface-thread')
    expect(tokens).toContain('--trace-rail')
    expect(layout).toContain('.msg-bubble')
    expect(layout).toContain('.msg-row.user')
    expect(components).toContain('.tool-item::before')
    expect(components).toContain('.tool-item-running::after')
    expect(components).toContain('.workflow-empty::before')
    expect(components).toContain('.qt-empty::before')
    expect(components).toContain('atelier-trace-pulse')
  })

  it('unifies text inputs and form controls as etched warm instruments', () => {
    const tokens = readStyle('tokens.css')
    const layout = readStyle('layout.css')
    const components = readStyle('components.css')
    const settings = readStyle('settings.css')

    expect(tokens).toContain('--input-etched')
    expect(tokens).toContain('--input-focus-beam')
    expect(layout).toContain('.inputbar-field:focus')
    expect(components).toContain('.wf-search-box::before')
    expect(components).toContain('.bookmark-search::after')
    expect(components).toContain('.wf-editor-field:focus-within label')
    expect(components).toContain('.sd-input:focus')
    expect(settings).toContain('.settings-input:focus')
  })

  it('keeps the chat send control as a lit vermilion control', () => {
    const layout = readStyle('layout.css')
    const redesign = readStyle('redesign.css')

    expect(layout).toContain('--send-control-paper')
    expect(layout).toContain('.inputbar-send')
    expect(redesign).toContain('.inputbar-send')
  })

  it('distills the persistent chat chrome instead of layering more decoration', () => {
    const layout = readStyle('layout.css')
    const chatSlot = readSource('components/ChatSlot.tsx')
    const topBar = readSource('components/TopBar.tsx')

    expect(layout).toContain('.msg-tool-disclosure')
    expect(layout).toContain('.chat-slot')
    expect(chatSlot).toContain('<MessageContent content={m.content} />')
    expect(topBar).not.toContain('ri-fullscreen-line')
  })

  it('refines transient interaction states with warm edge details', () => {
    const tokens = readStyle('tokens.css')
    const base = readStyle('base.css')
    const components = readStyle('components.css')

    expect(tokens).toContain('--scroll-etched')
    expect(tokens).toContain('--selection-wash')
    expect(base).toContain('::selection')
    expect(base).toContain('scrollbar-color')
    expect(base).toContain('::-webkit-scrollbar-thumb:hover')
    expect(components).toContain('.tv-loading::before')
    expect(components).toContain('.tv-loading-spinner::before')
    expect(components).toContain('.tool-param-suggestions-loading::before')
  })

  it('keeps the warm palette disciplined instead of color-heavy', () => {
    const tokens = readStyle('tokens.css')
    const coreStyles = [
      tokens,
      readStyle('base.css'),
      readStyle('layout.css'),
      readStyle('components.css'),
      readStyle('settings.css'),
      readStyle('wallpaper.css'),
      readStyle('redesign.css'),
    ].join('\n')

    expect(tokens).toContain('--accent-vermilion-muted')
    expect(tokens).toContain('--accent-aged-gold')
    expect(tokens).toContain('--accent-quiet-wash')
    expect(tokens).toContain('--color-presence: 8%')
    expect(coreStyles).not.toContain('0.48 0.12 19')
    expect(coreStyles).not.toContain('0.67 0.12 82')
  })

  it('retires bottom-right wallpaper floats by default', () => {
    const tokens = readStyle('tokens.css')
    const wallpaper = readStyle('wallpaper.css')

    expect(tokens).toContain('--corner-float-paper')
    expect(tokens).toContain('--corner-float-ink')
    expect(tokens).toContain('--corner-float-edge-opacity')
    expect(tokens).toContain('--right-bottom-floats-display: none')
    expect(wallpaper).toContain('.wp-cc-panel')
    expect(wallpaper).toContain('.wp-org-panel')
    expect(wallpaper).toContain('.wp-tp-panel')
    expect(wallpaper).toContain('.system-dock')
    expect(wallpaper).toContain('var(--right-bottom-floats-display, none) !important')
  })

  it('keeps wallpaper floating overlays opt-in instead of always-on', () => {
    const tokens = readStyle('tokens.css')
    const wallpaper = readStyle('wallpaper.css')

    expect(tokens).toContain('--wallpaper-floating-ui-display: none')
    expect(wallpaper).toContain('.wp-cc-panel')
    expect(wallpaper).toContain('.wp-cc-panel--collapsed')
    expect(wallpaper).toContain('.wp-mem-panel')
    expect(wallpaper).toContain('.prediction-toast-container')
    expect(wallpaper).toContain('.wallpaper-status-label')
    expect(wallpaper).toContain('var(--wallpaper-floating-ui-display, none) !important')
  })

  it('keeps the right utility drawer structurally opt-in instead of CSS-hidden', () => {
    const wallpaper = readStyle('wallpaper.css')
    const app = readSource('App.tsx')
    const slotContext = readSource('slots/SlotContext.tsx')

    expect(slotContext).toContain('rightPanelOpen: false')
    expect(app).toContain('{uiState.rightPanelOpen && <RightPanel />}')
    expect(wallpaper).not.toContain('--auxiliary-side-panel-display')
    expect(wallpaper).not.toContain('var(--auxiliary-side-panel-display')
  })

  it('shares the reading-column centering between chat and input bar', () => {
    const app = readSource('App.tsx')
    const redesign = readStyle('redesign.css')

    expect(app).toContain('<MainArea>')
    expect(app).toContain('<InputBar')
    expect(redesign).toContain('.chat-slot.chat-reading-column')
    expect(redesign).toContain('.inputbar-row')
  })

  it('keeps wallpaper atmosphere separate from UI-bearing floating components', () => {
    const app = readSource('App.tsx')
    const wallpaperOverlay = readSource('components/WallpaperOverlay.tsx')

    expect(app).not.toContain('<SystemDock />')
    expect(wallpaperOverlay).not.toContain('BehaviorQuickActions')
    expect(wallpaperOverlay).not.toContain('PeriodicPredictionToast')
    expect(wallpaperOverlay).not.toContain('WallpaperAgentPanel')
    expect(wallpaperOverlay).not.toContain('WallpaperWidgetHost')
    expect(wallpaperOverlay).not.toContain('TaskSwitcher')
    expect(wallpaperOverlay).not.toContain('TtsSubtitleOverlay')
    expect(wallpaperOverlay).not.toContain('EmotionalWaveform')
    expect(wallpaperOverlay).toContain('privacyFade <= 0')
  })

  it('prevents hard-coded black glass from returning to persistent floating widgets', () => {
    const wallpaper = readStyle('wallpaper.css')
    const voiceWallpaper = readFileSync(join(process.cwd(), 'src/renderer/src/widgets/plugins/VoiceWallpaperWidget.tsx'), 'utf8')
    const voiceNote = readFileSync(join(process.cwd(), 'src/renderer/src/widgets/plugins/VoiceNoteWidget.tsx'), 'utf8')
    const floatingSources = [wallpaper, voiceWallpaper, voiceNote].join('\n')

    expect(floatingSources).toContain('--corner-float-paper')
    expect(floatingSources).not.toContain('rgba(0,0,0,0.6)')
    expect(floatingSources).not.toContain("background: '#333'")
    expect(floatingSources).not.toContain("background: 'oklch(0.25 0.02 260 / 0.85)'")
    expect(floatingSources).not.toContain("boxShadow: '0 4px 24px oklch(0 0 0 / 0.4)'")
    expect(floatingSources).not.toContain('background: oklch(0.08 0.005 260 / 0.82)')
  })
})
