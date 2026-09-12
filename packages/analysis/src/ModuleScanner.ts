import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

/**
 * ModuleScanner — 静态分析 packages 源码目录，提取真实子系统特征
 * 输出可直接用于 CreativitySource 的描述块
 */
export class ModuleScanner {
  /** 扫描各包的 src 目录，返回结构化信息。 */
  scan(): any {
    const root = join(process.cwd(), 'packages')
    const categories: { [key: string]: string[] } = {}
    let fileCount = 0
    const toolPatterns: string[] = []
    const recentChangeSummaries: string[] = []

    // 1. 简单遍历所有条目
    function scanSource(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith('.') || entry.name === '__tests__') return []
        const path = join(directory, entry.name)
        return entry.isDirectory() ? scanSource(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
      })
    }
    for (const pkg of readdirSync(root, { withFileTypes: true })) {
      const source = join(root, pkg.name, 'src')
      if (!pkg.isDirectory() || !existsSync(source)) continue
      try {
        const files = scanSource(source)
        categories[pkg.name] = files.map((file) => relative(source, file))
        fileCount += files.length
        for (const entry of files) {
          // 2. 检测常见工具定义文件（tool 和 export 关键字）
          const content = readFileSync(entry, 'utf-8')
          if (/[\\/]tool[\\/]/i.test(entry) || content.includes('export const') || content.includes('export function')) {
            toolPatterns.push(
              `[${entry}] ${content
                .slice(0, 80)
                .replace(/\r\n/g, ' ')
                .replace(/[\r\n]+/, ' ')
                .substring(0, 80)}`,
            )
          }
        }
      } catch (e) {
        // ignore inaccessible items
      }
    }

    // 3. 最近 git 改动（不抛异常即可）
    try {
      const changedFiles = execSync('git diff --name-only HEAD -- packages', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
      recentChangeSummaries.push(`git changed: ${changedFiles || 'none'}`)
    } catch {
      recentChangeSummaries.push('git unavailable')
    }

    // 4. 构造可直接用于 source 的描述
    const description = [
      `packages 目录共 ${fileCount} 项源码文件`,
      `子目录分布: ${Object.entries(categories).join('; ')}`,
      `检测到 ${toolPatterns.length} 条潜在工具定义`,
      ...recentChangeSummaries,
    ].join('\n')

    return {
      moduleName: 'packages',
      fileCount,
      toolExpressions: toolPatterns,
      recentChanges: recentChangeSummaries.join(' | '),
      description,
    }
  }
}
