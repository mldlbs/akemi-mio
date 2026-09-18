import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // preload 的模块顶层会读 window.location 解析形态（resolveFormKind），
    // 用 node 环境导入即抛 "window is not defined" —— 整个测试文件一条都跑不起来。
    environment: 'jsdom',
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
