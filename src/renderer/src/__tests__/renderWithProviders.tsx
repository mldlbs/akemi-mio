import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { SlotProvider } from '../slots/SlotContext'
import { ThemeProvider } from '../hooks/useTheme'

export function renderWithProviders(ui: ReactElement, options?: RenderOptions): RenderResult {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider>
        <SlotProvider>{children}</SlotProvider>
      </ThemeProvider>
    )
  }

  return render(ui, { wrapper: Wrapper, ...options })
}
