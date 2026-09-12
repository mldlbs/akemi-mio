# 自定义项目工作区（方案 A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许用户在设置中选择一个本地目录作为「项目工作区」，文件类工具（读/写/编辑/搜索/命令/分析）以该目录为 project 工作区根；未配置时行为与现状完全一致。

**Architecture:** 新增 `src/main/workspace/project-root.ts` 作为配置读取/保存/校验唯一入口（全局存储：直接读写 credentialsManager，键 project_workspace_root；Mio 单会话，不做 per-session 表）；`src/main/tool/utils/workspace.ts` 的 `resolveWorkspace('project')` 改为运行时取 `getEffectiveProjectRoot()`；仅有的两处模块级路径缓存（`GrepTool` / `AnalyzeCodebaseTool`）改为调用时求值；新增 `workspace:getProjectRoot` / `workspace:setProjectRoot` / `workspace:selectProjectRootDialog` IPC + preload 方法 + 会话面板（ChatSlot 顶部）「授权目录」栏；`buildSystemPrompt` 动态注入项目工作区路径。保存后立即生效，无需重启。

**Tech Stack:** Electron + TypeScript + better-sqlite3（credentials 表）+ React 19 + Vitest。

**前置文档:** `docs/design/2026-08-11-custom-project-workspace-design.md`

---

## Task 0: 准备工作区与基线

**Files:** 无

- [ ] **Step 1: 创建功能分支**

```bash
git checkout -b codex/custom-project-workspace
```

- [ ] **Step 2: 确认基线测试可通过（改动前绿）**

Run: `npx vitest run src/main/config/__tests__/index.test.ts src/main/tool/__tests__/index.test.ts`
Expected: 全部 PASS

---

## Task 1: `project-root` 配置模块

**Files:**
- Create: `src/main/workspace/project-root.ts`
- Test: `src/main/workspace/__tests__/project-root.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/workspace/__tests__/project-root.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setProjectRootStore,
  getCustomProjectRoot,
  getEffectiveProjectRoot,
  isCustomProjectRootConfigured,
  validateProjectRoot,
  setCustomProjectRoot,
  PROJECT_WORKSPACE_ROOT_KEY,
} from '../project-root'
import { WORKSPACE_ROOT } from '../../config'

const DEFAULT_PROJECTS = join(WORKSPACE_ROOT, 'projects')

function makeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    store: {
      get: vi.fn((k: string) => data[k] ?? null),
      set: vi.fn((k: string, v: string) => { data[k] = v }),
      delete: vi.fn((k: string) => { delete data[k]; return true }),
    },
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-ws-test-'))
})

afterEach(() => {
  setProjectRootStore(null)
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('getCustomProjectRoot / getEffectiveProjectRoot', () => {
  it('未接线 store 时返回 null / 默认目录 / 未配置', () => {
    expect(getCustomProjectRoot()).toBeNull()
    expect(getEffectiveProjectRoot()).toBe(DEFAULT_PROJECTS)
    expect(isCustomProjectRootConfigured()).toBe(false)
  })

  it('store 有值时返回归一化路径并生效', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(getCustomProjectRoot()).toBe(tmpDir)
    expect(getEffectiveProjectRoot()).toBe(tmpDir)
    expect(isCustomProjectRootConfigured()).toBe(true)
  })

  it('配置目录被删除后回退默认', () => {
    const gone = join(tmpDir, 'gone')
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: gone })
    setProjectRootStore(store)
    expect(getEffectiveProjectRoot()).toBe(DEFAULT_PROJECTS)
  })
})

describe('validateProjectRoot', () => {
  it('接受存在的目录并归一化', () => {
    const v = validateProjectRoot(tmpDir)
    expect(v.ok).toBe(true)
    expect(v.normalized).toBe(tmpDir)
  })

  it('空串 = 恢复默认', () => {
    expect(validateProjectRoot('')).toEqual({ ok: true, normalized: undefined })
    expect(validateProjectRoot('   ')).toEqual({ ok: true, normalized: undefined })
  })

  it('拒绝不存在的目录', () => {
    const v = validateProjectRoot(join(tmpDir, 'nope'))
    expect(v.ok).toBe(false)
    expect(v.error).toContain('目录不存在')
  })

  it('拒绝文件路径', () => {
    const file = join(tmpDir, 'a.txt')
    writeFileSync(file, 'x')
    const v = validateProjectRoot(file)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('不是目录')
  })

  it('拒绝 Mio 自身工作区内部目录', () => {
    expect(validateProjectRoot(WORKSPACE_ROOT).ok).toBe(false)
    expect(validateProjectRoot(join(WORKSPACE_ROOT, 'projects')).ok).toBe(false)
  })

  it('拒绝系统根目录与 Windows 目录', () => {
    expect(validateProjectRoot('C:\\').ok).toBe(false)
    expect(validateProjectRoot('C:\\Windows').ok).toBe(false)
  })
})

describe('setCustomProjectRoot', () => {
  it('设置合法目录后写入 store', () => {
    const { store } = makeStore()
    setProjectRootStore(store)
    const v = setCustomProjectRoot(tmpDir)
    expect(v.ok).toBe(true)
    expect(store.set).toHaveBeenCalledWith(PROJECT_WORKSPACE_ROOT_KEY, tmpDir)
  })

  it('空串恢复默认（delete）', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    const v = setCustomProjectRoot('')
    expect(v.ok).toBe(true)
    expect(store.delete).toHaveBeenCalledWith(PROJECT_WORKSPACE_ROOT_KEY)
  })

  it('非法路径不写 store', () => {
    const { store } = makeStore()
    setProjectRootStore(store)
    const v = setCustomProjectRoot(join(tmpDir, 'nope'))
    expect(v.ok).toBe(false)
    expect(store.set).not.toHaveBeenCalled()
  })

  it('store 未接线时返回错误', () => {
    setProjectRootStore(null)
    const v = setCustomProjectRoot(tmpDir)
    expect(v.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/workspace/__tests__/project-root.test.ts`
