import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'

const GoodChild = () => <div>OK</div>
const BadChild = () => {
  throw new Error('boom')
}

describe('ErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('OK')).toBeTruthy()
  })

  it('shows default fallback when child throws', () => {
    render(
      <ErrorBoundary>
        <BadChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('组件渲染异常')).toBeTruthy()
  })

  it('shows custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom Error</div>}>
        <BadChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Custom Error')).toBeTruthy()
  })
})
