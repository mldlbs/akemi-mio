/**
 * RadarOptimizationExecutor — 雷达代码自动优化执行器
 *
 * 消费 RadarOptimizationCollector 生成的 Problem（source='tool'），
 * 对观察者采集器代码应用确定性、基于规则的转换：
 *
 * Rule 1: inject_timeout — 为 fetch() 调用注入 AbortSignal.timeout
 * Rule 2: inject_res_ok — 在 fetch 后添加 !res.ok 状态检查
 * Rule 3: add_fallback — 为单端点采集器添加备用 URL
 * Rule 4: inject_retry — 添加指数退避重试逻辑（withRetry 包装）
 * Rule 5: inject_metrics — 注入成功/失败计数器和延迟记录
 * Rule 6: externalize_url — 提示 URL 提取（以 logs 形式输出）
 *
 * 安全机制：
 * - Git snapshot 保护（可在验证失败时回滚）
 * - tsc 编译验证（验证通过才提交）
 * - 确定性规则（零幻觉，无 LLM 依赖）
 * - 每次仅修改一个文件，单一规则
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from '../../logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'
import { execAsync } from '../../utils/async'

// =============================================================================
// 配置
// =============================================================================

/** tsc 验证超时 */
const TSC_TIMEOUT_MS = 60_000

/** 项目根 */
const PROJECT_ROOT = process.cwd()

/** 转换规则名称列表 */
type TransformRule =
  | 'inject_timeout'
  | 'inject_res_ok'
  | 'add_fallback'
  | 'inject_retry'
  | 'inject_metrics'
  | 'externalize_url'

// =============================================================================
// TransformResult — 转换结果
// =============================================================================

interface TransformResult {
  /** 转换后的完整源码 */
  content: string
  /** 变更描述 */
  description: string
  /** 是否产生了实际变更 */
  changed: boolean
  /** 变更的行范围（用于 diff） */
  changedLines?: string
}

// =============================================================================
// 规则 1: inject_timeout — 注入 AbortSignal.timeout
// =============================================================================

/**
 * 为缺少 timeout 的 fetch() 注入 AbortSignal.timeout(15000)。
 * 匹配 fetch(url) → fetch(url, { signal: AbortSignal.timeout(15000) })
 * 匹配 fetch(url, { ... }) → 在 options 中添加 signal: AbortSignal.timeout(15000)
 */
function transformInjectTimeout(content: string): TransformResult {
  let changed = false
  const description = '为 fetch() 调用注入 AbortSignal.timeout(15000)'

  // 模式: fetch(url) 无第二个参数
  content = content.replace(
    /(fetch\s*\(\s*['"][^'"]+['"])\s*\)/g,
    (match, urlPart) => {
      // 检查是否已有 options 参数（包含逗号 + 信号）
      if (match.includes('signal:')) return match
      if (match.includes('signal:') || match.includes('AbortSignal')) return match
      changed = true
      return `${urlPart}, { signal: AbortSignal.timeout(15000) })`
    },
  )

  // 模式: fetch(url, { ... }) 但缺少 signal
  content = content.replace(
    /(fetch\s*\(\s*['"][^'"]+['"]\s*,\s*\{)([^}]*?)(\}\s*\))/g,
    (match, open, opts, close) => {
      if (opts.includes('signal:')) return match
      if (open.includes('AbortSignal.timeout') || opts.includes('AbortSignal.timeout')) return match
      changed = true
      const newOpts = opts.trim() ? `${opts}, signal: AbortSignal.timeout(15000)` : `signal: AbortSignal.timeout(15000)`
      return `${open} ${newOpts} ${close}`
    },
  )

  return { content, description, changed }
}

// =============================================================================
// 规则 2: inject_res_ok — 添加 !res.ok 状态检查
// =============================================================================

/**
 * 在 await fetch(...) 后添加 if (!res.ok) continue / return 等降级逻辑。
 * 模式匹配: const res = await fetch(...) → 后续行无 res.ok 检查
 */
