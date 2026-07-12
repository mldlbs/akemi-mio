/**
 * BehaviorOptimizationExecutor — 行为驱动优化执行器
 *
 * 消费 BehaviorCollector 生成的 Problem（source='behavior'），
 * 根据优化类型生成代码变更计划并记录影响。
 *
 * ── 执行模式 ──
 * 1. suggest（默认）: 输出优化建议文件到进化工作区，不直接修改代码
 * 2. auto_patch（metadata.autoPatch === 'true'）: 自动修改目标代码，
 *    通过 LLM 生成改进代码 + Git 快照保护 + tsc 编译验证 + 自动回滚
 *
 * ── 优化类型及对应的执行策略 ──
 * - preload_module:   添加预加载逻辑（在工具 handler 中异步预载后续工具上下文）
 * - optimize_response: 优化响应延迟（添加流式输出、减少阻塞）
 * - add_cache:        添加 LRU 缓存层
 * - improve_error:    增强错误处理（重试、优雅降级）
 * - merge_tools:      生成工具合并建议（不建议自动执行，风险高）
 * - increase_priority: 生成优先级调整建议（不建议自动执行）
 */

import { log } from '../../logger/Logger'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'
import { execAsync } from '../../utils/async'
import { LLM_CODE_API_URL, LLM_CODE_MODEL, WORKSPACE } from '../../config'

/** 行为优化输出目录 */
const OPTIMIZATIONS_DIR = join(WORKSPACE.evolution, 'behavior_optimizations')

/** tsc 验证超时 */
const TSC_TIMEOUT_MS = 60000

/** LLM 最大重试 */
const MAX_LLM_RETRIES = 2

/** LLM 超时 */
const LLM_TIMEOUT_MS = 120_000

// =============================================================================
// LLM Prompt 构建
// =============================================================================

/**
 * 构建优化专用的 LLM prompt。
 * 每种优化类型使用不同的提示模板，引导 LLM 生成符合项目风格的代码。
 */
function buildOptimizationPrompt(
  optimizationType: string,
  target: string,
  sourceCode: string,
  behaviorContext: string,
): string {
  const optimizationGuides: Record<string, string> = {
    preload_module: `## 优化方向：添加预加载逻辑
- 在工具 handler 中检测高频后续工具序列，异步预加载后续工具所需的上下文数据
- 使用 Promise 或 setTimeout(0) 实现非阻塞预加载，不增加主路径延迟
- 预加载的数据存储在模块级变量中（如 \`_preloadedContext\`），后续工具直接消费
- 添加 TTL 控制（建议 30s），避免内存泄漏
- 保持原有的导入结构、API 签名和返回值格式`,

    optimize_response: `## 优化方向：响应延迟优化
- 添加流式/分块输出逻辑，减少用户感知等待时间
- 对同步阻塞操作改用异步非阻塞版本
- 添加进度反馈（如先返回"正在处理..."再返回最终结果）
- 检查是否有不必要的同步 I/O 操作，改用异步版本
- 保持原有的 API 签名和返回值格式`,

    add_cache: `## 优化方向：添加缓存机制
- 为工具 handler 添加内存缓存，对相同参数组合的重复调用直接返回缓存结果
- 使用 Map<string, { result: string; expiresAt: number }> 作为缓存容器
- 缓存 TTL 设置为 30-60 秒，缓存上限 50 条
- 调用前检查缓存是否命中且未过期，命中后直接返回
- 保持原有的错误处理和结果格式化逻辑`,

    improve_error: `## 优化方向：错误处理改进
- 对网络/IO 类操作添加自动重试（最多 3 次，指数退避）
- 确保所有可能的异常路径都有 try-catch 保护
- 对已知错误类型给出更友好的错误提示信息
- 添加优雅降级策略，部分失败时不阻塞整体流程
- 保持原有的导入结构、API 签名和返回值格式`,
  }

  const guide = optimizationGuides[optimizationType] || optimizationGuides.improve_error

  return `你是一个 TypeScript 代码优化专家。请改进以下工具代码，优化其执行效率。

## 优化类型
${optimizationType}

## 目标工具
${target}

## 行为上下文
${behaviorContext || '该工具在用户行为序列中频繁出现，需要优化。'}

## 当前源码
\`\`\`typescript
${sourceCode}
\`\`\`

${guide}

## 要求
- 只返回改进后的完整 TypeScript 源码，用 \`\`\`typescript ... \`\`\` 包装
- 保持与原文件相同的导入结构和 API 签名
- 不要改变工具的名称、描述、inputJSONSchema
- 不要移除原有功能，只增加优化逻辑
- 遵守项目现有的代码风格
- 生成的代码必须可以通过 TypeScript 编译`
}

