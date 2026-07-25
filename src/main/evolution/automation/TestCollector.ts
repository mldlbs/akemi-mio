/**
 * TestCollector — 测试失败采集器
 *
 * 运行 vitest run，解析输出中的 FAIL 行，报告失败文件。
 */

import { execAsync } from '../../utils/async'
import { existsSync } from 'fs'
import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from './types'

export class TestCollector implements SignalCollector {
  readonly name = 'test'
  readonly source = 'test' as const

  private projectRoot: string
  private lastRun = 0
  private minIntervalMs = 30 * 60 * 1000

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
      const stdout = await execAsync('npx vitest run 2>&1', {
        cwd: this.projectRoot,
        timeout: 120_000,
        windowsHide: true,
      })
      return []
    } catch (err: any) {
      const output: string = (err.stdout || err.stderr || err.message || '').toString()
      const problems = this.parseTestOutput(output)

      log('INFO', 'test_collector_done', { count: problems.length })
      return problems
    }
  }

  private parseTestOutput(output: string): Problem[] {
    const problems: Problem[] = []
    const seen = new Set<string>()

    // vitest FAIL 格式:
    //   FAIL  src/main/xxx.test.ts [ src/main/xxx.test.ts ]
    //   FAIL  src/main/xxx.test.ts > suite > test name
    for (const line of output.split('\n')) {
      // 格式: " FAIL  path [path]" 或 " FAIL  path > suite > test"
      if (!line.startsWith(' FAIL ')) continue
      let rest = line.slice(6).trim()
      // 去掉 " [path]" 后缀
      const bracketIdx = rest.indexOf(' [')
      if (bracketIdx > 0) rest = rest.slice(0, bracketIdx)
      // 去掉 " > suite > test name" 后缀
      const gtIdx = rest.indexOf(' > ')
      if (gtIdx > 0) rest = rest.slice(0, gtIdx)

      const filePath = rest.replace(/\\/g, '/')
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue
      if (seen.has(filePath)) continue
      seen.add(filePath)

      problems.push({
        id: `test:${filePath}`,
        source: 'test',
        severity: 'error',
        title: `测试失败: ${filePath.split('/').pop()}`,
        description: `${filePath} 测试用例失败，需要修复`,
        file: filePath,
        estimatedCostChars: 100,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: `FAIL ${filePath}`,
          metadata: { file: filePath },
        },
      })
    }

    return problems
  }
}
