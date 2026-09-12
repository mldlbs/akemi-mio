/**
 * RadarOptimizationCollector — 雷达代码优化机会采集器
 *
 * 扫描观察者（observer）采集器代码，识别可自动优化的模式：
 * 1. 硬编码 API URL（应提权到 config / 环境变量）
 * 2. fetch() 调用缺少 AbortSignal.timeout
 * 3. fetch() 调用缺少 !res.ok 检查
 * 4. 缺少备用 API 端点（单点故障风险）
 * 5. 缺少异常重试逻辑
 * 6. 缺少成功/失败指标采集
 *
 * 作为 SignalCollector 接入自动化管道（ProblemSource='tool' 复用工具优化来源），
 * 生成的 Problem 由 RadarOptimizationExecutor 消费。
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 观察者采集器目录 */
const COLLECTORS_DIR = 'packages/intelligence/src/observer/collectors'

/** 最小采集间隔（匹配进化周期 2h） */
const COLLECT_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 单次最大问题数 */
const MAX_PROBLEMS_PER_RUN = 10

// =============================================================================
// 规则定义
// =============================================================================

interface ScanRule {
  name: string
  description: string
  severity: 'error' | 'warning' | 'info'
  /** 检查函数：返回问题列表 */
  check: (filePath: string, content: string, lines: string[]) => ScanFinding[]
}

interface ScanFinding {
  line: number
  message: string
  detail: string
  estimatedCostChars: number
  metadata: Record<string, string>
}

