/**
 * ChapterConsistencyExecutor — 章节一致性补丁执行器
 *
 * 接收 ChapterConsistencyCollector 采集的 chapter Problem，
 * 针对每章的不一致项生成多个文本补丁方案，按评分排序，
 * 最高分方案自动应用，低分则暂停并标记为需人工审查。
 *
 * 流程：
 * 1. 解析 Problem 元数据，获取不一致项列表
 * 2. 读取目标章节文件的完整内容
 * 3. 调用 LLM 为每个不一致项生成候选补丁方案（3 个方案）
 * 4. 对每个补丁方案评分（考虑修复准确性、文风兼容性、风险）
 * 5. 最优方案评分 >= THRESHOLD_AUTO_APPLY → Git 快照 → 应用补丁 → 验证 → 提交
 * 6. 最优方案评分 < THRESHOLD_AUTO_APPLY → 跳过，标记为低分待审查
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'
import { EvolutionGitOps } from '@akemi-mio/evolution-core'
import type { AssignedProblem, FixResult, FixExecutor, ProblemSource } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 支持的来源类型 */
const SUPPORTED_SOURCES: ProblemSource[] = ['chapter']

/** 执行超时（毫秒） */
const EXEC_TIMEOUT_MS = 300_000

/** 两次执行最小间隔 */
const MIN_INTERVAL_MS = 30_000

/** 自动应用的最低评分阈值（0-100） */
const THRESHOLD_AUTO_APPLY = 70

/** 低分暂停阈值（低于此值标记为需人工审查） */
const THRESHOLD_LOW_SCORE = 40

/** 每项不一致生成的候选补丁数 */
const CANDIDATES_PER_ISSUE = 3

/** LLM 调用超时 */
const LLM_TIMEOUT_MS = 120_000

/** LLM 重试次数 */
const MAX_RETRIES = 2

// =============================================================================
// 类型
// =============================================================================

/** 候选补丁方案 */
interface PatchCandidate {
  /** 方案索引 */
  index: number
  /** 补丁描述 */
  description: string
  /** 替换原文（用于在文件中定位） */
  originalText: string
  /** 替换文本 */
  newText: string
  /** 修复评分 0-100 */
  score: number
  /** 风险等级 */
  risk: 'low' | 'medium' | 'high'
  /** 评分解释 */
  scoreRationale: string
}

/** LLM 返回的补丁生成结果 */
interface PatchGenerationResult {
  candidates: Array<{
    description: string
    originalText: string
    newText: string
    score: number
    risk: 'low' | 'medium' | 'high'
    scoreRationale: string
  }>
}

// =============================================================================
// 执行器
// =============================================================================

export class ChapterConsistencyExecutor implements FixExecutor {
  readonly name = 'chapter-consistency-executor'
  readonly supportedSources: ProblemSource[] = SUPPORTED_SOURCES
  readonly timeoutMs = EXEC_TIMEOUT_MS

  private lastExecuteAt = 0
  private busy = false
  private gitOps: EvolutionGitOps

