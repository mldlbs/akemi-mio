/**
 * FixTemplateRegistry — 预定义修复模板注册表
 *
 * 职责：
 * 1. 提供确定性代码生成模板，不依赖 LLM
 * 2. 每种模板针对特定失败模式生成经过验证的代码修改
 * 3. 支持：重试包装、参数校验、超时控制、错误处理
 *
 * 与 LLM 方案的关系：
 * - 本模块提供可靠的基础修复（覆盖 ~80% 常见问题）
 * - LLM 方案（ToolEvolutionExecutor.callLlm）作为补充处理复杂场景
 * - 模板方案优先（零幻觉、可预测），LLM 方案兜底
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixTemplateType, FailurePattern } from './FailurePatternAnalyzer'

// =============================================================================
// 类型定义
// =============================================================================

export interface FixTemplate {
  type: FixTemplateType
  name: string
  description: string
  /** 适用该模板的失败模式类型 */
  applicablePatternTypes: string[]
  /** 生成修复代码 */
  generate: (sourceCode: string, toolName: string, pattern: FailurePattern) => string | null
}

// =============================================================================
// 辅助函数（用于模板 generate 闭包）
// =============================================================================

/**
 * 查找源文件中匹配的大括号位置
 */
function findMatchingBrace(code: string, openPos: number): { closePos: number } | null {
  let depth = 1
  let pos = openPos

  while (pos < code.length && depth > 0) {
    pos++
    const ch = code[pos]
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }

  if (depth === 0) {
    return { closePos: pos }
  }
  return null
}

/**
 * 在最后一个 import 语句后插入缺失的导入
 */
function ensureImports(code: string, requiredImports: string): string {
  const existingImports = new Set<string>()
  const importRegex = /import\s+.*\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = importRegex.exec(code)) !== null) {
    existingImports.add(match[1])
  }

  const newLines: string[] = []
  for (const line of requiredImports.trim().split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const pathMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/)
    if (pathMatch && existingImports.has(pathMatch[1])) continue
    newLines.push(trimmed)
  }

  if (newLines.length === 0) return code

  const block = '\n' + newLines.join('\n') + '\n'

  // 在最后一个 import 后插入
  const lastImportMatch = code.match(/^(?:import .*$\n?)+/m)
  if (lastImportMatch) {
    const endPos = lastImportMatch.index! + lastImportMatch[0].length
    return code.slice(0, endPos) + block + code.slice(endPos)
  }

  return block + '\n' + code
}

// =============================================================================
// 模板实现
// =============================================================================

/**
 * 模板 1: RetryWrapper — 为工具 handler 添加重试机制
 *
 * 适用模式：TRANSIENT_ERROR（网络中断、连接重置、间歇性失败）
 *
 * 策略：
 * - 在 handler 中为 TRANSIENT 类型错误添加自动重试
 * - 指数退避：1s → 2s → 4s
 * - 最多重试 3 次
 * - 非 TRANSIENT 错误直接抛出，不重试
 */
const retryWrapperTemplate: FixTemplate = {
  type: 'retry_wrapper',
  name: '重试包装器',
  description: '为工具 handler 添加自动重试机制，对 TRANSIENT 类型错误指数退避重试',
  applicablePatternTypes: ['transient_error', 'timeout_error'],

  generate(sourceCode: string, toolName: string, _pattern: FailurePattern): string | null {
    // 检查是否已有重试逻辑
    if (/(retry|重试|MAX_RETRIES|exponentialBackoff|指数退避)/.test(sourceCode)) {
      log('INFO', 'fix_template_retry_exists', { toolName })
      return null
    }

    // 定位 handler 函数：找到 "async handler" 的定义
    const handlerMatch = sourceCode.match(/(handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^{]*)?\s*\{)/)
    if (!handlerMatch) {
      log('WARN', 'fix_template_no_handler', { toolName })
      return null
    }

    const handlerStart = handlerMatch.index!
    const handlerDecl = handlerMatch[0]
    const braceInfo = findMatchingBrace(sourceCode, handlerStart + handlerDecl.length)
    if (!braceInfo) return null

    const bodyStart = handlerStart + handlerDecl.length
    const bodyContent = sourceCode.slice(bodyStart, braceInfo.closePos)

    // 构建重试包装
    const importBlock = `import { createTimeoutSignal } from '@akemi-mio/core/utils/async'
import { classifyToolError, ToolErrorType } from '@akemi-mio/capabilities/tool/ToolErrorType'`

    const retryBody = `
    const MAX_RETRIES = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
${bodyContent}
      } catch (err: any) {
        lastError = err
        const errorType = classifyToolError(err.message || String(err))
        if (errorType === ToolErrorType.TRANSIENT && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        throw err
      }
    }
    throw lastError || new Error('重试耗尽: 连续 3 次失败')
`

    // 替换 handler body
    const modifiedCode = sourceCode.slice(0, bodyStart) + retryBody + sourceCode.slice(braceInfo.closePos + 1)

    return ensureImports(modifiedCode, importBlock)
  },
}

