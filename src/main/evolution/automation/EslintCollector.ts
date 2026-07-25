/**
 * EslintCollector — ESLint 问题采集器
 *
 * 运行 npx eslint，解析 compact 格式为结构化 Problem[]。
 * 遵循与 TscCollector 相同的模式。
 */

import { execAsync } from '../../utils/async'
import { existsSync } from 'fs'
import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from './types'

export class EslintCollector implements SignalCollector {
  readonly name = 'eslint'
  readonly source = 'lint' as const

  private projectRoot: string
  private lastRun = 0
  private minIntervalMs = 15 * 60 * 1000

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  shouldRun(): boolean {
    if (!existsSync(this.projectRoot)) return false
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  getSkipReason(): string {
    if (!existsSync(this.projectRoot)) return 'project_root_not_found'
    if (Date.now() - this.lastRun < this.minIntervalMs) {
      const remaining = Math.round((this.minIntervalMs - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    try {
      const stdout = await execAsync('npx eslint src/ --ext .ts,.tsx --format=compact 2>&1 || true', {
        cwd: this.projectRoot,
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })

      const problems = this.parseEslintOutput(stdout)
      log('INFO', 'eslint_collector_done', { count: problems.length })
      return problems
    } catch (err: any) {
      log('WARN', 'eslint_collector_error', { error: err.message })
      return []
    }
  }

  private parseEslintOutput(output: string): Problem[] {
    // ESLint compact 格式:
    //   /path/file.ts: line 10, col 5, Error - message (rule-id)
    //   /path/file.ts: line 20, col 1, Warning - message (rule-id)
    // Windows 路径使用反斜杠
    const problems: Problem[] = []
    const seen = new Set<string>()

    // 匹配格式: path: line N, col N, severity - message (rule)
    const lineRegex = /^(.+?):\s+line\s+(\d+),\s+col\s+\d+,\s+(Error|Warning)\s+-\s+(.+?)\s+\((.+?)\)\s*$/gm
    let match: RegExpExecArray | null

    while ((match = lineRegex.exec(output)) !== null) {
      const [, file, lineStr, severity, message, rule] = match
      const line = parseInt(lineStr, 10)
      // 规范化路径（Windows 反斜杠 → 正斜杠）
      const normalizedFile = file.replace(/\\/g, '/')
      const dedupKey = `lint:${normalizedFile}:${line}:${rule}`

      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      problems.push({
        id: `lint:${normalizedFile}:${line}:${rule}`,
        source: 'lint',
        severity: severity === 'Error' ? 'error' : 'warning',
        title: `${rule}: ${message.slice(0, 80)}`,
        description: message,
        file: normalizedFile,
        line,
        estimatedCostChars: message.length + 50,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: match[0],
          metadata: { rule },
        },
      })
    }

    // 如果没有匹配到 compact 格式，尝试解析没有规则的输出
    if (problems.length === 0 && output.trim()) {
      const fallbackRegex = /^(.+?):\s+line\s+(\d+),\s+col\s+\d+,\s+(Error|Warning)\s+-\s+(.+?)\s*$/gm
      while ((match = fallbackRegex.exec(output)) !== null) {
        const [, file, lineStr, severity, message] = match
        const line = parseInt(lineStr, 10)
        const normalizedFile = file.replace(/\\/g, '/')
        const dedupKey = `lint:${normalizedFile}:${line}:${message.slice(0, 40)}`

        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        problems.push({
          id: `lint:${normalizedFile}:${line}:${message.slice(0, 40)}`,
          source: 'lint',
          severity: severity === 'Error' ? 'error' : 'warning',
          title: message.slice(0, 80),
          description: message,
          file: normalizedFile,
          line,
          estimatedCostChars: message.length + 50,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: match[0],
          },
        })
      }
    }

    return problems
  }
}
