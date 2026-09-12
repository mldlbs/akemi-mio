import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

describe('main package boundaries', () => {
  it('keeps only Electron entry points, bootstrap and IPC in main', () => {
    expect(readdirSync(join(repoRoot, 'packages/main/src')).sort()).toEqual([
      'bootstrap', 'index.ts', 'ipc', 'ort-log.ts',
    ])
    expect(existsSync(join(repoRoot, 'src/main'))).toBe(false)
  })

  it('keeps application tests outside package source trees', () => {
    const misplaced: string[] = []
    function visit(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.name === '__tests__' || entry.name === 'tests' || entry.name === 'test' || /^__test_/.test(entry.name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) misplaced.push(path)
        else if (entry.isDirectory()) visit(path)
      }
    }
    for (const entry of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
      const source = join(repoRoot, 'packages', entry.name, 'src')
      if (entry.isDirectory() && existsSync(source)) visit(source)
    }
    expect(misplaced).toEqual([])
  })

  it('does not keep generated JavaScript beside TypeScript tests', () => {
    const duplicates: string[] = []
    function visit(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.name.endsWith('.test.js') && existsSync(path.replace(/\.js$/, '.ts'))) duplicates.push(path)
      }
    }
    visit(join(repoRoot, 'tests/main'))
    expect(duplicates).toEqual([])
  })
  it('does not keep duplicate source bridges for modules owned by canonical packages', () => {
    const packageOwnedPaths = [
      'packages/main/src/config',
      'packages/main/src/credentials',
      'packages/main/src/goals',
      'packages/main/src/logger',
      'packages/main/src/messaging',
      'packages/main/src/agent',
      'packages/main/src/skill',
      'packages/main/src/llm',
      'packages/main/src/typing',
      'packages/main/src/learning',
      'packages/main/src/fanqie-publish',
      'packages/main/src/browser-agent',
      'packages/main/src/memory',
      'packages/main/src/mcp',
      'packages/main/src/db',
      'packages/main/src/behavior',
      'packages/main/src/observer',
      'packages/main/src/governance',
      'packages/main/src/knowledge',
      'packages/main/src/runtime',
      'packages/main/src/plugin',
      'packages/main/src/anti-mcp',
      'packages/main/src/anti-memory',
      'packages/main/src/audit',
      'packages/main/src/blog-publish',
      'packages/main/src/evolution',
      'packages/main/src/reasoning',
      'packages/main/src/updater',
      'packages/main/src/asr',
      'packages/main/src/audio',
      'packages/main/src/core',
      'packages/main/src/speech',
      'packages/main/src/tts',
      'packages/main/src/user-behavior',
      'packages/main/src/utils',
      'packages/main/src/workflow',
      'packages/main/src/workspace',
      'packages/main/src/tool',
      'packages/main/src/capability',
      'packages/main/src/creativity',
    ]

    for (const path of packageOwnedPaths) {
      expect(existsSync(join(repoRoot, path)), `${path} should be imported from its canonical package`).toBe(false)
    }
  })
})
