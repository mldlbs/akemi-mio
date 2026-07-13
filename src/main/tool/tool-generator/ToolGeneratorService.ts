/**
 * ToolGeneratorService — 自进化工具生成服务
 *
 * 输入：自然语言描述的用户需求
 * 输出：已注册到 MCP 框架的新工具
 *
 * 流程：
 * 1. generateSpec() — LLM 将需求转化为工具规格（名、描述、I/O Schema）
 * 2. generateCode() — LLM 根据规格生成 TS 源码 + JS handler body
 * 3. writeSourceFile() — 将 TS 源码写入 WORKSPACE 下的独立文件
 * 4. validateTsc() — 运行 tsc --noEmit 验证编译通过
 * 5. registerTool() — 通过 LocalProviderAdapter 注册到运行时
 *
 * 运行时注册策略：
 * - LLM 同时生成 TypeScript 源文件（存盘）和纯 JavaScript handler 体（`new Function` 执行）
 * - JS handler 体不含类型注解，使用项目已有的 Node.js 内置模块
 * - handler 通过动态 `import()` 获取 formatToolResult/formatToolError
 *
 * 安全设计：
 * - 生成的文件存储在隔离目录（WORKSPACE.evolution/generated_tools/）
 * - 注册前必须通过 tsc 编译验证
 * - 安全模式支持 review（仅生成不注册）
 * - 所有生成代码记录日志供审计
 * - 以独立的 provider 名称注册，便于管理/注销
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE, LLM_CODE_API_URL, LLM_CODE_MODEL, LLM_KEY } from '../../config'
import { getLocalProviderAdapter } from '../../mcp/LocalProvider'
import { execAsync } from '../../utils/async'
import type { MCPToolResult } from '../../mcp/types'
import type {
  ToolSpec,
  GeneratedTool,
  GenerateToolRequest,
  GenerateToolResult,
  GeneratorProgress,
  LlmToolSpecResponse,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 生成工具文件存储目录 */
const GENERATED_TOOLS_DIR = join(WORKSPACE.evolution, 'generated_tools')

/** 动态工具提供者名称前缀 */
const DYNAMIC_PROVIDER_PREFIX = '@dynamic/'

/** LLM 调用超时（毫秒） */
const LLM_TIMEOUT_MS = 120_000

/** tsc 验证超时（毫秒） */
const TSC_TIMEOUT_MS = 60_000

/** 最大并发生成任务数 */
const MAX_CONCURRENT_GENERATIONS = 3

// =============================================================================
// LLM 提示模板
// =============================================================================

const SPEC_GENERATION_SYSTEM_PROMPT = `你是一个工具设计专家。请根据用户描述的需求，设计一个新的 MCP 工具规格。

要求：
- 工具名使用 snake_case，如 get_weather、send_notification
- 输入 Schema 使用 JSON Schema 格式
- 工具描述简洁明了（一句话）
- 只返回 JSON，不要任何额外文字

输出格式（严格 JSON，不要 markdown）：
{
  "name": "工具名",
  "description": "工具描述",
  "inputSchema": {
    "properties": {
      "param1": { "type": "string", "description": "参数说明" }
    },
    "required": ["param1"]
  }
}`

const CODE_GENERATION_SYSTEM_PROMPT = `你是一个 TypeScript 工具实现专家。请根据工具规格生成工具实现。

**你需要生成两部分，用 ===SPLIT=== 分隔：**

## 第一部分：TypeScript 源文件

完整的工具定义文件，使用 buildTool() 工厂函数。遵循项目的标准代码风格。
- 从 '../types' 导入 { buildTool, formatToolResult, formatToolError }
- handler 签名: handler: async (args: { ... }) => { ... }
- 用 try-catch 包装所有逻辑
- 只使用 Node.js 内置模块 (fs, path 等) 或项目已有模块
- 不要使用外部 npm 包 (axios, node-fetch 等)

## 第二部分：纯 JavaScript handler 体

一段可以在 \`new Function()\` 中执行的纯 JavaScript 代码。
- 不能有任何 TypeScript 类型注解
- handler 接收参数: (args, formatResult, formatError) => { ... }
- 使用 const { module } = await import('module') 获取 Node.js 内置模块
- 通过 await import('../types') 获取工具函数
- 不要使用 require()
- 这是一个 async 函数体

## 输出格式

第一部分用 \`\`\`typescript ... \`\`\` 包裹。
第二部分用 \`\`\`javascript ... \`\`\` 包裹。
两部分之间用 ===SPLIT=== 分隔。

可用的模块导入（JavaScript handler 中通过 await import()）：
- '{ readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync }' from 'fs'
- '{ join, resolve, relative, dirname, basename, extname }' from 'path'
- '{ execAsync }' from '../../utils/async'
- '{ log }' from '../../logger/Logger'`

