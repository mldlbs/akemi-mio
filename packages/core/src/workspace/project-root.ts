import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import * as fs from 'fs'
import * as path from 'path'
import { WORKSPACE_ROOT, RUNTIME_ROOT } from '@akemi-mio/core/config'

/** 存储键名 */
export const PROJECT_WORKSPACE_ROOTS_KEY = 'project_workspace_roots'
export const PROJECT_WORKSPACE_ACTIVE_KEY = 'project_workspace_active'
/** 旧版单目录键（兼容迁移） */
const LEGACY_PROJECT_WORKSPACE_ROOT_KEY = 'project_workspace_root'

/** 读取已授权的项目工作区目录列表（可能为空） */
export function getAuthorizedProjectRoots(): string[] {
  try {
    const raw = credentialsManager.get(PROJECT_WORKSPACE_ROOTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => typeof p === 'string' && p.length > 0)
      }
    }
    // 迁移旧版单目录配置
    const legacy = credentialsManager.get(LEGACY_PROJECT_WORKSPACE_ROOT_KEY)
    if (legacy) {
      const roots = [legacy]
      credentialsManager.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify(roots))
      try {
        credentialsManager.delete(LEGACY_PROJECT_WORKSPACE_ROOT_KEY)
      } catch {
        // 删除旧键失败不阻塞
      }
      return roots
    }
  } catch {
    // 存储异常时按未授权处理
  }
  return []
}

/** 读取当前生效（active）的项目工作区目录；未设置时取列表第一项 */
export function getActiveProjectRoot(): string | null {
  const roots = getAuthorizedProjectRoots()
  if (roots.length === 0) return null
  try {
    const active = credentialsManager.get(PROJECT_WORKSPACE_ACTIVE_KEY)
    if (active && roots.includes(active)) return active
  } catch {
    // 忽略
  }
  return roots[0]
}

/** 读取生效的项目工作区根目录（active || 默认 projects 目录） */
export function getEffectiveProjectRoot(): string {
  const active = getActiveProjectRoot()
  if (active) {
    try {
      const stat = fs.statSync(active)
      if (stat.isDirectory()) return active
    } catch {
      // 目录不存在或不可读，自动回退默认
    }
  }
  return path.join(WORKSPACE_ROOT, 'projects')
}

/** 是否已配置自定义项目工作区（存在任意授权目录） */
export function isCustomProjectRootConfigured(): boolean {
  return getAuthorizedProjectRoots().length > 0
}

/** 校验用户提供的候选路径 */
export function validateProjectRoot(candidate: string): { ok: boolean; normalized?: string; error?: string } {
  const trimmed = (candidate ?? '').trim()
  if (!trimmed) return { ok: true, normalized: undefined }

  let resolved: string
  try {
    resolved = path.resolve(trimmed)
  } catch {
    return { ok: false, error: '无法解析路径' }
  }

  try {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) return { ok: false, error: '不是目录' }
  } catch {
    return { ok: false, error: '目录不存在' }
  }

  // 拒绝保护路径
  const lower = resolved.toLowerCase()
  const denyList = [
    WORKSPACE_ROOT.toLowerCase(),
    RUNTIME_ROOT.toLowerCase(),
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\',
  ]
  for (const deny of denyList) {
    if (lower === deny || lower.startsWith(deny + '\\')) {
      return { ok: false, error: `路径与系统保护位置重叠: ${deny}` }
    }
  }

  return { ok: true, normalized: resolved }
}

/** 新增授权目录 */
export function addAuthorizedProjectRoot(candidate: string): { ok: boolean; error?: string } {
  const v = validateProjectRoot(candidate)
  if (!v.ok) return { ok: false, error: v.error || '无效的项目工作区路径' }
  if (v.normalized === undefined) return { ok: false, error: '目录路径不能为空' }

  const roots = getAuthorizedProjectRoots()
  if (!roots.includes(v.normalized)) {
    roots.push(v.normalized)
    credentialsManager.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify(roots))
    log('INFO', 'project_root_added', { root: v.normalized })
  }
  return { ok: true }
}

/** 撤销授权目录 */
export function removeAuthorizedProjectRoot(target: string): void {
  const roots = getAuthorizedProjectRoots().filter((r) => r !== target)
  if (roots.length === 0) {
    try {
      credentialsManager.delete(PROJECT_WORKSPACE_ROOTS_KEY)
    } catch {
      // 忽略
    }
  } else {
    credentialsManager.set(PROJECT_WORKSPACE_ROOTS_KEY, JSON.stringify(roots))
  }
  // 撤销的是当前目录时清除 active
  try {
    if (credentialsManager.get(PROJECT_WORKSPACE_ACTIVE_KEY) === target) {
      credentialsManager.delete(PROJECT_WORKSPACE_ACTIVE_KEY)
    }
  } catch {
    // 忽略
  }
  log('INFO', 'project_root_removed', { root: target })
}

/** 设为当前项目工作区 */
export function setActiveProjectRoot(target: string): { ok: boolean; error?: string } {
  const roots = getAuthorizedProjectRoots()
  if (!roots.includes(target)) return { ok: false, error: '该目录未授权' }
  credentialsManager.set(PROJECT_WORKSPACE_ACTIVE_KEY, target)
  log('INFO', 'project_root_active_set', { root: target })
  return { ok: true }
}

/** 在授权目录内做安全检查（支持多个授权根目录） */
export function safeProjectPath(target: string): string {
  const roots = getAuthorizedProjectRoots()
  const base = getEffectiveProjectRoot()
  const fullPath = path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target)
  const candidates = roots.length > 0 ? roots : [base]
  for (const root of candidates) {
    if (fullPath === root || fullPath.startsWith(root + path.sep)) return fullPath
  }
  throw new Error('路径越界: 目标路径不在已授权的项目工作区内')
}
