/**
 * DynamicToolSandbox — 轻量级沙箱执行环境
 *
 * 使用 Node.js `vm` 模块为动态注册的工具提供隔离执行环境。
 * 通过限制全局对象、设置超时、阻断危险 API 来降低安全风险。
 *
 * ## 安全边界
 *
 * 此沙箱基于 `vm.Script.runInNewContext()`，提供基础隔离：
 * - 有限的全局对象（无 process、require、module）
 * - 可配置超时，防止无限循环
 * - 危险 API 黑名单检测（exec、spawn、child_process 等）
 * - 无文件系统访问（fs 模块）
 * - 无网络请求（除非显式授权）
 *
 * ⚠️ 注意：Node.js `vm` 模块不是完美沙箱。
 * 在涉及不可信代码的高安全场景中，应考虑进程级隔离
 * （子进程、Worker Threads 或 Docker 容器）。
 *
 * ## 与 ToolGeneratorService 的关系
 *
 * ToolGeneratorService 使用 `new Function()` 直接执行生成代码，
 * 无任何隔离。此沙箱旨在替代那种直接执行方式，
 * 为所有动态注册工具提供统一的安全层。
 */

import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 类型定义
// =============================================================================

/** 沙箱执行配置 */
export interface SandboxConfig {
  /** 执行超时（毫秒），默认 15000 */
  timeoutMs: number
  /** 允许的内存上限，仅用于文档（实际由 OS 管理） */
  memoryLimitMb?: number
  /** 是否允许使用 fetch/网络请求 */
  allowNetwork: boolean
  /** 是否允许访问文件系统 API */
  allowFileSystem: boolean
  /** 额外允许的全局 API（如 Math, JSON 等始终可用） */
  extraGlobals?: string[]
}

/** 沙箱执行结果 */
export interface SandboxResult {
  success: boolean
  /** 返回值（JSON 序列化后的字符串） */
  value: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 错误信息（失败时） */
  error?: string
  /** script 中 console.log 捕获的输出 */
  consoleOutput: string[]
}

/** 默认沙箱配置 */
const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 15_000,
  allowNetwork: false,
  allowFileSystem: false,
}

// =============================================================================
// 安全检查：检测 handler 代码中的危险模式
// =============================================================================