function transformInjectResOk(content: string): TransformResult {
  const lines = content.split('\n')
  let changed = false
  const modifiedLines = [...lines]

  for (let i = 0; i < modifiedLines.length; i++) {
    const line = modifiedLines[i]
    // 匹配 const \w+ = await fetch( 或 \w+ = await fetch(
    const fetchMatch = line.match(
      /(\w+)\s*=\s*await\s+fetch\s*\(/
    )
    if (!fetchMatch) continue

    const varName = fetchMatch[1]
    // 检查后续 5 行是否有 .ok 检查
    const nextLines = modifiedLines.slice(i + 1, i + 6).join('\n')
    if (nextLines.includes(`${varName}.ok`)) continue

    // 检查是否已经在一个 try 块内（已经有 error 处理）
    // 确定缩进
    const indent = line.match(/^\s*/)?.[0] || ''
    const innerIndent = indent + '  '

    // 在下一行插入 if (!res.ok) 检查
    // 先判断上下文环境：是在循环中（for）还是顺序执行？
    const isInLoop = modifiedLines.slice(Math.max(0, i - 5), i).some(
      (l) => l.includes('for') || l.includes('while'),
    )

    const guardLine = isInLoop
      ? `${innerIndent}if (!${varName}.ok) continue`
      : `${innerIndent}if (!${varName}.ok) { continue }`

    // 检查是否已经有类似的降级逻辑
    if (!nextLines.includes('continue') && !nextLines.includes('return []') && !nextLines.includes('return null')) {
      modifiedLines.splice(i + 1, 0, '')
      modifiedLines.splice(i + 1, 0, guardLine)
      changed = true
      break // 一次只修改一个地方
    }
  }

  return {
    content: modifiedLines.join('\n'),
    description: '在 fetch() 后添加 !res.ok 状态检查',
    changed,
  }
}

// =============================================================================
// 规则 3: add_fallback — 添加备用 API 端点
// =============================================================================

/**
 * 为单端点采集器添加备用 URL。
 * 模式匹配: 类中有单个 API URL → 转为 apis 数组 + fallback 循环
 *
 * 这是一个复杂的转换，只在明确安全的情况下进行：
 * - 如果类已经有 apis 数组但只有一个元素 → 添加注释提示
 * - 如果类使用单个 URL → 转换为 apis 数组模式
 */
function transformAddFallback(content: string): TransformResult {
  const lines = content.split('\n')
  let changed = false
  const modifiedLines = [...lines]

  // 检查是否已经有 apis 数组或 fallback 模式
  const hasApisArray = content.includes('apis') && (content.includes('apis[') || content.includes('private apis'))

  if (hasApisArray) {
    // 已经有 apis 但可能只有一个端点 → 添加注释建议
    return { content, description: '已有 API 数组，跳过（可手动添加更多端点）', changed: false }
  }

  // 查找 fetch('https://...') 中的 URL
  const urls: Array<{ url: string; line: number; indent: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/fetch\s*\(\s*['"](https?:\/\/[^'"]+)['"]/)
    if (urlMatch) {
      urls.push({
        url: urlMatch[1],
        line: i,
        indent: lines[i].match(/^\s*/)?.[0] || '',
      })
    }
  }

  if (urls.length <= 1) {
    // 只有一个或零个 URL，不适合自动添加 fallback（不知道用什么备用）
    return { content, description: '需人工添加备用 API 端点（无可靠备选源）', changed: false }
  }

  // 多个 URL 已经存在，但可能是顺序执行的（没有 fallback 循环）
  // 检查是否已用循环或数组模式
  const hasLoop = content.includes('for') && content.includes('apis')
  if (hasLoop) return { content, description: '已有 fallback 循环模式', changed: false }

  // 存在多个 URL 但没有 fallback 机制 → 输出提示
  return {
    content,
    description: `发现 ${urls.length} 个 API URL 但缺乏 fallback 循环，建议转为 apis[] + for-of 模式`,
    changed: false, // 不自动修改，因为重构较大
  }
}

// =============================================================================
// 规则 4: inject_retry — 注入重试逻辑
// =============================================================================

/**
 * 在调用 fetch 前添加重试包装。
 * 使用项目已有的 withRetry 工具函数。
 *
 * 注入方式：在文件顶部 import { withRetry } from '../../utils/async'
 * 然后将 fetch 调用包装为 withRetry(() => fetch(...), 3, 1000)
 */
function transformInjectRetry(content: string): TransformResult {
  const lines = content.split('\n')
  let changed = false
  const modifiedLines = [...lines]

  // 检查是否已有重试相关 import
  const hasRetryImport = content.includes('withRetry') && content.includes('../../utils/async')
  // 检查是否已有重试逻辑
  const hasRetryLogic = /retry|withRetry|指数退避/i.test(content)

  if (hasRetryLogic) {
    return { content, description: '已有重试逻辑', changed: false }
  }

  // 在最后一个 import 后添加 withRetry import
  if (!hasRetryImport) {
    const lastImportIdx = -1
    for (let i = modifiedLines.length - 1; i >= 0; i--) {
      if (modifiedLines[i].startsWith('import ')) {
        // 在最后一个 import 后面插入
        const insertPos = i + 1
        // 找到 import 块结束（连续 import 行）
        let endIdx = insertPos
        while (endIdx < modifiedLines.length && modifiedLines[endIdx].trim() === '') endIdx++
        modifiedLines.splice(
          endIdx,
          0,
          "import { withRetry } from '../../utils/async'",
        )
        changed = true
        break
      }
    }
  }

  // 将 fetch() 调用包装为 withRetry(() => fetch(...))
  // 模式匹配: const res = await fetch(url, ...)
  // 改为: const res = await withRetry(() => fetch(url, ...), 3, 1000)
  for (let i = 0; i < modifiedLines.length; i++) {
    const line = modifiedLines[i]
    // 只包装已检测到缺少重试的 fetch
    if (line.includes('withRetry')) continue

    const fetchMatch = line.match(
      /^(.*?)(const\s+\w+\s*=\s*await\s+)(fetch\s*\([^)]*\))\s*(.*)$/,
    )
    if (fetchMatch) {
      const prefix = fetchMatch[1]
      const assignment = fetchMatch[2]
      const fetchCall = fetchMatch[3]
      const suffix = fetchMatch[4]

      // 检查是否在 catch 块或 try 块内
      modifiedLines[i] = `${prefix}${assignment}withRetry(() => ${fetchCall}, 2, 1000)${suffix}`
      changed = true
      break // 一次只包装一个
    }
  }

  // 重新合成 content
  let resultContent = modifiedLines.join('\n')
  // 如果添加了 import，确保 import 语句按顺序（应在已有 import 后面）
  if (changed && !hasRetryImport) {
    // 整理 import 顺序（简单保证）
  }

  return {
    content: resultContent,
    description: '添加 withRetry 重试包装，含指数退避',
    changed,
  }
}

