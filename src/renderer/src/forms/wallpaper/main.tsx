import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared.css'
import { WallpaperForm } from './WallpaperForm'

const container = document.getElementById('root')
if (!container) throw new Error('wallpaper form: #root not found')

createRoot(container).render(
  <StrictMode>
    <WallpaperForm />
  </StrictMode>,
)
