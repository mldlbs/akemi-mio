/**
 * FileScanner — 工作区文件扫描与特征提取
 *
 * 扫描项目工作区（projects/）下的所有文件，
 * 提取类型、扩展名、大小、修改时间等特征，
 * 供 FileOrganizerCollector 消费。
 */

import { readdirSync, statSync } from 'fs'
import { join, relative, basename, extname, dirname } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type { FileFeatures } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 扫描根目录：项目工作区 */
const SCAN_ROOT = WORKSPACE.projects

/** 排除的目录名称 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.claude',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.vscode',
  '.idea',
])

/** 排除的文件扩展名 */
const EXCLUDED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat',
  '.pyc', '.pyo',
  '.map',
])

/** 最大扫描深度 */
const MAX_SCAN_DEPTH = 8

/** 单次最大扫描文件数（防止大项目 OOM） */
const MAX_SCAN_FILES = 5000

// =============================================================================
// 测试文件/配置文件检测
// =============================================================================

const TEST_PATTERNS = [
  /\.(test|spec|e2e|integration)\./,
  /\/__tests__\//,
  /\/__test__\//,
  /\/test\//,
  /\/spec\//,
]

const CONFIG_FILE_NAMES = new Set([
  '.env', '.env.local', '.env.production',
  'tsconfig.json', 'package.json', '.eslintrc.js', '.eslintrc.json', '.eslintrc',
  'prettier.config.js', '.prettierrc',
  'babel.config.js', '.babelrc',
  'jest.config.js', 'jest.config.ts',
  'vite.config.ts', 'vite.config.js',
  'next.config.js', 'next.config.ts',
  'webpack.config.js',
  'tailwind.config.js', 'tailwind.config.ts',
  'postcss.config.js',
  '.gitignore', '.gitattributes',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
  'Makefile', 'Makefile.*',
  '.editorconfig',
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
])

// =============================================================================
// FileScanner
// =============================================================================

export class FileScanner {
  private lastScanResult: FileFeatures[] = []
  private lastScanTime = 0

  /** 执行一次完整的工作区扫描 */
  scan(): FileFeatures[] {
    const results: FileFeatures[] = []
    this.scanDir(SCAN_ROOT, 0, results)

    this.lastScanResult = results
    this.lastScanTime = Date.now()

    log('INFO', 'file_scanner_done', {
      root: SCAN_ROOT,
      filesFound: results.length,
    })

    return results
  }

  /** 获取上一次的扫描结果 */
  getLastResult(): FileFeatures[] {
    return [...this.lastScanResult]
  }

  /** 上次扫描时间戳 */
  get lastScanTimestamp(): number {
    return this.lastScanTime
  }

  /**
   * 递归扫描目录
   */
  private scanDir(dirPath: string, depth: number, results: FileFeatures[]): void {
    if (depth > MAX_SCAN_DEPTH) return
    if (results.length >= MAX_SCAN_FILES) return

    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return // 跳过无权限目录
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue // 跳过隐藏文件
      const fullPath = join(dirPath, entry)
      if (results.length >= MAX_SCAN_FILES) break

      try {
        const stat = statSync(fullPath)

        if (stat.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry)) continue
          this.scanDir(fullPath, depth + 1, results)
        } else if (stat.isFile()) {
          const features = this.extractFeatures(fullPath, stat)
          if (features) results.push(features)
        }
      } catch {
        // 跳过 stat 失败的文件
      }
    }
  }

  /**
   * 从文件路径和 stat 信息提取特征
   */
  private extractFeatures(fullPath: string, stat: import('fs').Stats): FileFeatures | null {
    const relPath = relative(SCAN_ROOT, fullPath).replace(/\\/g, '/')
    const fileName = basename(relPath)
    const ext = extname(fileName).toLowerCase()
    const dir = dirname(relPath)

    // 排除不需要的文件类型
    if (EXCLUDED_EXTENSIONS.has(ext)) return null

    return {
      path: relPath,
      name: fileName,
      stem: fileName.slice(0, fileName.length - (ext.length || 0)),
      extension: ext,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      depth: dir === '.' ? 0 : dir.split('/').length,
      directory: dir === '.' ? '' : dir,
      isTest: TEST_PATTERNS.some((p) => p.test(relPath)),
      isConfig: CONFIG_FILE_NAMES.has(fileName) || ext === '.env',
    }
  }
}

/** 全局单例 */
export const fileScanner = new FileScanner()