  constructor() {
    this.gitOps = new EvolutionGitOps()
  }

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < MIN_INTERVAL_MS) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    try {
      // 1. 解析问题元数据
      const chapterNumber = parseInt(problem.context.metadata?.chapterNumber || '0', 10)
      const issueCount = parseInt(problem.context.metadata?.issueCount || '0', 10)
      const healthScore = parseInt(problem.context.metadata?.healthScore || '0', 10)

      if (!chapterNumber || !problem.file) {
        return {
          problemId: problem.id,
          success: false,
          summary: `章节编号或文件路径缺失（chapter=${chapterNumber}, file=${problem.file}）`,
          durationMs: Date.now() - startedAt,
          error: 'MISSING_METADATA',
        }
      }

      // 解析不一致项列表
      let issues: any[]
      try {
        issues = JSON.parse(problem.context.raw)
      } catch {
        issues = []
      }

      if (issues.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: `第${chapterNumber}章无有效不一致项，跳过修复`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 2. 读取章节文件
      const absFile = resolve(process.cwd(), problem.file)
      if (!existsSync(absFile)) {
        return {
          problemId: problem.id,
          success: false,
          summary: `章节文件不存在: ${problem.file}`,
          durationMs: Date.now() - startedAt,
          error: 'FILE_NOT_FOUND',
        }
      }

      const chapterContent = readFileSync(absFile, 'utf-8')

      log('INFO', 'chapter_exec_start', {
        problemId: problem.id,
        chapter: chapterNumber,
        issues: issues.length,
        healthScore,
        file: problem.file,
      })

      // 3. 为每个不一致项生成补丁方案
      const allPatches: { issue: any; candidates: PatchCandidate[] }[] = []
      let totalPatches = 0

      for (const issue of issues) {
        const result = await this.generatePatches(issue, chapterContent, chapterNumber)
        if (result && result.candidates.length > 0) {
          const candidates = result.candidates.map((c, i) => ({
            index: i,
            description: c.description,
            originalText: c.originalText,
            newText: c.newText,
            score: Math.max(0, Math.min(100, c.score)),
            risk: c.risk || 'medium',
            scoreRationale: c.scoreRationale || '',
          }))
          allPatches.push({ issue, candidates })
          totalPatches += candidates.length
        }
      }

      if (allPatches.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: `第${chapterNumber}章：LLM 未生成可用补丁方案，跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      log('INFO', 'chapter_exec_patches_generated', {
        chapter: chapterNumber,
        patchedIssues: allPatches.length,
        totalPatches,
      })

      // 4. 评估所有补丁方案，选择最优
      const bestPatch = this.selectBestPatch(allPatches)

      if (!bestPatch) {
        return {
          problemId: problem.id,
          success: true,
          summary: `第${chapterNumber}章：无法选择最优补丁`,
          durationMs: Date.now() - startedAt,
        }
      }

      log('INFO', 'chapter_exec_best_patch', {
        chapter: chapterNumber,
        score: bestPatch.candidate.score,
        risk: bestPatch.candidate.risk,
        description: bestPatch.candidate.description.slice(0, 100),
      })

      // 5. 根据评分决定动作
      if (bestPatch.candidate.score >= THRESHOLD_AUTO_APPLY) {
        // 自动应用补丁
        return await this.applyPatch(absFile, chapterContent, bestPatch, chapterNumber, problem.id, startedAt)
      } else if (bestPatch.candidate.score >= THRESHOLD_LOW_SCORE) {
        // 评分不足，建议用户审查
        return {
          problemId: problem.id,
          success: true,
          summary:
            `第${chapterNumber}章一致性修复建议（评分 ${bestPatch.candidate.score}/100，低于自动阈值 ${THRESHOLD_AUTO_APPLY}，需人工审查）\n` +
            `问题: ${bestPatch.issue.title}\n` +
            `方案: ${bestPatch.candidate.description}\n` +
            `原文: ${bestPatch.candidate.originalText.slice(0, 100)}...\n` +
            `建议: ${bestPatch.candidate.newText.slice(0, 100)}...`,
          durationMs: Date.now() - startedAt,
          output: JSON.stringify({
            suggestedPatch: bestPatch.candidate,
            allPatches: allPatches.map((p) => ({
              issue: p.issue.title,
              candidates: p.candidates.map((c) => ({
                score: c.score,
                risk: c.risk,
                description: c.description,
              })),
            })),
          }),
        }
      } else {
        // 低分暂停
        return {
          problemId: problem.id,
          success: true,
          summary:
            `第${chapterNumber}章：所有补丁方案评分过低（最优 ${bestPatch.candidate.score}/100），` +
            `已暂停自动修复，需要人工评估。\n` +
            `主要问题: ${bestPatch.issue.title}\n` +
            `建议: ${bestPatch.candidate.description}`,
          durationMs: Date.now() - startedAt,
          output: JSON.stringify({
            lowScore: true,
            bestScore: bestPatch.candidate.score,
            suggestion: bestPatch.candidate.description,
          }),
        }
      }
    } catch (err: any) {
      log('ERROR', 'chapter_exec_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `执行异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: err.message,
      }
    } finally {
      this.busy = false
    }
  }

  // ─────────────────────────────────────────────
  //  补丁生成
  // ─────────────────────────────────────────────

  /**
   * 为单个不一致项生成补丁方案。
   */
  private async generatePatches(issue: any, chapterContent: string, chapterNumber: number): Promise<PatchGenerationResult | null> {
    const { text } = getRuntimeLlmConfig({ getCredential: (key) => credentialsManager.get(key) })
    const apiUrl = text.apiUrl
    const apiKey = text.apiKey
    const model = text.model

    if (!apiKey) {
      log('WARN', 'chapter_exec_no_llm_key')
      return null
    }

    const systemPrompt = `你是一个专业的小说文本润色助手。你的任务是为章节中的不一致问题生成多个修正方案。

对于给定的问题描述和原文片段，你需要生成 ${CANDIDATES_PER_ISSUE} 个不同的修正方案。
每个方案需要：
1. description: 方案简述（说明如何修复）
2. originalText: 需要替换的原文片段（必须与原文完全一致）
3. newText: 替换后的新文本
4. score: 方案质量评分（0-100），考虑：修复准确性、与原文风格匹配度、修改风险
5. risk: 风险等级（low/medium/high）
6. scoreRationale: 评分理由

要求：
- originalText 必须精确匹配原文中的内容（可包含换行）
- newText 应保持与周围文本一致的文风
- 评分低于 60 的方案不要输出（质量不足）
- 输出严格 JSON 格式

JSON 结构：
{
  "candidates": [
    {
      "description": "方案描述",
      "originalText": "原文片段",
      "newText": "替换文本",
      "score": 85,
      "risk": "low",
      "scoreRationale": "该方案精确修复了角色名称不一致问题...且保持了原文的行文风格"
    }
  ]
}`

    const prompt = [
      `# 章节 ${chapterNumber} — 文本不一致修复`,
      '',
      '## 问题描述',
      `类型: ${issue.type || 'unknown'}`,
      `标题: ${issue.title || ''}`,
      `严重程度: ${issue.severity || 'minor'}`,
      `详细: ${issue.description || ''}`,
      '',
      '## 关联的设计文档要求',
      issue.relatedGuideline || '无',
      '',
      '## 建议方向',
      issue.suggestion || '',
      '',
      '## 原文中出问题的片段',
      issue.originalText || '',
      '',
      '## 章节上下文（问题片段附近）',
      this.extractContext(chapterContent, issue.originalText),
      '',
      `请生成 ${CANDIDATES_PER_ISSUE} 个修正方案，覆盖不同修复策略。`,
    ].join('\n')

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            stream: false,
            temperature: 0.4,
          }),
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) {
          log('WARN', 'chapter_exec_llm_api_error', { attempt, status: res.status })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
        const reply = data.choices?.[0]?.message?.content?.trim() || ''

        const jsonStr = this.extractJSON(reply)
        if (!jsonStr) {
          log('WARN', 'chapter_exec_llm_no_json', { attempt })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        const parsed = JSON.parse(jsonStr) as PatchGenerationResult
        if (!parsed.candidates || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
          log('WARN', 'chapter_exec_llm_empty_candidates', { attempt })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        return parsed
      } catch (err: any) {
        log('WARN', 'chapter_exec_llm_error', { attempt, error: err.message })
        if (attempt < MAX_RETRIES) continue
      }
    }

    return null
  }

  /**
   * 从章节内容中提取问题片段附近的上下文。
   */
  private extractContext(fullContent: string, originalText: string): string {
    if (!originalText) return ''

    const index = fullContent.indexOf(originalText)
    if (index === -1) return originalText

    const start = Math.max(0, index - 500)
    const end = Math.min(fullContent.length, index + originalText.length + 500)
    let context = fullContent.slice(start, end)

    // 在上下文前后添加标记
    const beforeMarker = '>>> 上下文开始 >>>'
    const afterMarker = '<<< 上下文结束 <<<'
    const issueStart = index - start
    const issueEnd = issueStart + originalText.length

    context =
      context.slice(0, issueStart) + '【问题片段开始】' + context.slice(issueStart, issueEnd) + '【问题片段结束】' + context.slice(issueEnd)

    return `${beforeMarker}\n${context}\n${afterMarker}`
  }

  // ─────────────────────────────────────────────
  //  补丁选择
  // ─────────────────────────────────────────────

  /**
   * 从所有补丁方案中选择最优的。
   * 优先选择低风险、高评分方案。
   */
  private selectBestPatch(allPatches: { issue: any; candidates: PatchCandidate[] }[]): { issue: any; candidate: PatchCandidate } | null {
    if (allPatches.length === 0) return null

    // 展平所有方案
    const flat = allPatches.flatMap((p) => p.candidates.map((c) => ({ issue: p.issue, candidate: c })))

    // 按评分排序（降序），同分时低风险优先
    flat.sort((a, b) => {
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score
      const riskOrder = { low: 0, medium: 1, high: 2 }
      return riskOrder[a.candidate.risk] - riskOrder[b.candidate.risk]
    })

    return flat[0] || null
  }

  // ─────────────────────────────────────────────
  //  补丁应用
  // ─────────────────────────────────────────────

  /**
   * 应用最优补丁方案。
   * 创建 Git 快照 → 替换文本 → 验证 → 提交或回滚。
   */
  private async applyPatch(
    absFile: string,
    originalContent: string,
    bestPatch: { issue: any; candidate: PatchCandidate },
    chapterNumber: number,
    problemId: string,
    startedAt: number,
  ): Promise<FixResult> {
    const { candidate, issue } = bestPatch

    // 1. 创建 Git 快照
    const snapshotBranch = await this.gitOps.createSnapshot(`chapter_consistency_${chapterNumber}_${Date.now()}`)
    if (!snapshotBranch) {
      log('WARN', 'chapter_exec_snapshot_failed', { chapter: chapterNumber })
    }

    // 2. 验证原文在文件中存在
    const originalText = candidate.originalText
    if (!originalContent.includes(originalText)) {
      await this.rollback(snapshotBranch, problemId)
      return {
        problemId,
        success: false,
        summary: `第${chapterNumber}章：原文片段在文件中不存在，无法应用补丁\n查找: "${originalText.slice(0, 100)}"`,
        durationMs: Date.now() - startedAt,
        error: 'ORIGINAL_TEXT_NOT_FOUND',
      }
    }

    // 3. 应用补丁
    const newContent = originalContent.replace(originalText, candidate.newText)

    // 验证替换次数（避免意外替换过多）
    const replaceCount = (originalContent.match(new RegExp(this.escapeRegex(originalText), 'g')) || []).length
    if (replaceCount > 1 && originalText.length < 20) {
      log('WARN', 'chapter_exec_multi_replace', {
        chapter: chapterNumber,
        count: replaceCount,
        originalText: originalText.slice(0, 50),
      })
      // 短文本多次匹配时使用首次替换（默认行为）
    }

    try {
      writeFileSync(absFile, newContent, 'utf-8')
    } catch (err: any) {
      await this.rollback(snapshotBranch, problemId)
      return {
        problemId,
        success: false,
        summary: `第${chapterNumber}章：写入文件失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'WRITE_FAILED',
      }
    }

    // 4. 格式化校验（基本检查）
    const formatOk = this.validateFormat(newContent)
    if (!formatOk) {
      await this.rollback(snapshotBranch, problemId)
      return {
        problemId,
        success: false,
        summary: `第${chapterNumber}章：补丁应用后格式校验未通过，已回滚`,
        durationMs: Date.now() - startedAt,
        error: 'FORMAT_CHECK_FAILED',
      }
    }

    // 5. 格式校验通过 → 提交
    if (snapshotBranch) {
      try {
        await this.gitOps.autoGitCommit(`[chapter] 第${chapterNumber}章一致性修复: ${candidate.description.slice(0, 60)}`)
        await this.gitOps.cleanupSnapshot(snapshotBranch)
      } catch (err: any) {
        log('WARN', 'chapter_exec_commit_failed', { chapter: chapterNumber, error: err.message })
        // 提交失败不阻塞——补丁已成功应用
      }
    }

    const elapsedMs = Date.now() - startedAt

    log('INFO', 'chapter_exec_apply_success', {
      chapter: chapterNumber,
      issue: issue.title,
      score: candidate.score,
      risk: candidate.risk,
      durationMs: elapsedMs,
      description: candidate.description.slice(0, 80),
    })

    return {
      problemId,
      success: true,
      summary:
        `✅ 第${chapterNumber}章一致性自动修复成功（评分 ${candidate.score}/100, 风险 ${candidate.risk}）\n` +
        `问题: ${issue.title}\n` +
        `方案: ${candidate.description}\n` +
        `耗时: ${(elapsedMs / 1000).toFixed(0)}s`,
      durationMs: elapsedMs,
      output: JSON.stringify({
        chapter: chapterNumber,
        issueType: issue.type,
        appliedPatch: {
          originalText: originalText.slice(0, 200),
          newText: candidate.newText.slice(0, 200),
          score: candidate.score,
          risk: candidate.risk,
        },
      }),
    }
  }

  // ─────────────────────────────────────────────
  //  工具方法
  // ─────────────────────────────────────────────

  /**
   * 基本的 Markdown 格式校验。
   * 检查补丁应用后的文件是否仍具有合理的结构。
   */
  private validateFormat(content: string): boolean {
    if (!content || content.trim().length === 0) return false

    const lines = content.split('\n')

    // 检查文件是否仍然有合理长度
    if (lines.length < 3) return false

    // 检查没有出现明显损坏的标记
    const corruptPatterns = [
      /[\\]{3,}/, // 连续反斜杠
      /\0/, // null 字节
      /undefined/, // 意外出现 undefined
      /\[\/\/\]/, // LLM 占位符
    ]

    for (const pattern of corruptPatterns) {
      if (pattern.test(content)) return false
    }

    return true
  }

  /**
   * 转义正则表达式特殊字符。
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 从 LLM 回复中提取 JSON。
   */
  private extractJSON(reply: string): string | null {
    const fenceMatch = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) return fenceMatch[1].trim()
    const braceMatch = reply.match(/\{[\s\S]*\}/)
    if (braceMatch) return braceMatch[0]
    return null
  }

  /**
   * 回滚到 Git 快照。
   */
  private async rollback(snapshotBranch: string | null, problemId: string): Promise<void> {
    if (!snapshotBranch) {
      log('WARN', 'chapter_exec_no_snapshot_rollback', { problemId })
      return
    }
    try {
      const success = await this.gitOps.rollbackToSnapshot(snapshotBranch)
      if (success) {
        await this.gitOps.cleanupSnapshot(snapshotBranch)
        log('INFO', 'chapter_exec_rollback_ok', { problemId })
      } else {
        log('ERROR', 'chapter_exec_rollback_failed', { problemId })
      }
    } catch (err: any) {
      log('ERROR', 'chapter_exec_rollback_error', { problemId, error: err.message })
    }
  }
}