// =============================================================================
// 代码提取工具
// =============================================================================

/** 从 LLM 回复中提取 TypeScript 代码块 */
function extractTsCode(reply: string): string | null {
  const m = reply.match(/```typescript\s*\n?([\s\S]*?)\n?```/)
  if (m?.[1]?.trim()) return m[1].trim()
  const m2 = reply.match(/```ts\s*\n?([\s\S]*?)\n?```/)
  if (m2?.[1]?.trim()) return m2[1].trim()
  return null
}

/** 从 LLM 回复中提取 JavaScript 代码块 */
function extractJsCode(reply: string): string | null {
  const m = reply.match(/```javascript\s*\n?([\s\S]*?)\n?```/)
  if (m?.[1]?.trim()) return m[1].trim()
  const m2 = reply.match(/```js\s*\n?([\s\S]*?)\n?```/)
  if (m2?.[1]?.trim()) return m2[1].trim()
  return null
}

// =============================================================================
// JS handler 模板（兜底 — LLM 未提供 JS 体时使用）
// =============================================================================

/**
 * 当 LLM 未生成纯 JS handler 体时，使用此兜底策略：
 * 从 TS 源码中提取 handler 函数体内容，去除类型注解后构造 JS handler。
 */
function fallbackJsHandler(spec: ToolSpec): string {
  // 从 TypeScript 源码中提取 handler 函数体
  const source = spec.sourceCode
  // 匹配 handler: async (...) => { ... } 或 handler: function(...) { ... }
  const handlerMatch = source.match(/handler:\s*(async\s*)?(\([^)]*\))\s*(:\s*[^{]+)?\s*=>\s*\{([\s\S]*?)\n\s*\}/)
  if (handlerMatch) {
    const body = handlerMatch[4]
    return `const { formatToolResult, formatToolError } = await import('../types');
${body}`
  }

  // 兜底：简单的返回错误
  return `const { formatToolResult, formatToolError } = await import('../types');
return formatToolResult('工具 "${spec.name}" 已生成，但 handler 体提取失败。请查看源文件：${spec.name}.ts');`
}

// =============================================================================
// ToolGeneratorService
// =============================================================================

export class ToolGeneratorService {
  /** 当前进行中的生成任务数 */
  private activeGenerations = 0

  /** 已生成的工具记录（内存中） */
  private generatedTools = new Map<string, GeneratedTool>()

  /** 生成目录是否已初始化 */
  private dirInitialized = false

  /**
   * 检查服务是否可接受新的生成请求
   */
  canAccept(): boolean {
    return this.activeGenerations < MAX_CONCURRENT_GENERATIONS
  }