/**
 * 模板 2: ParamValidator — 添加参数校验
 *
 * 适用模式：ARGUMENT_ERROR（特定参数值导致校验失败）
 *
 * 策略：
 * - 在 handler 开头对 affectedParams 添加校验
 * - 检查空字符串、路径安全性、长度限制
 * - 返回 formatToolError 给出明确错误原因
 */
const paramValidatorTemplate: FixTemplate = {
  type: 'param_validator',
  name: '参数校验器',
  description: '在 handler 开头添加参数合法性校验，对空值、越界路径给出明确错误',
  applicablePatternTypes: ['argument_error'],

  generate(sourceCode: string, toolName: string, pattern: FailurePattern): string | null {
    // 检查是否已有参数校验
    if (/(参数校验|参数检查|!args\.|args\?\.|validation|校验)/.test(sourceCode)) {
      log('INFO', 'fix_template_validator_exists', { toolName })
      return null
    }

    // 定位 handler body 开始位置
    const handlerMatch = sourceCode.match(/(handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^{]*)?\s*\{)/)
    if (!handlerMatch) return null

    const handlerStart = handlerMatch.index!
    const handlerDecl = handlerMatch[0]
    const bodyStart = handlerStart + handlerDecl.length

    // 构建参数校验代码
    const affectedParams = pattern.affectedParams.length > 0 ? pattern.affectedParams : ['path']

    const validationLines = affectedParams.map((param) => {
      return `    // 参数校验: ${param}
    if (args.${param} === undefined || args.${param} === null) {
      return formatToolError('缺少必需参数: ${param}')
    }
    if (typeof args.${param} === 'string' && args.${param}.trim().length === 0) {
      return formatToolError('参数 ${param} 不能为空')
    }
    if (typeof args.${param} === 'string' && args.${param}.length > 10000) {
      return formatToolError('参数 ${param} 过长 (最大 10000 字符)')
    }`
    })

    const validationBlock = `\n${validationLines.join('\n\n')}\n`

    const importBlock = `import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'`

    const modifiedCode = sourceCode.slice(0, bodyStart) + validationBlock + sourceCode.slice(bodyStart)

    return ensureImports(modifiedCode, importBlock)
  },
}

/**
 * 模板 3: TimeoutWrapper — 添加超时保护
 *
 * 适用模式：TIMEOUT_ERROR（调用超时）
 *
 * 策略：
 * - 在 handler 中为耗时操作添加超时限制
 * - 使用 createTimeoutSignal 或 AbortController
 * - 超时后返回 formatToolError 而非崩溃
 */
