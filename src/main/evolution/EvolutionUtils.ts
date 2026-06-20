import { log } from '../logger/Logger'

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
