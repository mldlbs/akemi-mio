import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import { SlotProvider } from './slots/SlotContext'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SlotProvider>
      <App />
    </SlotProvider>
  </React.StrictMode>,
)
