import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getAuthorizedProjectRoots,
  getActiveProjectRoot,
  getEffectiveProjectRoot,
  isCustomProjectRootConfigured,
  validateProjectRoot,
  addAuthorizedProjectRoot,
  removeAuthorizedProjectRoot,
  setActiveProjectRoot,
  safeProjectPath,
  PROJECT_WORKSPACE_ROOTS_KEY,
  PROJECT_WORKSPACE_ACTIVE_KEY,
} from '@akemi-mio/core/workspace/project-root'
import { WORKSPACE_ROOT } from '@akemi-mio/core/config'

const DEFAULT_PROJECTS = join(WORKSPACE_ROOT, 'projects')
const LEGACY_KEY = 'project_workspace_root'

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

let tmpDir: string
let tmpDir2: string

beforeEach(() => {
  store.data.clear()
  vi.clearAllMocks()
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-ws-test-'))
  tmpDir2 = mkdtempSync(join(tmpdir(), 'mio-ws-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(tmpDir2, { recursive: true, force: true })
})

describe('getAuthorizedProjectRoots / getActiveProjectRoot / getEffectiveProjectRoot', () => {
  it('\u672a\u914d\u7f6e\u65f6\u8fd4\u56de\u7a7a\u5217\u8868 / null / \u9ed8\u8ba4\u76ee\u5f55', () => {
    expect(getAuthorizedProjectRoots()).toEqual([])
    expect(getActiveProjectRoot()).toBeNull()
    expect(getEffectiveProjectRoot()).toBe(DEFAULT_PROJECTS)
    expect(isCustomProjectRootConfigured()).toBe(false)
  })

  it('\u65b0\u952e\u914d\u7f6e\u591a\u4e2a\u76ee\u5f55\u540e\u8fd4\u56de\u5217\u8868\uff0c\u9ed8\u8ba4 active \u4e3a\u7b2c\u4e00\u4e2a', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir, tmpDir2])
    expect(getActiveProjectRoot()).toBe(tmpDir)
    expect(getEffectiveProjectRoot()).toBe(tmpDir)
    expect(isCustomProjectRootConfigured()).toBe(true)
  })

  it('\u8bbe\u7f6e active \u540e\u4f18\u5148\u8fd4\u56de active \u76ee\u5f55', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    store.data.set(PROJECT_WORKSPACE_ACTIVE_KEY, tmpDir2)
    expect(getActiveProjectRoot()).toBe(tmpDir2)
    expect(getEffectiveProjectRoot()).toBe(tmpDir2)
  })

  it('active \u6307\u5411\u672a\u6388\u6743\u76ee\u5f55\u65f6\u56de\u9000\u7b2c\u4e00\u4e2a', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    store.data.set(PROJECT_WORKSPACE_ACTIVE_KEY, join(tmpDir, 'nope'))
    expect(getActiveProjectRoot()).toBe(tmpDir)
  })

  it('\u65e7\u952e\u5355\u76ee\u5f55\u81ea\u52a8\u8fc1\u79fb\u4e3a\u65b0\u5217\u8868', () => {
    store.data.set(LEGACY_KEY, tmpDir)
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir])
    expect(store.data.get(PROJECT_WORKSPACE_ROOTS_KEY)).toBe(JSON.stringify([tmpDir]))
    expect(store.data.has(LEGACY_KEY)).toBe(false)
  })

  it('\u914d\u7f6e\u76ee\u5f55\u88ab\u5220\u9664\u540e getEffectiveProjectRoot \u56de\u9000\u9ed8\u8ba4', () => {
    const gone = join(tmpDir, 'gone')
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([gone]))
    expect(getEffectiveProjectRoot()).toBe(DEFAULT_PROJECTS)
  })
})

describe('validateProjectRoot', () => {
  it('accepts existing directory and normalizes', () => {
    const v = validateProjectRoot(tmpDir)
    expect(v.ok).toBe(true)
    expect(v.normalized).toBe(tmpDir)
  })

  it('empty string = reset to default', () => {
    expect(validateProjectRoot('')).toEqual({ ok: true, normalized: undefined })
    expect(validateProjectRoot('   ')).toEqual({ ok: true, normalized: undefined })
  })

  it('rejects non-existent directory', () => {
    const v = validateProjectRoot(join(tmpDir, 'nope'))
    expect(v.ok).toBe(false)
    expect(v.error).toContain('\u76ee\u5f55\u4e0d\u5b58\u5728')
  })

  it('rejects file path', () => {
    const file = join(tmpDir, 'a.txt')
    writeFileSync(file, 'x')
    const v = validateProjectRoot(file)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('\u4e0d\u662f\u76ee\u5f55')
  })

  it('rejects Mio workspace internal directories', () => {
    expect(validateProjectRoot(WORKSPACE_ROOT).ok).toBe(false)
    expect(validateProjectRoot(join(WORKSPACE_ROOT, 'projects')).ok).toBe(false)
  })

  it('rejects system root and Windows directories', () => {
    expect(validateProjectRoot('C:\\\\').ok).toBe(false)
    expect(validateProjectRoot('C:\\\\Windows').ok).toBe(false)
    expect(validateProjectRoot('C:\\\\Program Files').ok).toBe(false)
  })
})

