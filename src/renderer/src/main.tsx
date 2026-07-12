import React, { Component, type ReactNode, Profiler } from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/settings.css'
import './styles/wallpaper.css'
import './styles/themes/theme-cyber.css'
import { SlotProvider } from './slots/SlotContext'
import { ThemeProvider } from './hooks/useTheme'
import App from './App'

// ── 渲染循环看门狗（仅开发模式，防误杀）──
let _lastRender = performance.now()
let _fastCount = 0
function onRender() {
  const now = performance.now()
  const gap = now - _lastRender
  _lastRender = now
  if (gap < 2) {
    _fastCount++
    if (_fastCount > 300) {
      _fastCount = 0
      console.warn('[PERF] fast commit detected, possible render loop')
    }
  } else {
    _fastCount = 0
  }
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    const el = document.createElement('pre')
    el.style.cssText = 'color:red;padding:20px;font-size:14px;white-space:pre-wrap'
    el.textContent = 'COMPONENT ERROR: ' + error.message + '\n\n' + (error.stack || '').slice(0, 1500)
    document.body.innerHTML = ''
    document.body.appendChild(el)
  }
  render() {
    if (this.state.error) {
      return <pre style={{ color: 'red', padding: 20, fontSize: 14, whiteSpace: 'pre-wrap' as any }}>ERROR: {this.state.error.message}</pre>
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Profiler id="root" onRender={onRender}>
        <ThemeProvider>
          <SlotProvider>
            <App />
          </SlotProvider>
        </ThemeProvider>
      </Profiler>
    </ErrorBoundary>
  </React.StrictMode>,
)