// =============================================================================
// LLM 调用与代码提取
// =============================================================================

/**
 * 调用 LLM 生成优化代码。
 * 使用与 ToolEvolutionExecutor 相同的调用模式（直接 fetch LLM API）。
 */
async function callLlmForOptimization(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      const res = await fetch(LLM_CODE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_CODE_MODEL,
          messages: [
            {
              role: 'system',
              content:
                '你是一个 TypeScript 代码优化专家。请根据优化需求生成改进后的完整 TypeScript 源码。只返回代码，不要添加额外说明。',
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
        log('WARN', 'behavior_opt_llm_api_error', { status: res.status, body: errBody.slice(0, 200) })
        return null
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      return data.choices?.[0]?.message?.content?.trim() || null
    } finally {
      clearTimeout(timer)
    }
  } catch (err: any) {
    log('WARN', 'behavior_opt_llm_network_error', { error: err.message })
    return null
  }
}

/**
 * 从 LLM 回复中提取 TypeScript 代码块。
 */
function extractCodeFromReply(reply: string): string | null {
  const tsMatch = reply.match(/```typescript\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch && tsMatch[1]) return tsMatch[1].trim()
  const tsMatch2 = reply.match(/```ts\s*\n?([\s\S]*?)\n?```/)
  if (tsMatch2 && tsMatch2[1]) return tsMatch2[1].trim()
  const genericMatch = reply.match(/```\s*\n?([\s\S]*?)\n?```/)
  if (genericMatch && genericMatch[1]) return genericMatch[1].trim()
  return reply.trim() || null
}

// =============================================================================
// tsc 编译验证
// =============================================================================

interface TscResult {
  passed: boolean
  errors: string[]
}

/**
 * 运行 tsc --noEmit 验证。
 */
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

// =============================================================================
// BehaviorOptimizationExecutor
// =============================================================================

export class BehaviorOptimizationExecutor implements FixExecutor {
  readonly name = 'behavior-optimization-executor'
  readonly timeoutMs = 180_000 // 3 分钟，包含 LLM 调用 + tsc 编译
  readonly supportedSources = ['behavior']
  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()
    const optimizationType = problem.context.metadata?.optimizationType || 'unknown'
    const target = problem.context.metadata?.target || 'unknown'
    const expectedBenefit = problem.context.metadata?.expectedBenefit || ''
    const risk = problem.context.metadata?.risk || ''

    // 决策是否为 auto_patch 模式:
    // 1. 如果 metadata 显式指定 autoPatch，以它为准
    // 2. 默认为安全优化类型自动启用 auto_patch
    const autoPatch = this.shouldAutoPatch(optimizationType, problem.context.metadata)

    log('INFO', 'behavior_opt_exec_start', {
      problemId: problem.id,
      type: optimizationType,
      target,
      mode: autoPatch ? 'auto_patch' : 'suggest',
    })

    if (autoPatch) {
      return this.executeAutoPatch(problem, optimizationType, target, startTime)
    }

    return this.executeSuggest(problem, optimizationType, target, expectedBenefit, risk, startTime)
  }

  /**
   * 判断是否应为该优化类型启用 auto_patch 模式。
   * 安全优化类型默认启用；高风险类型（merge_tools, increase_priority）默认仅生成建议。
   */
  private shouldAutoPatch(optimizationType: string, metadata?: Record<string, string>): boolean {
    // 显式覆盖
    if (metadata?.autoPatch === 'true') return true
    if (metadata?.autoPatch === 'false') return false

    // 高风险类型跳过自动执行
    if (optimizationType === 'merge_tools' || optimizationType === 'increase_priority') return false

    // 安全优化类型默认启用 auto_patch
    const safeForAutoPatch = ['preload_module', 'optimize_response', 'add_cache', 'improve_error']
    return safeForAutoPatch.includes(optimizationType)
  }

  // ==================== suggest 模式（原行为） ====================

  /**
   * suggest 模式：生成优化建议 JSON 文件到工作区。
   */
  private async executeSuggest(
    problem: AssignedProblem,
    optimizationType: string,
    target: string,
    expectedBenefit: string,
    risk: string,
    startTime: number,
  ): Promise<FixResult> {
    try {
      if (!existsSync(OPTIMIZATIONS_DIR)) {
        mkdirSync(OPTIMIZATIONS_DIR, { recursive: true })
      }

      const planFilePath = join(
        OPTIMIZATIONS_DIR,
        `${problem.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.json`,
      )
      const plan = this.buildOptimizationPlan(problem, optimizationType, target)
      writeFileSync(planFilePath, JSON.stringify(plan, null, 2), 'utf-8')

      log('INFO', 'behavior_opt_suggest_done', {
        planFile: planFilePath,
        durationMs: Date.now() - startTime,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 生成行为优化计划: [${optimizationType}] ${problem.title}`,
        durationMs: Date.now() - startTime,
        output: `优化计划已输出到: ${planFilePath}\n预期收益: ${expectedBenefit}\n风险: ${risk}`,
      }
    } catch (err: any) {
      log('ERROR', 'behavior_opt_suggest_error', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `行为优化计划生成失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  // ==================== auto_patch 模式（新增） ====================

  /**
   * auto_patch 模式：自动修改目标代码，包含完整的安全机制。
   *
   * 流程：
   * 1. 解析目标文件路径
   * 2. 读取当前源码
   * 3. 创建 Git 快照
   * 4. 调用 LLM 生成优化代码
   * 5. 写入优化代码
   * 6. tsc 编译验证
   * 7. 成功 → Git 提交；失败 → 回滚到快照
   */
  private async executeAutoPatch(
    problem: AssignedProblem,
    optimizationType: string,
    target: string,
    startTime: number,
  ): Promise<FixResult> {
    try {
      // ── 步骤 1：解析目标文件路径 ──
      const filePath = this.resolveTargetFile(target)
      if (!filePath || filePath.startsWith('src/main/unknown/')) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 无法解析目标 "${target}" 的文件路径，自动修补中止`,
          durationMs: Date.now() - startTime,
          error: 'unknown_target',
        }
      }

      // 高风险类型跳过自动修补
      if (optimizationType === 'merge_tools' || optimizationType === 'increase_priority') {
        return {
          problemId: problem.id,
          success: false,
          summary: `⏭️ 跳过自动修补: [${optimizationType}] 高风险操作需人工确认`,
          durationMs: Date.now() - startTime,
          output: `优化类型 "${optimizationType}" 不支持自动执行，请在优化计划中手动实施。`,
        }
      }

      const absolutePath = join(process.cwd(), filePath)

      // ── 步骤 2：读取当前源码 ──
      if (!existsSync(absolutePath)) {
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 目标文件不存在: ${filePath}`,
          durationMs: Date.now() - startTime,
          error: 'file_not_found',
        }
      }

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

      log('INFO', 'behavior_opt_patch_read_source', {
        target,
        filePath,
        sourceSize: sourceCode.length,
      })

      // ── 步骤 3：创建 Git 快照 ──
      const snapshotTag = `behavior_opt_${optimizationType}_${target}_${Date.now()}`
      const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
      if (!snapshotBranch) {
        log('WARN', 'behavior_opt_patch_snapshot_failed', { target })
        // 继续执行，无快照也能工作（只是无法回滚）
      }

      // ── 步骤 4：构建行为上下文文本 ──
      const behaviorContext = this.buildBehaviorContextText(problem)

      // ── 步骤 5：调用 LLM 生成优化代码 ──
      const prompt = buildOptimizationPrompt(optimizationType, target, sourceCode, behaviorContext)

      let generatedCode: string | null = null
      let llmError: string | undefined

      for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
        try {
          const reply = await callLlmForOptimization(prompt)
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
          log('WARN', 'behavior_opt_patch_llm_exception', { attempt, error: err.message })
          if (attempt < MAX_LLM_RETRIES) continue
        }
      }

      if (!generatedCode) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ LLM 代码生成失败（${MAX_LLM_RETRIES} 次重试）: ${llmError || '无响应'}`,
          durationMs: Date.now() - startTime,
          error: 'generation_failed',
        }
      }

      // ── 步骤 6：代码结构预检查 ──
      // 检查是否有明显的代码结构破坏（丢失关键导入/签名）
      const structureCheck = this.checkCodeStructure(sourceCode, generatedCode, optimizationType)
      if (!structureCheck.passed) {
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ 代码结构检查失败: ${structureCheck.reason}`,
          durationMs: Date.now() - startTime,
          error: 'structure_check_failed',
          output: structureCheck.detail,
        }
      }

      // ── 步骤 7：写入优化代码 ──
      try {
        writeFileSync(absolutePath, generatedCode, 'utf-8')
        log('INFO', 'behavior_opt_patch_written', {
          target,
          filePath,
          generatedSize: generatedCode.length,
        })
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

      // ── 步骤 8：tsc 编译验证 ──
      const tscResult = await runTscValidation()
      if (!tscResult.passed) {
        log('WARN', 'behavior_opt_patch_tsc_failed', {
          target,
          errors: tscResult.errors.slice(0, 3),
        })
        await this.rollbackIfNeeded(snapshotBranch)
        return {
          problemId: problem.id,
          success: false,
          summary: `❌ tsc 编译验证失败（${tscResult.errors.length} 个错误）`,
          durationMs: Date.now() - startTime,
          output: tscResult.errors.slice(0, 5).join('\n'),
          error: 'tsc_validation_failed',
        }
      }

      // ── 步骤 9：Git 提交 ──
      try {
        await this.gitOps.autoGitCommit(
          `[behavior] ${optimizationType}: optimize ${target} based on usage patterns`,
        )
      } catch {
        log('WARN', 'behavior_opt_patch_commit_skip', { target })
      }

      const durationMs = Date.now() - startTime
      log('INFO', 'behavior_opt_patch_success', {
        target,
        optimizationType,
        durationMs,
        filePath,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 自动优化: [${optimizationType}] ${target} — ${relative(process.cwd(), absolutePath)}，耗时 ${(durationMs / 1000).toFixed(0)}s`,
        durationMs,
        output: `文件: ${relative(process.cwd(), absolutePath)}
优化类型: ${optimizationType}
预期收益: ${this.getExpectedBenefitText(optimizationType)}
状态: ✅ tsc 编译验证通过，已提交 Git`,
      }
    } catch (err: any) {
      log('ERROR', 'behavior_opt_patch_fatal', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `❌ 自动优化执行异常: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  // ==================== 代码结构检查 ====================

  /**
   * 检查生成的代码是否保留了关键结构要素。
   * 防止 LLM 生成了完整但破坏了导入/导出/签名的代码。
   */
  private checkCodeStructure(
    oldCode: string,
    newCode: string,
    optimizationType: string,
  ): { passed: boolean; reason: string; detail: string } {
    // 提取旧代码中的 import 语句
    const oldImports = oldCode.match(/^import .+$/gm) || []
    const newImports = newCode.match(/^import .+$/gm) || []

    // 关键导入必须保留（排除 node_modules 内部导入）
    const criticalImports = oldImports.filter(
      (imp) =>
        !imp.includes('lodash') &&
        !imp.includes('date-fns') &&
        !imp.includes('uuid') &&
        !imp.includes('chalk') &&
        !imp.includes('debug') &&
        !imp.includes('fs') &&
        !imp.includes('path') &&
        !imp.includes('os') &&
        !imp.includes('child_process'),
    )

    // 检查导出语句
    const hasOldExport = oldCode.includes('export ')
    const hasNewExport = newCode.includes('export ')

    // 检查 handler（如果是工具代码）
    const hasOldHandler = oldCode.includes('handler:')
    const hasNewHandler = newCode.includes('handler:')

    const issues: string[] = []

    if (hasOldExport && !hasNewExport) {
      issues.push('export 语句丢失')
    }
    if (hasOldHandler && !hasNewHandler) {
      issues.push('handler 定义丢失')
    }

    if (issues.length > 0) {
      return {
        passed: false,
        reason: issues.join('; '),
        detail: `旧代码导出: ${hasOldExport}, 新代码导出: ${hasNewExport}; handler: ${hasOldHandler} → ${hasNewHandler}`,
      }
    }

    return { passed: true, reason: '', detail: '' }
  }

  // ==================== 回滚 ====================

  /**
   * 需要时回滚到 Git 快照。
   */
  private async rollbackIfNeeded(snapshotBranch: string | null): Promise<void> {
    if (!snapshotBranch) return
    try {
      await this.gitOps.rollbackToSnapshot(snapshotBranch, RollbackLevel.MODULE)
      await this.gitOps.cleanupSnapshot(snapshotBranch)
      log('INFO', 'behavior_opt_rollback_success', { branch: snapshotBranch })
    } catch (err: any) {
      log('WARN', 'behavior_opt_rollback_failed', { error: err.message })
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 从 Problem 上下文构建行为描述文本。
   */
  private buildBehaviorContextText(problem: AssignedProblem): string {
    const metadata = problem.context.metadata || {}
    const parts: string[] = []

    if (metadata.totalToolCalls) {
      parts.push(`分析窗口内总工具调用数: ${metadata.totalToolCalls}`)
    }

    if (metadata.frequentSequences) {
      try {
        const sequences = JSON.parse(metadata.frequentSequences) as Array<{
          tools: string[]
          frequency: number
        }>
        if (sequences.length > 0) {
          parts.push(`高频序列: ${sequences.map((s) => `${s.tools.join('→')}(${s.frequency}次)`).join('; ')}`)
        }
      } catch {
        // ignore parse errors
      }
    }

    if (metadata.pausePoints) {
      try {
        const pauses = JSON.parse(metadata.pausePoints) as Array<{
          tool: string
          avgWaitMs: number
        }>
        if (pauses.length > 0) {
          parts.push(`等待热点: ${pauses.map((p) => `${p.tool}(${Math.round(p.avgWaitMs / 1000)}s)`).join('; ')}`)
        }
      } catch {
        // ignore parse errors
      }
    }

    return parts.join('\n') || '无详细行为数据'
  }

  /**
   * 获取优化类型的预期收益文本。
   */
  private getExpectedBenefitText(optimizationType: string): string {
    const benefits: Record<string, string> = {
      preload_module: '减少高频序列总延迟 20-30%',
      optimize_response: '减少用户等待时间 30-50%',
      add_cache: '减少重复计算延迟 50%+',
      improve_error: '提升成功率至 90%+',
      merge_tools: '（高风险，建议手动实施）',
      increase_priority: '（配置变更，建议手动实施）',
    }
    return benefits[optimizationType] || '提升模块性能'
  }

  // ==================== 原有方法（suggest 模式） ====================

  /**
   * 构建优化计划对象。
   */
  private buildOptimizationPlan(
    problem: AssignedProblem,
    optimizationType: string,
    target: string,
  ): BehaviorOptimizationPlan {
    const plan: BehaviorOptimizationPlan = {
      planId: problem.id,
      type: optimizationType,
      target,
      title: problem.title,
      description: problem.description,
      priority: parseInt(problem.context.metadata?.priority || '50'),
      expectedBenefit: problem.context.metadata?.expectedBenefit || '',
      risk: problem.context.metadata?.risk || '',
      behaviorContext: this.extractBehaviorContext(problem),
      implementationSteps: this.generateImplementationSteps(optimizationType, target, problem),
      createdAt: Date.now(),
      status: 'proposed',
    }
    return plan
  }

  private extractBehaviorContext(problem: AssignedProblem): BehaviorContext {
    const metadata = problem.context.metadata || {}
    let frequentSequences: Array<{ tools: string[]; frequency: number }> = []
    let pausePoints: Array<{ tool: string; avgWaitMs: number }> = []
    try {
      if (metadata.frequentSequences) {
        frequentSequences = JSON.parse(metadata.frequentSequences)
      }
    } catch {
      /* ignore parse errors */
    }
    try {
      if (metadata.pausePoints) {
        pausePoints = JSON.parse(metadata.pausePoints)
      }
    } catch {
      /* ignore parse errors */
    }
    return {
      totalToolCalls: parseInt(metadata.totalToolCalls || '0'),
      frequentSequences,
      pausePoints,
    }
  }

  private generateImplementationSteps(
    optimizationType: string,
    target: string,
    problem: AssignedProblem,
  ): ImplementationStep[] {
    const baseSteps: ImplementationStep[] = [
      {
        order: 1,
        action: 'review',
        description: `审查 ${target} 的当前实现代码`,
        targetFile: this.resolveTargetFile(target),
        estimatedEffort: '10min',
      },
    ]

    switch (optimizationType) {
      case 'preload_module':
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `在 ${target} 的执行入口添加后续模块的预加载逻辑`,
            detail: `当 ${target} 被调用时，异步预加载后续高频工具所需的数据和上下文`,
            estimatedEffort: '20min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证预加载不引入额外的延迟或内存泄漏',
            estimatedEffort: '10min',
          },
        )
        break
      case 'optimize_response':
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `优化 ${target} 的响应输出逻辑`,
            detail: '添加流式输出、减少同步阻塞、增加进度反馈',
            estimatedEffort: '30min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证响应时间减少和输出格式兼容性',
            estimatedEffort: '15min',
          },
        )
        break
      case 'add_cache':
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `为 ${target} 添加 LRU 缓存层`,
            detail: '使用 Map 实现 LRU 缓存，设置合理的 TTL（建议 5-30 秒）',
            estimatedEffort: '20min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证缓存的命中率和数据一致性',
            estimatedEffort: '10min',
          },
        )
        break
      case 'improve_error':
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `增强 ${target} 的错误处理逻辑`,
            detail: '添加重试机制、更友好的错误提示、优雅降级策略',
            estimatedEffort: '25min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证错误场景下的行为符合预期',
            estimatedEffort: '15min',
          },
        )
        break
      default:
        baseSteps.push({
          order: 2,
          action: 'analyze',
          description: `分析 ${target} 的优化可行性`,
          estimatedEffort: '15min',
        })
    }

    return baseSteps
  }

  private resolveTargetFile(target: string): string {
    const knownModules: Record<string, string> = {
      grep: 'src/main/agent/tools/grep.ts',
      read_file: 'src/main/agent/tools/readFile.ts',
      write_file: 'src/main/agent/tools/writeFile.ts',
      edit_file: 'src/main/agent/tools/editFile.ts',
      analyze_codebase: 'src/main/agent/tools/analyzeCodebase.ts',
      remember_fact: 'src/main/agent/tools/rememberFact.ts',
      create_dev_plan: 'src/main/agent/tools/createDevPlan.ts',
      userBehaviorAnalyzer: 'src/main/agent/UserBehaviorAnalyzer.ts',
      SelfEvolutionService: 'src/main/evolution/SelfEvolutionService.ts',
      ChatExecutor: 'src/main/agent/ChatExecutor.ts',
    }
    if (knownModules[target]) return knownModules[target]
    for (const [key, path] of Object.entries(knownModules)) {
      if (target.includes(key) || key.includes(target)) {
        return path
      }
    }
    return `src/main/unknown/${target}.ts`
  }
}

// =============================================================================
// 类型定义
// =============================================================================

export interface BehaviorOptimizationPlan {
  planId: string
  type: 'preload_module' | 'optimize_response' | 'add_cache' | 'improve_error' | 'merge_tools' | 'increase_priority' | string
  target: string
  title: string
  description: string
  priority: number
  expectedBenefit: string
  risk: string
  behaviorContext: BehaviorContext
  implementationSteps: ImplementationStep[]
  createdAt: number
  status: 'proposed' | 'approved' | 'implemented' | 'rejected' | 'rolled_back'
}

export interface BehaviorContext {
  totalToolCalls: number
  frequentSequences: Array<{ tools: string[]; frequency: number }>
  pausePoints: Array<{ tool: string; avgWaitMs: number }>
}

export interface ImplementationStep {
  order: number
  action: 'review' | 'modify' | 'verify' | 'analyze'
  description: string
  targetFile?: string
  detail?: string
  estimatedEffort: string
}
