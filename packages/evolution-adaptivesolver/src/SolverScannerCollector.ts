/**
 * SolverScannerCollector — 固定步长 ODE 求解器扫描采集器
 *
 * 职责：
 * 1. 扫描项目源码中实现了 OdeSolver 接口且 isFixedStep = true 的类
 * 2. 提取步长变量名和数值
 * 3. 识别主循环结构（for/while 固定步进）
 * 4. 生成 Problem 提交给管道
 *
 * 触发条件：
 * - 检测到新的或修改过的求解器文件
 * - 距离上次扫描超过 2 小时
 *
 * 扫描策略：
 * - 使用文件系统扫描 src/main/evolution/adaptivesolver/solvers/ 目录
 * - 通过 AST 级别检测（简单正则匹配）识别步长参数
 * - 匹配模式：class XXX implements OdeSolver, isFixedStep = true, stepSize 参数
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import type { SignalCollector, Problem } from '@akemi-mio/evolution/automation/types'
import type { FixedSolverScanResult } from './solvers/types'

// =============================================================================
// 配置
// =============================================================================

/** 扫描目标目录 */
const SOLVER_DIRS = ['packages/evolution/src/adaptivesolver/solvers']

/** 最小采集间隔（2 小时，匹配 Evolution 周期） */
const SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 已识别的求解器文件缓存 */
interface SolverCacheEntry {
  filePath: string
  lastModified: number
  hash: string
}

// =============================================================================
// 扫描器
// =============================================================================

export class SolverScannerCollector implements SignalCollector {
  readonly name = 'solver-scanner-collector'
  readonly source = 'synthetic' as const

