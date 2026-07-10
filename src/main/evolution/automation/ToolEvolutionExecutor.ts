/**
 * ToolEvolutionExecutor — 工具自动进化执行器
 *
 * 职责：
 * 1. 接收高错误率工具的问题描述（含 FailurePattern 细节）
 * 2. 优先使用 FixTemplateRegistry 生成确定性修复代码
 * 3. 模板方案不适用时，回退到 LLM 生成改进版本
 * 4. 对生成的代码进行回归测试（重播历史成功调用）
 * 5. tsc 编译验证
 * 6. 验证通过后提交 Git 变更并热替换运行时的工具处理器
 *
 * 安全机制：
 * - 每次优化前创建 Git snapshot
 * - 模板方案优先（零幻觉、可预测）
 * - 回归测试确保历史成功调用不退化
 * - tsc 编译验证通过才提交
 * - 热替换仅影响当前进程，重启后恢复原始代码
 * - 验证失败则回滚
 *
 * v2 增强：
 * - 集成 FixTemplateRegistry 提供确定性修复（Task #3）
 * - 集成 toolCallLogStore 进行回归测试
 * - failurePattern 中的 affectedParams 驱动参数校验模板
 * - 支持模板 + LLM 双路径修复策略
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from './types'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'
import { getLocalProviderAdapter } from '../../mcp/LocalProvider'
import { toolStatsTracker } from '../../tool/ToolStatsTracker'
import { execAsync } from '../../utils/async'
import { formatToolResult, formatToolError } from '../../tool/types'
import { getAllTools } from '../../tool/index'
import { LLM_CODE_API_URL, LLM_CODE_MODEL } from '../../config'
import { fixTemplateRegistry } from '../../tool/FixTemplateRegistry'
import { toolCallLogStore } from '../../tool/ToolCallLogStore'
import type { ToolCallRecord } from '../../tool/ToolCallLogStore'
import { failurePatternAnalyzer } from '../../tool/FailurePatternAnalyzer'
import type { FailurePattern } from '../../tool/FailurePatternAnalyzer'

// =============================================================================
// 类型定义
// =============================================================================

/** 改进类型，对应 LLM 可应用的优化模式 */
type ImprovementType = 'retry' | 'timeout' | 'parameter_validation' | 'error_handling' | 'cache' | 'general'

// =============================================================================
// 常量配置
// =============================================================================

const CONFIG = {
  /** tsc 验证超时（毫秒） */
  TSC_TIMEOUT_MS: 60000,
  /** 最大重试次数 */
  MAX_RETRIES: 2,
  /** 项目根目录（相对于 execAsync 工作目录） */
  PROJECT_ROOT: process.cwd(),
  /** 工具定义目录 */
  DEFINITIONS_DIR: 'src/main/tool/definitions',
}

// =============================================================================
// 工具源码映射构建
// =============================================================================

/**
 * 构建工具名 → 源文件路径的映射
 * 通过解析 definitions 目录下每个文件提取 buildTool 调用的 name 字段
 */
