import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PreviewSlot } from '../PreviewSlot'

describe('PreviewSlot', () => {
  it('renders the empty state message', () => {
    render(<PreviewSlot />)
    expect(screen.getByText(/AI 生成的图片/)).toBeTruthy()
  })
})
