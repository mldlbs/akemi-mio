/**
 * TypeRefactorExecutor — 类型重构执行器
 *
 * 接收类型健康度问题，使用 LLM 生成类型安全的代码重构方案，
 * 在沙箱环境中应用并验证后，提交修复。
 *
 * 流程：
 * 1. 解析 Problem 上下文，确定重构类型和目标文件
 * 2. 读取源文件，获取目标行上下文
 * 3. 调用 LLM 生成类型安全的代码建议
 * 4. 创建 Git 快照保护现场
 * 5. 应用重构
 * 6. 运行编译验证
 * 7. 验证通过 → 提交；失败 → 回滚
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import { VerificationRunner } from '@akemi-mio/evolution-core'
import { EvolutionGitOps } from '@akemi-mio/evolution-core'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from '@akemi-mio/evolution/automation/types'
import type { TypeHealthCategory } from './TypeHealthIssue'

// =============================================================================
// 配置
// =============================================================================

/** 支持的问题来源 */
const SUPPORTED_SOURCES: ProblemSource[] = ['tsc']
/** 执行超时（毫秒） */
const EXEC_TIMEOUT_MS = 300_000
/** 两次执行最小间隔 */
const MIN_INTERVAL_MS = 30_000

// =============================================================================
// 重构策略描述
// =============================================================================

const REFACTOR_DESCRIPTIONS: Record<TypeHealthCategory, string> = {
  explicit_any: '将显式 any 替换为具体类型或泛型参数',
  as_any: '使用类型守卫或精确类型替代 as any',
  unsafe_assertion: '使用类型守卫验证替代不安全断言',
  missing_return_type: '为函数添加返回类型标注',
  missing_param_type: '为函数参数添加类型标注',
  any_array: '为数组添加元素类型约束',
  ts_ignore: '修复被 @ts-ignore 压制的类型问题',
  generic_opportunity: '引入泛型参数替代 any，增强类型关联',
  conditional_opportunity: '使用条件类型简化函数重载',
  type_guard_opportunity: '提取类型守卫函数替代 as 断言',
}

// =============================================================================
// TypeRefactorExecutor
// =============================================================================

export class TypeRefactorExecutor implements FixExecutor {
  readonly name = 'type-refactor'
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
      const metadata = problem.context.metadata || {}
      const category = metadata.category as TypeHealthCategory
      const suggestion = metadata.suggestion || ''