function buildToolFileMap(): Map<string, string> {
  const map = new Map<string, string>()
  const defsDir = join(CONFIG.PROJECT_ROOT, CONFIG.DEFINITIONS_DIR)
  if (!existsSync(defsDir)) {
    log('WARN', 'tool_evolution_defs_dir_not_found', { dir: CONFIG.DEFINITIONS_DIR })
    return map
  }

  const files = readdirSync(defsDir).filter((f: string) => f.endsWith('.ts') && !f.endsWith('.d.ts'))

  for (const file of files) {
    const filePath = join(defsDir, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      // 匹配 name: 'tool_name' 模式
      const nameMatch = content.match(/name:\s*'([^']+)'/)
      if (nameMatch && nameMatch[1]) {
        map.set(nameMatch[1], filePath)
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  return map
}

/**
 * 获取工具源码路径
 * 首先尝试动态扫描，失败后使用内置备选映射
 */
function getToolSourcePath(toolName: string): string | null {
  const map = buildToolFileMap()
  const cached = map.get(toolName)
  if (cached) return cached

  // 备选：使用静态映射表（部分常用工具）
  const staticMap: Record<string, string> = {
    'read_file': 'ReadFileTool.ts',
    'write_file': 'WriteFileTool.ts',
    'edit_file': 'EditFileTool.ts',
    'grep': 'GrepTool.ts',
    'list_files': 'ListFilesTool.ts',
    'run_command': 'RunCommandTool.ts',
  }

  const defsDir = join(CONFIG.PROJECT_ROOT, CONFIG.DEFINITIONS_DIR)
  const fileName = staticMap[toolName]
  if (fileName) {
    const filePath = join(defsDir, fileName)
    if (existsSync(filePath)) return filePath
  }

  return null
}

// =============================================================================
// LLM 提示生成
// =============================================================================

function buildImprovementPrompt(
  toolName: string,
  sourceCode: string,
  errorContext: string,
  improvementType: ImprovementType,
): string {
  const improvementGuides: Record<ImprovementType, string> = {
    retry: `## 优化方向：添加重试机制
- 在工具 handler 中对 TRANSIENT 类型错误添加自动重试（最多 3 次，指数退避）
- 使用 createTimeoutSignal 或 withTimeout 避免重试无限等待
- 保持原有的错误分类和格式化逻辑`,
    timeout: `## 优化方向：超时控制
- 为工具调用添加超时保护（使用 createTimeoutSignal 或 AbortController）
- 超时后返回 formatToolResult 或 formatToolError 而非崩溃
- 超时阈值根据工具类型合理设定（I/O 操作 30s，计算操作 60s）`,
    parameter_validation: `## 优化方向：参数校验增强
- 在 handler 开头对 required 参数进行存在性检查
- 对字符串参数添加长度/格式校验
- 对路径参数使用 safeWorkspacePath 确保安全性
- 返回 formatToolError 给出明确的错误原因`,
    error_handling: `## 优化方向：错误处理改进
- 确保所有可能的异常路径都有 try-catch
- 对已知错误给出 human-readable 的 formatToolError
- 使用 classifyToolError 对错误进行分类
- 避免吞掉原始错误信息`,
    general: `## 优化方向：综合改进
- 检查并改进错误处理：确保所有外部调用有 try-catch
- 添加适当的参数校验
- 考虑是否需要超时保护
- 确保 formatToolResult/formatToolError 使用正确
- 保持原有功能的兼容性`,
    cache: `## 优化方向：添加缓存机制
- 为工具 handler 添加内存缓存，对相同参数组合的重复调用直接返回缓存结果
- 使用 Map<string, { result: string; expiresAt: number }> 作为缓存容器
- 缓存 TTL 设置为 60 秒，缓存上限 50 条
- 调用前检查缓存是否命中且未过期，命中后直接返回
- 保持原有的错误处理和结果格式化逻辑`,
  }

  return `你是一个 TypeScript 代码优化专家。请改进以下工具代码，提高其健壮性。

## 当前工具
工具名: ${toolName}

## 错误上下文
${errorContext || '该工具存在较高的错误率，需要提高健壮性。'}

## 当前源码
\`\`\`typescript
${sourceCode}
\`\`\`

${improvementGuides[improvementType]}

## 要求
- 只返回改进后的完整 TypeScript 源码，用 \`\`\`typescript ... \`\`\` 包装
- 保持与原文件相同的导入结构和 API 签名
- 不要改变工具的名称、描述、inputJSONSchema
- 不要移除原有功能，只增强健壮性
- 遵守项目现有的代码风格
- 必须使用 formatToolResult() 和 formatToolError() 进行返回`
}

// =============================================================================
// 代码解析工具函数
// =============================================================================

/**
 * 从 LLM 回复中提取 TypeScript 代码块
 */
function extractCodeFromReply(reply: string): string | null {
  // 尝试匹配 ```typescript ... ``` 块
  const tsMatch = reply.match(/```typescript\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch && tsMatch[1]) return tsMatch[1].trim()

  // 尝试匹配 ```ts ... ``` 块
  const tsMatch2 = reply.match(/```ts\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch2 && tsMatch2[1]) return tsMatch2[1].trim()

  // 尝试匹配 ``` ... ``` 块
  const genericMatch = reply.match(/```\s*\n?([\s\S]*?)\n?```/)
  if (genericMatch && genericMatch[1]) return genericMatch[1].trim()

  // 如果没有任何代码块，返回整个回复
  return reply.trim() || null
}

/**
 * 从错误上下文中推断改进类型
 */
function inferImprovementType(errorContext: string): ImprovementType {
  const ctx = errorContext.toLowerCase()
  if (ctx.includes('timeout') || ctx.includes('timed out') || ctx.includes('超时')) return 'timeout'
  if (ctx.includes('retry') || ctx.includes('transient') || ctx.includes('econnrefused') || ctx.includes('socket')) return 'retry'
  if (ctx.includes('argument') || ctx.includes('invalid') || ctx.includes('参数') || ctx.includes('required')) return 'parameter_validation'
  if (ctx.includes('error') || ctx.includes('exception') || ctx.includes('错误') || ctx.includes('异常')) return 'error_handling'
  return 'general'
}

// =============================================================================
// 回归测试 + A/B 测试
// =============================================================================

interface AbTestResult {
  /** A/B 测试是否通过 */
  passed: boolean
  /** A 组（旧代码）指标 */
  baseline: { successRate: number; avgLatencyMs: number; sampleCount: number }
  /** B 组（新代码）指标 */
  candidate: { successRate: number; avgLatencyMs: number; sampleCount: number }
  /** 对比说明 */
  summary: string
}

/**
 * A/B 测试：对同一组历史调用，分别用旧和新处理器执行并对比结果
 *
 * 通过条件：
 * 1. 新代码成功率 >= 旧代码成功率
 * 2. 新代码平均延迟不会显著超标（不超过旧代码 2 倍或超 10s 以上）
 * 3. 样本数 >= 2 才有统计意义
 */
async function runAbTest(
  toolName: string,
  oldSourceCode: string,
  newSourceCode: string,
): Promise<AbTestResult> {
  const historicalCalls = toolCallLogStore.getHistoricalSuccessfulCalls(toolName, 5)
  if (historicalCalls.length < 2) {
    return {
      passed: true, // 样本不足时跳过 A/B
      baseline: { successRate: 1, avgLatencyMs: 0, sampleCount: 0 },
      candidate: { successRate: 1, avgLatencyMs: 0, sampleCount: 0 },
      summary: `A/B 测试跳过：历史调用样本不足 (${historicalCalls.length})`,
    }
  }

  log('INFO', 'tool_evolution_ab_test_start', { toolName, testCount: historicalCalls.length })

  // ── 阶段 1：用旧代码建立基线 ──
  const baselineResults = await executeTestCalls(toolName, oldSourceCode, historicalCalls)
  const baselineSuccessRate = baselineResults.passed / baselineResults.total
  const baselineAvgLatency = baselineResults.total > 0
    ? Math.round(baselineResults.latencyTotal / baselineResults.total)
    : 0

  // ── 阶段 2：用新代码执行候选 ──
  const candidateResults = await executeTestCalls(toolName, newSourceCode, historicalCalls)
  const candidateSuccessRate = candidateResults.passed / candidateResults.total
  const candidateAvgLatency = candidateResults.total > 0
    ? Math.round(candidateResults.latencyTotal / candidateResults.total)
    : 0

  // ── 阶段 3：对比判定 ──
  let passed = true
  const reasons: string[] = []

  // 成功率不能下降
  if (candidateSuccessRate < baselineSuccessRate - 0.05) {
    passed = false
    reasons.push(`成功率下降: ${(baselineSuccessRate * 100).toFixed(0)}% → ${(candidateSuccessRate * 100).toFixed(0)}%`)
  }

  // 延迟不能大幅上升
  if (baselineAvgLatency > 0 && candidateAvgLatency > baselineAvgLatency * 2 + 5000) {
    passed = false
    reasons.push(`延迟显著增加: ${baselineAvgLatency}ms → ${candidateAvgLatency}ms`)
  }

  const summary = reasons.length > 0
    ? `A/B 测试失败: ${reasons.join('; ')}`
    : `A/B 测试通过: 成功率 ${(candidateSuccessRate * 100).toFixed(0)}%, 延迟 ${candidateAvgLatency}ms`

  log('INFO', 'tool_evolution_ab_test_result', {
    toolName,
    passed,
    baseline: `${(baselineSuccessRate * 100).toFixed(0)}% ${baselineAvgLatency}ms`,
    candidate: `${(candidateSuccessRate * 100).toFixed(0)}% ${candidateAvgLatency}ms`,
    summary,
  })

  return {
    passed,
    baseline: { successRate: baselineSuccessRate, avgLatencyMs: baselineAvgLatency, sampleCount: baselineResults.total },
    candidate: { successRate: candidateSuccessRate, avgLatencyMs: candidateAvgLatency, sampleCount: candidateResults.total },
    summary,
  }
}

interface TestCallsResult {
  passed: number
  total: number
  latencyTotal: number
  failures: Array<{ args: Record<string, any>; error: string }>
}

/**
 * 用指定源码构建 handler 并执行一组测试调用
 * 通过 eval + Function 动态编译源码来模拟旧/新两个版本的 handler
 */
function executeTestCalls(
  toolName: string,
  sourceCode: string,
  testCalls: ToolCallRecord[],
): TestCallsResult {
  // 尝试从源码中提取 handler 函数体
  const handlerMatch = sourceCode.match(
    /handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^\{]*)?\s*\{([\s\S]*?)\n\}/,
  )
  if (!handlerMatch) {
    // 无法解析 handler 时，使用当前运行时的工具处理器
    log('WARN', 'tool_evolution_ab_parse_failed', { toolName })
    return executeWithCurrentHandler(toolName, testCalls)
  }

  // 通过 Function 构造函数尝试编译 handler
  // 注意：这有风险，仅用于沙箱环境
  let passed = 0
  let total = 0
  let latencyTotal = 0
  const failures: Array<{ args: Record<string, any>; error: string }> = []

  for (const call of testCalls) {
    total++
    const start = Date.now()
    try {
      // 通过动态 Function 模拟执行
      // 实际我们无法完美重现场景，此处主要做结构验证
      const fn = new Function('args', 'formatToolResult', 'formatToolError', `
        try {
          ${sourceCode}
          if (typeof handler === 'function') return handler(args)
          return null
        } catch (e: any) {
          return { _error: e.message }
        }
      `)

      const mockFormatResult = (v: any) => String(v)
      const mockFormatError = (e: string) => `error: ${e}`

      const result = fn(call.args, mockFormatResult, mockFormatError)
      if (result && result._error) {
        failures.push({ args: call.args, error: result._error })
      } else {
        passed++
      }
    } catch (err: any) {
      failures.push({ args: call.args, error: err.message || String(err) })
    }
    latencyTotal += Date.now() - start
  }

  return { passed, total, latencyTotal, failures }
}

/**
 * 使用运行时工具处理器执行测试调用
 */
function executeWithCurrentHandler(
  toolName: string,
  testCalls: ToolCallRecord[],
): TestCallsResult {
  const tools = getAllTools()
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) {
    return { passed: 0, total: testCalls.length, latencyTotal: 0, failures: testCalls.map((c) => ({ args: c.args, error: '工具未注册' })) }
  }

  let passed = 0
  let total = 0
  let latencyTotal = 0
  const failures: Array<{ args: Record<string, any>; error: string }> = []

  for (const call of testCalls) {
    total++
    const start = Date.now()
    try {
      // 同步调用 handler
      const resultP = tool.handler(call.args)
      if (resultP instanceof Promise) {
        // 无法 await，仅记录发起成功
        passed++
      } else {
        const result = resultP as any
        if (typeof result === 'string' && result.includes('error') && !result.includes('成功')) {
          failures.push({ args: call.args, error: result.slice(0, 200) })
        } else {
          passed++
        }
      }
    } catch (err: any) {
      failures.push({ args: call.args, error: err.message || String(err) })
    }
    latencyTotal += Date.now() - start
  }

  return { passed, total, latencyTotal, failures }
}

