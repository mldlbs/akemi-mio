/**
 * CicdCollector — CI/CD 管道采集器
 *
 * 作为自动化管道的 SignalCollector，定期执行 CI/CD 检查并报告问题。
 * 将 tsc/lint/test 等命令通过 MCP CI/CD 工具执行，结果统一为 Problem 格式。
 *
 * 与 PipelineOrchestrator 集成后，Evolution 系统可通过管道自动发现 CI/CD 问题。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { cicdTypecheckTool } from '@akemi-mio/capabilities/tool/definitions/CicdTools'
import type { Problem, SignalCollector } from '@akemi-mio/evolution/automation/types'

export class CicdCollector implements SignalCollector {
  readonly name = 'cicd-collector'
  readonly source = 'cicd' as const

  private lastRun = 0
  private minIntervalMs = 30 * 60 * 1000 // 30 分钟

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    // 1. TypeScript 编译检查
    try {
      const tscResult = await cicdTypecheckTool.handler({})
      const rawText = tscResult.content?.[0]?.text || '{}'
      let parsed: any = {}
      try {
        parsed = JSON.parse(rawText)
      } catch {}

      if (!parsed.passed && Array.isArray(parsed.errors)) {
        for (const err of parsed.errors.slice(0, 30)) {
          const { file, line, column, message } = parseTscError(err)
          problems.push({
            id: `cicd:tsc:${file}:${line}:${column || 0}`,
            source: 'cicd',
            severity: 'error',
            title: `TypeScript 编译错误: ${message?.slice(0, 80) || '未知错误'}`,
            description: message || err,
            file: file || undefined,
            line,
            estimatedCostChars: 200,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: err,
              metadata: {
                toolType: 'typecheck',
                column: String(column || ''),
              },
            },
          })
        }
      }
    } catch (err: any) {
      log('WARN', 'cicd_collector_tsc_error', { error: err.message })
    }

    // 2. Collect test failures via TestCollector (existing)
    // Note: This avoids duplicate collection — test failures are already collected by TestCollector

    log('INFO', 'cicd_collector_done', { problems: problems.length })
    return problems
  }
}

/**
 * 解析 tsc 错误行格式: file(line,column): error TS2345: message
 * 或 standard TS format: file.ts:line:column - error TS2345: message
 */
function parseTscError(errorLine: string): { file?: string; line?: number; column?: number; message?: string } {
  const result: { file?: string; line?: number; column?: number; message?: string } = {}

  // 尝试格式 1: file(line,column): error TS...
  const parenMatch = errorLine.match(/^(.+)\((\d+)(?:,(\d+))?\):\s+(error\s+TS[\s\S]*)$/)
  if (parenMatch) {
    result.file = parenMatch[1].trim()
    result.line = parseInt(parenMatch[2], 10)
    if (parenMatch[3]) result.column = parseInt(parenMatch[3], 10)
    result.message = parenMatch[4].trim()
    return result
  }

  // 尝试格式 2: file.ts:line:column - error TS...
  const colonMatch = errorLine.match(/^(.+\.tsx?):(\d+):(\d+)\s*-\s*(error\s+TS[\s\S]*)$/)
  if (colonMatch) {
    result.file = colonMatch[1].trim()
    result.line = parseInt(colonMatch[2], 10)
    result.column = parseInt(colonMatch[3], 10)
    result.message = colonMatch[4].trim()
    return result
  }

  // 尝试格式 3: error TS...
  const simpleMatch = errorLine.match(/^(error\s+TS[\s\S]*)$/)
  if (simpleMatch) {
    result.message = simpleMatch[1].trim()
    return result
  }

  // 回退：整行作为消息
  result.message = errorLine.trim()
  return result
}
