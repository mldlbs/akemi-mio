/**
 * TypeHealthScanner — 类型健康度扫描器
 *
 * 使用正则表达式扫描 TypeScript 项目，检测类型相关问题：
 * - 显式 any 类型
 * - as any 断言
 * - 缺少参数/返回类型
 * - 泛型可替代的 any
 * - unsafe 断言
 *
 * 不依赖第三方 AST 解析器，通过多模式正则匹配 + 上下文分析实现。
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { relative, join } from 'path'
import { log } from '../../logger/Logger'
import type {
  TypeHealthIssue,
  TypeHealthCategory,
  TypeHealthSeverity,
  TypeHealthScanConfig,
  TypeHealthSummary,
} from './TypeHealthIssue'
import { DEFAULT_SCAN_CONFIG, getTargetCategories } from './TypeHealthIssue'
import type { LearningCategory } from '../../learning/types'

// ══════════════════════════════════════════
//  扫描结果标识生成
// ══════════════════════════════════════════

let scanCounter = 0

function nextIssueId(): string {
  scanCounter++
  return `th-${Date.now()}-${scanCounter}`
}

// ══════════════════════════════════════════
//  TypeHealthScanner
// ══════════════════════════════════════════

export class TypeHealthScanner {
  private config: TypeHealthScanConfig
  private issues: TypeHealthIssue[] = []

  constructor(config?: Partial<TypeHealthScanConfig>) {
    this.config = { ...DEFAULT_SCAN_CONFIG, ...config }
  }

  /** 更新配置 */
  setConfig(config: Partial<TypeHealthScanConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** 获取当前配置 */
  getConfig(): TypeHealthScanConfig {
    return { ...this.config }
  }

  /** 获取最近一次扫描结果 */
  getIssues(): TypeHealthIssue[] {
    return [...this.issues]
  }

  /** 按分类获取问题 */
  getIssuesByCategory(category: TypeHealthCategory): TypeHealthIssue[] {
    return this.issues.filter((i) => i.category === category)
  }

  // ══════════════════════════════════════════
  //  扫描入口
  // ══════════════════════════════════════════

  /**
   * 执行一次完整扫描。
   * 返回检测到的所有类型健康问题，同时保存在内部。
   */
  scan(config?: Partial<TypeHealthScanConfig>): TypeHealthIssue[] {
    if (config) this.setConfig(config)
    const startedAt = Date.now()

    const files = this.resolveFiles()
    log('INFO', 'type_health_scan_start', {
      filesCount: files.length,
      projectRoot: this.config.projectRoot,
    })

    const newIssues: TypeHealthIssue[] = []

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8')
        const fileIssues = this.scanFile(file, content)
        newIssues.push(...fileIssues)
      } catch (err: any) {
        log('WARN', 'type_health_scan_file_error', {
          file,
          error: err.message,
        })
      }
    }

    // 按分类过滤（如果指定了目标分类）
    const filtered = this.config.targetCategories.length > 0
      ? newIssues.filter((i) => {
          const targetCategories = this.getMappedCategories(this.config.targetCategories)
          return targetCategories.includes(i.category)
        })
      : newIssues

    // 按严重程度过滤
    const severityOrder: TypeHealthSeverity[] = ['error', 'warning', 'info', 'suggestion']
    const minIdx = severityOrder.indexOf(this.config.minSeverity)
    const finalIssues = filtered.filter((i) => {
      const idx = severityOrder.indexOf(i.severity)
      return idx >= minIdx
    })

    this.issues = finalIssues

    const duration = Date.now() - startedAt
    log('INFO', 'type_health_scan_done', {
      total: newIssues.length,
      filtered: finalIssues.length,
      files,
      durationMs: duration,
    })

    return finalIssues
  }

  /** 获取扫描摘要 */
  getSummary(): TypeHealthSummary {
    const byCategory = {} as Record<TypeHealthCategory, number>
    const bySeverity = {} as Record<TypeHealthSeverity, number>
    const fileCount = new Map<string, number>()

    for (const issue of this.issues) {
      byCategory[issue.category] = (byCategory[issue.category] || 0) + 1
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1
      fileCount.set(issue.file, (fileCount.get(issue.file) || 0) + 1)
    }

    const byFile = Array.from(fileCount.entries())
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)

    return {
      totalIssues: this.issues.length,
      byCategory,
      bySeverity,
      byFile,
      scanDurationMs: 0,
      scannedFiles: 0,
      scannedAt: Date.now(),
    }
  }

  // ══════════════════════════════════════════
  //  文件解析
  // ══════════════════════════════════════════

  private resolveFiles(): string[] {
    const root = this.config.projectRoot
    if (!root || !existsSync(root)) return []

    // 将 include 模式转换为正则表达式
    const includeRes = this.config.includePatterns.map((p) => this.patternToRegex(p))
    const excludeRes = this.config.excludePatterns.map((p) => this.patternToRegex(p))

    const files: string[] = []
    this.walkDir(root, root, includeRes, excludeRes, files)
    return [...new Set(files)]
  }

  /**
   * 递归遍历目录，收集匹配的文件。
   */
  private walkDir(
    root: string,
    currentDir: string,
    includeRes: RegExp[],
    excludeRes: RegExp[],
    result: string[],
  ): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      const relPath = relative(root, fullPath).replace(/\\/g, '/')

      // 检查排除模式
      if (excludeRes.some((re) => re.test(relPath))) continue

      if (entry.isDirectory()) {
        this.walkDir(root, fullPath, includeRes, excludeRes, result)
      } else if (entry.isFile()) {
        // 检查包含模式
        if (includeRes.some((re) => re.test(relPath))) {
          result.push(fullPath)
        }
      }
    }
  }

  /**
   * 将简单的 glob pattern 转换为正则表达式。
   * 支持 *（单段通配）、**（递归通配）、?.tsx 等后缀匹配。
   */
  private patternToRegex(pattern: string): RegExp {
    let regexStr = pattern
      // 转义正则特殊字符（除 * 和 ?）
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // ** 通配：匹配任意层路径
      .replace(/\*\*/g, '<<DOUBLESTAR>>')
      // * 通配：匹配单段内任意字符
      .replace(/\*/g, '[^/]*')
      // 恢复 ** 为 .+
      .replace(/<<DOUBLESTAR>>/g, '.*')
      // ? 通配：匹配单个字符
      .replace(/\?/g, '.')
    return new RegExp(`^${regexStr}$`)
  }

  // ══════════════════════════════════════════
  //  文件级扫描
  // ══════════════════════════════════════════

  private scanFile(filePath: string, content: string): TypeHealthIssue[] {
    const lines = content.split('\n')
    const issues: TypeHealthIssue[] = []
    const relPath = this.toRelativePath(filePath)

    // 跳过生成的文件和声明文件
    if (relPath.endsWith('.d.ts') || relPath.includes('__generated__')) return []

    // 运行各检测器
    issues.push(...this.detectExplicitAny(lines, relPath))
    issues.push(...this.detectAsAny(lines, relPath))
    issues.push(...this.detectMissingParamTypes(lines, relPath))
    issues.push(...this.detectMissingReturnTypes(lines, relPath))
    issues.push(...this.detectAnyArray(lines, relPath))
    issues.push(...this.detectTsIgnore(lines, relPath))
    issues.push(...this.detectGenericOpportunity(lines, relPath))
    issues.push(...this.detectTypeGuardOpportunity(lines, relPath))

    return issues
  }

  // ══════════════════════════════════════════
  //  检测器
  // ══════════════════════════════════════════

  /**
   * 检测 1: 显式 any 类型标注
   * 匹配模式: `: any` 在变量/参数/返回类型位置
   */
  private detectExplicitAny(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []
    // 排除注释、字符串、已经是泛型位置的 any（如 <T = any>）
    const pattern = /(?<!\/\/.*)(?<!`[^`]*)(?<!['"][^'"]*)(:\s*any)(?!\s*[>,])/g

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 跳过注释、import 语句、declare 语句
      if (this.isSkippableLine(line)) continue

      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        const col = match.index + 1
        const snippet = this.extractSnippet(lines, i)

        // 判断是否为泛型机会（函数参数或返回值中的 any）
        const isFunctionParam = /^\s*(private|public|protected|static|async)?\s*\w+\s*\(/.test(line) ||
          /=>\s*\{/.test(line) || line.includes('(') && line.includes(')')

        issues.push({
          id: nextIssueId(),
          category: 'explicit_any',
          learningCategory: '泛型',
          severity: isFunctionParam ? 'warning' : 'info',
          file,
          line: i + 1,
          column: col,
          title: '显式 any 类型',
          description: `第 ${i + 1} 行使用了显式 any 类型，缺少类型约束`,
          snippet,
          suggestion: isFunctionParam
            ? '考虑使用泛型参数替代 any：function fn<T>(arg: T): T'
            : '考虑使用更具体的类型替代 any',
          estimatedChars: 20,
          detectedAt: Date.now(),
        })
      }
    }
    return issues
  }

  /**
   * 检测 2: as any 断言
   */
  private detectAsAny(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []
    const pattern = /(?<!\/\/.*)(\s+as\s+any)\b/g

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        const col = match.index + 1
        const snippet = this.extractSnippet(lines, i)

        issues.push({
          id: nextIssueId(),
          category: 'as_any',
          learningCategory: '类型守卫',
          severity: 'warning',
          file,
          line: i + 1,
          column: col,
          title: 'as any 类型断言',
          description: `第 ${i + 1} 行使用 as any 跳过了类型检查`,
          snippet,
          suggestion: '使用类型守卫（type guard）或更精确的类型断言替代 as any',
          estimatedChars: 30,
          detectedAt: Date.now(),
        })
      }
    }
    return issues
  }

  /**
   * 检测 3: 函数参数缺少类型标注
   */
  private detectMissingParamTypes(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []
    // 匹配函数参数中未标注类型的参数: `(a, b:` 或 `(a, b)` 但参数无类型
    const funcPattern = /(?:function\s+\w+\s*|=>\s*|\([\s\S]*?\)\s*:\s*\w+)/

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      // 查找函数定义行（包含 function 关键字或箭头函数）
      const isFunctionDef = /(?:function\s+\w+\s*\(|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(|^\s*\w+\s*=\s*\(|^\s*\((?:\w+\s*,?\s*)*\)\s*:\s*)/m.test(line)

      if (!isFunctionDef) continue

      // 提取参数部分
      const paramMatch = line.match(/\(([^)]*)\)/)
      if (!paramMatch) continue

      const params = paramMatch[1].split(',').map((p) => p.trim()).filter(Boolean)
      for (const param of params) {
        // 参数没有类型标注（没有 :Type）
        if (!/:\s*\w+/.test(param) && !param.startsWith('...')) {
          const col = line.indexOf(param) + 1
          const snippet = this.extractSnippet(lines, i)

          issues.push({
            id: nextIssueId(),
            category: 'missing_param_type',
            learningCategory: '基础类型',
            severity: 'info',
            file,
            line: i + 1,
            column: col,
            title: '函数参数缺少类型标注',
            description: `参数 "${param}" 缺少类型标注`,
            snippet,
            suggestion: `为参数 "${param}" 添加类型标注`,
            estimatedChars: 15,
            detectedAt: Date.now(),
          })
        }
      }
    }
    return issues
  }

  /**
   * 检测 4: 函数缺少返回类型
   */
  private detectMissingReturnTypes(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      // function name(...) {  → 缺返回类型
      const defMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/)
      if (defMatch && !line.includes('):') && !line.includes(') :')) {
        const snippet = this.extractSnippet(lines, i)
        issues.push({
          id: nextIssueId(),
          category: 'missing_return_type',
          learningCategory: '基础类型',
          severity: 'info',
          file,
          line: i + 1,
          column: line.indexOf(defMatch[1]) + 1,
          title: '函数缺少返回类型',
          description: `函数 "${defMatch[1]}" 缺少返回类型标注`,
          snippet,
          suggestion: `为函数 "${defMatch[1]}" 添加返回类型`,
          estimatedChars: 15,
          detectedAt: Date.now(),
        })
      }

      // 箭头函数: const fn = (...) => {  → 缺返回类型
      const arrowMatch = line.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/)
      if (arrowMatch && !line.includes('):') && !/: \w+/.test(line)) {
        const snippet = this.extractSnippet(lines, i)
        issues.push({
          id: nextIssueId(),
          category: 'missing_return_type',
          learningCategory: '基础类型',
          severity: 'info',
          file,
          line: i + 1,
          column: line.indexOf(arrowMatch[1]) + 1,
          title: '箭头函数缺少返回类型',
          description: `箭头函数 "${arrowMatch[1]}" 缺少返回类型标注`,
          snippet,
          suggestion: `为箭头函数 "${arrowMatch[1]}" 添加返回类型`,
          estimatedChars: 15,
          detectedAt: Date.now(),
        })
      }
    }
    return issues
  }

  /**
   * 检测 5: any[] / Array<any>
   */
  private detectAnyArray(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []
    const patterns = [
      { re: /(?<!\/\/.*)(:\s*any\[\])/g, label: 'any[]' },
      { re: /(?<!\/\/.*)(Array\s*<\s*any\s*>)/g, label: 'Array<any>' },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      for (const { re, label } of patterns) {
        let match: RegExpExecArray | null
        while ((match = re.exec(line)) !== null) {
          const col = match.index + 1
          const snippet = this.extractSnippet(lines, i)

          issues.push({
            id: nextIssueId(),
            category: 'any_array',
            learningCategory: '泛型',
            severity: 'warning',
            file,
            line: i + 1,
            column: col,
            title: `${label} 数组类型`,
            description: `第 ${i + 1} 行使用 ${label}，缺少元素类型约束`,
            snippet,
            suggestion: `使用泛型数组类型如 Array<T> 或 T[] 替代 ${label}`,
            estimatedChars: 15,
            detectedAt: Date.now(),
          })
        }
      }
    }
    return issues
  }

  /**
   * 检测 6: @ts-ignore 注释
   */
  private detectTsIgnore(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/\/\/\s*@ts-(ignore|expect-error)/.test(line)) {
        const snippet = this.extractSnippet(lines, i)
        issues.push({
          id: nextIssueId(),
          category: 'ts_ignore',
          learningCategory: null,
          severity: 'warning',
          file,
          line: i + 1,
          column: line.indexOf('@ts-') + 1,
          title: '@ts-ignore 压制类型错误',
          description: `第 ${i + 1} 行使用 @ts-ignore 压制了类型错误`,
          snippet,
          suggestion: '修复底层类型问题，而非压制错误',
          estimatedChars: 40,
          detectedAt: Date.now(),
        })
      }
    }
    return issues
  }

  /**
   * 检测 7: 泛型可替代 any 的机会
   * 检测函数签名中用 any 的参数，如果参数间存在关联则推荐泛型
   */
  private detectGenericOpportunity(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      // 检测模式: function name(a: any, b: any) 或 (a: any, b: any) =>
      // 同一函数有多个 any 参数，或 any 参数与 any 返回值
      const anyParamMatch = line.match(/\(([^)]*)\)/)
      if (!anyParamMatch) continue

      const params = anyParamMatch[1].split(',').map((p) => p.trim()).filter(Boolean)
      const anyParams = params.filter((p) => /:\s*any\b/.test(p))

      // 如果有多个 any 参数 或 any 参数 + any 返回，推荐泛型
      const hasAnyReturn = /\)\s*:\s*any\b/.test(line)
      if (anyParams.length >= 2 || (anyParams.length >= 1 && hasAnyReturn)) {
        const snippet = this.extractSnippet(lines, i)
        const paramNames = anyParams.map((p) => p.split(':')[0].trim()).join(', ')

        issues.push({
          id: nextIssueId(),
          category: 'generic_opportunity',
          learningCategory: '泛型',
          severity: 'suggestion',
          file,
          line: i + 1,
          column: line.indexOf('(') + 1,
          title: '泛型替代 any 的机会',
          description: `参数 (${paramNames}) 使用 any，参数间存在类型关联，可引入泛型`,
          snippet,
          suggestion: `提取公共类型参数：function fn<T>(a: T, b: T): T`,
          estimatedChars: 30,
          detectedAt: Date.now(),
        })
      }

      // 检测简单泛型机会：单个 any 参数但在多个位置使用
      if (anyParams.length === 1 && !hasAnyReturn) {
        const paramName = anyParams[0].split(':')[0].trim()
        // 检查函数体是否消费了该参数的类型信息
        if (this.hasTypeUsageInScope(lines, i, paramName)) {
          const snippet = this.extractSnippet(lines, i)
          issues.push({
            id: nextIssueId(),
            category: 'generic_opportunity',
            learningCategory: '泛型',
            severity: 'suggestion',
            file,
            line: i + 1,
            column: line.indexOf(paramName) + 1,
            title: '泛型替代 any 的机会',
            description: `参数 "${paramName}" 使用 any，其属性在函数体中被访问，可引入泛型约束`,
            snippet,
            suggestion: `引入泛型并约束：function fn<T extends { ... }>(arg: T)`,
            estimatedChars: 30,
            detectedAt: Date.now(),
          })
        }
      }
    }
    return issues
  }

  /**
   * 检测 8: 类型守卫可替代 as 的机会
   */
  private detectTypeGuardOpportunity(lines: string[], file: string): TypeHealthIssue[] {
    const issues: TypeHealthIssue[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (this.isSkippableLine(line)) continue

      // 检测 as Type 断言（排除 as any）
      const asMatch = line.match(/\bas\s+(\w+)\b(?!\s*any\b)/)
      if (asMatch && !line.includes('import') && !line.includes('from')) {
        const snippet = this.extractSnippet(lines, i)
        const typeName = asMatch[1]

        issues.push({
          id: nextIssueId(),
          category: 'type_guard_opportunity',
          learningCategory: '类型守卫',
          severity: 'info',
          file,
          line: i + 1,
          column: line.indexOf(asMatch[0]) + 1,
          title: '类型断言可替换为类型守卫',
          description: `第 ${i + 1} 行使用 as ${typeName} 断言，可在入口处用类型守卫验证`,
          snippet,
          suggestion: `添加类型守卫函数：function is${typeName}(val: unknown): val is ${typeName} { ... }`,
          estimatedChars: 50,
          detectedAt: Date.now(),
        })
      }
    }
    return issues
  }

  // ══════════════════════════════════════════
  //  辅助方法
  // ══════════════════════════════════════════

  /** 判断行是否可跳过（注释、字符串、import、声明） */
  private isSkippableLine(line: string): boolean {
    const trimmed = line.trim()
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export type') ||
      trimmed.startsWith('export interface') ||
      trimmed.startsWith('interface ') ||
      trimmed.startsWith('type ') ||
      trimmed.startsWith('declare ') ||
      trimmed === '' ||
      trimmed.startsWith('}') ||
      trimmed.startsWith('`')
    )
  }

  /** 提取上下文片段 */
  private extractSnippet(lines: string[], lineIdx: number, contextLines = 2): string {
    const start = Math.max(0, lineIdx - contextLines)
    const end = Math.min(lines.length, lineIdx + contextLines + 1)
    return lines.slice(start, end).join('\n')
  }

  /** 转换为相对路径 */
  private toRelativePath(absPath: string): string {
    const root = this.config.projectRoot
    if (!root) return absPath
    return relative(root, absPath).replace(/\\/g, '/')
  }

  /** 获取学习分类对应的检测分类 */
  private getMappedCategories(categories: LearningCategory[]): TypeHealthCategory[] {
    return getTargetCategories(categories)
  }

  /** 检查函数范围内是否使用了参数的属性 */
  private hasTypeUsageInScope(lines: string[], funcLineIdx: number, paramName: string): boolean {
    // 简单的范围检查：查找函数体中的 paramName.xxx 模式
    const searchEnd = Math.min(lines.length, funcLineIdx + 30)
    for (let i = funcLineIdx + 1; i < searchEnd; i++) {
      const line = lines[i]
      if (line.includes('}') && i > funcLineIdx + 1) break // 超出函数体
      if (new RegExp(`\\b${paramName}\\.`).test(line)) return true
    }
    return false
  }
}

/** 全局单例 */
export const typeHealthScanner = new TypeHealthScanner()