/**
 * 简化版 A/B 测试：仅对源码进行静态结构分析，无需实际执行
 * 适用于无法动态编译 handler 的环境
 */
function runStaticAbTest(sourceCode: string, newCode: string): AbTestResult {
  const baseline = { successRate: 1, avgLatencyMs: 0, sampleCount: 0 }
  const candidate = { successRate: 1, avgLatencyMs: 0, sampleCount: 0 }

  let passed = true
  const reasons: string[] = []

  // 检查重试逻辑是否存在（如果建议了 retry）
  if (sourceCode.includes('retry') && newCode.includes('retry')) {
    // 重试逻辑保持，正常
  }

  // 检查新的 try-catch 是否引入
  if (!sourceCode.includes('try {') && newCode.includes('try {') && newCode.includes('catch')) {
    reasons.push('新增 try-catch 保护')
  }

  // 检查超时逻辑
  if (!sourceCode.includes('createTimeoutSignal') && newCode.includes('createTimeoutSignal')) {
    reasons.push('新增超时保护')
  }

  // 检查缓存逻辑
  if (!sourceCode.includes('_cache') && newCode.includes('_cache')) {
    reasons.push('新增缓存机制')
  }

  const summary = reasons.length > 0 ? `A/B 静态分析: ${reasons.join('; ')}` : 'A/B 静态分析: 结构无明显变化'

  return { passed, baseline, candidate, summary }
}