  private lastRun = 0
  private cache = new Map<string, SolverCacheEntry>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < SCAN_INTERVAL_MS) return false
    return true
  }

  getSkipReason(): string {
    const remaining = SCAN_INTERVAL_MS - (Date.now() - this.lastRun)
    return `冷却中（还需 ${Math.round(remaining / 60000)} 分钟）`
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    for (const dir of SOLVER_DIRS) {
      const absDir = join(DEV_PROJECT_ROOT, dir)
      try {
        // 使用 glob 或 fs 扫描
        const files = this.getSolverFiles(absDir)
        for (const file of files) {
          const result = this.scanFile(file)
          if (result) {
            // 检查缓存是否命中
            const fileHash = this.computeSimpleHash(result.snippet)
            const cached = this.cache.get(result.filePath)
            if (cached && cached.hash === fileHash) {
              continue // 无变化，跳过
            }
            this.cache.set(result.filePath, {
              filePath: result.filePath,
              lastModified: Date.now(),
              hash: fileHash,
            })

            const problem = this.buildProblem(result)
            if (problem) {
              problems.push(problem)
            }
          }
        }
      } catch (err: any) {
        log('WARN', 'solver_scanner_dir_error', { dir, error: err.message })
      }
    }

    log('INFO', 'solver_scanner_complete', {
      scanned: SOLVER_DIRS.length,
      problems: problems.length,
    })

    return problems
  }

  // ==================== 文件扫描 ====================

  /**
   * 获取目录下的所有 TypeScript 文件。
   */
  private getSolverFiles(dir: string): string[] {
    try {
      if (!statSync(dir).isDirectory()) return []
      const entries = readdirSync(dir)
      return entries
        .filter((e: string) => e.endsWith('.ts') && !e.endsWith('.d.ts') && e !== 'index.ts' && e !== 'types.ts')
        .map((e: string) => join(dir, e))
        .filter((f: string) => {
          const s = statSync(f)
          return s.isFile() && s.size > 0
        })
    } catch {
      return []
    }
  }

  /**
   * 扫描单个文件，提取固定步长求解器信息。
   */
  private scanFile(filePath: string): FixedSolverScanResult | null {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      // 检测是否为求解器类：class XXX implements OdeSolver
      const classMatch = content.match(/class\s+(\w+)\s+implements\s+OdeSolver/)
      if (!classMatch) return null

      const solverName = classMatch[1]

      // 检测是否为固定步长
      const isFixedStep = content.includes('isFixedStep = true') || content.includes('isFixedStep: true')
      if (!isFixedStep) return null

      // 提取步长变量名和值
      const stepVarResult = this.extractStepVariable(content, lines)

      // 提取循环结构
      const loopDesc = this.extractLoopStructure(content, lines)

      // 查找类定义行
      let classLine = 0
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('class ') && lines[i].includes(solverName)) {
          classLine = i + 1
          break
        }
      }

      // 提取代码片段（类定义前后几行）
      const snippetStart = Math.max(0, classLine - 2)
      const snippetEnd = Math.min(lines.length, classLine + 20)
      const snippet = lines.slice(snippetStart, snippetEnd).join('\n')

      return {
        filePath,
        lineNumber: classLine,
        solverName,
        stepVarName: stepVarResult.name,
        stepValue: stepVarResult.value,
        loopStructure: loopDesc,
        snippet,
      }
    } catch (err: any) {
      log('WARN', 'solver_scanner_file_error', { filePath, error: err.message })
      return null
    }
  }

  /**
   * 提取步长变量名和值。
   */
  private extractStepVariable(content: string, lines: string[]): { name: string; value: number } {
    // 模式 1: stepSize = 0.01 或 stepSize: 0.01
    const stepPattern = /stepSize\s*[=:]\s*([\d.]+(?:e[+-]?\d+)?)/
    const stepMatch = content.match(stepPattern)
    if (stepMatch) {
      return { name: 'stepSize', value: parseFloat(stepMatch[1]) }
    }

    // 模式 2: const stepSize = 0.01 或 defaultStepSize: number = 0.01
    const defaultPattern = /defaultStepSize\s*(?::\s*\w+)?\s*=\s*([\d.]+(?:e[+-]?\d+)?)/
    const defaultMatch = content.match(defaultPattern)
    if (defaultMatch) {
      return { name: 'defaultStepSize', value: parseFloat(defaultMatch[1]) }
    }

    // 模式 3: h = 0.01（循环内部步长变量）
    const hPattern = /(?:const|let|var)\s+(h|dt|delta)\s*[=:]\s*([\d.]+(?:e[+-]?\d+)?)/
    const hMatch = content.match(hPattern)
    if (hMatch) {
      return { name: hMatch[1], value: parseFloat(hMatch[2]) }
    }

    return { name: 'stepSize', value: 0.01 }
  }

  /**
   * 提取主循环结构描述。
   */
  private extractLoopStructure(content: string, _lines: string[]): string {
    // 查找 for 循环
    const forMatch = content.match(/for\s*\([^)]+\)/)
    if (forMatch) return `for-loop: ${forMatch[0].trim()}`

    // 查找 while 循环
    const whileMatch = content.match(/while\s*\([^)]+\)/)
    if (whileMatch) return `while-loop: ${whileMatch[0].trim()}`

    return 'unknown-loop'
  }

  // ==================== Problem 构建 ====================

  /**
   * 从扫描结果构建 Problem。
   */
  private buildProblem(result: FixedSolverScanResult): Problem | null {
    const relPath = result.filePath.replace(DEV_PROJECT_ROOT, '').replace(/^[/\\]/, '')
    const problemId = `solver:${result.solverName}:${Date.now()}`

    return {
      id: problemId,
      source: 'synthetic',
      severity: 'info',
      title: `固定步长求解器 ${result.solverName} 可升级为自适应步长版本`,
      description: `检测到固定步长 ODE 求解器：${result.solverName}（步长 ${result.stepValue}）位于 ${relPath}。可自动升级为自适应步长 RK45 版本，提升精度并自动调节步长应对复杂方程。`,
      file: relPath,
      line: result.lineNumber,
      estimatedCostChars: 3000,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: result.snippet,
        snippet: result.snippet,
        metadata: {
          solverName: result.solverName,
          stepVarName: result.stepVarName,
          stepValue: String(result.stepValue),
          loopStructure: result.loopStructure,
          filePath: result.filePath,
          fixType: 'upgrade_to_adaptive',
          expectedBenefit: `精度提升预估 ≥ 20%（自适应步长），耗时增加 ≤ 10%`,
          risk: '中等风险：自动修改可能引入不稳定算法；严格沙箱测试和回滚',
        },
      },
    }
  }

  /**
   * 简单哈希（用于缓存比较）。
   */
  private computeSimpleHash(content: string): string {
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash |= 0
    }
    return String(hash)
  }
}