Expected: FAIL（`../project-root` 模块不存在）

- [ ] **Step 3: 实现 `project-root.ts`**

创建 `src/main/workspace/project-root.ts`：

```ts
import { join, resolve } from 'path'
import { statSync } from 'fs'
import { WORKSPACE_ROOT, RUNTIME_ROOT } from '../config'
import { log } from '../logger/Logger'

export const PROJECT_WORKSPACE_ROOT_KEY = 'project_workspace_root'

export interface ProjectRootStore {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): boolean
}

let _store: ProjectRootStore | null = null

export function setProjectRootStore(store: ProjectRootStore | null): void {
  _store = store
}

function normalizePath(input: string): string {
  const resolved = resolve((input || '').trim() || '.')
  let out = resolved.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(out)) out += '\\'
  return out
}

function isPathWithin(root: string, target: string): boolean {
  const lower = process.platform === 'win32'
  const r = (lower ? root.toLowerCase() : root).replace(/[\\/]+$/, '')
  const t = lower ? target.toLowerCase() : target
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}

export function getCustomProjectRoot(): string | null {
  if (!_store) return null
  const raw = _store.get(PROJECT_WORKSPACE_ROOT_KEY)
  if (!raw || !raw.trim()) return null
  return normalizePath(raw)
}

export function getEffectiveProjectRoot(): string {
  const custom = getCustomProjectRoot()
  if (custom) {
    try {
      if (statSync(custom).isDirectory()) return custom
    } catch {
      /* fall through to default */
    }
    log('WARN', 'project_root_missing_fallback', { path: custom })
  }
  return join(WORKSPACE_ROOT, 'projects')
}

export function isCustomProjectRootConfigured(): boolean {
  return getCustomProjectRoot() !== null
}

export interface ProjectRootValidation {
  ok: boolean
  error?: string
  normalized?: string
}

export function validateProjectRoot(input: string): ProjectRootValidation {
  const trimmed = (input || '').trim()
  if (!trimmed) return { ok: true, normalized: undefined }

  const normalized = normalizePath(trimmed)
  let stat
  try {
    stat = statSync(normalized)
  } catch {
    return { ok: false, error: `目录不存在: ${normalized}` }
  }
  if (!stat.isDirectory()) return { ok: false, error: `不是目录: ${normalized}` }

  if (isPathWithin(WORKSPACE_ROOT, normalized)) {
    return { ok: false, error: `不能选择 Mio 自身工作区内部目录: ${normalized}` }
  }
  if (isPathWithin(RUNTIME_ROOT, normalized)) {
    return { ok: false, error: `不能选择应用安装目录内部: ${normalized}` }
  }
  if (/^[A-Za-z]:[\\/]$/.test(normalized) || /^[A-Za-z]:[\\/]Windows(?:[\\/]|$)/i.test(normalized)) {
    return { ok: false, error: `不能选择系统根目录或 Windows 目录: ${normalized}` }
  }
  return { ok: true, normalized }
}

export function setCustomProjectRoot(input: string): ProjectRootValidation {
  const v = validateProjectRoot(input)
  if (!v.ok) return v
  if (!_store) return { ok: false, error: '凭据管理器未就绪' }
  if (v.normalized === undefined) {
    _store.delete(PROJECT_WORKSPACE_ROOT_KEY)
  } else {
    _store.set(PROJECT_WORKSPACE_ROOT_KEY, v.normalized)
  }
  return v
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/main/workspace/__tests__/project-root.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/workspace/project-root.ts src/main/workspace/__tests__/project-root.test.ts
git commit -m "feat: add project-root config module with validation"
```

---

## Task 2: `workspace.ts` 接入自定义根

