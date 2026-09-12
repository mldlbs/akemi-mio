import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import { buildSystemPrompt } from '@akemi-mio/intelligence/agent/context'
import { addAuthorizedProjectRoot, setActiveProjectRoot } from '@akemi-mio/core/workspace/project-root'

const store = vi.hoisted(() => {
  const data = new Map<string, string>()
  return {
    data,
    get: vi.fn((k: string) => data.get(k) ?? null),
    set: vi.fn((k: string, v: string) => {
      data.set(k, v)
    }),
    delete: vi.fn((k: string) => {
      data.delete(k)
      return true
    }),
  }
})

vi.mock('@akemi-mio/core/credentials/CredentialsManager', () => ({
  credentialsManager: {
    get: store.get,
    set: store.set,
    delete: store.delete,
  },
}))

describe('buildSystemPrompt - authorized project workspaces', () => {
  let tempRoot: string
  let tempRoot2: string

  beforeEach(() => {
    store.data.clear()
    vi.clearAllMocks()
    tempRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mio-ctx-root-'))
    tempRoot2 = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mio-ctx-root-'))
  })

  afterEach(() => {
    try {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {}
    try {
      nodeFs.rmSync(tempRoot2, { recursive: true, force: true })
    } catch {}
  })

  it('unconfigured - no workspace hint', () => {
    const p = buildSystemPrompt()
    expect(p).not.toContain('[Authorized Project Workspaces]')
  })

  it('configured - injects path into prompt', () => {
    addAuthorizedProjectRoot(tempRoot)
    const p = buildSystemPrompt()
    expect(p).toContain('[Authorized Project Workspaces]')
    expect(p).toContain(tempRoot)
  })

  it('multiple roots - lists all and marks active', () => {
    addAuthorizedProjectRoot(tempRoot)
    addAuthorizedProjectRoot(tempRoot2)
    setActiveProjectRoot(tempRoot2)
    const p = buildSystemPrompt()
    expect(p).toContain(tempRoot)
    expect(p).toContain(tempRoot2)
    expect(p).toContain(`当前生效目录：\`${tempRoot2}\``)
  })

  it('injection placed after reflectionContext content', () => {
    addAuthorizedProjectRoot(tempRoot)
    const REFLECT = '=== REFLECTION MARKER ==='
    const p = buildSystemPrompt(undefined, undefined, REFLECT)
    const wsIdx = p.indexOf('[Authorized Project Workspaces]')
    const reflectIdx = p.indexOf(REFLECT)
    expect(reflectIdx).toBeGreaterThan(-1)
    expect(wsIdx).toBeGreaterThan(reflectIdx)
  })
})