/** 硬编码 API URL 检测 — 匹配 fetch() 调用中的字符串字面量 */
function detectHardcodedUrls(_filePath: string, content: string, _lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  // 匹配 fetch('https://...') 或 fetch("https://...")
  const urlPattern = /fetch\s*\(\s*['"](https?:\/\/[^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = urlPattern.exec(content)) !== null) {
    const url = match[1]
    // 计算行号
    const prefix = content.slice(0, match.index)
    const lineNum = prefix.split('\n').length
    findings.push({
      line: lineNum,
      message: `硬编码 API URL: ${url.length > 60 ? url.slice(0, 60) + '...' : url}`,
      detail: `将 URL "${url}" 提取为 config 常量或环境变量，避免硬编码`,
      estimatedCostChars: 80,
      metadata: { url, pattern: 'hardcoded_url' },
    })
  }
  return findings
}

/** 缺少 AbortSignal.timeout 检测 */
function detectMissingTimeout(_filePath: string, content: string, _lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  // 匹配 fetch(...) 调用，检查是否包含 signal: AbortSignal.timeout 或 signal: controller.signal
  const fetchPattern = /^\s*.*fetch\s*\(/gm
  let match: RegExpExecArray | null
  while ((match = fetchPattern.exec(content)) !== null) {
    const lineText = match[0]
    // 检查同一行或后续几行是否有 signal:
    const pos = match.index
    const snippet = content.slice(pos, pos + 300) // 看后 300 字符
    if (!snippet.includes('AbortSignal.timeout') && !snippet.includes('signal:')) {
      const prefix = content.slice(0, pos)
      const lineNum = prefix.split('\n').length
      findings.push({
        line: lineNum,
        message: 'fetch() 调用缺少超时控制',
        detail: '添加 AbortSignal.timeout(ms) 防止网络请求挂起',
        estimatedCostChars: 40,
        metadata: { pattern: 'missing_timeout' },
      })
    }
  }
  return findings
}

/** 缺少 !res.ok 检查 — 检测 fetch 后是否立即检查 res.ok */
function detectMissingResOkCheck(_filePath: string, content: string, _lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  // 找到所有 res = await fetch(...) 或 const res = await fetch(...)
  const fetchAssignPattern = /(?:const\s+)?(\w+)\s*=\s*await\s+fetch\s*\(/g
  let match: RegExpExecArray | null
  while ((match = fetchAssignPattern.exec(content)) !== null) {
    const varName = match[1]
    const pos = match.index
    const prefix = content.slice(0, pos)
    const lineNum = prefix.split('\n').length
    // 查找后续 5 行内是否有 res.ok 检查
    const afterLines = content.slice(pos).split('\n').slice(0, 6).join('\n')
    const okCheckPattern = new RegExp(`${varName}\\.ok`)
    if (!okCheckPattern.test(afterLines)) {
      findings.push({
        line: lineNum,
        message: `响应状态检查缺失: ${varName} = fetch(...) 后缺少状态校验`,
        detail: `添加 if (!${varName}.ok) continue / return [] 避免处理失败响应`,
        estimatedCostChars: 30,
        metadata: { varName, pattern: 'missing_res_ok' },
      })
    }
  }
  return findings
}

/** 缺少备用 API 端点检测 */
function detectMissingFallbackApis(_filePath: string, _content: string, lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  // 查找类属性中定义 apis 数组的
  const apiLines: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(private\s+)?apis\s*[:=]\s*\[/.test(lines[i])) {
      // 收集这个数组的所有行直到 ]
      let j = i
      let text = ''
      while (j < lines.length && !lines[j].includes(']')) {
        text += lines[j] + '\n'
        j++
      }
      if (j < lines.length) text += lines[j]
      const urlCount = (text.match(/https?:\/\//g) || []).length
      apiLines.push({ line: i + 1, text: lines[i] })
      if (urlCount <= 1) {
        findings.push({
          line: i + 1,
          message: `采集器仅有 ${urlCount} 个 API 端点，存在单点故障风险`,
          detail: '添加至少一个备用 API 端点以提高可用性',
          estimatedCostChars: 120,
          metadata: { pattern: 'single_api_endpoint', currentCount: String(urlCount) },
        })
      }
    }
  }

  // 如果没有显式的 apis 数组，检查是否通过多个 try-catch 实现了 fallback
  const hasExplicitApis = apiLines.length > 0
  if (!hasExplicitApis) {
    // 检查是否有多个 try-catch 块（隐式 fallback）
    const tryBlocks = lines.filter((l) => l.trim().startsWith('try {') || l.trim() === 'try').length
    if (tryBlocks < 2) {
      const classDeclLine = lines.findIndex((l) => /class\s+\w+Collector/.test(l))
      if (classDeclLine >= 0) {
        findings.push({
          line: classDeclLine + 1,
          message: '采集器缺少 API 故障转移（仅 1 个 try-catch 或 API 调用）',
          detail: '添加备用 API 端点和故障转移逻辑以提高可用性',
          estimatedCostChars: 150,
          metadata: { pattern: 'missing_fallback' },
        })
      }
    }
  }
  return findings
}

/** 检测是否有重试逻辑 */
function detectMissingRetryLogic(_filePath: string, content: string, _lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  const fetchCalls = content.match(/fetch\s*\(/g)
  if (!fetchCalls || fetchCalls.length === 0) return findings

  // 检查是否有 retry 相关逻辑
  const hasRetry = /retry|withRetry|指数退避|exponentialBackoff/i.test(content)
  if (!hasRetry) {
    // 找到第一个 fetch 调用的位置
    const firstFetch = content.search(/fetch\s*\(/)
    if (firstFetch >= 0) {
      const prefix = content.slice(0, firstFetch)
      const lineNum = prefix.split('\n').length
      findings.push({
        line: lineNum,
        message: `${fetchCalls.length} 处 fetch() 调用缺少重试逻辑`,
        detail: '添加指数退避重试（最多 3 次），提升网络不稳定时的采集成功率',
        estimatedCostChars: 200,
        metadata: { fetchCount: String(fetchCalls.length), pattern: 'missing_retry' },
      })
    }
  }
  return findings
}

/** 检测是否缺少指标采集（success/failure tracking） */
function detectMissingMetrics(_filePath: string, content: string, lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  const hasMetrics = /metrics|successRate|成功率|_success|_failure|successCount|failureCount/i.test(content)
  if (!hasMetrics) {
    // 查找是否有任何 logging（作为是否有关注执行质量的信号）
    const hasLogging = /log\(/i.test(content)
    if (hasLogging) {
      const classDeclLine = lines.findIndex((l) => /class\s+\w+Collector/.test(l))
      if (classDeclLine >= 0) {
        findings.push({
          line: classDeclLine + 1,
          message: '采集器缺少执行指标采集（成功/失败计数、延迟）',
          detail: '添加成功/失败计数器、延迟记录，用于自适应调参',
          estimatedCostChars: 160,
          metadata: { pattern: 'missing_metrics' },
        })
      }
    }
  }
  return findings
}

/** 检测硬编码密钥/Token */
function detectHardcodedSecrets(_filePath: string, content: string, _lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  // 检测常见的密钥模式
  const secretPatterns = [
    /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
    /token\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /secret\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /password\s*[:=]\s*['"][^'"]+['"]/i,
    /auth.*['"][A-Za-z0-9+/]{20,}['"]/i,
  ]
  for (const pattern of secretPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const prefix = content.slice(0, match.index)
      const lineNum = prefix.split('\n').length
      findings.push({
        line: lineNum,
        message: `潜在硬编码密钥: ${match[0].slice(0, 50)}...`,
        detail: '将敏感信息移到环境变量或配置文件中',
        estimatedCostChars: 60,
        metadata: { pattern: 'hardcoded_secret' },
      })
    }
  }
  return findings
}

// =============================================================================
// 所有扫描规则
// =============================================================================

const SCAN_RULES: ScanRule[] = [
  {
    name: 'hardcoded-url',
    description: '硬编码 API URL',
    severity: 'warning',
    check: detectHardcodedUrls,
  },
  {
    name: 'missing-timeout',
    description: 'fetch() 缺少超时控制',
    severity: 'warning',
    check: detectMissingTimeout,
  },
  {
    name: 'missing-res-ok',
    description: 'fetch() 缺少状态检查',
    severity: 'warning',
    check: detectMissingResOkCheck,
  },
  {
    name: 'missing-fallback',
    description: '缺少备用 API 端点',
    severity: 'info',
    check: detectMissingFallbackApis,
  },
  {
    name: 'missing-retry',
    description: '缺少重试逻辑',
    severity: 'warning',
    check: detectMissingRetryLogic,
  },
  {
    name: 'missing-metrics',
    description: '缺少执行指标',
    severity: 'info',
    check: detectMissingMetrics,
  },
  {
    name: 'hardcoded-secret',
    description: '硬编码密钥',
    severity: 'error',
    check: detectHardcodedSecrets,
  },
]

// =============================================================================
// RadarOptimizationCollector
// =============================================================================

export class RadarOptimizationCollector implements SignalCollector {
  readonly name = 'radar-optimization-collector'
  readonly source = 'tool' as const
  private lastCollectAt = 0

  shouldRun(): boolean {
    return Date.now() - this.lastCollectAt >= COLLECT_INTERVAL_MS
  }

  async collect(): Promise<Problem[]> {
    this.lastCollectAt = Date.now()
    const projectRoot = process.cwd()
    const collectorsAbsDir = join(projectRoot, COLLECTORS_DIR)

    if (!existsSync(collectorsAbsDir)) {
      log('WARN', 'radar_opt_collect_dir_not_found', { dir: COLLECTORS_DIR })
      return []
    }

    const files = readdirSync(collectorsAbsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))

    log('INFO', 'radar_opt_collect_scan', { fileCount: files.length })
    const problems: Problem[] = []

    for (const file of files) {
      const filePath = join(collectorsAbsDir, file)
      const relPath = relative(projectRoot, filePath)

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }

      const lines = content.split('\n')
      const fileFindings: Array<{ rule: string; finding: ScanFinding }> = []

      for (const rule of SCAN_RULES) {
        const findings = rule.check(relPath, content, lines)
        for (const f of findings) {
          fileFindings.push({ rule: rule.name, finding: f })
        }
      }

      // 去重：同文件同行同规则只保留一个
      const seen = new Set<string>()
      const uniqueFindings = fileFindings.filter((ff) => {
        const key = `${ff.rule}:${ff.finding.line}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      for (const ff of uniqueFindings) {
        const severity = SCAN_RULES.find((r) => r.name === ff.rule)?.severity || 'info'
        problems.push({
          id: `radar_opt_${file}_${ff.rule}_${ff.finding.line}_${Date.now()}`,
          source: 'tool',
          severity,
          title: `[雷达优化] ${file}: ${ff.finding.message}`,
          description: ff.finding.detail,
          file: relPath,
          line: ff.finding.line,
          estimatedCostChars: ff.finding.estimatedCostChars,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `${relPath}:${ff.finding.line} — ${ff.finding.message}\n${ff.finding.detail}`,
            snippet: lines.slice(Math.max(0, ff.finding.line - 2), ff.finding.line + 2).join('\n'),
            metadata: {
              rule: ff.rule,
              ...ff.finding.metadata,
            },
          },
        })

        if (problems.length >= MAX_PROBLEMS_PER_RUN) break
      }

      if (problems.length >= MAX_PROBLEMS_PER_RUN) break
    }

    log('INFO', 'radar_opt_collect_done', {
      problemsFound: problems.length,
      filesScanned: files.length,
    })

    return problems
  }
}
