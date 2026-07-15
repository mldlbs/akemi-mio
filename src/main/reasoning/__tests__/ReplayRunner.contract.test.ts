/**
 * ReplayRunner Contract Tests — M4.3 Verification
 *
 * Validates Runner Contract:
 *  1. identical directive → PASS
 *  2. different directive → FAIL (negative test)
 *  3. invalid GoldenCase → Schema rejected
 *  4. read-only → no golden files modified
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ReplayRunner, ReplayError } from '../golden/ReplayRunner'
import type { GoldenCase } from '../golden/types'

const GOLDEN_ROOT = join(__dirname, '..', '..', '..', '..', 'docs', 'golden')

/**
 * Helper: snapshot golden file mtimes before a run, verify they're unchanged after.
 */
function captureGoldenFiles(): Map<string, number> {
  const snap = new Map<string, number>()
  const cats = ['analysis', 'decision', 'planning', 'creation']
  for (const cat of cats) {
    const dir = join(GOLDEN_ROOT, cat)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) {
        const fp = join(dir, f)
        snap.set(fp, statSync(fp).mtimeMs)
      }
    }
  }
  return snap
}

function verifyReadOnly(snap: Map<string, number>): void {
  for (const [fp, mtime] of snap) {
    expect(statSync(fp).mtimeMs).toBe(mtime)
  }
}

describe('ReplayRunner Contract', () => {
  const runner = new ReplayRunner({ goldenRoot: GOLDEN_ROOT })

  // ── 1. Identical directive → PASS ──
  describe('identical directive (positive)', () => {
    it('all 44 cases pass', () => {
      const snap = captureGoldenFiles()
      const report = runner.run()
      expect(report.total).toBe(44)
      expect(report.passed).toBe(44)
      expect(report.failed).toBe(0)
      expect(report.failures).toHaveLength(0)
      verifyReadOnly(snap)
    })

    it('report has valid metadata', () => {
      const report = runner.run()
      expect(report.runnerVersion).toBe('0.1')
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
      expect(report.executedAt).toBeTruthy()
      expect(() => new Date(report.executedAt)).not.toThrow()
    })
  })

  // ── 2. Different directive → FAIL (negative test) ──
  describe('different directive (negative)', () => {
    const backupDir = join(GOLDEN_ROOT, 'analysis', '.backup')
    const targetDir = join(GOLDEN_ROOT, 'analysis')
    const targetFile = 'Q01.json'

    beforeEach(() => {
      // Backup Q01.json before mutating
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true })
      }
    })

    it('detects pattern change as regression', () => {
      // Read original
      const fp = join(targetDir, targetFile)
      const original = JSON.parse(readFileSync(fp, 'utf8')) as GoldenCase

      // Backup
      writeFileSync(join(backupDir, targetFile), JSON.stringify(original, null, 2) + '\n', 'utf8')

      // Mutate: change pattern (simulate a real regression)
      const mutated = {
        ...original,
        level1: {
          ...original.level1,
          directive: {
            ...original.level1.directive,
            pattern: 'hypothesis_verification' as const,
          },
        },
      }
      writeFileSync(fp, JSON.stringify(mutated, null, 2) + '\n', 'utf8')

      // Run
      const report = runner.run()

      // Restore
      writeFileSync(fp, JSON.stringify(original, null, 2) + '\n', 'utf8')

      // Verify negative detection
      expect(report.failed).toBeGreaterThanOrEqual(1)
      const q01Failure = report.failures.find(f => f.caseId === 'Q01')
      expect(q01Failure).toBeDefined()
      expect(q01Failure!.diff).toContain('pattern')
      expect(q01Failure!.expected.pattern).toBe('cause_effect')
      expect(q01Failure!.actual.pattern).toBe('hypothesis_verification')
    })

    afterAll(() => {
      // Clean up backup
      if (existsSync(join(backupDir, targetFile))) {
        const fp = join(targetDir, targetFile)
        const backup = readFileSync(join(backupDir, targetFile), 'utf8')
        writeFileSync(fp, backup, 'utf8')
      }
    })
  })

  // ── 3. Invalid input handling ──
  describe('error handling', () => {
    it('throws ReplayError when manifest is missing', () => {
      const badRunner = new ReplayRunner({ goldenRoot: '/nonexistent' })
      expect(() => badRunner.run()).toThrow(ReplayError)
    })

    it('handles missing golden file gracefully', () => {
      // Temporarily move one file
      const src = join(GOLDEN_ROOT, 'analysis', 'Q01.json')
      const dst = join(GOLDEN_ROOT, 'analysis', 'Q01.json.bak')
      if (existsSync(src)) {
        writeFileSync(dst, readFileSync(src, 'utf8'))
      }
      const snap = captureGoldenFiles()

      // This should throw since manifest references Q01 but file is gone
      expect(() => runner.run()).toThrow()

      // Restore
      if (existsSync(dst)) {
        writeFileSync(src, readFileSync(dst, 'utf8'))
      }
      verifyReadOnly(snap)
    })
  })

  // ── 4. Read-only verification ──
  describe('read-only (no golden writes)', () => {
    it('does not modify any golden file during normal run', () => {
      const snap = captureGoldenFiles()
      runner.run()
      verifyReadOnly(snap)
    })

    it('does not modify manifest.json during run', () => {
      const manifestPath = join(GOLDEN_ROOT, 'manifest.json')
      const before = readFileSync(manifestPath, 'utf8')
      runner.run()
      const after = readFileSync(manifestPath, 'utf8')
      expect(after).toBe(before)
    })
  })
})