  /**
   * 完整流程：生成 → 验证 → 注册新工具
   */
  async generateTool(
    request: GenerateToolRequest,
    onProgress?: (progress: GeneratorProgress) => void,
  ): Promise<GenerateToolResult> {
    this.activeGenerations++
    const logs: string[] = []
    const startedAt = Date.now()

    const emit = (phase: GeneratorProgress['phase'], message: string) => {
      logs.push(`[${phase}] ${message}`)
      log('INFO', `tool_generator_${phase}`, { message })
      onProgress?.({ phase, message })
    }

    try {
      // ── 确保目录存在 ──
      this.ensureDirectories()

      // ── 步骤 1：生成工具规格 ──
      emit('generating_spec', '正在分析需求并设计工具规格...')
      const spec = await this.generateSpec(request.need, request.preferredName)
      if (!spec) {
        return { success: false, error: '工具规格生成失败：LLM 未返回有效规格', log: logs }
      }
      emit('generating_spec', `工具规格已生成：${spec.name} - ${spec.description}`)

      // ── 步骤 2：生成工具代码（TS 源码 + JS handler 体）──
      emit('generating_code', '正在生成工具实现代码...')
      const codeResult = await this.generateCode(spec)
      if (!codeResult) {
        return { success: false, error: '工具代码生成失败：LLM 未返回有效代码', log: logs }
      }
      spec.sourceCode = codeResult.sourceCode
      spec.jsHandlerBody = codeResult.jsHandlerBody
      emit('generating_code', `代码已生成 (TS: ${spec.sourceCode.length} 字符)`)

      // ── 步骤 3：写入 TS 源文件 ──
      emit('writing_file', '正在写入工具源文件...')
      const sourcePath = this.writeSourceFile(spec)
      emit('writing_file', `文件已写入：${relative(WORKSPACE.evolution, sourcePath)}`)

      // review 模式：仅生成文件，不注册
      if (request.safetyMode === 'review') {
        emit('done', '安全模式为 review，工具已生成但未注册')
        this.activeGenerations--
        return {
          success: true,
          tool: {
            name: spec.name,
            description: spec.description,
            inputJSONSchema: spec.inputJSONSchema,
            sourcePath,
            providerName: `${DYNAMIC_PROVIDER_PREFIX}${spec.name}`,
            createdAt: Date.now(),
            tscPassed: false,
          },
          sourceCode: spec.sourceCode,
          log: logs,
        }
      }

      // ── 步骤 4：tsc 编译验证 ──
      emit('validating_tsc', '正在执行 tsc 编译验证...')
      const tscResult = await this.runTscValidation()
      if (!tscResult.passed) {
        emit('failed', `tsc 编译验证失败: ${tscResult.errors.slice(0, 3).join('; ')}`)
        this.activeGenerations--
        return {
          success: false,
          error: `tsc 验证失败: ${tscResult.errors.slice(0, 3).join('; ')}`,
          sourceCode: spec.sourceCode,
          log: logs,
        }
      }
      emit('validating_tsc', 'tsc 编译验证通过')

      // ── 步骤 5：注册到运行时 ──
      emit('registering', '正在注册新工具到运行时...')
      const providerName = this.registerTool(spec)
      emit('registering', `工具已注册，提供者：${providerName}`)

      // ── 记录已生成工具 ──
      const generated: GeneratedTool = {
        name: spec.name,
        description: spec.description,
        inputJSONSchema: spec.inputJSONSchema,
        sourcePath,
        providerName,
        createdAt: Date.now(),
        tscPassed: true,
      }
      this.generatedTools.set(spec.name, generated)

      const durationMs = Date.now() - startedAt
      emit('done', `工具 "${spec.name}" 创建完成，耗时 ${(durationMs / 1000).toFixed(1)}s`)

      this.activeGenerations--
      return {
        success: true,
        tool: generated,
        sourceCode: spec.sourceCode,
        log: logs,
      }
    } catch (err: any) {
      const errorMsg = err.message || String(err)
      log('ERROR', 'tool_generator_error', { error: errorMsg })
      this.activeGenerations--
      return {
        success: false,
        error: errorMsg,
        log: logs,
      }
    }
  }

  /**
   * 获取所有已生成的动态工具
   */
  listGeneratedTools(): GeneratedTool[] {
    return Array.from(this.generatedTools.values())
  }

  /**
   * 按名获取已生成的工具
   */
  getGeneratedTool(name: string): GeneratedTool | undefined {
    return this.generatedTools.get(name)
  }

  // =============================================================================
  // 内部方法
  // =============================================================================

  /**
   * 确保存储目录存在
   */
  private ensureDirectories(): void {
    if (this.dirInitialized) return
    if (!existsSync(GENERATED_TOOLS_DIR)) {
      mkdirSync(GENERATED_TOOLS_DIR, { recursive: true })
    }
    this.dirInitialized = true
  }

  /**
   * 步骤 1：LLM 生成工具规格
   */
  private async generateSpec(need: string, preferredName?: string): Promise<ToolSpec | null> {
    const userContent = `需求描述：${need}${preferredName ? `\n期望工具名：${preferredName}` : ''}`

    const reply = await this.callLlm(SPEC_GENERATION_SYSTEM_PROMPT, userContent)
    if (!reply) return null

    try {
      const parsed: LlmToolSpecResponse = JSON.parse(reply)
      if (!parsed.name || !parsed.description || !parsed.inputSchema) return null

      return {
        name: parsed.name,
        description: parsed.description,
        inputJSONSchema: {
          type: 'object',
          properties: parsed.inputSchema.properties,
          required: parsed.inputSchema.required || [],
        },
        sourceCode: '',
        jsHandlerBody: '',
      }
    } catch {
      log('WARN', 'tool_generator_spec_parse_failed', { reply: reply.slice(0, 200) })
      return null
    }
  }

