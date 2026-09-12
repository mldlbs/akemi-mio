import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceRoot = process.cwd()
const appRuntimePath = join(workspaceRoot, 'packages', 'main', 'src', 'bootstrap', 'AppRuntime.ts')

describe('AppRuntime LLM config source wiring', () => {
  it('uses credentials store for packaged builds and env bootstrap for development', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    expect(source).toMatch(/if\s*\(\s*app\.isPackaged\s*\)\s*\{/)
    expect(source).toMatch(/else\s+if\s*\(\s*llmKey\s*\)\s*\{/)
    expect(source).toMatch(/llmService\.setConfig\(llmKey,\s*llmCodeKey\s*\|\|\s*llmKey\)/)
    expect(source).toMatch(/llmService\.refreshFromCredentials\(\(key\)\s*=>\s*credentialsManager\.get\(key\)\)/)
  })
})
