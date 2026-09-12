/**
 * LearningCurveExecutor — 学习曲线适配执行器
 *
 * 职责：
 * 消费 UserErrorPatternCollector 生成的 Problem（source='behavior'），
 * 对用户频繁出错的高错误率工具执行代码级分析，生成改进补丁。
 *
 * ── 学习曲线适配机制 ──
 * 1. 识别用户高频出错的工具模式（来自 ToolFeedbackLoop）
 * 2. 分析工具源码，理解错误根因
 * 3. 生成专门的改进补丁（更好的错误提示、自动重试、简化逻辑）
 * 4. tsc 编译验证 + 导入完整性检查
 * 5. 输出补丁建议到进化工作区（suggest 模式），自动修改需用户确认
 *
 * ── 执行方式 ──
 * - suggest（默认）: 生成改进补丁文件到工作区，输出差异和影响分析
 * - auto_apply（metadata.autoApply === 'true'）: 自动修改目标代码，
 *   通过 LLM 生成改进代码 + Git 快照保护 + tsc 验证 + 自动回滚
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { EvolutionGitOps } from '@akemi-mio/evolution-core'
import { execAsync } from '@akemi-mio/core/utils/async'
import { WORKSPACE } from '@akemi-mio/core/config'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'

// ════════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════════

/** 学习曲线优化输出目录 */
const LEARNING_CURVE_DIR = join(WORKSPACE.evolution, 'learning_curve_patches')

/** tsc 验证超时 */
const TSC_TIMEOUT_MS = 60000

/** LLM 最大重试 */
const MAX_LLM_RETRIES = 2

/** LLM 超时 */
const LLM_TIMEOUT_MS = 120_000

/** 工具名 → 源码文件路径映射 */
const TOOL_SOURCE_MAP: Record<string, string> = {
  read_file: 'packages/capabilities/src/tool/definitions/ReadFileTool.ts',
  write_file: 'packages/capabilities/src/tool/definitions/WriteFileTool.ts',
  edit_file: 'packages/capabilities/src/tool/definitions/EditFileTool.ts',
  grep: 'packages/capabilities/src/tool/definitions/GrepTool.ts',
  list_files: 'packages/capabilities/src/tool/definitions/ListFilesTool.ts',
  run_command: 'packages/capabilities/src/tool/definitions/RunCommandTool.ts',
  remember_fact: 'packages/capabilities/src/tool/definitions/RememberFactTool.ts',
  analyze_codebase: 'packages/capabilities/src/tool/definitions/AnalyzeCodebaseTool.ts',
  generate_image: 'packages/capabilities/src/tool/definitions/ImageGenerationTool.ts',
  writing_system: 'packages/capabilities/src/tool/definitions/WritingTool.ts',
  cicd_trigger: 'packages/capabilities/src/tool/definitions/CicdTools.ts',
  memory_search: 'packages/capabilities/src/tool/definitions/MemoryLoadTool.ts',
  memory_save: 'packages/capabilities/src/tool/definitions/MemorySaveTool.ts',
  telegram_send: 'packages/capabilities/src/tool/definitions/TelegramGatewayTools.ts',
  workflow_run: 'packages/capabilities/src/tool/definitions/WorkflowTools.ts',
}

// ════════════════════════════════════════════════════════════════
//  LLM Prompt 构建
// ════════════════════════════════════════════════════════════════

function buildLearningCurvePrompt(toolName: string, errorPatterns: string[], sourceCode: string, userLevel: string): string {
  const errorPatternGuide =
    errorPatterns.length > 0
      ? `主导错误模式: ${errorPatterns.join(', ')}\n请针对这些错误模式进行改进。`
      : '该工具存在高错误率，需要整体提升代码健壮性。'

  const userLevelGuide = getLevelGuide(userLevel)

  return `你是一个 TypeScript 代码质量专家。请改进以下工具的代码，使其更适应用户的使用模式和技能水平。

## 工具名称
${toolName}

## 用户技能水平适配
${userLevelGuide}

## 错误模式分析
${errorPatternGuide}

## 改进方向
1. 【错误提示优化】对常见错误给出更具体的友好错误提示，帮助用户理解失败原因
2. 【自动重试机制】对网络/IO/临时错误增加指数退避重试（最多 3 次）
3. 【验证前置】在工具执行前验证必要的前置条件，对缺少的条件给出清晰的修复指引
4. 【降级策略】部分失败时不阻塞整体流程，提供优雅降级
5. 【简化高频路径】对用户最常使用的参数组合简化调用逻辑

## 当前源码
\`\`\`typescript
${sourceCode}
\`\`\`

## 要求
- 只返回改进后的完整 TypeScript 源码，用 \`\`\`typescript ... \`\`\` 包装
- 保持与原文件相同的导入结构和 API 签名
- 不要改变工具的名称、描述、inputJSONSchema
- 不要移除原有功能，只增加错误处理和用户引导逻辑
- 遵守项目现有的代码风格
- 生成的代码必须可以通过 TypeScript 编译
- 错误提示使用中文，简洁明了`
}

