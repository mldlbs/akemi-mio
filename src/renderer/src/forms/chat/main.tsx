import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared.css'
import { ChatForm } from './ChatForm'

const container = document.getElementById('root')
if (!container) throw new Error('chat form: #root not found')

createRoot(container).render(
  <StrictMode>
    <ChatForm />
  </StrictMode>,
)