describe('addAuthorizedProjectRoot', () => {
  it('\u4fdd\u5b58\u6709\u6548\u8def\u5f84\u5e76\u5199\u5165\u5217\u8868', () => {
    const res = addAuthorizedProjectRoot(tmpDir)
    expect(res.ok).toBe(true)
    expect(store.set).toHaveBeenCalledWith(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir]))
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir])
  })

  it('\u591a\u4e2a\u76ee\u5f55\u7d2f\u52a0', () => {
    addAuthorizedProjectRoot(tmpDir)
    addAuthorizedProjectRoot(tmpDir2)
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir, tmpDir2])
  })

  it('\u91cd\u590d\u6dfb\u52a0\u540c\u4e00\u76ee\u5f55\u4e0d\u4f1a\u91cd\u590d', () => {
    addAuthorizedProjectRoot(tmpDir)
    addAuthorizedProjectRoot(tmpDir)
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir])
  })

  it('\u62d2\u7edd\u4e0d\u5b58\u5728\u7684\u76ee\u5f55', () => {
    const res = addAuthorizedProjectRoot(join(tmpDir, 'nope'))
    expect(res.ok).toBe(false)
    expect(getAuthorizedProjectRoots()).toEqual([])
  })

  it('\u62d2\u7edd\u7a7a\u8def\u5f84', () => {
    const res = addAuthorizedProjectRoot('')
    expect(res.ok).toBe(false)
  })
})

describe('removeAuthorizedProjectRoot', () => {
  it('\u79fb\u9664\u6307\u5b9a\u76ee\u5f55', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    removeAuthorizedProjectRoot(tmpDir)
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir2])
  })

  it('\u79fb\u9664\u6700\u540e\u4e00\u4e2a\u76ee\u5f55\u65f6\u5220\u9664\u952e', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir]))
    removeAuthorizedProjectRoot(tmpDir)
    expect(store.delete).toHaveBeenCalledWith(PROJECT_WORKSPACE_ROOTS_KEY)
    expect(getAuthorizedProjectRoots()).toEqual([])
  })

  it('\u79fb\u9664\u5f53\u524d active \u76ee\u5f55\u65f6\u6e05\u9664 active \u952e', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    store.data.set(PROJECT_WORKSPACE_ACTIVE_KEY, tmpDir)
    removeAuthorizedProjectRoot(tmpDir)
    expect(store.data.has(PROJECT_WORKSPACE_ACTIVE_KEY)).toBe(false)
    expect(getActiveProjectRoot()).toBe(tmpDir2)
  })

  it('\u79fb\u9664\u672a\u6388\u6743\u76ee\u5f55\u4e3a\u65e0\u64cd\u4f5c', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir]))
    removeAuthorizedProjectRoot(tmpDir2)
    expect(getAuthorizedProjectRoots()).toEqual([tmpDir])
  })
})

describe('setActiveProjectRoot', () => {
  it('\u8bbe\u7f6e\u6388\u6743\u76ee\u5f55\u4e3a\u5f53\u524d', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    const res = setActiveProjectRoot(tmpDir2)
    expect(res.ok).toBe(true)
    expect(store.data.get(PROJECT_WORKSPACE_ACTIVE_KEY)).toBe(tmpDir2)
  })

  it('\u62d2\u7edd\u672a\u6388\u6743\u76ee\u5f55', () => {
    const res = setActiveProjectRoot(join(tmpDir, 'nope'))
    expect(res.ok).toBe(false)
    expect(store.data.has(PROJECT_WORKSPACE_ACTIVE_KEY)).toBe(false)
  })
})

describe('safeProjectPath', () => {
  it('\u7edd\u5bf9\u8def\u5f84\u5728\u6388\u6743\u76ee\u5f55\u5185\u65f6\u8fd4\u56de', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    const target = join(tmpDir, 'a', 'b.ts')
    expect(safeProjectPath(target)).toBe(target)
  })

  it('\u76f8\u5bf9\u8def\u5f84\u57fa\u4e8e\u5f53\u524d\u751f\u6548\u76ee\u5f55\u89e3\u6790', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir, tmpDir2]))
    store.data.set(PROJECT_WORKSPACE_ACTIVE_KEY, tmpDir2)
    expect(safeProjectPath('x/y.ts')).toBe(resolve(tmpDir2, 'x', 'y.ts'))
  })

  it('\u8d85\u51fa\u6388\u6743\u76ee\u5f55\u65f6\u629b\u51fa', () => {
    store.data.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify([tmpDir]))
    const outside = join(tmpDir2, 'x.ts')
    expect(() => safeProjectPath(outside)).toThrow()
  })
})