**Files:**
- Modify: `src/main/tool/utils/workspace.ts`
- Test: `src/main/tool/__tests__/workspace.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/tool/__tests__/workspace.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveWorkspace,
  safeWorkspacePath,
  getProjectSourceRoot,
  WORKSPACE_DIR,
  EVOLUTION_WORKSPACE_DIR,
} from '../utils/workspace'
import { setProjectRootStore, PROJECT_WORKSPACE_ROOT_KEY } from '../../workspace/project-root'
import { WORKSPACE_ROOT } from '../../config'

const DEFAULT_PROJECTS = join(WORKSPACE_ROOT, 'projects')

function makeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    store: {
      get: vi.fn((k: string) => data[k] ?? null),
      set: vi.fn((k: string, v: string) => { data[k] = v }),
      delete: vi.fn((k: string) => { delete data[k]; return true }),
    },
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-ws-util-'))
})

afterEach(() => {
  setProjectRootStore(null)
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveWorkspace', () => {
  it('默认（未配置）时 project 与不传参均为默认 projects 目录', () => {
    expect(resolveWorkspace('project')).toBe(DEFAULT_PROJECTS)
    expect(resolveWorkspace()).toBe(DEFAULT_PROJECTS)
  })

  it('evolution / mcp 不受自定义根影响', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(resolveWorkspace('evolution')).toBe(EVOLUTION_WORKSPACE_DIR)
    expect(resolveWorkspace('mcp')).toBe(WORKSPACE_DIR)
  })

  it('配置自定义根后 project 返回自定义目录', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(resolveWorkspace('project')).toBe(tmpDir)
    expect(resolveWorkspace()).toBe(tmpDir)
  })
})

describe('safeWorkspacePath', () => {
  it('默认边界：相对路径解析在默认 projects 内', () => {
    expect(safeWorkspacePath('src/a.ts', 'project')).toBe(join(DEFAULT_PROJECTS, 'src/a.ts'))
  })

  it('自定义根边界：路径解析在自定义目录内', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(safeWorkspacePath('src/a.ts', 'project')).toBe(join(tmpDir, 'src/a.ts'))
  })

  it('拒绝 .. 穿越', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(() => safeWorkspacePath('../../escape.txt', 'project')).toThrow()
  })

  it('拒绝工作区外的绝对路径', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(() => safeWorkspacePath(process.cwd(), 'project')).toThrow()
  })
})

describe('getProjectSourceRoot', () => {
  it('默认 = PROJECT_ROOT（DEV_PROJECT_ROOT || WORKSPACE_ROOT）', () => {
    expect(getProjectSourceRoot()).toBe(WORKSPACE_ROOT)
  })

  it('自定义根优先于默认', () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    expect(getProjectSourceRoot()).toBe(tmpDir)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/tool/__tests__/workspace.test.ts`
Expected: FAIL（`getProjectSourceRoot` 不存在，`resolveWorkspace` 未返回自定义根）

- [ ] **Step 3: 实现**

修改 `src/main/tool/utils/workspace.ts`：

```ts
import { resolve, join, relative } from 'path'
import { existsSync } from 'fs'
import { DEV_PROJECT_ROOT, WORKSPACE_ROOT, WORKSPACE } from '../../config'
import { getCustomProjectRoot, getEffectiveProjectRoot } from '../../workspace/project-root'

/** Mio 工作区根 —— 所有操作限定在此 */
export const PROJECT_ROOT = DEV_PROJECT_ROOT || WORKSPACE_ROOT
export const WORKSPACE_DIR = join(WORKSPACE_ROOT, 'projects', '__sandbox__')
export const EVOLUTION_WORKSPACE_DIR = WORKSPACE.evolution

/** grep / analyze_codebase 的搜索/执行根：自定义项目根 > DEV_PROJECT_ROOT > WORKSPACE_ROOT */
export function getProjectSourceRoot(): string {
  return getCustomProjectRoot() || PROJECT_ROOT
}
```

并修改 `resolveWorkspace`：

```ts
export function resolveWorkspace(ws?: string): string {
  if (ws === 'project' || !ws) return getEffectiveProjectRoot()
  if (ws === 'evolution') return EVOLUTION_WORKSPACE_DIR
  return WORKSPACE_DIR
}
```

并修改 `safeWorkspacePath` 的大小写归一化边界校验：

```ts
function isWithin(root: string, target: string): boolean {
  const lower = process.platform === 'win32'
  const r = (lower ? root.toLowerCase() : root).replace(/[\\/]+$/, '')
  const t = lower ? target.toLowerCase() : target
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}

/** 安全的工作区路径解析 */
export function safeWorkspacePath(requested: string, ws?: string): string {
  const wsDir = resolveWorkspace(ws)
  const cleanRequested = stripWorkspaceLabelPrefix(requested, ws)
  const resolved = resolve(wsDir, cleanRequested)
  if (!isWithin(wsDir, resolved)) throw new Error(`路径 ${requested} 超出工作区目录`)
  return resolved
}
```

其余函数（`wsLabel` / `safePath` / `inferWorkspace` / `stripWorkspaceLabelPrefix`）保持不变。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/main/tool/__tests__/workspace.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 回归确认现有工具测试不破**

Run: `npx vitest run src/main/tool/__tests__/index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/tool/utils/workspace.ts src/main/tool/__tests__/workspace.test.ts
git commit -m "feat: resolve project workspace from custom root at runtime"
```

---

## Task 3: `write_file` / `edit_file` 规则放宽