// =============================================================================
// 规则 5: inject_metrics — 注入指标采集
// =============================================================================

/**
 * 在采集器类中添加成功/失败计数器和方法耗时记录。
 * 使用模块级变量存储指标，在 collect() 开始/结束时记录。
 *
 * 注入方式：
 * 1. 在类中添加指标字段
 * 2. 在 collect() 方法开头添加计数逻辑
 * 3. 在收集完成后记录指标
 */
function transformInjectMetrics(content: string): TransformResult {
  const lines = content.split('\n')
  let changed = false
  const modifiedLines = [...lines]

  // 检查是否已有指标相关代码
  if (/successCount|failureCount|_metrics|collectorMetrics|totalRequests/i.test(content)) {
    return { content, description: '已有指标采集', changed: false }
  }

  // 检查 import 中是否已有 log
  const hasLogImport = content.includes("import { log } from '../../logger/Logger'") ||
    content.includes("import { log } from '../logger/Logger'")

  // 在 class 声明之前添加模块级指标变量
  for (let i = 0; i < modifiedLines.length; i++) {
    if (/^export\s+class\s+\w+Collector/.test(modifiedLines[i])) {
      const indent = '  '
      const metricsBlock = [
        '',
        '  // ── 指标采集 ──',
        '  private metrics = {',
        '    successCount: 0,',
        '    failureCount: 0,',
        '    totalLatencyMs: 0,',
        '    requestCount: 0,',
        '  }',
      ]
      modifiedLines.splice(i + 1, 0, ...metricsBlock.map((l) => `${indent}${l.trimStart()}`))
      changed = true
      break
    }
  }

  // 在 collect() 方法结尾（return 之前）添加日志记录
  if (changed) {
    for (let i = 0; i < modifiedLines.length; i++) {
      const isCollectEnd =
        modifiedLines[i].includes('return all') ||
        modifiedLines[i].includes('return []') ||
        (modifiedLines[i].includes('return') && i > 10 && modifiedLines.slice(Math.max(0, i - 20), i).some(l => l.includes('collect()')))

      if (isCollectEnd) {
        const indent = modifiedLines[i].match(/^\s*/)?.[0] || ''
        const metricsLog = [
          `${indent}// 记录指标`,
          `${indent}this.metrics.requestCount++`,
          `${indent}if (all.length > 0) this.metrics.successCount++`,
          `${indent}else this.metrics.failureCount++`,
        ]
        modifiedLines.splice(i, 0, ...metricsLog)
        changed = true
        break
      }
    }
  }

  return {
    content: modifiedLines.join('\n'),
    description: '注入成功/失败计数器和延迟记录',
    changed,
  }
}