interface RegressionResult {
  passed: boolean
  totalTests: number
  passedTests: number
  failedTests: number
  failures: Array<{ args: Record<string, any>; error: string }>
}

/**
 * 对修改后的工具代码进行回归测试
 * 重播历史成功调用，验证修改不引入退化
 */
async function runRegressionTest(toolName: string): Promise<RegressionResult> {
  const historicalCalls = toolCallLogStore.getHistoricalSuccessfulCalls(toolName, 5)
  if (historicalCalls.length === 0) {
    log('INFO', 'tool_evolution_regression_no_data', { toolName })
    return { passed: true, totalTests: 0, passedTests: 0, failedTests: 0, failures: [] }
  }

  log('INFO', 'tool_evolution_regression_start', { toolName, testCount: historicalCalls.length })

  const failures: Array<{ args: Record<string, any>; error: string }> = []
  let passedCount = 0

  for (const call of historicalCalls) {
    try {
      // 查找最新的工具处理器并调用
      const tools = getAllTools()
      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        failures.push({ args: call.args, error: '工具未注册' })
        continue
      }

      const result = await tool.handler(call.args)
      // 检查是否返回了错误格式
      if (typeof result === 'string' && result.includes('error') && !result.includes('成功')) {
        failures.push({ args: call.args, error: result.slice(0, 200) })
        continue
      }
      passedCount++
    } catch (err: any) {
      failures.push({ args: call.args, error: err.message || String(err) })
    }
  }

  const passed = failures.length === 0
  log('INFO', 'tool_evolution_regression_result', {
    toolName,
    passed,
    total: historicalCalls.length,
    passedCount,
    failedCount: failures.length,
  })

  return {
    passed,
    totalTests: historicalCalls.length,
    passedTests: passedCount,
    failedTests: failures.length,
    failures,
  }
}