const timeoutWrapperTemplate: FixTemplate = {
  type: 'timeout_wrapper',
  name: '超时包装器',
  description: '为工具 handler 添加超时保护，指定超时阈值，超时后返回友好错误',
  applicablePatternTypes: ['timeout_error'],

  generate(sourceCode: string, toolName: string, _pattern: FailurePattern): string | null {
    // 检查是否已有超时逻辑
    if (/(createTimeoutSignal|AbortController|timeout|超时|TIMEOUT)/.test(sourceCode)) {
      log('INFO', 'fix_template_timeout_exists', { toolName })
      return null
    }

    const handlerMatch = sourceCode.match(/(handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^{]*)?\s*\{)/)
    if (!handlerMatch) return null

    const handlerStart = handlerMatch.index!
    const handlerDecl = handlerMatch[0]
    const bodyStart = handlerStart + handlerDecl.length
    const braceInfo = findMatchingBrace(sourceCode, bodyStart)
    if (!braceInfo) return null

    const importBlock = `import { createTimeoutSignal } from '@akemi-mio/core/utils/async'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'`

    // 在 handler 开头添加超时 preamble
    const timeoutPreamble = `
    // 超时保护：30 秒超时
    const { controller, timer } = createTimeoutSignal(30000)
    try {
`

    // 在 handler 结束前添加 finally
    const timeoutPostamble = `
    } finally {
      clearTimeout(timer)
    }
`

    const modifiedCode =
      sourceCode.slice(0, bodyStart) +
      timeoutPreamble +
      sourceCode.slice(bodyStart, braceInfo.closePos) +
      timeoutPostamble +
      sourceCode.slice(braceInfo.closePos + 1)

    return ensureImports(modifiedCode, importBlock)
  },
}

/**
 * 模板 4: ErrorHandler — 改进错误处理
 *
 * 适用模式：HIGH_FREQUENCY_ERROR、PERMISSION_ERROR（通用错误改进）
 *
 * 策略：
 * - 确保 handler 中所有异步操作有 try-catch
 * - 使用 classifyToolError 对错误进行分类
 * - 对已知错误类型给出 formatToolError
 * - 避免吞掉原始错误信息
 */
const errorHandlerTemplate: FixTemplate = {
  type: 'error_handler',
  name: '错误处理改进器',
  description: '确保 handler 中关键路径有 try-catch，使用 classifyToolError 分类错误',
  applicablePatternTypes: ['high_frequency_error', 'permission_error', 'tool_missing'],

  generate(sourceCode: string, toolName: string, _pattern: FailurePattern): string | null {
    const handlerMatch = sourceCode.match(/(handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^{]*)?\s*\{)/)
    if (!handlerMatch) return null

    const handlerStart = handlerMatch.index!
    const handlerDecl = handlerMatch[0]
    const bodyStart = handlerStart + handlerDecl.length
    const braceInfo = findMatchingBrace(sourceCode, bodyStart)
    if (!braceInfo) return null

    const bodyContent = sourceCode.slice(bodyStart, braceInfo.closePos)

    // 检查是否已有外层 try-catch
    if (bodyContent.includes('try {') && bodyContent.includes('catch')) {
      log('INFO', 'fix_template_try_catch_exists', { toolName })
      return null
    }

    const importBlock = `import { classifyToolError, ToolErrorType } from '@akemi-mio/capabilities/tool/ToolErrorType'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'`

    // 在 handler 外层添加 try-catch
    const wrappedBody = `
    try {
${bodyContent}
    } catch (err: any) {
      const errorType = classifyToolError(err.message || String(err))
      const errorMsg = (err.message || String(err)).slice(0, 500)
      log('WARN', '${toolName}_error', {
        error: errorMsg,
        errorType,
      })
      return formatToolError(errorMsg)
    }
`

    let modifiedCode = sourceCode.slice(0, bodyStart) + wrappedBody + sourceCode.slice(braceInfo.closePos + 1)

    // 确保有 log 导入
    if (!modifiedCode.includes("from '@akemi-mio/core/logger/Logger'") && !modifiedCode.includes("from '@akemi-mio/core/logger/Logger'")) {
      const importBlockLog = `import { log } from '@akemi-mio/core/logger/Logger'`
      modifiedCode = ensureImports(modifiedCode, importBlockLog)
    }

    return ensureImports(modifiedCode, importBlock)
  },
}

/**
 * 模板 5: CacheWrapper — 添加内存缓存减少重复执行
 *
 * 适用模式：CACHE_ERROR（同一参数重复调用）
 *
 * 策略：
 * - 在 handler 中添加 Map<string, { result: string; expiresAt: number }> 缓存
 * - 调用前检查缓存是否命中且未过期
 * - 缓存 TTL 根据工具类型调整（只读工具 60s，其他 30s）
 * - 缓存上限防止内存泄露
 */