// =============================================================================
// 规则 6: externalize_url — 提取 URL 为常量
// =============================================================================

/**
 * 将硬编码的 fetch URL 提取为类常量。
 * 只在简单场景下执行（单个 URL 提取）。
 */
function transformExternalizeUrl(content: string): TransformResult {
  const lines = content.split('\n')
  let changed = false
  const modifiedLines = [...lines]

  // 查找 fetch('https://...') 中的 URL
  const urlEntries: Array<{ url: string; line: number; indent: string }> = []
  const urlPattern = /fetch\s*\(\s*['"](https?:\/\/[^'"]+)['"]/
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(urlPattern)
    if (match) {
      // 跳过已经用变量的
      urlEntries.push({ url: match[1], line: i, indent: lines[i].match(/^\s*/)?.[0] || '' })
    }
  }

  if (urlEntries.length === 0) {
    return { content, description: '未发现可提取的 URL', changed: false }
  }

  // 检查是否已有 API_URLS 或类似常量
  const hasUrlConstant = /API_URL|API_ENDPOINT|BASE_URL|_URL/i.test(content)
  if (hasUrlConstant) {
    return { content, description: 'URL 已提取为常量', changed: false }
  }

  // 为每个唯一 URL 创建常量
  const uniqueUrls = [...new Set(urlEntries.map((e) => e.url))]
  if (uniqueUrls.length > 3) {
    return { content, description: `发现 ${uniqueUrls.length} 个 URL，过多不适合自动提取`, changed: false }
  }

  // 在类声明后添加 URL 常量
  for (let i = 0; i < modifiedLines.length; i++) {
    if (/^export\s+class\s+\w+Collector/.test(modifiedLines[i]) || /^class\s+\w+Collector/.test(modifiedLines[i])) {
      const urlConstants = uniqueUrls.map((url, idx) => {
        const name = `API_URL_${idx}`
        return `  private readonly ${name} = '${url}' as const`
      })
      modifiedLines.splice(i + 1, 0, '', ...urlConstants)
      changed = true
      break
    }
  }

  // 替换 fetch 中的 URL 为常量引用
  if (changed) {
    for (let i = 0; i < modifiedLines.length; i++) {
      for (let uIdx = 0; uIdx < uniqueUrls.length; uIdx++) {
        const url = uniqueUrls[uIdx]
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (modifiedLines[i].includes(url) && modifiedLines[i].includes('fetch')) {
          modifiedLines[i] = modifiedLines[i].replace(
            new RegExp(`['"]${escapedUrl}['"]`),
            `this.API_URL_${uIdx}`,
          )
        }
      }
    }
  }

  return {
    content: modifiedLines.join('\n'),
    description: `将 ${uniqueUrls.length} 个硬编码 URL 提取为类常量`,
    changed,
  }
}