function getLevelGuide(level: string): string {
  switch (level) {
    case 'beginner':
      return `用户对该工具的使用处于入门阶段，错误率高。
- 错误提示需要包含具体的原因说明和修复步骤
- 在用户常出错的路径添加前置条件检查
- 对常见错误提供自动修复或重试机制
- 简化高频调用路径的参数默认值`
    case 'intermediate':
      return `用户对该工具有一定使用经验但仍频繁出错。
- 错误提示需区分临时错误（网络超时等）和逻辑错误
- 对临时错误增加自动重试，对逻辑错误给出更明确的指引
- 优化高频参数组合的调用体验`
    case 'advanced':
      return `用户对该工具熟悉但遇到特定边缘情况。
- 保持错误提示精炼，不冗余
- 对罕见错误提供更详细的诊断信息
- 优化边界条件的处理逻辑`
    default:
      return `根据用户的错误模式优化工具的容错性和用户引导。`
  }
}

// ════════════════════════════════════════════════════════════════
//  LLM 调用与代码提取
// ════════════════════════════════════════════════════════════════

async function callLlmForImprovement(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      const { code } = getRuntimeLlmConfig({ getCredential: (key) => credentialsManager.get(key) })
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (code.apiKey) {
        headers.Authorization = `Bearer ${code.apiKey}`
      }

      const res = await fetch(code.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: code.model,
          messages: [
            {
              role: 'system',
              content:
                '你是一个 TypeScript 代码质量专家。请根据用户错误模式生成改进后的完整 TypeScript 源码。只返回代码，不要添加额外说明。',
            },
            { role: 'user', content: prompt },
          ],
          stream: false,
          temperature: 0.2,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        log('WARN', 'learning_curve_llm_api_error', { status: res.status, body: errBody.slice(0, 200) })
        return null
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      return data.choices?.[0]?.message?.content?.trim() || null
    } finally {
      clearTimeout(timer)
    }
  } catch (err: any) {
    log('WARN', 'learning_curve_llm_network_error', { error: err.message })
    return null
  }
}

function extractCodeFromReply(reply: string): string | null {
  const tsMatch = reply.match(/```typescript\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch && tsMatch[1]) return tsMatch[1].trim()
  const tsMatch2 = reply.match(/```ts\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch2 && tsMatch2[1]) return tsMatch2[1].trim()
  const genericMatch = reply.match(/```\s*\n?([\s\S]*?)\n?```/)
  if (genericMatch && genericMatch[1]) return genericMatch[1].trim()
  return reply.trim() || null
}

// ════════════════════════════════════════════════════════════════
//  tsc 验证
// ════════════════════════════════════════════════════════════════

interface TscResult {
  passed: boolean
  errors: string[]
}

async function runTscValidation(timeoutMs: number = TSC_TIMEOUT_MS): Promise<TscResult> {
  try {
    await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', { timeout: timeoutMs })
    return { passed: true, errors: [] }
  } catch (err: any) {
    const errorText = err.message || err.stderr || err.stdout || String(err)
    const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
    return { passed: false, errors: lines.length > 0 ? lines : [errorText.slice(0, 500)] }
  }
}

// ════════════════════════════════════════════════════════════════
//  LearningCurveExecutor
// ════════════════════════════════════════════════════════════════

export class LearningCurveExecutor implements FixExecutor {
  readonly name = 'learning-curve-executor'
  readonly timeoutMs = 240_000
  readonly supportedSources = ['behavior'] as const
  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()
    const toolName = problem.context.metadata?.toolName || ''
    const errorPatterns = (problem.context.metadata?.errorPatterns || '').split(', ').filter(Boolean)
    const autoApply = problem.context.metadata?.autoApply === 'true'

