/**
 * TscCollector — TypeScript 编译错误采集器
 *
 * 运行 tsc --noEmit，解析输出为结构化 Problem[]。
 * 只报告新增/变更的错误（去重由 ProblemQueue 处理）。
 */

import { exec } from 'child_process'
import { existsSync } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import type { Problem, SignalCollector } from './types'

export class TscCollector implements SignalCollector {
  readonly name = 'tsc'
  readonly source = 'tsc' as const

  private projectRoot: string
  private lastRun = 0
  private minIntervalMs = 10 * 60 * 1000

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
      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          'node_modules/.bin/tsc --noEmit -p tsconfig.node.json 2>&1',
          {
            cwd: this.projectRoot,
            timeout: 60_000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            encoding: 'utf-8',
          },
          (err, stdout) => {
            if (err && !stdout) {
              reject(err)
              return
            }
            resolve(stdout || '')
          },
        )
      })

      const problems = this.parseTscOutput(stdout)
      log('INFO', 'tsc_collector_done', { count: problems.length })
      return problems
    } catch (err: any) {
      log('WARN', 'tsc_collector_error', { error: err.message })
      return []
    }
  }

  private parseTscOutput(output: string): Problem[] {
    // tsc 错误格式：file.ts(line,column): error TS2345: message
    const problems: Problem[] = []
    const seen = new Set<string>()

    const lineRegex = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
    let match: RegExpExecArray | null

    while ((match = lineRegex.exec(output)) !== null) {
      const [, file, lineStr, severity, code, message] = match
      const line = parseInt(lineStr, 10)
      const dedupKey = `${file}:${line}:${code}`

      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      problems.push({
        id: `tsc:${file}:${line}:${code}`,
        source: 'tsc',
        severity: severity === 'error' ? 'error' : 'warning',
        title: `${code}: ${message.slice(0, 80)}`,
        description: message,
        file,
        line,
        estimatedCostChars: message.length + 50,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: match[0],
          metadata: { code },
        },
      })
    }

    return problems
  }
}
