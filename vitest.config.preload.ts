import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/preload/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/preload/**/*.ts'],
      exclude: ['src/preload/**/__tests__/**', 'src/preload/**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