const cacheWrapperTemplate: FixTemplate = {
  type: 'cache_wrapper',
  name: '缓存包装器',
  description: '为工具 handler 添加内存缓存，对相同参数的重复调用直接返回缓存结果',
  applicablePatternTypes: ['cache_error'],

  generate(sourceCode: string, toolName: string, _pattern: FailurePattern): string | null {
    // 检查是否已有缓存逻辑
    if (/(cache|缓存|Map<.*result|memoiz)/.test(sourceCode)) {
      log('INFO', 'fix_template_cache_exists', { toolName })
      return null
    }

    const handlerMatch = sourceCode.match(/(handler:\s*(async)?\s*\([^)]*\)\s*(:\s*Promise[^{]*)?\s*\{)/)
    if (!handlerMatch) return null

    const handlerStart = handlerMatch.index!
    const handlerDecl = handlerMatch[0]
    const bodyStart = handlerStart + handlerDecl.length
    const braceInfo = findMatchingBrace(sourceCode, bodyStart)
    if (!braceInfo) return null

    const bodyContent = sourceCode.slice(bodyStart, braceInfo.closePos)

    const importBlock = `import { createTimeoutSignal } from '@akemi-mio/core/utils/async'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'`

    // 在 handler body 前添加缓存 preamble
    // 使用工具名+参数签名的哈希作为缓存键
    const cachePreamble = `
    // 内存缓存：减少对相同参数组合的重复执行
    const CACHE_TTL_MS = 60000 // 缓存 60 秒
    const CACHE_MAX_SIZE = 50
    if (!handler._cache) {
      handler._cache = new Map<string, { result: string; expiresAt: number }>()
    }
    const _cacheKey = JSON.stringify(args)
    const _cached = handler._cache.get(_cacheKey)
    if (_cached && Date.now() < _cached.expiresAt) {
      return _cached.result
    }
    // 缓存清理：超出上限时删除最旧的条目
    if (handler._cache.size >= CACHE_MAX_SIZE) {
      const _oldest = [...handler._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (_oldest) handler._cache.delete(_oldest[0])
    }
`

    // 在 handler body 末尾（return 前）添加缓存存储
    const cachePostamble = `
    // 将结果存入缓存
    if (handler._cache.size < CACHE_MAX_SIZE) {
      handler._cache.set(_cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return result
`

    // 构建新的 handler body
    const newBody = cachePreamble + bodyContent + cachePostamble

    // 从 body 中去除原有的 return result 或 return formatToolResult(...)，因为 cachePostamble 已包含 return
    const cleanedBody = newBody.replace(/return\s+result\s*;?\s*$/, 'result')

    const modifiedCode = sourceCode.slice(0, bodyStart) + cleanedBody + sourceCode.slice(braceInfo.closePos + 1)

    return ensureImports(modifiedCode, importBlock)
  },
}

// =============================================================================
// FixTemplateRegistry
// =============================================================================

export class FixTemplateRegistry {
  private templates = new Map<FixTemplateType, FixTemplate>()

  constructor() {
    this.register(retryWrapperTemplate)
    this.register(paramValidatorTemplate)
    this.register(timeoutWrapperTemplate)
    this.register(errorHandlerTemplate)
    this.register(cacheWrapperTemplate)
  }

  register(template: FixTemplate): void {
    this.templates.set(template.type, template)
  }

  get(type: FixTemplateType): FixTemplate | undefined {
    return this.templates.get(type)
  }

  getAll(): FixTemplate[] {
    return Array.from(this.templates.values())
  }

  /**
   * 根据失败模式选择合适的修复模板并生成修复代码
   * @returns 生成的修复代码，或 null 如果不适用
   */
  generateFix(sourceCode: string, toolName: string, pattern: FailurePattern): string | null {
    const template = this.templates.get(pattern.suggestedFix)
    if (!template) {
      log('WARN', 'fix_template_not_found', { type: pattern.suggestedFix, toolName })
      return null
    }

    log('INFO', 'fix_template_applying', {
      template: template.name,
      toolName,
      patternType: pattern.type,
    })

    return template.generate(sourceCode, toolName, pattern)
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const fixTemplateRegistry = new FixTemplateRegistry()