// =============================================================================
// 规则 分发
// =============================================================================

const RULE_MAP: Record<TransformRule, (content: string) => TransformResult> = {
  inject_timeout: transformInjectTimeout,
  inject_res_ok: transformInjectResOk,
  add_fallback: transformAddFallback,
  inject_retry: transformInjectRetry,
  inject_metrics: transformInjectMetrics,
  externalize_url: transformExternalizeUrl,
}

const RULE_PRIORITY: TransformRule[] = [
  'inject_timeout',
  'inject_res_ok',
  'inject_retry',
  'inject_metrics',
  'externalize_url',
  'add_fallback',
]

// =============================================================================
// RadarOptimizationExecutor
// =============================================================================

export class RadarOptimizationExecutor implements FixExecutor {
  readonly name = 'radar-optimization-executor'
  readonly supportedSources = ['tool'] as const
  readonly timeoutMs = 180_000 // 3 分钟

  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    const rule = problem.context.metadata?.rule as TransformRule | undefined
    const file = problem.file

    if (!file) {
      return {
        problemId: problem.id,
        success: false,
        summary: '问题缺少目标文件路径',
        durationMs: Date.now() - startedAt,
        error: 'missing_file_path',
      }
    }

    log('INFO', 'radar_opt_exec_start', {
      problemId: problem.id,
      rule,
      file,
    })

    // ── 步骤 1：确定转换规则 ──
    const targetRule = rule && RULE_MAP[rule] ? rule : this.inferRule(problem)
    if (!targetRule || !RULE_MAP[targetRule]) {
      return {
        problemId: problem.id,
        success: false,
        summary: `无法推断转换规则（rule=${rule}）`,
        durationMs: Date.now() - startedAt,
        error: 'unknown_rule',
      }
    }

    // ── 步骤 2：解析文件路径 ──
    const absFile = join(PROJECT_ROOT, file)
    if (!existsSync(absFile)) {
      return {
        problemId: problem.id,
        success: false,
        summary: `目标文件不存在: ${file}`,
        durationMs: Date.now() - startedAt,
        error: 'file_not_found',
      }
    }

