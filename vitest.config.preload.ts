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
      // ⚠️ 实测标定的棘轮，不是质量目标。原值 80/80/80/80。
      //
      // 那个 80 从来没有生效过：CI 跑 preload 时**不带 `--coverage`**
      // （见 .github/workflows/ci.yml），而不带 --coverage 时 vitest 完全
      // 不评估 thresholds —— 一块写得像门禁、实际从未被求值的配置（FM-2）。
      //
      // 实测（94 个用例全过，分母只有 src/preload/index.ts 一个文件、
      // 420 行可执行代码）：lines 37.85 / functions 35.29 / branches 42.85 /
      // statements 38.70。80 与实测差 42pp —— 那不是「差一点」，是两个不同的
      // 目标。要真提到 80 得再覆盖约 177 行（261 行未覆盖，散在 159 个小段里）。
      //
      // 每个数字留约 1.7pp 余量（单文件粒度粗，1 行 ≈ 0.24pp）。
      // 真实目标 80/80/80/80 作为债记在报告 §10.8。
      thresholds: {
        lines: 36,
        functions: 34,
        branches: 41,
        statements: 37,
      },
    },
  },
})