/** 危险 API 黑名单（正则表达式列表） */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brequire\s*\(/g, description: 'require() 调用' },
  { pattern: /\bimport\s*\(/g, description: '动态 import() 调用（默认禁用）' },
  { pattern: /__dirname/g, description: '__dirname 访问' },
  { pattern: /__filename/g, description: '__filename 访问' },
  { pattern: /\bprocess\b/g, description: 'process 全局对象' },
  { pattern: /\bglobal\b/g, description: 'global 对象访问' },
  { pattern: /child_process/g, description: '子进程模块' },
  { pattern: /\.exec\s*\(/g, description: 'exec() 调用' },
  { pattern: /\.spawn\s*\(/g, description: 'spawn() 调用' },
  { pattern: /\.fork\s*\(/g, description: 'fork() 调用' },
  { pattern: /\.execFile\s*\(/g, description: 'execFile() 调用' },
  { pattern: /new Function\s*\(/g, description: 'new Function() 动态创建函数' },
  { pattern: /eval\s*\(/g, description: 'eval() 调用' },
  { pattern: /vm\./g, description: 'vm 模块访问' },
  { pattern: /\bWorker\b/g, description: 'Worker 线程创建' },
  { pattern: /Reflect\./g, description: 'Reflect API（用于绕过限制）' },
]

/** 文件系统访问模式（仅当 allowFileSystem=false 时检查） */
const FS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /['"]fs['"]/g, description: 'fs 模块引用' },
  { pattern: /readFileSync|writeFileSync|readdirSync|mkdirSync|unlinkSync|rmSync/g, description: '文件系统同步操作' },
  { pattern: /readFile|writeFile|readdir|mkdir|unlink|rm/g, description: '文件系统异步操作' },
  { pattern: /createReadStream|createWriteStream/g, description: '文件流操作' },
  { pattern: /accessSync|statSync|lstatSync/g, description: '文件状态查询' },
]

/** 网络访问模式（仅当 allowNetwork=false 时检查） */
const NETWORK_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\bfetch\s*\(/g, description: 'fetch() 网络请求' },
  { pattern: /XMLHttpRequest/g, description: 'XMLHttpRequest 网络请求' },
  { pattern: /WebSocket/g, description: 'WebSocket 连接' },
  { pattern: /\.listen\s*\(/g, description: '网络监听' },
  { pattern: /createServer/g, description: '创建 HTTP 服务器' },
  { pattern: /net\./g, description: 'net 模块' },
  { pattern: /http\./g, description: 'http 模块' },
  { pattern: /https\./g, description: 'https 模块' },
  { pattern: /dgram\./g, description: 'dgram 模块' },
]

/**
 * 检查 handler 代码中的危险模式。
 * 返回所有匹配的危险模式列表，空数组表示安全。
 */
export function checkHandlerSafety(code: string, config: Partial<SandboxConfig> = {}): Array<{ pattern: RegExp; description: string }> {
  const violations: Array<{ pattern: RegExp; description: string }> = []
  const merged = { ...DEFAULT_CONFIG, ...config }

  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(code)) {
      violations.push(item)
    }
  }

  if (!merged.allowFileSystem) {
    for (const item of FS_PATTERNS) {
      if (item.pattern.test(code)) {
        violations.push(item)
      }
    }
  }

  if (!merged.allowNetwork) {
    for (const item of NETWORK_PATTERNS) {
      if (item.pattern.test(code)) {
        violations.push(item)
      }
    }
  }

  return violations
}

// =============================================================================
// 沙箱上下文构建
// =============================================================================

/**
 * 构建安全的沙箱全局上下文。
 * 仅暴露安全的全局 API，阻断危险对象。
 */
function buildSandboxContext(config: SandboxConfig): Record<string, any> {
  const consoleLogs: string[] = []

  const ctx: Record<string, any> = {
    // ── 安全的全局对象 ──
    console: {
      log: (...args: any[]) => {
        consoleLogs.push(args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
      },
      warn: (...args: any[]) => {
        consoleLogs.push('[WARN] ' + args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
      },
      error: (...args: any[]) => {
        consoleLogs.push('[ERROR] ' + args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
      },
    },
    JSON: JSON,
    Math: Math,
    Date: Date,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    WeakSet: WeakSet,
    Promise: Promise,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    SyntaxError: SyntaxError,
    ReferenceError: ReferenceError,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    isFinite: isFinite,
    encodeURI: encodeURI,
    encodeURIComponent: encodeURIComponent,
    decodeURI: decodeURI,
    decodeURIComponent: decodeURIComponent,
    ArrayBuffer: ArrayBuffer,
    Uint8Array: Uint8Array,
    Uint16Array: Uint16Array,
    Uint32Array: Uint32Array,
    Int8Array: Int8Array,
    Int16Array: Int16Array,
    Int32Array: Int32Array,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    DataView: DataView,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    // ── 安全的定时器（有限制） ──
    setTimeout: (fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
      return setTimeout(fn, Math.min(ms, 5000), ...args) // 限制最大 5s
    },
    clearTimeout: clearTimeout,
    setInterval: setInterval, // 可用但需注意泄漏
    clearInterval: clearInterval,
    // ── 安全的 URL 工具 ──
    URL: URL,
    URLSearchParams: URLSearchParams,
    // ── 文件系统（根据配置） ──
    ...(config.allowFileSystem
      ? {}
      : {
          // 默认阻止文件系统 API 引用
        }),
    // ── 网络（根据配置） ──
    ...(config.allowNetwork
      ? {
          fetch: fetch,
        }
      : {}),
  }

  // 沙箱内部存储 console 输出
  ;(ctx as any).__consoleOutputs = consoleLogs

  return ctx
}

// =============================================================================
// 沙箱执行
// =============================================================================

/**
 * 在沙箱中执行一段 JavaScript 代码。
 *
 * @param code 要执行的 JavaScript 代码字符串
 * @param context 额外注入沙箱的上下文变量
 * @param config 沙箱执行配置
 * @returns 执行结果
 */
export async function executeInSandbox(
  code: string,
  context: Record<string, any> = {},
  config: Partial<SandboxConfig> = {},
): Promise<SandboxResult> {
  const startedAt = Date.now()
  const merged: SandboxConfig = { ...DEFAULT_CONFIG, ...config }

  // 1. 安全检查
  const violations = checkHandlerSafety(code, merged)
  if (violations.length > 0) {
    const descs = violations.map((v) => v.description).join(', ')
    log('WARN', 'dynamic_tool_sandbox_violation', { violations: descs })
    return {
      success: false,
      value: '',
      durationMs: Date.now() - startedAt,
      error: `代码安全检查未通过：检测到危险 API (${descs})`,
      consoleOutput: [],
    }
  }

  // 2. 构建沙箱上下文
  const sandboxCtx = buildSandboxContext(merged)

  // 注入调用方提供的上下文
  for (const [key, value] of Object.entries(context)) {
    // 不允许覆盖沙箱内置对象
    if (key in sandboxCtx && key !== '__consoleOutputs') {
      log('WARN', 'dynamic_tool_sandbox_context_conflict', { key })
      continue
    }
    sandboxCtx[key] = value
  }

  // 3. 使用 vm 模块执行
  try {
    // 动态导入 vm（仅在需要时加载）
    const vm = await import('vm')

    // 包装代码为异步函数，确保支持 await
    const wrappedCode = `
      (async () => {
        ${code}
      })()
    `

    const script = new vm.Script(wrappedCode, {
      filename: 'dynamic-tool-sandbox',
    })

    const result = await script.runInNewContext(sandboxCtx, {
      timeout: merged.timeoutMs,
      breakOnSigint: true,
    })

    const durationMs = Date.now() - startedAt
    const consoleOutput = (sandboxCtx as any).__consoleOutputs || []

    log('DEBUG', 'dynamic_tool_sandbox_executed', {
      durationMs,
      consoleLines: consoleOutput.length,
    })

    return {
      success: true,
      value: result !== undefined ? (typeof result === 'string' ? result : JSON.stringify(result)) : '',
      durationMs,
      consoleOutput,
    }
  } catch (err: any) {
    const durationMs = Date.now() - startedAt
    const consoleOutput = (sandboxCtx as any).__consoleOutputs || []

    log('WARN', 'dynamic_tool_sandbox_error', {
      error: err.message,
      durationMs,
    })

    return {
      success: false,
      value: '',
      durationMs,
      error: err.message || String(err),
      consoleOutput,
    }
  }
}

// =============================================================================
// 导出
// =============================================================================

export const dynamicToolSandbox = {
  executeInSandbox,
  checkHandlerSafety,
}
