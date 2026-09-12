/**
 * TypeScriptCompilerService — 本地 TypeScript 编译器封装
 *
 * 使用子进程运行 tsc --noEmit 对用户提交的代码进行即时类型检查。
 * 遵循 TscCollector 的 execSync 模式（已验证可靠）。
 *
 * 职责：
 * 1. 接收用户完成的 TypeScript 代码 + 验证代码
 * 2. 写入临时文件
 * 3. 运行 tsc --noEmit --strict 检查类型错误
 * 4. 解析错误并返回结构化结果
 * 5. 清理临时文件
 *
 * 集成方式：
 * - 由 TypeChallengeService 调用，用于验证用户提交的挑战答案
 * - 也可单独由 MCP 工具调用
 */

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { log } from '@akemi-mio/core/logger/Logger'

// ── 编译结果类型 ──

export interface CompileResult {
  /** 是否编译通过（无类型错误） */
  success: boolean
  /** 解析后的编译器诊断列表 */
  diagnostics: CompileDiagnostic[]
  /** 原始 tsc 标准输出 */
  rawOutput: string
  /** 编译总耗时 ms */
  durationMs: number
}

export interface CompileDiagnostic {
  /** 错误代码（如 TS2345） */
  code: string
  /** 错误信息 */
  message: string
  /** 所在行号（1-indexed） */
  line: number
  /** 所在列号 */
  column: number
  /** 严重程度 */
  severity: 'error' | 'warning'
  /** 文件路径 */
  file: string
}

// ── 编译选项 ──

export interface CompileOptions {
  /** 额外 tsconfig 选项 */
  strict?: boolean
  noUnusedLocals?: boolean
  noUnusedParameters?: boolean
  target?: string
  module?: string
  /** 超时 ms（默认 30s） */
  timeout?: number
  /** 是否保留临时文件用于调试 */
  keepTempFile?: boolean
}

const DEFAULT_OPTIONS: Required<CompileOptions> = {
  strict: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  target: 'esnext',
  module: 'esnext',
  timeout: 30_000,
  keepTempFile: false,
}

// ── TypeScriptCompilerService ──

export class TypeScriptCompilerService {
  private tempDir: string

  constructor() {
    this.tempDir = join(tmpdir(), 'akemi-mio-tsc')
    try {
      mkdirSync(this.tempDir, { recursive: true })
    } catch {
      // 目录已存在或不可创建，使用系统 tmpdir
      this.tempDir = tmpdir()
    }
  }

  /**
   * 编译并检查用户提交的 TypeScript 代码。
   *
   * @param code - 用户完成的 TypeScript 源代码
   * @param options - 编译选项
   * @returns 编译结果，包含诊断信息
   */
  compile(code: string, options?: CompileOptions): CompileResult {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const startTime = Date.now()
    const tempFile = join(this.tempDir, `challenge_${randomBytes(4).toString('hex')}.ts`)

    try {
      // 写入临时文件
      writeFileSync(tempFile, code, 'utf-8')

      // 构建 tsc 命令
      const tscArgs = [
        '--noEmit',
        opts.strict ? '--strict' : '',
        `--target ${opts.target}`,
        `--module ${opts.module}`,
        opts.noUnusedLocals ? '--noUnusedLocals' : '',
        opts.noUnusedParameters ? '--noUnusedParameters' : '',
        '--skipLibCheck',
        // 将临时文件中的行号映射回显示给用户的代码
        tempFile,
      ]
        .filter(Boolean)
        .join(' ')

      // 使用项目根目录的 tsc（保证与项目使用的 TypeScript 版本一致）
      const projectRoot = this.findProjectRoot()
      // 遵循 TscCollector 的可靠模式：2>&1 合并输出，|| true 阻止 execSync 因 exit code 2 抛异常
      const tscCmd = `npx --prefix "${projectRoot}" tsc ${tscArgs} 2>&1 || true`

      const stdout = execSync(tscCmd, {
        cwd: projectRoot,
        timeout: opts.timeout,
        windowsHide: true,
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024,
      })

      const durationMs = Date.now() - startTime
      const output = (stdout || '').toString()

      // 无输出 = 编译通过
      if (!output || output.trim().length === 0) {
        return {
          success: true,
          diagnostics: [],
          rawOutput: '',
          durationMs,
        }
      }

      const diagnostics = this.parseDiagnostics(output)
      return {
        success: diagnostics.length === 0,
        diagnostics,
        rawOutput: output,
        durationMs,
      }
    } catch (err: any) {
      // execSync 可能因为 tsc 命令不存在而抛出（exit code 非 0）
      // 使用 || true 后，正常类型错误不会进入此分支
      const durationMs = Date.now() - startTime
      log('ERROR', 'tsc_compiler_exec_failed', {
        error: String(err).slice(0, 200),
        durationMs,
      })
      return {
        success: false,
        diagnostics: [
          {
            code: 'TSC_EXEC',
            message: `TypeScript 编译器调用失败，请确认已安装 TypeScript: ${String(err).slice(0, 150)}`,
            line: 0,
            column: 0,
            severity: 'error',
            file: tempFile,
          },
        ],
        rawOutput: String(err),
        durationMs,
      }
    } finally {
      // 清理临时文件
      if (!opts.keepTempFile) {
        try {
          unlinkSync(tempFile)
        } catch {
          // 清理失败可忽略
        }
      }
    }
  }

