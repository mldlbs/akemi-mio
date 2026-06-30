import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/renderer/src/**/__tests__/**/*.test.{ts,tsx}'],
    css: false,
    setupFiles: ['src/renderer/src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/renderer/src/**/*.{ts,tsx}'],
      exclude: ['src/renderer/src/**/__tests__/**', 'src/renderer/src/**/*.test.*', 'src/renderer/src/main.tsx'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 37,
        functions: 35,
        branches: 26,
        statements: 35,
      },
    },
  },
})
