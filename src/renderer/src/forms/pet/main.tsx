import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared.css'
import { PetForm } from './PetForm'

const container = document.getElementById('root')
if (!container) throw new Error('pet form: #root not found')

createRoot(container).render(
  <StrictMode>
    <PetForm />
  </StrictMode>,
)
