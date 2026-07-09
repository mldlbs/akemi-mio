/**
 * PlanLogCollector — Plan 执行日志分析采集器
 *
 * 作为 SignalCollector 接入自动化管道：
 * 1. 读取应用日志目录中最近 48 小时的日志文件
 * 2. 正则匹配 Plan 执行阶段的已知错误模式（ENOENT、JSON parse、undefined 等）
 * 3. 从堆栈/错误消息中提取出错文件路径和行号
 * 4. 生成 Problem 条目供 AutoPatchExecutor 处理
 *
 * 运行条件：
 * - 最近 48 小时内的 app 日志中有 Plan 执行错误
 * - 同一错误模式在 24h 窗口内重复出现 >= 2 次
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type { SignalCollector, Problem, ProblemSource } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 日志回顾窗口（毫秒）— 最多看 48 小时内日志 */
const LOOKBACK_WINDOW_MS = 48 * 60 * 60 * 1000
/** 采集最小间隔（匹配进化周期 2h） */
const COLLECT_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 同一错误模式触发问题的最小出现次数 */
const MIN_OCCURRENCE_THRESHOLD = 2
/** 单次采集最大生成的问题数 */
const MAX_PROBLEMS_PER_COLLECT = 5
/** 单文件最大读取行数（尾部） */
const MAX_TAIL_LINES = 5000

// =============================================================================
// 已知错误模式 — key 是问题类型标识，pattern 用于正则匹配
// =============================================================================

interface ErrorPattern {
  type: string
  label: string
  severity: 'error' | 'warning'
  /** 匹配错误行内容 */
  regex: RegExp
  /** 从错误行或后续行提取文件路径 */
  extractFile?: (lines: string[], matchIndex: number) => { file: string; line: number } | null
  /** 修复建议模板（填入 {file} {line}） */
  suggestionTemplate: string
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    type: 'ENOENT',
    label: '文件/目录不存在',
    severity: 'error',
    regex: /ENOENT|Error:\s*ENOENT|no such file or directory|FileNotFound/i,
    suggestionTemplate: '在文件操作前添加 `if (!existsSync(dir)) mkdirSync(dir, { recursive: true })` 确保目录存在',
  },
  {
    type: 'EACCES',
    label: '权限不足',
    severity: 'error',
    regex: /EACCES|Error:\s*EACCES|permission denied/i,
    suggestionTemplate: '添加权限检查和 try/catch 包装，确保程序有权访问目标路径',
  },
  {
    type: 'JSON_PARSE',
    label: 'JSON 解析失败',
    severity: 'error',
    regex: /JSON\.parse|Unexpected token.*in JSON|JSON\.stringify.*failed|SyntaxError.*JSON/i,
    suggestionTemplate: '在 JSON.parse 调用外添加 try/catch 包装，提供降级默认值',
  },
  {
    type: 'UNDEFINED_PROPERTY',
    label: '访问 undefined 属性',
    severity: 'error',
    regex: /Cannot read propert|Cannot destructure|undefined.*is not|TypeError.*undefined/i,
    suggestionTemplate: '添加可选链操作符 `?.` 或空值合并运算符 `??` 保护 null/undefined 安全',
  },
  {
    type: 'NOT_A_FUNCTION',
    label: '非函数调用',
    severity: 'error',
    regex: /is not a function|not a function/i,
    suggestionTemplate: '添加 typeof 类型守卫，调用前检查目标是否为函数类型',
  },
  {
    type: 'EPERM',
    label: '操作不允许',
    severity: 'warning',
    regex: /EPERM|Error:\s*EPERM|operation not permitted/i,
    suggestionTemplate: '添加错误处理和重试逻辑，Windows 下注意文件锁竞争',
  },
  {
    type: 'WRITE_AFTER_END',
    label: '写入已关闭流',
    severity: 'warning',
    regex: /write after end|write.*after.*end|Cannot write after/i,
    suggestionTemplate: '确保 WriteStream 在写入前未被销毁，添加状态检查或队列机制',
  },
]

// =============================================================================
// PlanLogCollector
// =============================================================================

export class PlanLogCollector implements SignalCollector {
  readonly name = 'PlanLogCollector'
  readonly source: ProblemSource = 'log'
  private lastRunAt = 0
  /** 已发现的错误指纹（用于跨采集去重） */
  private seenFingerprints = new Set<string>()