**Files:**
- Modify: `src/main/tool/definitions/WriteFileTool.ts`
- Modify: `src/main/tool/definitions/EditFileTool.ts`
- Test: `src/main/tool/__tests__/project-workspace-tools.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/tool/__tests__/project-workspace-tools.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileTool } from '../definitions/WriteFileTool'
import { editFileTool } from '../definitions/EditFileTool'
import { setProjectRootStore, PROJECT_WORKSPACE_ROOT_KEY } from '../../workspace/project-root'

function makeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    store: {
      get: vi.fn((k: string) => data[k] ?? null),
      set: vi.fn((k: string, v: string) => { data[k] = v }),
      delete: vi.fn((k: string) => { delete data[k]; return true }),
    },
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-ws-tools-'))
})

afterEach(() => {
  setProjectRootStore(null)
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('write_file 默认规则（未配置自定义根）', () => {
  it('project 根级写入被拒绝', async () => {
    const res = await writeFileTool.handler({ path: 'package.json', content: '{}', workspace: 'project' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('根目录')
  })

  it('project 内 .json 临时文件被拒绝', async () => {
    const res = await writeFileTool.handler({ path: 'myapp/notes.json', content: '{}', workspace: 'project' })
    expect(res.isError).toBe(true)
  })
})

describe('write_file 自定义根', () => {
  it('允许写根级 package.json', async () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    const res = await writeFileTool.handler({ path: 'package.json', content: '{"name":"x"}', workspace: 'project' })
    expect(res.isError).toBe(false)
    expect(readFileSync(join(tmpDir, 'package.json'), 'utf-8')).toBe('{"name":"x"}')
  })

  it('允许写子目录 .json', async () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    const res = await writeFileTool.handler({ path: 'config/settings.json', content: '{}', workspace: 'project' })
    expect(res.isError).toBe(false)
    expect(existsSync(join(tmpDir, 'config/settings.json'))).toBe(true)
  })
})

describe('edit_file 自定义根', () => {
  it('允许编辑根级文件', async () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    writeFileSync(join(tmpDir, 'README.md'), 'hello')
    const res = await editFileTool.handler({
      path: 'README.md',
      old_string: 'hello',
      new_string: 'hi',
      workspace: 'project',
    })
    expect(res.isError).toBe(false)
    expect(readFileSync(join(tmpDir, 'README.md'), 'utf-8')).toBe('hi')
  })
})

describe('edit_file 默认规则', () => {
  it('project 根级编辑被拒绝', async () => {
    const res = await editFileTool.handler({
      path: 'README.md',
      old_string: 'a',
      new_string: 'b',
      workspace: 'project',
    })
    expect(res.isError).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/tool/__tests__/project-workspace-tools.test.ts`
Expected: FAIL（自定义根下根级写入仍被拒绝）

- [ ] **Step 3: 实现 WriteFileTool**

修改 `src/main/tool/definitions/WriteFileTool.ts`：
- 顶部新增 import：`import { isCustomProjectRootConfigured } from '../../workspace/project-root'`
- handler 中把两条硬阻断包进条件：

```ts
      const customProjectRoot = isCustomProjectRootConfigured()
      // 硬阻断：project workspace 下禁止写入根级文件（仅默认沙箱；自定义项目根放行）
      if (ws === 'project' && !customProjectRoot) {
        const cleanPath = args.path.replace(/^[.\/\\]+/, '')
        if (!cleanPath.includes('/') && !cleanPath.includes('\\')) {
          return formatToolError(
            `禁止在项目源码根目录写文件「${args.path}」。代码写入 projects/ 下，临时文件写入 evolution_workspace/tmp/。`,
          )
        }
        // project 工作区禁止写 .txt/.json/.log 临时文件
        const ext = cleanPath.split('.').pop()?.toLowerCase()
        if (ext && ['txt', 'json', 'log', 'tmp', 'out'].includes(ext)) {
          return formatToolError(`禁止在 projects/ 目录写 .${ext} 临时文件「${args.path}」。请写入 evolution_workspace/tmp/。`)
        }
      }
```

- [ ] **Step 4: 实现 EditFileTool**

修改 `src/main/tool/definitions/EditFileTool.ts`：
- 顶部新增 import：`import { isCustomProjectRootConfigured } from '../../workspace/project-root'`
- 把根级编辑阻断包进条件：

```ts
      // 硬阻断：禁止编辑项目根目录的根级文件（仅默认沙箱；自定义项目根放行）
      if (ws === 'project' && !isCustomProjectRootConfigured()) {
        const cleanPath = args.path.replace(/^[.\/\\]+/, '')
        if (!cleanPath.includes('/') && !cleanPath.includes('\\')) {
          throw new Error(`禁止编辑项目根目录文件「${args.path}」。`)
        }
      }
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/main/tool/__tests__/project-workspace-tools.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/tool/definitions/WriteFileTool.ts src/main/tool/definitions/EditFileTool.ts src/main/tool/__tests__/project-workspace-tools.test.ts
git commit -m "feat: relax project workspace write/edit guards when custom root configured"
```

---

## Task 4: `grep` / `analyze_codebase` 运行时解析

**Files:**
- Modify: `src/main/tool/definitions/GrepTool.ts`
- Modify: `src/main/tool/definitions/AnalyzeCodebaseTool.ts`
- Test: `src/main/tool/__tests__/project-workspace-tools.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `src/main/tool/__tests__/project-workspace-tools.test.ts` 末尾追加：

```ts
describe('grep 自定义根', () => {
  it('搜索范围 = 自定义项目根', async () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    writeFileSync(join(tmpDir, 'src/app.ts'), 'const x = 1 // TODO: fix')
    const { grepTool } = await import('../definitions/GrepTool')
    const res = await grepTool.handler({ pattern: 'TODO' })
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toContain('src/app.ts:1:')
  })
})

