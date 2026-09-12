import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { WORKSPACE } from '@akemi-mio/core/config'

/**
 * 确保被外部模块引用的 evolution_workspace 子目录存在。
 * 当 EVOLUTION_SERVICE_DISABLED 时，evolution 懒初始化被跳过，
 * 但这些目录仍被其他模块引用（SessionRecoveryManager、ConstitutionEngine 等）。
 */
export function ensureEssentialDirs(): void {
  const subDirs = [
    'recovery',
    'constitution',
    'social',
    'pipeline_data',
    'observer',
    'creativity',
    'inspiration',
    'sandbox',
    'generated_tools',
    'behavior_optimizations',
  ]
  for (const name of subDirs) {
    const dir = join(WORKSPACE.evolution, name)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
  log('INFO', 'evolution_essential_dirs_ensured', { count: subDirs.length })
}

/**
 * 获取系统状态快照（用于错误日志增强）。
 * 基础版本 — 用于 EvolutionHistoryManager 等独立模块的日志场景。
 */
export function getSystemStateSnapshot(): Record<string, any> {
  return { timestamp: Date.now() }
}

/**
 * 收集变更文件列表（按 git 状态区分新增和修改）。
 * 从 SelfEvolutionService 提取为独立工具函数。
 */
export function collectChangedFiles(projectRoot: string): { newFiles: string[]; modifiedFiles: string[] } {
  try {
    const { execSync } = require('child_process')
    const output = execSync('git status --porcelain 2>&1', {
      cwd: projectRoot,
      timeout: 5000,
      encoding: 'utf-8',
      windowsHide: true,
    }) as string
    const lines = (output || '').split('\n').filter(Boolean)
    const newFiles: string[] = []
    const modifiedFiles: string[] = []
    for (const line of lines) {
      const status = line.slice(0, 2).trim()
      const file = line.slice(3).trim()
      if (!file) continue
      if (status === '??' || status === 'A') newFiles.push(file)
      else modifiedFiles.push(file)
    }
    return { newFiles, modifiedFiles }
  } catch (err) {
    log('WARN', 'git_status_failed', { error: String(err) })
    return { newFiles: [], modifiedFiles: [] }
  }
}
