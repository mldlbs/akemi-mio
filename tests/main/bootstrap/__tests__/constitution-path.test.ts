import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CONSTITUTION_FILENAME,
  constitutionCandidates,
  resolveConstitutionPath,
} from '../../../../packages/main/src/bootstrap/constitution-path'

function seed(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mio-constitution-'))
  for (const rel of files) {
    const target = join(root, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, '# constitution\n', 'utf8')
  }
  return root
}

describe('constitution-path', () => {
  it('prefers RUNTIME_ROOT when the file ships next to the app', () => {
    const root = seed(['out/main/CONSTITUTION.md', 'CONSTITUTION.md'])
    const resolved = resolveConstitutionPath(join(root, 'out', 'main'), join(root, 'none'))
    expect(resolved).toBe(join(root, 'out', 'main', CONSTITUTION_FILENAME))
  })

  it('falls back two levels up when running out/main directly (the historical bug)', () => {
    const root = seed(['CONSTITUTION.md'])
    const resolved = resolveConstitutionPath(join(root, 'out', 'main'), join(root, 'none'))
    expect(resolved).toBe(join(root, CONSTITUTION_FILENAME))
    expect(existsSync(resolved)).toBe(true)
  })

  it('falls back to cwd when nothing else has it', () => {
    const root = seed(['cwd/CONSTITUTION.md'])
    const resolved = resolveConstitutionPath(join(root, 'a', 'b'), join(root, 'cwd'))
    expect(resolved).toBe(join(root, 'cwd', CONSTITUTION_FILENAME))
  })

  it('returns the preferred path when nothing exists, so ENOENT stays diagnosable', () => {
    const root = mkdtempSync(join(tmpdir(), 'mio-constitution-empty-'))
    const resolved = resolveConstitutionPath(join(root, 'resources', 'app.asar'), join(root, 'nope'))
    expect(resolved).toBe(join(root, 'resources', 'app.asar', CONSTITUTION_FILENAME))
    expect(existsSync(resolved)).toBe(false)
  })

  it('does not repeat a candidate when RUNTIME_ROOT and cwd are the same', () => {
    const root = seed([])
    const candidates = constitutionCandidates(root, root)
    expect(candidates).toHaveLength(3)
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})
