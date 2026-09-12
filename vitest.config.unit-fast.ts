// Vitest config for the fast unit-test group: excludes stress/endurance/benchmark suites.
import { defineConfig } from 'vitest/config'
import base from './vitest.config'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/main/**/*.test.{ts,js}'],
    exclude: [
      'tests/main/**/*.stress.test.ts',
      'tests/main/**/*.benchmark.test.ts',
      'tests/main/**/*endurance*',
      'tests/main/**/*baseline*',
      ...(base.test.exclude || []),
    ],
  },
})
