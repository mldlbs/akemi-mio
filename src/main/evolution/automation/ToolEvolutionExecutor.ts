/**
 * ToolEvolutionExecutor — 工具自动进化执行器
 *
 * 职责：
 * 1. 接收高错误率工具的问题描述
 * 2. 查找工具源码路径
 * 3. 创建 Git 快照（用于回滚）
 * 4. 调用 LLM 生成改进版本（添加重试、超时、参数校验、错误处理）
 * 5. 写入新代码并用 tsc 验证
 * 6. 验证通过后提交 Git 变更并热替换运行时的工具处理器
 * 7. 验证失败则回滚
 *
 * 安全机制：
 * - 每次优化前创建 Git snapshot
 * - tsc 编译验证通过才提交
 * - 热替换仅影响当前进程，重启后恢复原始代码
 * - 优化后的代码持久化到源码文件，重启后仍生效
 *
 * 集成点：
 * - 作为 FixExecutor 注册到 PipelineOrchestrator
 * - 使用 EvolutionGitOps 管理 Git 变更
 * - 使用 LlmService.chatJsonWithCode() 生成代码
 * - 使用 getLocalProviderAdapter() 进行运行时热替换
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from './types'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'
import { getLocalProviderAdapter } from '../../mcp/LocalProvider'
import { toolStatsTracker } from '../../tool/ToolStatsTracker'
import { execAsync, createTimeoutSignal } from '../../utils/async'
import { formatToolResult, formatToolError } from '../../tool/types'
import { getAllTools } from '../../tool/index'
import { LLM_CODE_API_URL, LLM_CODE_MODEL } from '../../config'

// =============================================================================
// 类型定义
// =============================================================================

/** 改进类型，对应 LLM 可应用的优化模式 */
type ImprovementType = 'retry' | 'timeout' | 'parameter_validation' | 'error_handling' | 'general'

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

    // ── 步骤 4：调用 LLM 生成改进代码 ──
    const improvementType = suggestion || inferImprovementType(problem.context.raw)
    const prompt = buildImprovementPrompt(toolName, sourceCode, problem.context.raw, improvementType)

    let generatedCode: string | null = null
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
        if (generatedCode) break
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
        summary: `LLM 代码生成失败: ${llmError || '无响应'}`,
        durationMs: Date.now() - startedAt,
        error: 'llm_generation_failed',
      }
    }

    // ── 步骤 5：写入新代码 ──
    try {
      writeFileSync(sourcePath, generatedCode, 'utf-8')
      log('INFO', 'tool_evolution_written', { toolName, sourcePath })
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

    // ── 步骤 6：tsc 编译验证 ──
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

    // ── 步骤 7：Git 提交 ──
    try {
      await this.gitOps.autoGitCommit(`[auto] tool evolution: improve ${toolName} error handling (${improvementType})`)
    } catch {
      log('WARN', 'tool_evolution_commit_skip', { toolName })
    }

    // ── 步骤 8：运行时热替换 ──
    await this.hotReloadTool(toolName, toolStatsTracker)

    // ── 步骤 9：标记冷却 ──
    toolStatsTracker.markOptimized(toolName)

    const durationMs = Date.now() - startedAt
    log('INFO', 'tool_evolution_success', { toolName, durationMs })

    return {
      problemId: problem.id,
      success: true,
      summary: `工具 "${toolName}" 已优化（${improvementType}）: ${relative(CONFIG.PROJECT_ROOT, sourcePath)}，耗时 ${(durationMs / 1000).toFixed(0)}s`,
      durationMs,
      output: `文件: ${relative(CONFIG.PROJECT_ROOT, sourcePath)}\n优化类型: ${improvementType}\nerrorRate: ${errorRate || '未知'}`,
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 调用 LLM 生成代码改进
   */
  private async callLlm(prompt: string, toolName: string): Promise<string | null> {
    try {
      const { controller, timer } = createTimeoutSignal(120_000)
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
      const output = await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', {
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