describe('analyze_codebase 自定义根', () => {
  it('命令 cwd = 自定义项目根', async () => {
    vi.resetModules()
    const execMock = vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: { stdout: string }, stderr: { stderr: string }) => void) => {
      cb(null, { stdout: '' }, { stderr: '' })
    })
    vi.doMock('child_process', () => ({ exec: execMock }))
    const { analyzeCodebaseTool } = await import('../definitions/AnalyzeCodebaseTool')
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    const res = await analyzeCodebaseTool.handler({ quick: true })
    expect(res.isError).toBe(false)
    const firstOpts = execMock.mock.calls[0][1] as { cwd: string }
    expect(firstOpts.cwd).toBe(tmpDir)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/tool/__tests__/project-workspace-tools.test.ts`
Expected: FAIL（grep 搜索仍为默认根 / analyze cwd 非自定义根）

- [ ] **Step 3: 实现 GrepTool**

修改 `src/main/tool/definitions/GrepTool.ts`：
- 把 `import { PROJECT_ROOT } from '../utils/workspace'` 改为 `import { getProjectSourceRoot } from '../utils/workspace'`
- 在 `grepCode` 内取根，替换三处 `PROJECT_ROOT`：

```ts
function grepCode(pattern: string, include?: string): string {
  const projectRoot = getProjectSourceRoot()
  const results: string[] = []
  let fileCount = 0

  const walk = (dir: string): void => {
    if (fileCount >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (fileCount >= MAX_FILES) return
      const p = join(dir, e.name)
      if (!p.startsWith(projectRoot)) continue
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.isFile()) continue
      if (include) {
        const globRe = new RegExp('^' + include.replace(/\*/g, '.*') + '$')
        if (!globRe.test(e.name)) continue
      }
      fileCount++
      try {
        const content = readFileSync(p, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            results.push(`${relative(projectRoot, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
        }
      } catch {
        /* skip binary */
      }
    }
  }

  walk(projectRoot)
  const output = results.join('\n')
  return output.slice(0, MAX_OUTPUT) || '未找到匹配'
}
```

- [ ] **Step 4: 实现 AnalyzeCodebaseTool**

修改 `src/main/tool/definitions/AnalyzeCodebaseTool.ts`：
- 把 `import { PROJECT_ROOT } from '../utils/workspace'` 改为 `import { getProjectSourceRoot } from '../utils/workspace'`
- 修改 `safeExec`：

```ts
async function safeExec(cmd: string, timeout: number, fallback: string): Promise<string> {
  try {
    const { stdout } = await asyncExec(cmd, { cwd: getProjectSourceRoot(), encoding: 'utf-8', timeout })
    return stdout.trim()
  } catch {
    return fallback
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/main/tool/__tests__/project-workspace-tools.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/tool/definitions/GrepTool.ts src/main/tool/definitions/AnalyzeCodebaseTool.ts src/main/tool/__tests__/project-workspace-tools.test.ts
git commit -m "feat: resolve grep/analyze_codebase root at runtime from custom project root"
```

---

## Task 5: IPC handler + 注册

**Files:**
- Create: `src/main/ipc/handlers/workspace.ts`
- Modify: `src/main/ipc/handlers.ts`
- Test: `src/main/ipc/__tests__/workspace.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/ipc/__tests__/workspace.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ipcHandlers = new Map<string, (event: any, ...args: any[]) => any>()
const dialogMock = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: any) => {
      ipcHandlers.set(channel, handler)
    }),
  },
  dialog: dialogMock,
  BrowserWindow: { fromWebContents: vi.fn(() => ({})) },
}))

import { registerWorkspaceHandlers } from '../handlers/workspace'
import { setProjectRootStore, PROJECT_WORKSPACE_ROOT_KEY } from '../../workspace/project-root'

function makeStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    store: {
      get: vi.fn((k: string) => data[k] ?? null),
      set: vi.fn((k: string, v: string) => { data[k] = v }),
      delete: vi.fn((k: string) => { delete data[k]; return true }),
    },
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-ws-ipc-'))
  ipcHandlers.clear()
  registerWorkspaceHandlers({} as any)
})

afterEach(() => {
  setProjectRootStore(null)
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('workspace:getProjectRoot', () => {
  it('未配置时返回默认', async () => {
    const res = await ipcHandlers.get('workspace:getProjectRoot')!({})
    expect(res.isCustom).toBe(false)
    expect(res.configured).toBeNull()
    expect(res.effective).toContain('projects')
    expect(res.exists).toBe(true)
  })

  it('配置后返回自定义目录', async () => {
    const { store } = makeStore({ [PROJECT_WORKSPACE_ROOT_KEY]: tmpDir })
    setProjectRootStore(store)
    const res = await ipcHandlers.get('workspace:getProjectRoot')!({})
    expect(res.isCustom).toBe(true)
    expect(res.configured).toBe(tmpDir)
    expect(res.effective).toBe(tmpDir)
  })
})

describe('workspace:setProjectRoot', () => {
  it('合法目录设置成功', async () => {
    const { store } = makeStore()
    setProjectRootStore(store)
    const res = await ipcHandlers.get('workspace:setProjectRoot')!({}, tmpDir)
    expect(res.ok).toBe(true)
    expect(store.set).toHaveBeenCalled()
  })

  it('非法目录返回错误', async () => {
    const { store } = makeStore()
    setProjectRootStore(store)
    const res = await ipcHandlers.get('workspace:setProjectRoot')!({}, join(tmpDir, 'nope'))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

describe('dialog:selectDirectory', () => {
  it('取消返回 null', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const res = await ipcHandlers.get('dialog:selectDirectory')!({})
    expect(res).toEqual({ path: null })
  })

  it('选择后返回路径', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [tmpDir] })
    const res = await ipcHandlers.get('dialog:selectDirectory')!({})
    expect(res).toEqual({ path: tmpDir })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/ipc/__tests__/workspace.test.ts`
Expected: FAIL（`../handlers/workspace` 不存在）

- [ ] **Step 3: 实现 handler**

创建 `src/main/ipc/handlers/workspace.ts`：

```ts
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { getCustomProjectRoot, getEffectiveProjectRoot, setCustomProjectRoot } from '../../workspace/project-root'
import type { HandlerContext } from './context'

export function registerWorkspaceHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('workspace:getProjectRoot', async () => {
    const configured = getCustomProjectRoot()
    const effective = getEffectiveProjectRoot()
    return {
      configured,
      effective,
      isCustom: configured !== null,
      exists: configured ? existsSync(configured) : true,
    }
  })

  ipcMain.handle('workspace:setProjectRoot', async (_event, input: string) => {
    return setCustomProjectRoot(typeof input === 'string' ? input : '')
  })

  ipcMain.handle('dialog:selectDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: '选择项目工作区目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
  })
}
```

- [ ] **Step 4: 注册到 handlers.ts**

修改 `src/main/ipc/handlers.ts`：
- 在 import 区（`registerCredentialsHandlers` 附近）新增：
  `import { registerWorkspaceHandlers } from './handlers/workspace'`
- 在 `registerHandlers` 内、`registerCredentialsHandlers(ctx)` 之后新增：
  `registerWorkspaceHandlers(ctx)`

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/main/ipc/__tests__/workspace.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/handlers/workspace.ts src/main/ipc/handlers.ts src/main/ipc/__tests__/workspace.test.ts
git commit -m "feat: add workspace IPC handlers and directory picker"
```

---

## Task 6: preload API + 类型联动

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/__tests__/index.test.ts`
- Modify: `src/renderer/src/__tests__/mockIPC.ts`

- [ ] **Step 1: 写失败测试**

在 `src/preload/__tests__/index.test.ts` 的 `mockResponses` 中新增（`'credentials:delete'` 附近）：

```ts
'workspace:getProjectRoot': { configured: null, effective: 'C:\\mio', isCustom: false, exists: true },
'workspace:setProjectRoot': { ok: true },
'dialog:selectDirectory': { path: null },
```

并在文件末尾的 describe 内新增用例（参照现有 `credentials` 测试用例的写法）：

```ts
it('getProjectRoot 调用 workspace:getProjectRoot', async () => {
  await api.getProjectRoot()
  expect(ipcMock.invoke).toHaveBeenCalledWith('workspace:getProjectRoot')
})

it('setProjectRoot 调用 workspace:setProjectRoot', async () => {
  await api.setProjectRoot('D:\\my-project')
  expect(ipcMock.invoke).toHaveBeenCalledWith('workspace:setProjectRoot', 'D:\\my-project')
})

it('selectDirectory 调用 dialog:selectDirectory', async () => {
  await api.selectDirectory()
  expect(ipcMock.invoke).toHaveBeenCalledWith('dialog:selectDirectory')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --config vitest.config.preload.ts`
Expected: FAIL（`api.getProjectRoot` 不是函数）

- [ ] **Step 3: 实现 preload**

修改 `src/preload/index.ts`，在 `deleteCredential` 行后新增：

```ts
    getProjectRoot: (): Promise<{ configured: string | null; effective: string; isCustom: boolean; exists: boolean }> =>
      ipc.invoke('workspace:getProjectRoot'),

    setProjectRoot: (path: string): Promise<{ ok: boolean; error?: string; normalized?: string }> =>
      ipc.invoke('workspace:setProjectRoot', path),

    selectDirectory: (): Promise<{ path: string | null }> => ipc.invoke('dialog:selectDirectory'),
```

- [ ] **Step 4: 更新 renderer mockIPC**

修改 `src/renderer/src/__tests__/mockIPC.ts`，在 `deleteCredential` mock 后新增：

```ts
    getProjectRoot: vi
      .fn<[], Promise<{ configured: string | null; effective: string; isCustom: boolean; exists: boolean }>>()
      .mockResolvedValue({ configured: null, effective: 'C:\\mio\\projects', isCustom: false, exists: true }),
    setProjectRoot: vi
      .fn<[string], Promise<{ ok: boolean; error?: string; normalized?: string }>>()
      .mockResolvedValue({ ok: true }),
    selectDirectory: vi.fn<[], Promise<{ path: string | null }>>().mockResolvedValue({ path: null }),
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run --config vitest.config.preload.ts`
Expected: 全部 PASS
Run: `npx vitest run --config vitest.config.renderer.ts src/renderer/src/__tests__/App.test.tsx`
Expected: PASS（mockIPC 类型联动正常）

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/preload/__tests__/index.test.ts src/renderer/src/__tests__/mockIPC.ts
git commit -m "feat: expose workspace root APIs to renderer"
```

---

## Task 7: AppRuntime 接线

**Files:**
- Modify: `src/main/bootstrap/AppRuntime.ts`

- [ ] **Step 1: 接线**

修改 `src/main/bootstrap/AppRuntime.ts`：
- import 区新增：`import { setProjectRootStore } from '../workspace/project-root'`
- 在 `setCredentialsManager(credentialsManager)`（约 681 行）之后新增：

```ts
    setProjectRootStore(credentialsManager)
```

- [ ] **Step 2: 验证类型与现有测试**

Run: `npx vitest run src/main/bootstrap/__tests__/AppRuntime.llm-config-source.test.ts`
Expected: PASS
Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无错误（若仓库基线已有存量错误，确认没有新增错误即可）

- [ ] **Step 3: Commit**

```bash
git add src/main/bootstrap/AppRuntime.ts
git commit -m "feat: wire project-root store from credentials manager at startup"
```

---

## Task 8: 设置页「工作区」区块

**Files:**
- Modify: `src/renderer/src/settings/SettingsSystemTab.tsx`
- Test: `src/renderer/src/settings/__tests__/SettingsSystemTab.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/src/settings/__tests__/SettingsSystemTab.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '@testing-library/react'
import { createMockIPC } from '../../__tests__/mockIPC'
import { SettingsSystemTab } from '../SettingsSystemTab'
import type { SettingsTabProps } from '../types'

const props: SettingsTabProps = {
  values: {},
  onSetCredential: vi.fn(),
}

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('SettingsSystemTab 工作区区块', () => {
  it('展示当前项目工作区', async () => {
    render(<SettingsSystemTab {...props} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue(/C:\\mio\\projects/)).toBeTruthy()
    })
  })

  it('点击选择目录后调用 setProjectRoot', async () => {
    const api = createMockIPC({
      selectDirectory: vi.fn().mockResolvedValue({ path: 'D:\\my-project' }),
      setProjectRoot: vi.fn().mockResolvedValue({ ok: true }),
      getProjectRoot: vi.fn().mockResolvedValue({
        configured: 'D:\\my-project',
        effective: 'D:\\my-project',
        isCustom: true,
        exists: true,
      }),
    }) as any
    window.electronAPI = api
    render(<SettingsSystemTab {...props} />)
    fireEvent.click(await screen.findByText('选择目录'))
    await waitFor(() => {
      expect(api.setProjectRoot).toHaveBeenCalledWith('D:\\my-project')
    })
  })

  it('恢复默认按钮调用 setProjectRoot 空串', async () => {
    const api = createMockIPC({
      getProjectRoot: vi.fn().mockResolvedValue({
        configured: 'D:\\my-project',
        effective: 'D:\\my-project',
        isCustom: true,
        exists: true,
      }),
      setProjectRoot: vi.fn().mockResolvedValue({ ok: true }),
    }) as any
    window.electronAPI = api
    render(<SettingsSystemTab {...props} />)
    fireEvent.click(await screen.findByText('恢复默认'))
    await waitFor(() => {
      expect(api.setProjectRoot).toHaveBeenCalledWith('')
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --config vitest.config.renderer.ts src/renderer/src/settings/__tests__/SettingsSystemTab.test.tsx`
Expected: FAIL（工作区区块不存在）

- [ ] **Step 3: 实现 UI**

修改 `src/renderer/src/settings/SettingsSystemTab.tsx`：
- 顶部 import 新增：

```tsx
import { useCallback, useEffect, useState } from 'react'
```

- 文件内新增组件并在 `SettingsSystemTab` 返回 JSX 的最前面渲染：

```tsx
interface ProjectRootInfo {
  configured: string | null
  effective: string
  isCustom: boolean
  exists: boolean
}

function WorkspaceSection() {
  const [info, setInfo] = useState<ProjectRootInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setInfo(await window.electronAPI.getProjectRoot())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const apply = async (input: string) => {
    setBusy(true)
    setError('')
    try {
      const res = await window.electronAPI.setProjectRoot(input)
      if (!res.ok) setError(res.error || '设置失败')
      else await refresh()
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    const { path } = await window.electronAPI.selectDirectory()
    if (path) void apply(path)
  }

  return (
    <div className="settings-section">
      <span className="settings-section-title">工作区</span>
      <div className="settings-field">
        <span className="settings-label">项目工作区</span>
        <input
          type="text"
          className="settings-input"
          readOnly
          value={info ? (info.isCustom ? info.effective : `默认（${info.effective}）`) : '加载中...'}
        />
        {info && info.isCustom && !info.exists && (
          <span className="settings-badge settings-badge-warn">目录不存在，已回退默认</span>
        )}
        {error && <span className="settings-badge settings-badge-warn">{error}</span>}
        <span className="settings-help">
          文件工具（读/写/搜索/命令）在项目工作区内执行；保存后立即生效，记忆与设置不受影响
        </span>
      </div>
      <div className="settings-update-row">
        <button type="button" className="settings-btn" onClick={pick} disabled={busy}>
          选择目录
        </button>
        <button type="button" className="settings-btn" onClick={() => void apply('')} disabled={busy || !info?.isCustom}>
          恢复默认
        </button>
      </div>
    </div>
  )
}
```

在 `SettingsSystemTab` 返回 JSX 的最前面插入 `<WorkspaceSection />`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --config vitest.config.renderer.ts src/renderer/src/settings/__tests__/SettingsSystemTab.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/settings/SettingsSystemTab.tsx src/renderer/src/settings/__tests__/SettingsSystemTab.test.tsx
git commit -m "feat: add workspace section to system settings"
```

---

## Task 9: Agent 提示词注入

**Files:**
- Modify: `src/main/agent/context.ts`
- Modify: `src/main/agent/__tests__/context.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `src/main/agent/__tests__/context.test.ts` 的 `buildSystemPrompt` describe 内追加：

```ts
  it('自定义项目根时注入当前项目工作区', () => {
    const { setProjectRootStore, PROJECT_WORKSPACE_ROOT_KEY } = require('../../workspace/project-root') as typeof import('../../workspace/project-root')
    const store = {
      get: (k: string) => (k === PROJECT_WORKSPACE_ROOT_KEY ? 'D:\\my-project' : null),
      set: () => {},
      delete: () => true,
    }
    setProjectRootStore(store)
    try {
      const p = buildSystemPrompt()
      expect(p).toContain('D:\\my-project')
      expect(p).toContain('workspace="project"')
    } finally {
      setProjectRootStore(null)
    }
  })

  it('未配置时不注入工作区片段', () => {
    const { setProjectRootStore } = require('../../workspace/project-root') as typeof import('../../workspace/project-root')
    setProjectRootStore(null)
    const p = buildSystemPrompt()
    expect(p).not.toContain('当前项目工作区')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/agent/__tests__/context.test.ts`
Expected: FAIL（未注入）

- [ ] **Step 3: 实现**

修改 `src/main/agent/context.ts`：
- import 区新增：`import { getCustomProjectRoot } from '../workspace/project-root'`
- 在 `buildSystemPrompt` 函数末尾（`return prompt` 之前）追加：

```ts
  const customProjectRoot = getCustomProjectRoot()
  if (customProjectRoot) {
    const safePath = customProjectRoot.replace(/[\r\n]+/g, ' ')
    prompt += `\n\n【当前项目工作区】\nproject workspace 已配置为：${safePath}。项目源码相关的读写/编辑/命令请使用 workspace="project"。`
  }

  return prompt
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/main/agent/__tests__/context.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/context.ts src/main/agent/__tests__/context.test.ts
git commit -m "feat: inject custom project workspace path into agent system prompt"
```

---

## Task 10: 回归验证与文档收尾

**Files:**
- Modify: `docs/design/2026-08-11-custom-project-workspace-design.md`（状态改为已实现）

- [ ] **Step 1: 全量主进程单测**

Run: `npm run test:unit`
Expected: 全部 PASS（若存在与本次改动无关的存量失败，记录并确认非新增）

- [ ] **Step 2: preload / renderer 测试**

Run: `npm run test:preload`
Run: `npm run test:renderer`
Expected: 全部 PASS

- [ ] **Step 3: 类型检查与 lint**

Run: `npm run typecheck`
Expected: 无新增错误
Run: `npm run lint`
Expected: 无新增错误（可用 `npm run format` 处理格式后重跑）

- [ ] **Step 4: 更新设计文档状态**

把 `docs/design/2026-08-11-custom-project-workspace-design.md` 顶部 `> 状态：设计评审中` 改为 `> 状态：已实现`，并追加「验收记录」小节：

```markdown
## 12. 验收记录

- 2026-08-11：按 `docs/superpowers/plans/2026-08-11-custom-project-workspace.md` 实施完成。
- 回归：`npm run test:unit` / `test:preload` / `test:renderer` / `typecheck` / `lint` 通过。
```

- [ ] **Step 5: Commit**

```bash
git add docs/design/2026-08-11-custom-project-workspace-design.md
git commit -m "docs: mark custom project workspace design as implemented"
```

---

## 备注

- 测试命令均为聚焦运行；全量回归在 Task 10 统一执行。
- `project-root.ts` 使用 setter 注入（`setProjectRootStore`）而非直接 import `tool/deps`，避免 `workspace.ts → project-root → deps → creativity/evolution → workspace` 潜在循环依赖。
- 所有工具 handler 在调用时解析根目录，保存设置后立即生效、无需重启（设计文档 D2）。
- 默认（未配置）行为不变：`resolveWorkspace('project')` 仍为 `<WORKSPACE_ROOT>/projects`，`write_file`/`edit_file` 硬阻断保留，`grep`/`analyze_codebase` 仍为 `DEV_PROJECT_ROOT || WORKSPACE_ROOT`。
