import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/themes/theme-cyber.css'
import { SlotProvider } from './slots/SlotContext'
import { ThemeProvider } from './hooks/useTheme'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SlotProvider>
        <App />
      </SlotProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
