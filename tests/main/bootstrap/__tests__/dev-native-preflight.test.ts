import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const devScript = readFileSync(join(process.cwd(), 'scripts', 'dev.js'), 'utf8')

describe('dev native dependency preflight', () => {
  it('checks better-sqlite3 with Electron before electron-vite starts', () => {
    const preflightIndex = devScript.indexOf('ensureElectronNativeDependency')
    const spawnIndex = devScript.indexOf("spawn(process.execPath, [electronVite, 'dev']")

    expect(preflightIndex).toBeGreaterThanOrEqual(0)
    expect(spawnIndex).toBeGreaterThanOrEqual(0)
    expect(preflightIndex).toBeLessThan(spawnIndex)
  })

  it('requests the Electron ABI prebuild instead of rebuilding the full native tree', () => {
    expect(devScript).toContain('--runtime')
    expect(devScript).toContain('electron')
    expect(devScript).toContain('--target')
    expect(devScript).toContain('prebuild-install')
  })
})
