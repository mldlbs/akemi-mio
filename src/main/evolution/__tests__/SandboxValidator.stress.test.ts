import { describe, it, expect, vi } from 'vitest'
import { validateAllSandboxes } from '../SandboxValidator'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function makeValidHtml(): string {
  return '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>T</title></head>\n<body><h1>H</h1></body>\n</html>'
}

describe('SandboxValidator 压力测试', () => {
  let testDir: string
  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true })
    } catch {}
  })

  it('100 个 sandbox HTML 并发验证', () => {
    testDir = join(tmpdir(), `sandbox-stress-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    for (let i = 0; i < 100; i++) {
      const d = join(testDir, `p${i}`)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `p${i}.html`), makeValidHtml(), 'utf-8')
    }
    const r = validateAllSandboxes(testDir)
    expect(r.total).toBe(100)
    expect(r.passed).toBe(100)
  })

  it('超大 HTML 不崩溃', () => {
    testDir = join(tmpdir(), `sandbox-large-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const d = join(testDir, 'large')
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, 'large.html'),
      makeValidHtml() + '\n' + Array.from({ length: 10000 }, (_, i) => `<div>${i}</div>`).join('\n'),
      'utf-8',
    )
    const r = validateAllSandboxes(testDir)
    expect(r.total).toBe(1)
  })
})
