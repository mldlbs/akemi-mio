/**
 * AutoPatchExecutor — 自动补丁执行器
 *
 * 针对 Plan 执行日志中检测到的已知错误模式，生成确定性代码补丁并验证：
 * 1. ENOENT/FileNotFound → 添加 mkdir -p 守护
 * 2. JSON 解析失败 → 添加 try/catch 包装
 * 3. undefined 属性访问 → 添加 null 安全守卫
 *
 * 流程：
 * 1. 解析 Problem 上下文，确定错误类型和受影响文件
 * 2. 读取源文件，生成模式匹配的代码补丁
 * 3. 创建 Git 快照保护现场
 * 4. 应用补丁
 * 5. 运行编译/测试验证
 * 6. 验证通过 → 清理快照（持久化）；验证失败 → 回滚快照
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import { VerificationRunner } from '@akemi-mio/evolution-core'
import { EvolutionGitOps } from '@akemi-mio/evolution-core'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 支持的问题来源 */
const SUPPORTED_SOURCES: ProblemSource[] = ['log']
/** 执行超时（毫秒） */
const EXEC_TIMEOUT_MS = 300_000
/** 两次执行最小间隔 */
const MIN_INTERVAL_MS = 30_000

// =============================================================================
// 修复策略定义
// =============================================================================

type FixStrategy = 'add_mkdir_guard' | 'add_json_trycatch' | 'add_null_guard' | 'unknown'

interface FixAction {
  strategy: FixStrategy
  filePath: string
  line: number
  description: string
}

// =============================================================================
// AutoPatchExecutor
// =============================================================================

export class AutoPatchExecutor implements FixExecutor {
  readonly name = 'AutoPatchExecutor'
  readonly supportedSources: ProblemSource[] = SUPPORTED_SOURCES
  readonly timeoutMs = EXEC_TIMEOUT_MS

  private lastExecuteAt = 0
  private busy = false
  private verifyRunner: VerificationRunner
  private gitOps: EvolutionGitOps