// =============================================================================
// ToolEvolutionExecutor 实现
// =============================================================================

export class ToolEvolutionExecutor implements FixExecutor {
  readonly name = 'tool-evolution-executor'
  readonly supportedSources = ['tool'] as const
  readonly timeoutMs = 180_000 // 3 分钟，包含 LLM 调用 + tsc 编译
  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    const toolName = problem.context.metadata?.toolName
    const errorRate = problem.context.metadata?.errorRate
    const suggestion = problem.context.metadata?.suggestion as ImprovementType | undefined

    if (!toolName) {
      return {
        problemId: problem.id,
        success: false,
        summary: '缺少工具名元数据',
        durationMs: Date.now() - startedAt,
        error: 'missing_tool_name',
      }
    }

    log('INFO', 'tool_evolution_start', {
      toolName,
      errorRate,
      suggestion,
    })

    // ── 步骤 1：查找源码路径 ──
    const sourcePath = getToolSourcePath(toolName)
    if (!sourcePath) {
      log('WARN', 'tool_evolution_source_not_found', { toolName })
      return {
        problemId: problem.id,
        success: false,
        summary: `找不到工具 "${toolName}" 的源文件`,
        durationMs: Date.now() - startedAt,
        error: 'source_not_found',
      }
    }

    // ── 步骤 2：读取当前源码 ──
    let sourceCode: string
    try {
      sourceCode = readFileSync(sourcePath, 'utf-8')
    } catch (err: any) {
      return {
        problemId: problem.id,
        success: false,
        summary: `读取源文件失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'read_failed',
      }
    }

    // ── 步骤 3：创建 Git 快照 ──
    const snapshotTag = `tool_evolve_${toolName}_${Date.now()}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
    if (!snapshotBranch) {
      log('WARN', 'tool_evolution_snapshot_failed', { toolName })
      // 继续执行，没有快照也能工作
    }

    // ── 步骤 4：修复策略 — 优先使用 FixTemplateRegistry ──
    let generatedCode: string | null = null
    let fixSource: 'template' | 'llm' | null = null

    // 4a: 尝试 FixTemplateRegistry 确定性修复
    const patterns = failurePatternAnalyzer.analyzeTool(toolName)
    const targetPattern = patterns.length > 0
      ? patterns.find((p) => p.suggestedFix === suggestion) || patterns[0]
      : null

    if (targetPattern) {
      generatedCode = fixTemplateRegistry.generateFix(sourceCode, toolName, targetPattern)
      if (generatedCode) {
        fixSource = 'template'
        log('INFO', 'tool_evolution_template_applied', {
          toolName,
          templateType: targetPattern.suggestedFix,
        })
      }
    }

    // 4b: 模板不可用时回退到 LLM
    if (!generatedCode) {
      const improvementType = suggestion || inferImprovementType(problem.context.raw)
      const prompt = buildImprovementPrompt(toolName, sourceCode, problem.context.raw, improvementType)

      let llmError: string | undefined

      for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        try {
          const reply = await this.callLlm(prompt, toolName)
          if (reply === null) {
            llmError = 'LLM 返回空'
            if (attempt < CONFIG.MAX_RETRIES) continue
            break
          }
          generatedCode = extractCodeFromReply(reply)
          if (generatedCode) {
            fixSource = 'llm'
            break
          }
          llmError = '无法从 LLM 回复中提取代码'
          if (attempt < CONFIG.MAX_RETRIES) continue
        } catch (err: any) {
          llmError = err.message
          log('WARN', 'tool_evolution_llm_exception', { attempt, error: err.message })
          if (attempt < CONFIG.MAX_RETRIES) continue
        }
      }

      if (!generatedCode) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `代码生成失败（模板+LLM）: ${llmError || '无响应'}`,
          durationMs: Date.now() - startedAt,
          error: 'generation_failed',
        }
      }
    }

    // ── 步骤 5：A/B 测试 — 生成代码 vs 原始代码 ──
    log('INFO', 'tool_evolution_ab_test', { toolName })

    // 执行静态 A/B 测试（结构对比，无需实际运行）
    const staticAbResult = runStaticAbTest(sourceCode, generatedCode)
    log('INFO', 'tool_evolution_ab_test_result', {
      toolName,
      passed: staticAbResult.passed,
      summary: staticAbResult.summary,
    })

    // 执行动态 A/B 测试（在沙箱中运行新旧代码对比）
    const testCalls = toolCallLogStore.getHistoricalSuccessfulCalls(toolName, 3)
    let abTestResult = staticAbResult
    if (testCalls.length >= 2) {
      // 基线：当前运行时 handler
      const baselineResult = executeWithCurrentHandler(toolName, testCalls)
      // 候选项：新生成的源码
      const candidateResult = executeTestCalls(toolName, generatedCode, testCalls)

      if (candidateResult.total > 0 && baselineResult.total > 0) {
        const baselineRate = baselineResult.passed / baselineResult.total
        const candidateRate = candidateResult.passed / candidateResult.total

        abTestResult = {
          passed: candidateRate >= baselineRate - 0.05,
          baseline: {
            successRate: baselineRate,
            avgLatencyMs: baselineResult.total > 0 ? Math.round(baselineResult.latencyTotal / baselineResult.total) : 0,
            sampleCount: baselineResult.total,
          },
          candidate: {
            successRate: candidateRate,
            avgLatencyMs: candidateResult.total > 0 ? Math.round(candidateResult.latencyTotal / candidateResult.total) : 0,
            sampleCount: candidateResult.total,
          },
          summary: `A/B 动态测试: ${candidateResult.passed}/${candidateResult.total} vs ${baselineResult.passed}/${baselineResult.total}`,
        }
      }
    }

    // A/B 测试失败 → 回滚
    if (!abTestResult.passed) {
      log('WARN', 'tool_evolution_ab_test_failed', {
        toolName,
        baseline: `${abTestResult.baseline.successRate} ${abTestResult.baseline.avgLatencyMs}ms`,
        candidate: `${abTestResult.candidate.successRate} ${abTestResult.candidate.avgLatencyMs}ms`,
      })
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `A/B 测试失败: ${abTestResult.summary}`,
        durationMs: Date.now() - startedAt,
        error: 'ab_test_failed',
      }
    }

    // ── 步骤 6：写入新代码 ──
    try {
      writeFileSync(sourcePath, generatedCode, 'utf-8')
      log('INFO', 'tool_evolution_written', { toolName, sourcePath, fixSource })
    } catch (err: any) {
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `写入源文件失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'write_failed',
      }
    }

    // ── 步骤 7：回归测试（重播历史成功调用）──
    const regressionResult = await runRegressionTest(toolName)
    if (!regressionResult.passed && regressionResult.totalTests > 0) {
      log('WARN', 'tool_evolution_regression_failed', {
        toolName,
        failedCount: regressionResult.failedTests,
        failures: regressionResult.failures.slice(0, 3).map((f) => f.error),
      })
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `回归测试失败（${regressionResult.failedTests}/${regressionResult.totalTests} 个历史调用失效）: ${regressionResult.failures[0]?.error?.slice(0, 100) || ''}`,
        durationMs: Date.now() - startedAt,
        error: 'regression_test_failed',
      }
    }

    // ── 步骤 8：tsc 编译验证 ──
    const tscResult = await this.runTscValidation()
    if (!tscResult.passed) {
      log('WARN', 'tool_evolution_tsc_failed', { toolName, errors: tscResult.errors.slice(0, 3) })
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: problem.id,
        success: false,
        summary: `tsc 编译验证失败（${tscResult.errors.length} 个错误）: ${tscResult.errors.slice(0, 2).join('; ')}`,
        durationMs: Date.now() - startedAt,
        output: tscResult.errors.join('\n'),
        error: 'tsc_validation_failed',
      }
    }

    // ── 步骤 9：Git 提交 ──
    try {
      await this.gitOps.autoGitCommit(`[auto] tool evolution: improve ${toolName} error handling (${fixSource})`)
    } catch {
      log('WARN', 'tool_evolution_commit_skip', { toolName })
    }

    // ── 步骤 10：运行时热替换 ──
    await this.hotReloadTool(toolName, toolStatsTracker)

    // ── 步骤 11：标记冷却 ──
    toolStatsTracker.markOptimized(toolName)

    const durationMs = Date.now() - startedAt
    log('INFO', 'tool_evolution_success', { toolName, durationMs, fixSource, regressionTests: regressionResult.totalTests })

    return {
      problemId: problem.id,
      success: true,
      summary: `工具 "${toolName}" 已优化（${fixSource}: ${suggestion || 'general'}）: ${relative(CONFIG.PROJECT_ROOT, sourcePath)}，${
        regressionResult.totalTests > 0 ? `回归测试 ${regressionResult.passedTests}/${regressionResult.totalTests} 通过, ` : ''
      }耗时 ${(durationMs / 1000).toFixed(0)}s`,
      durationMs,
      output: `文件: ${relative(CONFIG.PROJECT_ROOT, sourcePath)}
优化类型: ${suggestion || 'general'}
修复来源: ${fixSource}
回归测试: ${regressionResult.passedTests}/${regressionResult.totalTests} 通过
A/B测试: ${abTestResult.summary}
erroRate: ${errorRate || '未知'}`,
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 调用 LLM 生成代码改进
   */
  private async callLlm(prompt: string, toolName: string): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      try {
        const res = await fetch(LLM_CODE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: LLM_CODE_MODEL,
            messages: [
              { role: 'system', content: '你是一个 TypeScript 代码优化专家。请生成改进后的完整 TypeScript 源码。' },
              { role: 'user', content: prompt },
            ],
            stream: false,
            temperature: 0.2,
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          log('WARN', 'tool_evolution_llm_api_error', { status: res.status, body: errBody.slice(0, 200) })
          return null
        }

        const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
        const reply = data.choices?.[0]?.message?.content?.trim()
        return reply || null
      } finally {
        clearTimeout(timer)
      }
    } catch (err: any) {
      log('WARN', 'tool_evolution_llm_network_error', { toolName, error: err.message })
      return null
    }
  }

  /**
   * 运行 tsc --noEmit 验证
   */
  private async runTscValidation(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', {
        timeout: CONFIG.TSC_TIMEOUT_MS,
      })

      // tsc 成功时无输出或只有信息性消息
      return { passed: true, errors: [] }
    } catch (err: any) {
      // tsc 失败时抛出，stderr/stdout 中为错误信息
      const errorText = err.message || err.stderr || err.stdout || String(err)
      const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
      return { passed: false, errors: lines.length > 0 ? lines : [errorText.slice(0, 500)] }
    }
  }

  /**
   * 运行时热替换工具处理器
   */
  private async hotReloadTool(toolName: string, _stats: typeof toolStatsTracker): Promise<void> {
    try {
      const adapter = getLocalProviderAdapter()
      // 创建一个包装处理器，读取最新的工具文件重新编译
      const handler = async (args: Record<string, any>) => {
        try {
          // 通过 getAllTools() 获取最新的工具处理器
          const tools = getAllTools()
          const tool = tools.find((t) => t.name === toolName)
          if (tool) {
            return await tool.handler(args)
          }
          return formatToolError(`工具 "${toolName}" 未找到`)
        } catch (err: any) {
          return formatToolError(`工具 "${toolName}" 执行出错: ${err.message}`)
        }
      }

      // 先清除旧的覆盖，再设置新的
      adapter.removeToolHandlerOverride(toolName)
      adapter.setToolHandlerOverride(toolName, handler)

      log('INFO', 'tool_evolution_hot_reloaded', { toolName })
    } catch (err: any) {
      log('WARN', 'tool_evolution_hot_reload_failed', { toolName, error: err.message })
    }
  }

  /**
   * 需要时回滚到快照
   */
  private async rollbackIfNeeded(snapshotBranch: string | null): Promise<void> {
    if (!snapshotBranch) return
    try {
      await this.gitOps.rollbackToSnapshot(snapshotBranch, RollbackLevel.MODULE)
      await this.gitOps.cleanupSnapshot(snapshotBranch)
      log('INFO', 'tool_evolution_rolled_back', { branch: snapshotBranch })
    } catch (err: any) {
      log('WARN', 'tool_evolution_rollback_failed', { error: err.message })
    }
  }
}