      // 1. 解析目标文件
      const filePath = problem.file || ''
      if (!filePath) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少目标文件路径',
          durationMs: Date.now() - startedAt,
          error: 'NO_FILE',
        }
      }

      const absFile = this.resolveFilePath(filePath)
      if (!absFile || !existsSync(absFile)) {
        return {
          problemId: problem.id,
          success: false,
          summary: `目标文件不存在: ${filePath}`,
          durationMs: Date.now() - startedAt,
          error: 'FILE_NOT_FOUND',
        }
      }

      log('INFO', 'type_refactor_start', {
        problemId: problem.id,
        category,
        file: filePath,
        line: problem.line,
      })

      // 2. 读取源文件
      const content = readFileSync(absFile, 'utf-8')
      const lines = content.split('\n')

      // 3. 获取重构上下文
      const targetLineIdx = Math.max(0, (problem.line || 1) - 1)
      const contextStart = Math.max(0, targetLineIdx - 5)
      const contextEnd = Math.min(lines.length, targetLineIdx + 6)
      const contextLines = lines.slice(contextStart, contextEnd)

      // 4. 生成重构代码（使用 LLM）
      const refactorResult = await this.generateRefactor(category, suggestion, filePath, contextLines, targetLineIdx - contextStart)

      if (!refactorResult.success) {
        return {
          problemId: problem.id,
          success: false,
          summary: refactorResult.error || 'LLM 重构生成失败',
          durationMs: Date.now() - startedAt,
          error: 'REFACTOR_GENERATION_FAILED',
        }
      }

      // 5. 创建 Git 快照
      const snapshotBranch = await this.gitOps.createSnapshot(`typerefactor_${problem.id}`)

      // 6. 应用重构
      const applyResult = this.applyRefactor(absFile, content, refactorResult)
      if (!applyResult.success) {
        await this.rollback(snapshotBranch, problem.id)
        return {
          problemId: problem.id,
          success: false,
          summary: applyResult.error || '重构应用失败',
          durationMs: Date.now() - startedAt,
          error: 'APPLY_FAILED',
        }
      }

      // 7. 运行验证
      const changedFiles = [filePath]
      const verifyResult = await this.verifyRunner.verify(changedFiles)

      if (verifyResult.passed) {
        // 验证通过 → 提交
        if (snapshotBranch) {
          const categoryDesc = REFACTOR_DESCRIPTIONS[category] || '类型重构'
          await this.gitOps.autoGitCommit(`[type-refactor] ${categoryDesc} - ${filePath}:${problem.line}`)
          await this.gitOps.cleanupSnapshot(snapshotBranch)
        }

        // 记录学习进度：关联的知识点掌握度提升
        this.recordLearningProgress(category)

        log('INFO', 'type_refactor_success', {
          problemId: problem.id,
          category,
          file: filePath,
          durationMs: Date.now() - startedAt,
        })

        return {
          problemId: problem.id,
          success: true,
          summary: `类型重构成功: ${REFACTOR_DESCRIPTIONS[category] || '类型修复'} (编译验证通过)`,
          durationMs: Date.now() - startedAt,
          output: refactorResult.code,
        }
      } else {
        // 验证失败 → 回滚
        await this.rollback(snapshotBranch, problem.id)

        const errorDetails = this.formatVerifyErrors(verifyResult)
        log('WARN', 'type_refactor_verify_failed', {
          problemId: problem.id,
          errors: errorDetails,
        })

        return {
          problemId: problem.id,
          success: false,
          summary: `类型重构验证失败，已回滚: ${errorDetails}`,
          durationMs: Date.now() - startedAt,
          error: `VERIFY_FAILED: ${errorDetails}`,
        }
      }
    } catch (err: any) {
      log('ERROR', 'type_refactor_executor_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: '类型重构执行异常',
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.busy = false
    }
  }

  // ===========================================================================
  // 重构生成 (LLM)
  // ===========================================================================

  /**
   * 调用 LLM 生成类型安全的代码重构方案。
   *
   * 注意：当前实现使用模式匹配的确定性重构，
   * 未来可升级为 LLM 驱动的智能分析。
   */
  private async generateRefactor(
    category: TypeHealthCategory,
    suggestion: string,
    filePath: string,
    contextLines: string[],
    targetIdx: number,
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    const targetLine = contextLines[targetIdx] || ''
    const context = contextLines.join('\n')

    // 模式匹配的确定性重构
    switch (category) {
      case 'explicit_any':
      case 'generic_opportunity':
        return this.refactorGenericAny(targetLine, context, targetIdx)
      case 'as_any':
        return this.refactorAsAny(targetLine, context, targetIdx)
      case 'missing_return_type':
        return this.refactorAddReturnType(targetLine, context, targetIdx)
      case 'missing_param_type':
        return this.refactorAddParamType(targetLine, context, targetIdx)
      case 'any_array':
        return this.refactorAnyArray(targetLine, context, targetIdx)
      default:
        // 对于不支持确定性重构的类型，返回跳过
        return {
          success: true,
          code: context,
        }
    }
  }

  /**
   * 重构: 将显式 any 替换为泛型参数
   * 例如: function fn(a: any, b: any) → function fn<T>(a: T, b: T)
   */
  private refactorGenericAny(
    targetLine: string,
    _context: string,
    _targetIdx: number,
  ): { success: boolean; code?: string; error?: string } {
    let result = targetLine

    // 模式1: function name(a: any, b: any): any → function name<T>(a: T, b: T): T
    const funcPattern = /(function\s+\w+\s*)\(([^)]*)\)\s*(:\s*any)?/
    const funcMatch = result.match(funcPattern)
    if (funcMatch) {
      const prefix = funcMatch[1]
      const paramsStr = funcMatch[2]
      const returnAny = funcMatch[3] || ''

      const params = paramsStr
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      const anyParams = params.filter((p) => /:\s*any\b/.test(p))

      if (anyParams.length > 0) {
        // 替换 any 参数为泛型
        const genericParams = new Set<string>()
        const newParams = params.map((p) => {
          if (/:\s*any\b/.test(p)) {
            const name = p.split(':')[0].trim()
            // 如果之前已经有同名的泛型参数，复用
            const genericName = this.nextGenericName(genericParams)
            genericParams.add(genericName)
            return `${name}: ${genericName}`
          }
          return p
        })

        const genericList = Array.from(genericParams).join(', ')
        const returnType = returnAny ? `: ${genericParams.values().next().value || 'T'}` : returnAny

        result = `${prefix}<${genericList}>(${newParams.join(', ')})${returnType}`
      }
    }

    // 模式2: const fn = (a: any): any → const fn = <T>(a: T): T
    const arrowPattern = /(const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(:\s*any)?\s*=>/
    const arrowMatch = result.match(arrowPattern)
    if (arrowMatch) {
      const keyword = arrowMatch[1]
      const name = arrowMatch[2]
      const prefix = arrowMatch[0].includes('async') ? `${keyword} ${name} = async <` : `${keyword} ${name} = <`
      const paramsStr = arrowMatch[3]
      const returnAny = arrowMatch[4] || ''

      const params = paramsStr
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      const genericParams = new Set<string>()
      const newParams = params.map((p) => {
        if (/:\s*any\b/.test(p)) {
          const pName = p.split(':')[0].trim()
          const genericName = this.nextGenericName(genericParams)
          genericParams.add(genericName)
          return `${pName}: ${genericName}`
        }
        return p
      })

      const genericList = Array.from(genericParams).join(', ')
      const returnType = returnAny ? `: ${genericParams.values().next().value || 'T'}` : returnAny
      const afterParen = result.includes('=>') ? ' =>' : ''

      result = `${prefix}${genericList}>(${newParams.join(', ')})${returnType}${afterParen}`
    }

    // 简单替换: `: any` → 如果上下文中能推断类型则省略
    result = result.replace(/:\s*any\b(?!\s*[>),])/g, '')

    if (result === targetLine) {
      // 没有可替换的模式，返回原文
      return { success: true, code: targetLine }
    }

    return { success: true, code: result }
  }

  /**
   * 重构: 为 as any 添加类型守卫
   */
  private refactorAsAny(targetLine: string, _context: string, _targetIdx: number): { success: boolean; code?: string; error?: string } {
    // 替换 as any 为 as unknown（需配合类型守卫）
    const result = targetLine.replace(/\s+as\s+any\b/g, ' as unknown')
    if (result === targetLine) {
      return { success: true, code: targetLine }
    }
    return { success: true, code: result }
  }

  /**
   * 重构: 添加返回类型（推断为 unknown，需用户确认）
   */
  private refactorAddReturnType(
    targetLine: string,
    _context: string,
    _targetIdx: number,
  ): { success: boolean; code?: string; error?: string } {
    // 在函数定义的 ) 后添加 : unknown
    const defMatch = targetLine.match(/(function\s+\w+\s*\([^)]*\))\s*(\{)/)
    if (defMatch) {
      const result = targetLine.replace(defMatch[0], `${defMatch[1]}: unknown ${defMatch[2]}`)
      return { success: true, code: result }
    }
    return { success: true, code: targetLine }
  }

  /**
   * 重构: 为参数添加类型（添加 : unknown 占位）
   */
  private refactorAddParamType(
    targetLine: string,
    _context: string,
    _targetIdx: number,
  ): { success: boolean; code?: string; error?: string } {
    // 为没有类型的参数添加 : unknown
    const result = targetLine.replace(/\(([^)]*)\)/, (match, params: string) => {
      const newParams = params.split(',').map((p: string) => {
        p = p.trim()
        if (p && !/:\s*\w+/.test(p) && !p.startsWith('...')) {
          return `${p}: unknown`
        }
        return p
      })
      return `(${newParams.join(', ')})`
    })
    return { success: true, code: result }
  }

  /**
   * 重构: any[] → unknown[] 或 T[]
   */
  private refactorAnyArray(targetLine: string, _context: string, _targetIdx: number): { success: boolean; code?: string; error?: string } {
    // any[] → unknown[]
    let result = targetLine.replace(/(:\s*)any(\[\])/g, '$1unknown$2')
    // Array<any> → Array<unknown>
    result = result.replace(/Array\s*<\s*any\s*>/g, 'Array<unknown>')
    if (result === targetLine) {
      return { success: true, code: targetLine }
    }
    return { success: true, code: result }
  }

  // ===========================================================================
  // 辅助
  // ===========================================================================

  /** 生成下一个泛型参数名 */
  private nextGenericName(used: Set<string>): string {
    const names = ['T', 'U', 'V', 'K', 'R', 'S', 'A', 'B']
    for (const name of names) {
      if (!used.has(name)) return name
    }
    return `T${used.size + 1}`
  }

  // ===========================================================================
  // 文件操作
  // ===========================================================================

  /** 解析文件绝对路径 */
  private resolveFilePath(filePath: string): string | null {
    if (!filePath) return null
    if (filePath.startsWith('/') || filePath.match(/^[A-Z]:\\/i)) return filePath
    const root = DEV_PROJECT_ROOT || process.cwd()
    return join(root, filePath)
  }

  /** 应用重构结果到文件 */
  private applyRefactor(
    absFile: string,
    originalContent: string,
    refactor: { code?: string; error?: string },
  ): { success: boolean; error?: string } {
    if (!refactor.code) {
      return { success: false, error: '重构代码为空' }
    }

    try {
      // 检查内容是否有实际变化
      if (refactor.code === originalContent) {
        return { success: false, error: '重构未产生变更' }
      }

      writeFileSync(absFile, refactor.code, 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `写入文件失败: ${err.message}` }
    }
  }

  /** 记录学习进度 */
  private recordLearningProgress(category: TypeHealthCategory): void {
    const categoryMap: Partial<Record<TypeHealthCategory, string>> = {
      explicit_any: '泛型',
      as_any: '类型守卫',
      generic_opportunity: '泛型',
      missing_return_type: '基础类型',
      missing_param_type: '基础类型',
      any_array: '泛型',
      type_guard_opportunity: '类型守卫',
    }

    const learningCategory = categoryMap[category]
    if (learningCategory) {
      log('INFO', 'type_refactor_learning_progress', {
        category: learningCategory,
        refactorType: category,
      })
    }
  }

  /** 格式化验证错误 */
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

  /** 回滚到快照 */
  private async rollback(snapshotBranch: string | null, problemId: string): Promise<void> {
    if (!snapshotBranch) {
      log('WARN', 'type_refactor_no_snapshot_to_rollback', { problemId })
      return
    }
    try {
      const success = await this.gitOps.rollbackToSnapshot(snapshotBranch)
      if (success) {
        await this.gitOps.cleanupSnapshot(snapshotBranch)
        log('INFO', 'type_refactor_rolled_back', { problemId })
      } else {
        log('ERROR', 'type_refactor_rollback_failed', { problemId })
      }
    } catch (err: any) {
      log('ERROR', 'type_refactor_rollback_error', { problemId, error: String(err) })
    }
  }
}