  /**
   * 步骤 2：LLM 生成工具代码
   * 同时生成 TypeScript 源码（存盘）和纯 JavaScript handler 体（运行时执行）
   */
  private async generateCode(spec: ToolSpec): Promise<{ sourceCode: string; jsHandlerBody: string } | null> {
    const specJson = JSON.stringify(
      {
        name: spec.name,
        description: spec.description,
        inputJSONSchema: spec.inputJSONSchema,
      },
      null,
      2,
    )

    const userContent = `请为以下工具规格生成实现代码：

工具规格：
\`\`\`json
${specJson}
\`\`\``

    const reply = await this.callLlm(CODE_GENERATION_SYSTEM_PROMPT, userContent)
    if (!reply) return null

    // 提取 TypeScript 源码
    const sourceCode = extractTsCode(reply)
    if (!sourceCode) return null

    // 提取 JavaScript handler 体
    let jsHandlerBody = extractJsCode(reply)

    // 未提供 JS 体时使用兜底策略
    if (!jsHandlerBody) {
      jsHandlerBody = fallbackJsHandler({ ...spec, sourceCode })
    }

    return { sourceCode, jsHandlerBody }
  }

  /**
   * 步骤 3：写入 TS 源文件到 WORKSPACE
   */
  private writeSourceFile(spec: ToolSpec): string {
    const fileName = `${spec.name}.ts`
    const filePath = join(GENERATED_TOOLS_DIR, fileName)

    const fileContent = `// =============================================================================
// 自动生成工具：${spec.name}
// 生成时间：${new Date().toISOString()}
// 描述：${spec.description}
// =============================================================================
// 注意：此文件由 ToolGeneratorService 自动生成
// 重启后需重新注册。工具在运行时注册表中可用。
// =============================================================================

${spec.sourceCode}
`

    writeFileSync(filePath, fileContent, 'utf-8')
    return filePath
  }

  /**
   * 步骤 4：运行 tsc 编译验证
   */
  private async runTscValidation(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      await execAsync('npx tsc --noEmit -p tsconfig.node.json', {
        timeout: TSC_TIMEOUT_MS,
      })
      return { passed: true, errors: [] }
    } catch (err: any) {
      const errorText = err.message || err.stderr || err.stdout || String(err)
      const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
      return { passed: false, errors: lines.length > 0 ? lines : [errorText.slice(0, 500)] }
    }
  }

  /**
   * 步骤 5：将新工具注册到运行时
   *
   * 使用 LLM 生成的纯 JavaScript handler 体 + new Function 构建运行时处理器。
   * JS 体不含 TypeScript 注解，使用 await import() 获取 Node.js 内置模块和项目函数。
   *
   * handlerFn 包装为返回 Promise 的异步 IIFE，
   * 使 LLM 生成的 JS 体可以使用 await。
   */
  private registerTool(spec: ToolSpec): string {
    const adapter = getLocalProviderAdapter()
    const providerName = `${DYNAMIC_PROVIDER_PREFIX}${spec.name}`

    // 构建纯 JavaScript 异步 handler（包装为 async IIFE 以支持 await）
    // 使用字符串拼接而非模板字面量，避免 handlerBody 中的 `${}` 或反引号冲突
    const handlerBody = spec.jsHandlerBody
    // eslint-disable-next-line no-new-func
    const handlerFn = new Function(
      'args',
      'formatToolResult',
      'formatToolError',
      'return (async () => { ' + handlerBody + ' })();',
    )

    const wrappedHandler = async (args: Record<string, any>): Promise<MCPToolResult> => {
      try {
        const { formatToolResult: fmtResult, formatToolError: fmtError } = await import('../types')
        const result = await handlerFn(args, fmtResult, fmtError)
        return result as MCPToolResult
      } catch (err: any) {
        const { formatToolError: fmtError } = await import('../types')
        return fmtError(`工具 "${spec.name}" 执行失败: ${err.message}`)
      }
    }

    // 通过 LocalProviderAdapter 注册
    adapter.registerToolProvider(providerName, `动态生成工具：${spec.description}`, [
      {
        name: spec.name,
        description: spec.description,
        inputJSONSchema: spec.inputJSONSchema as any,
        handler: wrappedHandler,
      },
    ])

    log('INFO', 'tool_generator_registered', {
      providerName,
      toolName: spec.name,
    })

    return providerName
  }

  /**
   * 调用 LLM 生成代码
   */
  private async callLlm(systemPrompt: string, userContent: string): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

      try {
        const res = await fetch(LLM_CODE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}),
          },
          body: JSON.stringify({
            model: LLM_CODE_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            stream: false,
            temperature: 0.2,
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          log('WARN', 'tool_generator_llm_api_error', { status: res.status, body: errBody.slice(0, 200) })
          return null
        }

        const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
        return data.choices?.[0]?.message?.content?.trim() || null
      } finally {
        clearTimeout(timer)
      }
    } catch (err: any) {
      log('WARN', 'tool_generator_llm_network_error', { error: err.message })
      return null
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolGeneratorService = new ToolGeneratorService()