    if (!toolName) {
      return {
        problemId: problem.id,
        success: false,
        summary: '❌ 无法识别目标工具名称，跳过学习曲线适配',
        durationMs: Date.now() - startTime,
        error: 'missing_tool_name',
      }
    }

    log('INFO', 'learning_curve_exec_start', {
      problemId: problem.id,
      toolName,
      errorPatterns: errorPatterns.join(', ') || 'unknown',
      mode: autoApply ? 'auto_apply' : 'suggest',
    })

    if (autoApply) {
      return this.executeAutoApply(problem, toolName, errorPatterns, startTime)
    }

    return this.executeSuggest(problem, toolName, errorPatterns, startTime)
  }

  // ==================== suggest 模式（默认） ====================

  private async executeSuggest(problem: AssignedProblem, toolName: string, errorPatterns: string[], startTime: number): Promise<FixResult> {
    try {
      const filePath = this.resolveToolSource(toolName)
      if (!filePath || !existsSync(join(process.cwd(), filePath))) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 无法定位工具 "${toolName}" 的源码文件，建议生成跳过`,
          durationMs: Date.now() - startTime,
          error: 'source_not_found',
        }
      }

      const absolutePath = join(process.cwd(), filePath)
      const sourceCode = readFileSync(absolutePath, 'utf-8')
      const userLevel = this.inferUserLevel(problem)

      // 调用 LLM 生成改进代码
      const prompt = buildLearningCurvePrompt(toolName, errorPatterns, sourceCode, userLevel)

      let generatedCode: string | null = null
      let llmError: string | undefined

      for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
        try {
          const reply = await callLlmForImprovement(prompt)
          if (reply === null) {
            llmError = 'LLM 返回空'
            if (attempt < MAX_LLM_RETRIES) continue
            break
          }
          generatedCode = extractCodeFromReply(reply)
          if (generatedCode) break
          llmError = '无法从 LLM 回复中提取代码'
          if (attempt < MAX_LLM_RETRIES) continue
        } catch (err: any) {
          llmError = err.message
          if (attempt < MAX_LLM_RETRIES) continue
        }
      }

      if (!generatedCode) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ LLM 改进代码生成失败（${MAX_LLM_RETRIES} 次重试）: ${llmError || '无响应'}`,
          durationMs: Date.now() - startTime,
          error: 'generation_failed',
        }
      }

      // 导入完整性检查
      if (!this.checkImportIntegrity(sourceCode, generatedCode)) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 改进代码丢失关键导入，建议检查后重试`,
          durationMs: Date.now() - startTime,
          error: 'import_integrity_check_failed',
        }
      }

      // tsc 验证
      const tempDir = join(LEARNING_CURVE_DIR, '.tmp')
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })
      const tempFilePath = join(tempDir, `${toolName}_improved.ts`)
      writeFileSync(tempFilePath, generatedCode, 'utf-8')

      const tscResult = await runTscValidation()
      const tscPassed = tscResult.passed

      if (!tscPassed) {
        log('WARN', 'learning_curve_tsc_failed', {
          toolName,
          errors: tscResult.errors.slice(0, 3),
        })
      }

      // 生成补丁报告
      if (!existsSync(LEARNING_CURVE_DIR)) mkdirSync(LEARNING_CURVE_DIR, { recursive: true })

      const patchId = `learning_curve_${toolName}_${Date.now()}`
      const patchFile = join(LEARNING_CURVE_DIR, `${patchId}.json`)

      const patchReport = {
        id: patchId,
        toolName,
        errorPatterns,
        userLevel,
        sourceFile: filePath,
        timestamp: Date.now(),
        tscValidation: tscPassed ? 'passed' : 'failed',
        tscErrors: tscResult.errors.slice(0, 5),
        status: tscPassed ? 'ready_for_review' : 'needs_fix',
        improvedCode: generatedCode,
        problemId: problem.id,
        summary: this.buildPatchSummary(toolName, errorPatterns, userLevel, tscPassed),
        improvements: this.extractImprovementDescriptions(generatedCode, sourceCode),
      }

      writeFileSync(patchFile, JSON.stringify(patchReport, null, 2), 'utf-8')

      // 清理临时文件
      try {
        rmSync(tempFilePath, { force: true })
      } catch {
        /* silent */
      }

      // 发出通知事件（供 UI/用户确认使用）
      eventBus.emit(
        'evolution.learning_curve.patch_ready' as any,
        {
          patchId,
          toolName,
          sourceFile: filePath,
          patchFile,
          tscPassed,
          status: tscPassed ? 'ready_for_review' : 'needs_fix',
          summary: patchReport.summary,
        } as any,
      )

      const durationMs = Date.now() - startTime
      log('INFO', 'learning_curve_suggest_done', {
        toolName,
        tscPassed,
        patchFile,
        durationMs,
      })

      const statusText = tscPassed ? '等待用户审核' : '需手动修复 tsc 错误'
      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 生成学习曲线适配补丁: [${toolName}] ${statusText}`,
        durationMs,
        output: `补丁文件: ${patchFile}\ntsc 验证: ${tscPassed ? '通过' : tscResult.errors.length + ' 个错误'}\n建议: 查看补丁后在 metadata 中添加 autoApply=true 可自动应用`,
      }
    } catch (err: any) {
      log('ERROR', 'learning_curve_suggest_error', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `学习曲线适配补丁生成失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  // ==================== auto_apply 模式 ====================

  private async executeAutoApply(
    problem: AssignedProblem,
    toolName: string,
    errorPatterns: string[],
    startTime: number,
  ): Promise<FixResult> {
    try {
      const filePath = this.resolveToolSource(toolName)
      if (!filePath || !existsSync(join(process.cwd(), filePath))) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 无法定位工具 "${toolName}" 的源码文件，自动修补中止`,
          durationMs: Date.now() - startTime,
          error: 'source_not_found',
        }
      }

      const absolutePath = join(process.cwd(), filePath)

      let sourceCode: string
      try {
        sourceCode = readFileSync(absolutePath, 'utf-8')
      } catch (err: any) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 读取目标文件失败: ${err.message}`,
          durationMs: Date.now() - startTime,
          error: 'read_failed',
        }
      }

      // Git 快照
      const snapshotTag = `learning_curve_${toolName}_${Date.now()}`
      const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
      if (!snapshotBranch) {
        log('WARN', 'learning_curve_apply_snapshot_failed', { toolName })
      }

      const userLevel = this.inferUserLevel(problem)
      const prompt = buildLearningCurvePrompt(toolName, errorPatterns, sourceCode, userLevel)

      let generatedCode: string | null = null
      let llmError: string | undefined

      for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
        try {
          const reply = await callLlmForImprovement(prompt)
          if (reply === null) {
            llmError = 'LLM 返回空'
            if (attempt < MAX_LLM_RETRIES) continue
            break
          }
          generatedCode = extractCodeFromReply(reply)
          if (generatedCode) break
          llmError = '无法从 LLM 回复中提取代码'
          if (attempt < MAX_LLM_RETRIES) continue
        } catch (err: any) {
          llmError = err.message
          if (attempt < MAX_LLM_RETRIES) continue
        }
      }

      if (!generatedCode) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ LLM 改进代码生成失败（${MAX_LLM_RETRIES} 次重试）: ${llmError || '无响应'}`,
          durationMs: Date.now() - startTime,
          error: 'generation_failed',
        }
      }

      if (!this.checkImportIntegrity(sourceCode, generatedCode)) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 改进代码丢失关键导入，自动应用中止`,
          durationMs: Date.now() - startTime,
          error: 'import_integrity_check_failed',
        }
      }

      try {
        writeFileSync(absolutePath, generatedCode, 'utf-8')
      } catch (err: any) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 写入文件失败: ${err.message}`,
          durationMs: Date.now() - startTime,
          error: 'write_failed',
        }
      }

      // tsc 验证
      const tscResult = await runTscValidation()
      if (!tscResult.passed) {
        log('WARN', 'learning_curve_apply_tsc_failed', {
          toolName,
          errors: tscResult.errors.slice(0, 3),
        })
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ tsc 编译验证失败（${tscResult.errors.length} 个错误），已自动回滚`,
          durationMs: Date.now() - startTime,
          output: tscResult.errors.slice(0, 5).join('\n'),
          error: 'tsc_validation_failed',
        }
      }

      // Git 提交
      try {
        await this.gitOps.autoGitCommit(`[learning-curve] improve error handling for ${toolName} based on user error patterns`)
      } catch {
        log('WARN', 'learning_curve_apply_commit_skip', { toolName })
      }

      eventBus.emit(
        'evolution.learning_curve.patch_applied' as any,
        {
          toolName,
          sourceFile: filePath,
          snapshotTag,
          errorPatterns,
          userLevel,
        } as any,
      )

      const durationMs = Date.now() - startTime
      log('INFO', 'learning_curve_apply_success', {
        toolName,
        durationMs,
        filePath,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 学习曲线适配自动应用: [${toolName}] 已改进错误处理，请验证功能正常`,
        durationMs,
        output: `已修改: ${filePath}\ntsc 验证: 通过\n改进内容: ${this.buildPatchSummary(toolName, errorPatterns, userLevel, true)}`,
      }
    } catch (err: any) {
      log('ERROR', 'learning_curve_apply_error', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `学习曲线适配自动应用失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  // ==================== 内部方法 ====================

  private resolveToolSource(toolName: string): string | null {
    if (TOOL_SOURCE_MAP[toolName]) return TOOL_SOURCE_MAP[toolName]
    return null
  }

  private inferUserLevel(problem: AssignedProblem): string {
    const sampleCount = parseInt(problem.context.metadata?.sampleCount || '0', 10)
    const emaRate = parseFloat(problem.context.metadata?.emaSuccessRate || '1')
    const consecutiveCycles = parseInt(problem.context.metadata?.consecutiveErrorCycles || '0', 10)

    if (consecutiveCycles >= 2 || (sampleCount < 10 && emaRate < 0.6)) return 'beginner'
    if (sampleCount >= 20 && emaRate >= 0.7) return 'advanced'
    return 'intermediate'
  }

  private checkImportIntegrity(original: string, improved: string): boolean {
    const importRegex = /import\s+.*\s+from\s+['"].*['"]/g
    const requireRegex = /(const|let|var)\s+.*\s*=\s*require\s*\(/g

    const originalImports = new Set([...(original.match(importRegex) || []), ...(original.match(requireRegex) || [])])

    const improvedImports = new Set([...(improved.match(importRegex) || []), ...(improved.match(requireRegex) || [])])

    for (const imp of originalImports) {
      if (imp.includes("'./") || imp.includes("'../") || imp.includes("'fs'") || imp.includes("'path'")) continue
      if (!improvedImports.has(imp)) {
        log('WARN', 'learning_curve_missing_import', { missingImport: imp })
        return false
      }
    }

    return true
  }

  private buildPatchSummary(toolName: string, errorPatterns: string[], userLevel: string, tscPassed: boolean): string {
    const patterns = errorPatterns.length > 0 ? `针对错误模式: ${errorPatterns.join(', ')}` : '全面提升错误处理'
    return `[${toolName}] ${patterns}（用户水平: ${userLevel}，tsc: ${tscPassed ? '通过' : '失败'}）`
  }

  private extractImprovementDescriptions(improved: string, original: string): string[] {
    const descriptions: string[] = []

    const originalTryCount = (original.match(/try\s*{/g) || []).length
    const improvedTryCount = (improved.match(/try\s*{/g) || []).length
    if (improvedTryCount > originalTryCount) {
      descriptions.push(`新增 ${improvedTryCount - originalTryCount} 处异常捕获`)
    }

    if (improved.includes('retry') || improved.includes('Retry') || improved.includes('MAX_RETRIES')) {
      descriptions.push('增加了自动重试机制')
    }

    const originalErrorMsgCount = (original.match(/(?:错误|error|失败|fail|提示)/gi) || []).length
    const improvedErrorMsgCount = (improved.match(/(?:错误|error|失败|fail|提示)/gi) || []).length
    if (improvedErrorMsgCount > originalErrorMsgCount) {
      descriptions.push(`优化了 ${improvedErrorMsgCount - originalErrorMsgCount} 处错误提示信息`)
    }

    if (descriptions.length === 0) {
      descriptions.push('改进了整体代码质量和错误处理')
    }

    return descriptions
  }

  private async rollbackIfNeeded(snapshotBranch: string | null): Promise<void> {
    if (!snapshotBranch) return
    try {
      await this.gitOps.rollbackToSnapshot(snapshotTagFromBranch(snapshotBranch))
      log('INFO', 'learning_curve_rollback_done', { snapshotBranch })
    } catch (err: any) {
      log('WARN', 'learning_curve_rollback_failed', { snapshotBranch, error: err.message })
    }
  }
}

function snapshotTagFromBranch(branch: string): string {
  return branch.startsWith('snapshot/') ? branch.slice(9) : branch
}

/** 模块级单例 */
export const learningCurveExecutor = new LearningCurveExecutor()