  shouldRun(): boolean {
    // 匹配进化周期，每 2 小时采集一次
    if (Date.now() - this.lastRunAt < COLLECT_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRunAt = Date.now()
    log('INFO', 'plan_log_collector_start')

    const problems: Problem[] = []
    const logDir = WORKSPACE.logs

    try {
      if (!existsSync(logDir)) {
        log('INFO', 'plan_log_collector_no_log_dir', { dir: logDir })
        return problems
      }

      // 1. 列出日志目录中最近 LOOKBACK_WINDOW_MS 内的 .log 文件
      const now = Date.now()
      const cutoff = now - LOOKBACK_WINDOW_MS
      const logFiles = this.getRecentLogFiles(logDir, cutoff)

      if (logFiles.length === 0) {
        log('INFO', 'plan_log_collector_no_files')
        return problems
      }

      log('INFO', 'plan_log_collector_files', { fileCount: logFiles.length })

      // 2. 逐文件读取尾部，匹配错误模式
      const rawErrors: Array<{
        pattern: ErrorPattern
        file: string
        line: number
        message: string
        timestamp: number
      }> = []

      for (const logFile of logFiles) {
        const lines = this.tailLines(logFile, MAX_TAIL_LINES)
        if (lines.length === 0) continue

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]

          // 先过滤：只处理包含关键字的行（Plan 执行 / evolution 相关 / 错误标记）
          if (!this.isRelevantLine(line)) continue

          for (const pattern of ERROR_PATTERNS) {
            if (!pattern.regex.test(line)) continue

            // 提取文件路径和行号
            let fileInfo = pattern.extractFile
              ? pattern.extractFile(lines, i)
              : this.extractFileFromLine(line)

            // 如果没从堆栈提取到，尝试从错误行的关键字推断
            if (!fileInfo) {
              fileInfo = this.extractFileFromLine(line)
            }

            const timestamp = this.extractTimestamp(line, logFile)

            rawErrors.push({
              pattern,
              file: fileInfo?.file || '未知文件',
              line: fileInfo?.line || 0,
              message: line.slice(0, 300).trim(),
              timestamp,
            })
          }
        }
      }

      // 3. 按 (类型 + 文件) 聚类计数
      const clusterMap = new Map<string, typeof rawErrors>()
      for (const err of rawErrors) {
        const key = `${err.pattern.type}:${err.file}`
        if (!clusterMap.has(key)) clusterMap.set(key, [])
        clusterMap.get(key)!.push(err)
      }

      // 4. 聚类达到阈值的生成 Problem
      for (const [, errors] of clusterMap) {
        if (problems.length >= MAX_PROBLEMS_PER_COLLECT) break
        if (errors.length < MIN_OCCURRENCE_THRESHOLD) continue

        const err = errors[0]
        const fingerprint = `${err.pattern.type}:${err.file}:${err.line}`

        // 跨采集去重：同一指纹不重复提交
        if (this.seenFingerprints.has(fingerprint)) continue
        this.seenFingerprints.add(fingerprint)

        const problem = this.buildProblem(err, errors.length)
        if (problem) problems.push(problem)
      }

      log('INFO', 'plan_log_collector_result', {
        problems_generated: problems.length,
        raw_errors: rawErrors.length,
        clusters: clusterMap.size,
      })
    } catch (err) {
      log('ERROR', 'plan_log_collector_error', { error: String(err) })
    }

