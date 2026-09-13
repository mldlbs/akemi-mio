import { existsSync } from 'fs'
import { join, dirname } from 'path'

export const CONSTITUTION_FILENAME = 'CONSTITUTION.md'

/**
 * 定位 CONSTITUTION.md。
 *
 * 历史 bug：这里曾经直接 `join(RUNTIME_ROOT, 'CONSTITUTION.md')`，而 RUNTIME_ROOT
 * 取自 `app.getAppPath()` —— 直跑 out/main/index.js 时是 `out/main`，打包后是
 * `resources/app.asar`，两个位置当年都没有这份文件，于是 identity 永远静默回退到
 * 硬编码的 DEFAULT_CONSTITUTION_MD，仓库里真实的人格文件从未被读取。
 *
 * 现在按优先级依次尝试，第一个命中即用：
 *   1. RUNTIME_ROOT（打包后 = app.asar 根目录，electron-builder 的 files 已包含；
 *      直跑 out/main/index.js 时会在第 3 项命中仓库根）
 *   2. RUNTIME_ROOT 的上一级（打包后 = resources/）
 *   3. RUNTIME_ROOT 的上两级（打包后 = 安装目录；直跑 = 仓库根目录）
 *   4. process.cwd()（从仓库根目录直跑时的兜底）
 *
 * 全部未命中时返回首选路径，调用方仍会拿到一个可诊断的 ENOENT。
 */
export function constitutionCandidates(runtimeRoot: string, cwd: string = process.cwd()): string[] {
  const parent = dirname(runtimeRoot)
  const grandparent = dirname(parent)
  const raw = [
    join(runtimeRoot, CONSTITUTION_FILENAME),
    join(parent, CONSTITUTION_FILENAME),
    join(grandparent, CONSTITUTION_FILENAME),
    join(cwd, CONSTITUTION_FILENAME),
  ]
  return raw.filter((p, i) => raw.indexOf(p) === i)
}

export function resolveConstitutionPath(runtimeRoot: string, cwd: string = process.cwd()): string {
  const candidates = constitutionCandidates(runtimeRoot, cwd)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}