  constructor() {
    this.verifyRunner = new VerificationRunner({
      compileCheck: true,
      testRun: false,
      lintCheck: true,
      timeout: 60_000,
    })
    this.gitOps = new EvolutionGitOps()
  }

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < MIN_INTERVAL_MS) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    try {
      // 1. 解析修复动作
      const action = this.parseFixAction(problem)
      if (!action || action.strategy === 'unknown') {
        return {
          problemId: problem.id,
          success: true,
          summary: `未知错误类型 "${problem.context.metadata?.error_type}"，跳过自动补丁（由其他执行器处理）`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 2. 验证文件存在
      const absFile = this.resolveFilePath(action.filePath)
      if (!absFile || !existsSync(absFile)) {
        return {
          problemId: problem.id,
          success: false,
          summary: `目标文件不存在: ${action.filePath}`,
          durationMs: Date.now() - startedAt,
          error: 'FILE_NOT_FOUND',
        }
      }

      log('INFO', 'auto_patch_start', {
        problemId: problem.id,
        strategy: action.strategy,
        file: action.filePath,
        line: action.line,
      })

      // 3. 创建 Git 快照（沙箱保护）
      const snapshotBranch = await this.gitOps.createSnapshot(`autopatch_${problem.id}`)
      if (!snapshotBranch) {
        log('WARN', 'auto_patch_snapshot_failed', { problemId: problem.id })
        // 继续执行（快照失败不阻塞修复，但增加风险）
      }

      // 4. 应用补丁
      const patchResult = this.applyPatch(absFile, action)
      if (!patchResult.success) {
        await this.rollback(snapshotBranch, problem.id)
        return {
          problemId: problem.id,
          success: false,
          summary: patchResult.error || '补丁应用失败',
          durationMs: Date.now() - startedAt,
          error: patchResult.error,
        }
      }

      // 5. 运行回归验证
      const changedFiles = [action.filePath]
      const verifyResult = await this.verifyRunner.verify(changedFiles)

      if (verifyResult.passed) {
        // 验证通过 → 清理快照，提交修复
        if (snapshotBranch) {
          await this.gitOps.autoGitCommit(`[autopatch] ${action.description}`)
          await this.gitOps.cleanupSnapshot(snapshotBranch)
        }

        log('INFO', 'auto_patch_success', {
          problemId: problem.id,
          strategy: action.strategy,
          file: action.filePath,
          durationMs: Date.now() - startedAt,
        })

        return {
          problemId: problem.id,
          success: true,
          summary: `自动补丁成功: ${action.description} (编译验证通过)`,
          durationMs: Date.now() - startedAt,
          output: patchResult.diff,
        }
      } else {
        // 验证失败 → 回滚
        await this.rollback(snapshotBranch, problem.id)

        const errorDetails = this.formatVerifyErrors(verifyResult)
        log('WARN', 'auto_patch_verify_failed', {
          problemId: problem.id,
          errors: errorDetails,
        })

        return {
          problemId: problem.id,
          success: false,
          summary: `自动补丁验证失败，已回滚: ${errorDetails}`,
          durationMs: Date.now() - startedAt,
          error: `VERIFY_FAILED: ${errorDetails}`,
        }
      }
    } catch (err: any) {
      log('ERROR', 'auto_patch_executor_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: '自动补丁执行异常',
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.busy = false
    }
  }

  // ==================== 解析 ====================

  /**
   * 从 Problem 上下文中解析修复动作。
   */
  private parseFixAction(problem: AssignedProblem): FixAction | null {
    const metadata = problem.context.metadata
    if (!metadata) return null

    const fixType = metadata.fix_type || ''
    const filePath = metadata.error_file || problem.file || ''
    const line = parseInt(metadata.error_line || '0', 10) || 0

    const strategy = this.resolveStrategy(fixType)
    if (strategy === 'unknown') return null

    return { strategy, filePath, line, description: this.getStrategyDescription(strategy) }
  }

  /**
   * 将 fix_type 字符串转换为 FixStrategy 枚举。
   */
  private resolveStrategy(fixType: string): FixStrategy {
    const strategies: Record<string, FixStrategy> = {
      add_mkdir_guard: 'add_mkdir_guard',
      add_json_trycatch: 'add_json_trycatch',
      add_null_guard: 'add_null_guard',
    }
    return strategies[fixType] || 'unknown'
  }

  /**
   * 获取策略的中文描述。
   */
  private getStrategyDescription(strategy: FixStrategy): string {
    const descriptions: Record<FixStrategy, string> = {
      add_mkdir_guard: '添加目录存在性检查 (mkdir -p)',
      add_json_trycatch: '添加 JSON 解析 try/catch 保护',
      add_null_guard: '添加 null/undefined 守卫',
      unknown: '未知策略',
    }
    return descriptions[strategy]
  }

  // ==================== 文件操作 ====================

  /**
   * 将相对文件路径解析为绝对路径。
   */
  private resolveFilePath(filePath: string): string | null {
    if (!filePath || filePath === '未知文件') return null
    // 已经是绝对路径
    if (filePath.startsWith('/') || filePath.match(/^[A-Z]:\\/i)) return filePath
    // 相对于项目根
    const root = DEV_PROJECT_ROOT || process.cwd()
    return join(root, filePath)
  }

  // ==================== 补丁生成 ====================

  /**
   * 应用补丁到指定文件。
   */
  private applyPatch(filePath: string, action: FixAction): { success: boolean; error?: string; diff?: string } {
    const originalContent = readFileSync(filePath, 'utf-8')
    let newContent: string

    switch (action.strategy) {
      case 'add_mkdir_guard':
        newContent = this.applyMkdirGuard(originalContent, action)
        break
      case 'add_json_trycatch':
        newContent = this.applyJsonTryCatch(originalContent, action)
        break
      case 'add_null_guard':
        newContent = this.applyNullGuard(originalContent, action)
        break
      default:
        return { success: false, error: `未知修复策略: ${action.strategy}` }
    }

    if (newContent === originalContent) {
      return { success: false, error: '未找到可修复的代码模式，文件内容未变更' }
    }

    // 生成简单 diff 描述
    const diff = this.generateDiff(originalContent, newContent, action)

    // 写回文件
    try {
      writeFileSync(filePath, newContent, 'utf-8')
      return { success: true, diff }
    } catch (err: any) {
      return { success: false, error: `写入文件失败: ${err.message}` }
    }
  }

  /**
   * 修复策略：添加 mkdir -p 守卫。
   *
   * 模式匹配：
   * - writeFileSync(path, data)
   * - writeFile(path, data)
   * - createWriteStream(path)
   * - appendFileSync(path, data)
   *
   * 在前面插入:
   *   const dir = dirname(path)
   *   if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
   */
  private applyMkdirGuard(content: string, action: FixAction): string {
    const lines = content.split('\n')
    const targetLineIdx = Math.max(0, Math.min(action.line - 1, lines.length - 1))
    const targetLine = lines[targetLineIdx]

    // 检查目标行是否包含文件写入操作
    const writePattern = /(writeFileSync|writeFile|createWriteStream|appendFileSync|appendFile)\s*\(/
    if (!writePattern.test(targetLine)) {
      // 如果目标行没有写入操作，扫描附近行
      for (let i = 0; i < lines.length; i++) {
        if (writePattern.test(lines[i])) {
          return this.injectMkdirGuard(lines, i)
        }
      }
      return content // 未找到写入操作
    }

    return this.injectMkdirGuard(lines, targetLineIdx)
  }

  /**
   * 在指定行前注入 mkdir 守卫代码。
   */
  private injectMkdirGuard(lines: string[], writeLineIdx: number): string {
    const writeLine = lines[writeLineIdx]
    const indent = writeLine.match(/^\s*/)?.[0] || '  '

    // 提取文件路径参数（第一个参数）
    const pathArg = this.extractFirstArg(writeLine)
    if (!pathArg) return lines.join('\n')

    // 如果该行已经有 existsSync 守卫，跳过
    if (
      writeLine.includes('existsSync') ||
      lines.slice(Math.max(0, writeLineIdx - 3), writeLineIdx).some((l) => l.includes('existsSync'))
    ) {
      return lines.join('\n')
    }

    // 检查引用的变量名
    const dirVar = this.inferDirVar(pathArg)

    const guardLines = [
      `const ${dirVar} = dirname(${pathArg})`,
      `if (!existsSync(${dirVar})) mkdirSync(${dirVar}, { recursive: true })`,
    ].map((l) => `${indent}${l}`)

    lines.splice(writeLineIdx, 0, ...guardLines)
    return lines.join('\n')
  }

  /**
   * 从函数调用中提取第一个参数（简单模式，不处理嵌套）。
   */
  private extractFirstArg(line: string): string | null {
    const match = line.match(/\((.*?)(?:,|\))/)
    if (!match) return null
    const arg = match[1].trim()
    if (!arg || arg === '') return null
    return arg
  }

  /**
   * 根据原始路径变量名推断目录变量名。
   */
  private inferDirVar(pathArg: string): string {
    if (pathArg.includes('path') || pathArg.includes('Path')) return 'dir'
    if (pathArg.includes('file') || pathArg.includes('File')) return 'fileDir'
    if (pathArg.includes('log') || pathArg.includes('Log')) return 'logDir'
    return 'targetDir'
  }

  /**
   * 修复策略：添加 JSON.parse try/catch 保护。
   *
   * 模式匹配：
   * - const x = JSON.parse(str)
   * - return JSON.parse(str)
   * - const x = JSON.parse(str) as Type
   */
  private applyJsonTryCatch(content: string, action: FixAction): string {
    const lines = content.split('\n')
    const targetLineIdx = Math.max(0, Math.min(action.line - 1, lines.length - 1))

    // 扫描所有 JSON.parse 调用（不在 try 块内的）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('JSON.parse')) continue

      // 检查是否已在 try 块内
      if (this.isInsideTryBlock(lines, i)) continue

      // 检查是否已经有 try/catch
      if (i > 0 && lines[i - 1].trim().startsWith('try')) continue

      return this.injectJsonTryCatch(lines, i)
    }

    return content
  }

  /**
   * 在 JSON.parse 行周围注入 try/catch。
   */
  private injectJsonTryCatch(lines: string[], parseLineIdx: number): string {
    const parseLine = lines[parseLineIdx]
    const indent = parseLine.match(/^\s*/)?.[0] || '  '
    const innerIndent = indent + '  '

    // 提取变量声明或表达式
    const isAssignment = /(const|let|var)\s+\w+\s*=/.test(parseLine)
    const isReturn = /^\s*return\s+/.test(parseLine)

    // 构造解析语句：去掉 const/let/var 和 as 类型转换
    const safeParseLine = parseLine
      .trim()
      .replace(/^(const|let|var)\s+/, '')
      .replace(/\s+as\s+\w+(\[\])?\s*$/, '')

    // 构造 fallback 值
    const fallback = isAssignment ? 'null' : isReturn ? 'null' : 'undefined'

    const tryBlock: string[] = []
    tryBlock.push(`${indent}try {`)
    tryBlock.push(`${innerIndent}${safeParseLine}`)
    tryBlock.push(`${indent}} catch {`)
    tryBlock.push(`${innerIndent}// JSON.parse 失败，使用降级值`)
    if (isAssignment) {
      const varName = parseLine.match(/(const|let|var)\s+(\w+)/)
      if (varName) {
        tryBlock.push(`${innerIndent}${varName[2]} = ${fallback}`)
      }
    }
    if (isReturn) {
      tryBlock.push(`${innerIndent}return ${fallback}`)
    }
    tryBlock.push(`${indent}}`)

    lines.splice(parseLineIdx, 1, ...tryBlock)
    return lines.join('\n')
  }

  /**
   * 检查指定行是否位于 try 块内部（简单缩进检查）。
   */
  private isInsideTryBlock(lines: string[], index: number): boolean {
    const lineIndent = lines[index].match(/^\s*/)?.[0].length || 0
    for (let i = index - 1; i >= Math.max(0, index - 20); i--) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith('try') || trimmed.startsWith('try ')) {
        return true // try 块的内部缩进应该比 try 大
      }
      const currentIndent = lines[i].match(/^\s*/)?.[0].length || 0
      if (currentIndent < lineIndent && (trimmed.startsWith('try') || trimmed.startsWith('}') || trimmed.startsWith('catch'))) {
        return false // 出了 try 块
      }
    }
    return false
  }

  /**
   * 修复策略：添加 null/undefined 守卫。
   *
   * 模式匹配（在错误行附近）：
   * - obj.prop → obj?.prop
   * - obj.method() → obj?.method()
   * - arr[idx] → arr?.[idx]
   */
  private applyNullGuard(content: string, action: FixAction): string {
    const lines = content.split('\n')
    const targetLineIdx = Math.max(0, Math.min(action.line - 1, lines.length - 1))
    const targetLine = lines[targetLineIdx]

    // 找到属性访问或方法调用模式
    const accessPattern = /(\w+(?:\.\w+)*)\.(\w+)/g
    let match: RegExpExecArray | null
    let modified = false

    // 只在目标行附近查找（避免过度修改）
    const scanStart = Math.max(0, targetLineIdx - 2)
    const scanEnd = Math.min(lines.length, targetLineIdx + 3)

    for (let i = scanStart; i < scanEnd; i++) {
      const line = lines[i]
      if (!line.includes('.')) continue

      // 跳过已经使用可选链的行、typeof 检查、if 条件中的 exists 检查
      if (line.includes('?.') || line.includes('typeof') || line.includes('existsSync')) continue

      // 查找 obj.method() 或 obj.prop 模式但不包括函数定义和 import
      if (/^\s*(import|export|function|class|interface|type)\s/.test(line.trim())) continue
      if (/^\s*\/\//.test(line.trim())) continue // 注释行

      // 简单的链式访问替换：在第一个 . 前加 ?
      const chainMatch = line.match(/(\w+)(\.\w+[([]?)/)
      if (chainMatch) {
        // 不修改已经有空值检查的变量
        const varName = chainMatch[1]
        const isGuarded = lines
          .slice(Math.max(0, i - 3), i)
          .some((l) => l.includes(`${varName} != null`) || l.includes(`${varName} !== null`) || l.includes(`${varName} !== undefined`))
        if (isGuarded) continue

        // 将 . 替换为 ?.
        lines[i] = line.replace(new RegExp(`(\\b${varName})\\.(\\w+)`), `$1?.$2`)
        modified = true
        break // 每次只改一个访问点避免过度修改
      }
    }

    return modified ? lines.join('\n') : content
  }

  // ==================== 工具 ====================

  /**
   * 生成简单 diff 描述。
   */
  private generateDiff(original: string, patched: string, action: FixAction): string {
    const origLines = original.split('\n')
    const patchedLines = patched.split('\n')
    const added = patchedLines.length - origLines.length
    const changed: string[] = []
    for (let i = 0; i < Math.min(origLines.length, patchedLines.length); i++) {
      if (origLines[i] !== patchedLines[i]) {
        changed.push(`  L${i + 1}: ${origLines[i].trim()} → ${patchedLines[i].trim()}`)
        if (changed.length >= 5) break
      }
    }
    return [
      `策略: ${action.description}`,
      `文件: ${action.filePath}`,
      `变更: 新增 ${added > 0 ? '+' : ''}${added} 行`,
      ...(changed.length > 0 ? ['修改行:', ...changed] : []),
    ].join('\n')
  }

  /**
   * 格式化验证错误信息。
   */
  private formatVerifyErrors(verifyResult: any): string {
    const errors: string[] = []
    if (verifyResult.checks?.compile && !verifyResult.checks.compile.passed) {
      errors.push(`编译错误: ${(verifyResult.checks.compile.errors || []).slice(0, 2).join('; ')}`)
    }
    if (verifyResult.checks?.lint && !verifyResult.checks.lint.passed) {
      errors.push(`Lint 错误: ${(verifyResult.checks.lint.errors || []).slice(0, 2).join('; ')}`)
    }
    return errors.join(' | ') || '未知验证失败'
  }

  /**
   * 回滚到快照。
   */
  private async rollback(snapshotBranch: string | null, problemId: string): Promise<void> {
    if (!snapshotBranch) {
      log('WARN', 'auto_patch_no_snapshot_to_rollback', { problemId })
      return
    }
    try {
      const success = await this.gitOps.rollbackToSnapshot(snapshotBranch)
      if (success) {
        await this.gitOps.cleanupSnapshot(snapshotBranch)
        log('INFO', 'auto_patch_rolled_back', { problemId })
      } else {
        log('ERROR', 'auto_patch_rollback_failed', { problemId })
      }
    } catch (err: any) {
      log('ERROR', 'auto_patch_rollback_error', { problemId, error: String(err) })
    }
  }
}