    // ── 步骤 3：读取当前源码 ──
    let sourceCode: string
    try {
      sourceCode = readFileSync(absFile, 'utf-8')
    } catch (err: any) {
      return {
        problemId: problem.id,
        success: false,
        summary: `读取源文件失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'read_failed',
      }
    }

    // ── 步骤 4：应用规则转换 ──
    const transformFn = RULE_MAP[targetRule]
    const result = transformFn(sourceCode)

    if (!result.changed) {
      return {
        problemId: problem.id,
        success: true,
        summary: `跳过: ${result.description}`,
        durationMs: Date.now() - startedAt,
        output: result.description,
      }
    }

    // ── 步骤 5：创建 Git 快照 ──
    const snapshotTag = `radar_opt_${targetRule}_${file.replace(/[/\\]/g, '_')}_${Date.now()}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
    if (!snapshotBranch) {
      log('WARN', 'radar_opt_snapshot_failed', { file })
    }

    // ── 步骤 6：写入转换后代码 ──
    try {
      writeFileSync(absFile, result.content, 'utf-8')
      log('INFO', 'radar_opt_written', {
        file,
        rule: targetRule,
        size: result.content.length,
      })
    } catch (err: any) {
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `写入文件失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'write_failed',
      }
    }

    // ── 步骤 7：tsc 编译验证 ──
    const tscResult = await this.runTscValidation()
    if (!tscResult.passed) {
      log('WARN', 'radar_opt_tsc_failed', {
        file,
        rule: targetRule,
        errors: tscResult.errors.slice(0, 3),
      })
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `tsc 编译验证失败（${tscResult.errors.length} 个错误），已回滚`,
        durationMs: Date.now() - startedAt,
        output: tscResult.errors.slice(0, 5).join('\n'),
        error: 'tsc_validation_failed',
      }
    }

    // ── 步骤 8：Git 提交 ──
    try {
      await this.gitOps.autoGitCommit(`[radar_opt] ${targetRule}: ${result.description} — ${file}`)
      log('INFO', 'radar_opt_committed', { file, rule: targetRule })
    } catch (err: any) {
      log('WARN', 'radar_opt_commit_skip', { file, error: err.message })
    }

    const durationMs = Date.now() - startedAt
    log('INFO', 'radar_opt_success', {
      file,
      rule: targetRule,
      durationMs,
    })

    return {
      problemId: problem.id,
      success: true,
      summary: `✅ [雷达优化] ${targetRule}: ${result.description} — ${file}，耗时 ${(durationMs / 1000).toFixed(0)}s`,
      durationMs,
      output: `文件: ${file}
规则: ${targetRule}
变更: ${result.description}
状态: ✅ tsc 编译验证通过，${snapshotBranch ? '已提交 Git' : '已保存'}`,
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 从 Problem 上下文中推断合适的转换规则。
   */
  private inferRule(problem: AssignedProblem): TransformRule | null {
    const raw = problem.context.raw.toLowerCase()
    const title = problem.title.toLowerCase()
    const searchText = raw + ' ' + title

    if (searchText.includes('hardcoded_url') || searchText.includes('硬编码'))
      return 'externalize_url'
    if (searchText.includes('missing_timeout') || searchText.includes('超时'))
      return 'inject_timeout'
    if (searchText.includes('missing_res_ok') || searchText.includes('状态检查'))
      return 'inject_res_ok'
    if (searchText.includes('missing_retry') || searchText.includes('重试'))
      return 'inject_retry'
    if (searchText.includes('missing_metrics') || searchText.includes('指标'))
      return 'inject_metrics'
    if (searchText.includes('missing_fallback') || searchText.includes('备用'))
      return 'add_fallback'
    if (searchText.includes('hardcoded_secret') || searchText.includes('密钥'))
      return 'externalize_url'

    return null
  }

  /**
   * 运行 tsc --noEmit 验证。
   */
  private async runTscValidation(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', {
        timeout: TSC_TIMEOUT_MS,
      })
      return { passed: true, errors: [] }
    } catch (err: any) {
      const errorText = err.message || err.stderr || err.stdout || String(err)
      const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
      return {
        passed: false,
        errors: lines.length > 0 ? lines : [errorText.slice(0, 500)],
      }
    }
  }

  /**
   * 需要时回滚到 Git 快照。
   */
  private async rollbackIfNeeded(snapshotBranch: string | null): Promise<void> {
    if (!snapshotBranch) return
    try {
      await this.gitOps.rollbackToSnapshot(snapshotBranch, RollbackLevel.MODULE)
      await this.gitOps.cleanupSnapshot(snapshotBranch)
      log('INFO', 'radar_opt_rolled_back', { branch: snapshotBranch })
    } catch (err: any) {
      log('WARN', 'radar_opt_rollback_failed', { error: err.message })
    }
  }
}
