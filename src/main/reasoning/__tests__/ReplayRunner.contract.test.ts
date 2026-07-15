import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { ReplayRunner } from '../golden/ReplayRunner'

const ROOT = join(__dirname, '..', '..', '..', '..', 'docs', 'golden')
const runner = new ReplayRunner({ goldenRoot: ROOT })
const Q01 = join(ROOT, 'analysis', 'Q01.json')

function capture(): Map<string, number> {
  const snap = new Map<string, number>()
  for (const cat of ['analysis', 'decision', 'planning', 'creation']) {
    const dir = join(ROOT, cat)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) snap.set(join(dir, f), statSync(join(dir, f)).mtimeMs)
    }
  }
  return snap
}
function verify(snap: Map<string, number>): void {
  for (const [fp, mtime] of snap) expect(statSync(fp).mtimeMs).toBe(mtime)
}

const q01orig = readFileSync(Q01, 'utf8')
afterAll(() => {
  writeFileSync(Q01, q01orig, 'utf8')
})

describe('ReplayRunner', () => {
  describe('1. positive', () => {
    it('all 44 pass', () => {
      const s = capture()
      const r = runner.run()
      expect(r.total).toBe(44)
      expect(r.passed).toBe(44)
      expect(r.failed).toBe(0)
      verify(s)
    })
    it('metadata', () => {
      const r = runner.run()
      expect(r.runnerVersion).toBe('0.1')
    })
  })
  describe('2. negative', () => {
    it('pattern change', () => {
      const d = q01orig
      const data = JSON.parse(d)
      data.level1.directive.pattern = 'hypothesis_verification'
      writeFileSync(Q01, JSON.stringify(data, null, 2) + '\n', 'utf8')
      const r = runner.run()
      expect(r.failed).toBeGreaterThanOrEqual(1)
      expect(r.failures[0].diff).toContain('vs')
    })
  })
  describe('3. errors', () => {
    it('bad root throws', () => {
      expect(() => new ReplayRunner({ goldenRoot: '/x' }).run()).toThrow()
    })
    it('bad golden', () => {
      writeFileSync(Q01, 'null', 'utf8')
      const r = runner.run()
      expect(r.failed).toBeGreaterThanOrEqual(1)
    })
  })
  describe('4. readonly', () => {
    it('no writes', () => {
      const s = capture()
      runner.run()
      verify(s)
    })
    it('manifest', () => {
      const mp = join(ROOT, 'manifest.json')
      const b = readFileSync(mp, 'utf8')
      runner.run()
      expect(readFileSync(mp, 'utf8')).toBe(b)
    })
  })
})