    return problems
  }

  /**
   * 获取最近的日志文件列表（修改时间在 cutoff 之后）。
   */
  private getRecentLogFiles(logDir: string, cutoff: number): string[] {
    try {
      const files = readdirSync(logDir)
      return files
        .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
        .filter((f) => {
          try {
            return statSync(join(logDir, f)).mtimeMs >= cutoff
          } catch {
            return false
          }
        })
        .sort()
        .map((f) => join(logDir, f))
    } catch {
      return []
    }
  }

  /**
   * 读取文件尾部最多 maxLines 行（避免大日志文件 OOM）。
   */
  private tailLines(filePath: string, maxLines: number): string[] {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n')
      if (allLines.length <= maxLines) return allLines
      return allLines.slice(-maxLines)
    } catch {
      return []
    }
  }

  /**
   * 判断一行是否与计划执行相关（快速过滤器，避免每个日志行都跑全量 regex）。
   */
  private isRelevantLine(line: string): boolean {
    const keywords = [
      'plan_', 'evolution', 'pipeline', 'ERROR', 'error',
      'ENOENT', 'EACCES', 'EPERM', 'JSON.parse', 'SyntaxError',
      'TypeError', 'ReferenceError', 'undefined', 'Refused',
      'fail', 'timeout',
    ]
    const lower = line.toLowerCase()
    return keywords.some((kw) => lower.includes(kw.toLowerCase()))
  }

  /**
   * 从日志行中提取时间戳。
   */
  private extractTimestamp(line: string, _logFile: string): number {
    // 尝试从行首提取 ISO 时间戳
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    if (match) return new Date(match[1]).getTime()
    // 回退到文件修改时间
    try {
      return statSync(_logFile).mtimeMs
    } catch {
      return Date.now()
    }
  }

  /**
   * 从日志行中提取错误文件路径和行号。
   * 匹配常见的堆栈格式：at xxx (file.ts:line:col)
   */
  private extractFileFromLine(line: string): { file: string; line: number } | null {
    // 匹配 Node.js / TypeScript 堆栈：at xxx (path/to/file.ts:10:5)
    const stackMatch = line.match(/\(([^)]+\.(?:ts|tsx|js|jsx)):(\d+):\d+\)/)
    if (stackMatch) return { file: stackMatch[1], line: parseInt(stackMatch[2], 10) }

    // 匹配简单格式：path/to/file.ts:10:5
    const simpleMatch = line.match(/([^\s]+\.(?:ts|tsx|js|jsx)):(\d+):\d+/)
    if (simpleMatch) return { file: simpleMatch[1], line: parseInt(simpleMatch[2], 10) }

    // 匹配 Windows 路径格式
    const winMatch = line.match(/([A-Z]:\\[^:]+\.(?:ts|tsx|js|jsx)):(\d+)/)
    if (winMatch) return { file: winMatch[1], line: parseInt(winMatch[2], 10) }

    return null
  }

  /**
   * 从日志行前的上下文中提取文件路径（用于需要跨行分析的 pattern）。
   */
  private extractFileFromContext(lines: string[], index: number): { file: string; line: number } | null {
    // 向上搜索前 5 行
    const start = Math.max(0, index - 5)
    for (let i = index - 1; i >= start; i--) {
      const result = this.extractFileFromLine(lines[i])
      if (result) return result
    }
    return null
  }

  /**
   * 将错误信息转换为 Problem 条目。
   */
  private buildProblem(
    err: { pattern: ErrorPattern; file: string; line: number; message: string; timestamp: number },
    occurrenceCount: number,
  ): Problem | null {
    const id = `plan_log_${err.pattern.type}_${err.file}_${err.line}`
      .replace(/[^a-zA-Z0-9_\-\.一-鿿]/g, '_')
      .slice(0, 96)

    const title = `Plan 执行错误 [${err.pattern.label}]: ${err.file}`
    const description = [
      `【Plan 执行日志 - 自动检测】`,
      ``,
      `- 错误类型: ${err.pattern.label} (${err.pattern.type})`,
      `- 文件: ${err.file}${err.line > 0 ? `:${err.line}` : ''}`,
      `- 出现次数: ${occurrenceCount} 次`,
      `- 最后出现: ${new Date(err.timestamp).toLocaleString('zh-CN')}`,
      ``,
      `- 错误消息: ${err.message.slice(0, 200)}`,
      ``,
      `- 修复建议: ${err.pattern.suggestionTemplate}`,
      ``,
      `【自动补丁执行器将尝试修复此问题】`,
    ].join('\n')

    return {
      id,
      source: 'log',
      severity: err.pattern.severity,
      title,
      description,
      estimatedCostChars: description.length + 200,
      lastSeen: err.timestamp,
      occurrenceCount,
      context: {
        raw: err.message,
        snippet: this.buildSnippet(err.file, err.line),
        metadata: {
          error_type: err.pattern.type,
          error_label: err.pattern.label,
          error_file: err.file,
          error_line: String(err.line),
          occurrence_count: String(occurrenceCount),
          fix_type: this.getFixType(err.pattern.type),
        },
      },
    }
  }

  /**
   * 从源文件提取错误行附近的代码片段（便于修复分析）。
   */
  private buildSnippet(file: string, line: number): string | undefined {
    if (line <= 0) return undefined
    try {
      // 只读取项目源码目录内的文件
      const absFile = file.startsWith('/') || file.match(/^[A-Z]:\\/) ? file : join(process.cwd(), file)
      if (!existsSync(absFile)) return undefined

      const content = readFileSync(absFile, 'utf-8')
      const lines = content.split('\n')
      const start = Math.max(0, line - 3)
      const end = Math.min(lines.length, line + 2)

      return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
    } catch {
      return undefined
    }
  }

  /**
   * 将错误类型映射到自动补丁修复策略名称。
   */
  private getFixType(patternType: string): string {
    const fixMap: Record<string, string> = {
      ENOENT: 'add_mkdir_guard',
      EACCES: 'add_permission_check',
      EPERM: 'add_retry_wrapper',
      JSON_PARSE: 'add_json_trycatch',
      UNDEFINED_PROPERTY: 'add_null_guard',
      NOT_A_FUNCTION: 'add_type_guard',
      WRITE_AFTER_END: 'add_stream_guard',
    }
    return fixMap[patternType] || 'unknown'
  }
}