  /**
   * 编译用户代码 + 验证代码（将两者合并后编译）。
   * 验证代码通常包含类型测试，例如：
   * ```ts
   * type Test1 = MyPick<{a:1,b:2}, 'a'> extends {a:1} ? true : false
   * const assert1: Test1 = true
   * ```
   *
   * @param userCode - 用户填写的代码
   * @param verifierCode - 验证代码（附加在 userCode 之后）
   * @param options - 编译选项
   */
  compileWithVerifier(userCode: string, verifierCode: string, options?: CompileOptions): CompileResult {
    const combined = `${userCode}\n\n// ── Type verification ──\n${verifierCode}`
    return this.compile(combined, options)
  }

  /**
   * 将 tsc 输出解析为结构化诊断数组。
   * tsc 错误格式：file.ts(line,column): error TS2345: message
   */
  private parseDiagnostics(output: string, expectedFile?: string): CompileDiagnostic[] {
    const diagnostics: CompileDiagnostic[] = []
    const seen = new Set<string>()

    // tsc 标准错误格式
    const lineRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
    let match: RegExpExecArray | null

    while ((match = lineRegex.exec(output)) !== null) {
      const [, file, lineStr, colStr, severity, code, message] = match
      const line = parseInt(lineStr, 10)
      const column = parseInt(colStr, 10)
      const dedupKey = `${file}:${line}:${code}`

      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      diagnostics.push({
        code,
        message: message.trim(),
        line,
        column,
        severity: severity as 'error' | 'warning',
        file,
      })
    }

    // 如果没有匹配到标准格式，尝试宽松匹配
    if (diagnostics.length === 0) {
      const fallbackRegex = /error\s+(TS\d+):\s+(.+)$/gm
      while ((match = fallbackRegex.exec(output)) !== null) {
        const [, code, message] = match
        const dedupKey = `${code}:${message.slice(0, 40)}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        diagnostics.push({
          code,
          message: message.trim(),
          line: 0,
          column: 0,
          severity: 'error',
          file: expectedFile || '',
        })
      }
    }

    return diagnostics
  }

  /**
   * 将诊断列表格式化为用户可读的文本。
   */
  formatDiagnostics(diagnostics: CompileDiagnostic[]): string {
    if (diagnostics.length === 0) return ''

    return diagnostics
      .map((d) => {
        const location = d.line > 0 ? `第 ${d.line} 行` : ''
        return `  ${d.code}: ${d.message}${location ? ` (${location})` : ''}`
      })
      .join('\n')
  }

  /**
   * 自动检测项目根目录（包含 package.json 的目录）。
   * 回退到 process.cwd()。
   */
  private findProjectRoot(): string {
    let dir = process.cwd()
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return process.cwd()
  }
}

/** 全局单例 */
export const typeScriptCompilerService = new TypeScriptCompilerService()
