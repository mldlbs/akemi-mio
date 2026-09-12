import { resolve, join, relative, sep } from 'path'
import { existsSync } from 'fs'
import { DEV_PROJECT_ROOT, WORKSPACE_ROOT, WORKSPACE } from '@akemi-mio/core/config'
import { getEffectiveProjectRoot, getAuthorizedProjectRoots } from '@akemi-mio/core/workspace/project-root'

/** Mio 工作区根 — 所有操作限定在此 */
export const PROJECT_ROOT = DEV_PROJECT_ROOT || WORKSPACE_ROOT
export const WORKSPACE_DIR = join(WORKSPACE_ROOT, 'projects', '__sandbox__')
export const EVOLUTION_WORKSPACE_DIR = WORKSPACE.evolution

const WS_LABELS: Record<string, string> = {
  mcp: '__sandbox__',
  evolution: 'evolution_workspace',
  project: 'projects',
}

export function wsLabel(ws?: string): string {
  return WS_LABELS[ws || 'evolution'] || 'evolution_workspace'
}

/** 路径安全检查 */
export function safePath(requested: string): string {
  const resolved = resolve(PROJECT_ROOT, requested)
  if (!resolved.startsWith(PROJECT_ROOT)) {
    if (DEV_PROJECT_ROOT && resolved.startsWith(DEV_PROJECT_ROOT)) return resolved
    throw new Error(`路径 ${requested} 超出项目根目录`)
  }
  return resolved
}

/** 解析工作区目录 */
export function resolveWorkspace(ws?: string): string {
  if (ws === 'project' || !ws) return getEffectiveProjectRoot()
  if (ws === 'evolution') return EVOLUTION_WORKSPACE_DIR
  return WORKSPACE_DIR
}

/** 智能推断目标工作区 */
export function inferWorkspace(path: string, explicitWs?: string): string {
  if (explicitWs) return explicitWs
  const normalized = path.replace(/\\/g, '/')
  if (/^(sandbox|analysis|creativity|custom|tmp|living_plan)\//.test(normalized)) return 'evolution'
  if (/^projects\//.test(normalized)) return 'project'
  return 'evolution'
}

/** 剥离工作区目录名前缀，避免路径双重拼接 */
export function stripWorkspaceLabelPrefix(path: string, ws?: string): string {
  const label = wsLabel(ws)
  const normalized = path.replace(/\\/g, '/')
  if (label && normalized === label) return '.'
  if (label && normalized.startsWith(label + '/')) return normalized.slice(label.length + 1)
  return path
}

/** 安全的工作区路径解析 */
export function safeWorkspacePath(requested: string, ws?: string): string {
  const wsDir = resolveWorkspace(ws)
  const cleanRequested = stripWorkspaceLabelPrefix(requested, ws)
  const resolved = resolve(wsDir, cleanRequested)
  if (ws === 'project' || !ws) {
    // 项目工作区：允许任意已授权目录（未授权时仅默认 projects 目录）
    const roots = getAuthorizedProjectRoots()
    const allowed = roots.length > 0 ? roots : [wsDir]
    for (const root of allowed) {
      if (resolved === root || resolved.startsWith(root + sep)) return resolved
    }
    throw new Error(`路径 ${requested} 超出工作区目录`)
  }
  if (!resolved.startsWith(wsDir)) throw new Error(`路径 ${requested} 超出工作区目录`)
  return resolved
}
