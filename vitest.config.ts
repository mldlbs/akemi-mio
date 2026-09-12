import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const aliases = {
  '@akemi-mio/audit': resolve(__dirname, './packages/audit/src'),
  '@akemi-mio/anti-mcp': resolve(__dirname, './packages/anti-mcp/src'),
  '@akemi-mio/anti-memory': resolve(__dirname, './packages/anti-memory/src'),
  '@akemi-mio/blog': resolve(__dirname, './packages/blog/src'),
  '@akemi-mio/blog-publish': resolve(__dirname, './packages/blog-publish/src'),
  '@akemi-mio/capabilities': resolve(__dirname, './packages/capabilities/src'),
  '@akemi-mio/platform': resolve(__dirname, './packages/platform/src'),
  '@akemi-mio/intelligence': resolve(__dirname, './packages/intelligence/src'),
  '@akemi-mio/core': resolve(__dirname, './packages/core/src'),
  '@akemi-mio/creativity': resolve(__dirname, './packages/creativity/src'),
  '@akemi-mio/audio': resolve(__dirname, './packages/audio/src'),
  '@akemi-mio/evolution': resolve(__dirname, './packages/evolution/src'),
  '@akemi-mio/engine': resolve(__dirname, './packages/engine/src'),
  '@akemi-mio/image': resolve(__dirname, './packages/image/src'),
  '@akemi-mio/main': resolve(__dirname, './packages/main/src'),
  '@akemi-mio/messaging': resolve(__dirname, './packages/messaging/src'),
  '@akemi-mio/monitoring': resolve(__dirname, './packages/monitoring/src'),
  '@akemi-mio/reasoning': resolve(__dirname, './packages/reasoning/src'),
  '@akemi-mio/updater': resolve(__dirname, './packages/updater/src'),
  '@akemi-mio/voicenote': resolve(__dirname, './packages/voicenote/src'),
  '@akemi-mio/asr': resolve(__dirname, './packages/audio/src'),
  '@akemi-mio/agent': resolve(__dirname, './packages/intelligence/src/agent'),
  '@akemi-mio/constitution': resolve(__dirname, './packages/evolution/src/constitution'),
}

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/main/**/*.test.{ts,js}'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['tests/**', 'packages/*/src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 20,
        statements: 30,
      },
    },
  },
})
