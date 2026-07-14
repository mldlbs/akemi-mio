/**
 * ChapterConsistencyCollector — 章节一致性采集器
 *
 * 利用 Evolution 2 小时周期自动监控第 19-27 章节重写一致性。
 *
 * 流程：
 * 1. 扫描章节文件（19-27 章），检查是否有内容变更
 * 2. 读取设计文档（docs/ 目录下的 .md 文件）
 * 3. 使用 LLM 评估人物设定、时间线、设计偏离等
 * 4. 生成结构化不一致性问题列表（Problem[]）
 *
 * 与 WritingPlanAgent 的关系：
 * - WritingPlanAgent 提供可交互的按需对比工具
 * - 本采集器是自动化后台巡检，将检测结果注入 Evolution 管道
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { log } from '../../logger/Logger'
import {
  LLM_TEXT_API_URL,
  LLM_TEXT_KEY,
  LLM_TEXT_MODEL,
  LLM_API_URL,
  LLM_CHAT_MODEL,
} from '../../config'
import type { Problem, ProblemSource, Severity, SignalCollector } from './types'

// =============================================================================
// 常量 & 配置
// =============================================================================

/** 默认章节目录（相对于项目根目录） */
const DEFAULT_CHAPTERS_DIR = 'docs/chapters'

/** 默认设计文档路径（相对于项目根目录） */
const DEFAULT_DESIGN_DOC = 'docs/工业颂歌_完整设计体系.md'

/** 监控的章节范围 */
const CHAPTER_START = 19
const CHAPTER_END = 27

/** 两次执行最小间隔（防止同批次重复分析） */
const MIN_INTERVAL_MS = 25 * 60 * 1000

/** 首 18 章关键信息缓存文件（相对于项目根目录） */
const EARLY_CHAPTERS_SUMMARY_PATH = 'docs/前18章摘要.md'

/** LLM 调用超时（毫秒） */
const LLM_TIMEOUT_MS = 180_000

/** 最大 LLM 重试次数 */
const MAX_RETRIES = 2

// =============================================================================
// 类型
// =============================================================================

interface ChapterFile {
  number: number
  path: string
  mtimeMs: number
  content: string
}

/**
 * LLM 返回的结构化分析结果（单章不一致项）
 */
export interface ChapterInconsistency {
  /** 不一致类型 */
  type: 'character_deviation' | 'timeline_error' | 'design_deviation' | 'style_mismatch' | 'plot_contradiction'
  /** 章节编号 */
  chapterNumber: number
  /** 严重程度 */
  severity: 'critical' | 'major' | 'minor'
  /** 问题标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 原文片段（供后续补丁定位） */
  originalText: string
  /** 建议修正描述 */
  suggestion: string
  /** LLM 置信度 0-1 */
  confidence: number
  /** 关联的设计文档要求 */
  relatedGuideline: string
}

/**
 * LLM 分析返回的完整报告结构
 */
interface AnalysisReport {
  chapterAnalyses: ChapterInconsistency[]
  summary: {
    totalIssues: number
    criticalCount: number
    majorCount: number
    minorCount: number
    overallHealthScore: number // 0-100
  }
}

// =============================================================================
// 采集器
// =============================================================================

export class ChapterConsistencyCollector implements SignalCollector {
  readonly name = 'chapter-consistency'
  readonly source: ProblemSource = 'chapter'

  private lastRun = 0
  /** 上一次扫描时各章节文件的 mtime 快照，用于增量检测 */
  private chapterMtimeCache: Map<number, number> = new Map()
  /** 项目根目录 */
  private projectRoot: string

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd()
  }

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    try {
      // Step 1: 收集章节文件
      const chapters = this.collectChapterFiles(CHAPTER_START, CHAPTER_END)
      if (chapters.length === 0) {
        log('INFO', 'chapter_collector_no_files', {
          dir: DEFAULT_CHAPTERS_DIR,
          range: `${CHAPTER_START}-${CHAPTER_END}`,
        })
        return []
      }

      // Step 2: 增量检测 — 只有有关键变更的章节才需重新分析
      const changedChapters = this.getChangedChapters(chapters)
      if (changedChapters.length === 0) {
        log('INFO', 'chapter_collector_no_changes', {
          total: chapters.length,
        })
        return []
      }

      // Step 3: 读取设计文档
      const designDoc = this.readDesignDoc()
      if (!designDoc) {
        log('WARN', 'chapter_collector_no_design_doc', {
          path: DEFAULT_DESIGN_DOC,
        })
        return []
      }

      // Step 4: 读取前18章摘要（如果存在）
      const earlyChaptersSummary = this.readEarlyChaptersSummary()

      log('INFO', 'chapter_collector_start_analysis', {
        changedChapters: changedChapters.length,
        chapters: changedChapters.map((c) => c.number),
        hasDesignDoc: !!designDoc,
        hasEarlySummary: !!earlyChaptersSummary,
      })

      // Step 5: 调用 LLM 进行一致性分析
      const report = await this.analyzeWithLLM(changedChapters, designDoc, earlyChaptersSummary)

      // Step 6: 转换为 Problem[]
      const problems = this.reportToProblems(report, changedChapters)

      // Step 7: 更新 mtime 缓存
      for (const ch of chapters) {
        this.chapterMtimeCache.set(ch.number, ch.mtimeMs)
      }

      log('INFO', 'chapter_collector_done', {
        changed: changedChapters.length,
        problems: problems.length,
        totalIssues: report?.summary?.totalIssues ?? 0,
        healthScore: report?.summary?.overallHealthScore ?? -1,
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'chapter_collector_error', { error: err.message })
      return []
    }
  }

  // ─────────────────────────────────────────────
  //  文件操作
  // ─────────────────────────────────────────────

  /**
   * 扫描章节目录，收集已变更的章节文件。
   */
  private collectChapterFiles(start: number, end: number): ChapterFile[] {
    const dirPath = resolve(this.projectRoot, DEFAULT_CHAPTERS_DIR)
    if (!existsSync(dirPath)) {
      // 尝试备用路径
      const altPath = resolve(this.projectRoot, 'docs', 'chapters')
      if (!existsSync(altPath)) return []
      return this.scanDir(altPath, start, end)
    }
    return this.scanDir(dirPath, start, end)
  }

  private scanDir(dirPath: string, start: number, end: number): ChapterFile[] {
    try {
      const files = readdirSync(dirPath)
      const chapters: ChapterFile[] = []

      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const match = file.match(/(\d+)/)
        if (!match) continue
        const num = parseInt(match[1], 10)
        if (num < start || num > end) continue

        const fullPath = join(dirPath, file)
        const stat = statSync(fullPath)
        if (!stat.isFile()) continue
        const content = readFileSync(fullPath, 'utf-8')

        chapters.push({
          number: num,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          content,
        })
      }

      return chapters.sort((a, b) => a.number - b.number)
    } catch {
      return []
    }
  }

  /**
   * 增量检测：只筛选出 mtime 有变化的章节。
   */
  private getChangedChapters(chapters: ChapterFile[]): ChapterFile[] {
    // 首次运行：全部检测
    if (this.chapterMtimeCache.size === 0) return chapters

    return chapters.filter((ch) => {
      const cached = this.chapterMtimeCache.get(ch.number)
      return cached === undefined || ch.mtimeMs > cached
    })
  }

  /**
   * 读取设计文档。
   */
  private readDesignDoc(): string | null {
    const paths = [
      resolve(this.projectRoot, DEFAULT_DESIGN_DOC),
      resolve(this.projectRoot, 'docs', '工业颂歌_完整设计体系.md'),
      resolve(this.projectRoot, 'docs', '设计体系.md'),
      resolve(this.projectRoot, 'docs', 'design_doc.md'),
    ]

    for (const p of paths) {
      if (existsSync(p) && statSync(p).isFile()) {
        const content = readFileSync(p, 'utf-8')
        // 截取前 15000 字符以避免 token 溢出
        return content.length > 15000 ? content.slice(0, 15000) + '\n\n...（截断）' : content
      }
    }

    return null
  }

  /**
   * 读取前 18 章摘要（如果存在）。
   */
  private readEarlyChaptersSummary(): string | null {
    const p = resolve(this.projectRoot, EARLY_CHAPTERS_SUMMARY_PATH)
    if (existsSync(p) && statSync(p).isFile()) {
      return readFileSync(p, 'utf-8').slice(0, 8000)
    }
    return null
  }

  // ─────────────────────────────────────────────
  //  LLM 分析
  // ─────────────────────────────────────────────

  /**
   * 调用 LLM 进行章节一致性分析，返回结构化报告。
   */
  private async analyzeWithLLM(
    chapters: ChapterFile[],
    designDoc: string,
    earlySummary: string | null,
  ): Promise<AnalysisReport | null> {
    const apiUrl = LLM_TEXT_API_URL || LLM_API_URL
    const apiKey = LLM_TEXT_KEY || process.env.LLM_KEY || ''
    const model = LLM_TEXT_MODEL || LLM_CHAT_MODEL

    if (!apiKey) {
      log('WARN', 'chapter_collector_no_llm_key')
      return null
    }

    const systemPrompt = `你是一个专业的小说质量审核助手。你的任务是检查小说章节与设计文档的一致性。

检查维度：
1. character_deviation（角色偏差）：角色行为是否符合设计文档中的人物定位和成长弧线
2. timeline_error（时间线错误）：事件顺序是否与设计文档规划一致
3. design_deviation（设计偏离）：章节内容是否偏离设计文档的核心设定
4. style_mismatch（风格不匹配）：文风是否与设计文档要求的一致
5. plot_contradiction（情节矛盾）：章节内部或章节间是否存在情节冲突

对于每个问题，需要输出：
- type: 问题类型
- chapterNumber: 章节编号
- severity: critical（关键/需立即修复）/ major（重要/建议修改）/ minor（轻微/可忽略）
- title: 简短的问题标题
- description: 详细的问题描述（中文）
- originalText: 原文中出问题的片段（50-200字）
- suggestion: 具体的修改建议
- confidence: 你对这个问题的把握程度（0-1）
- relatedGuideline: 关联的设计文档要求

输出严格 JSON 格式，不要包含任何额外文字。JSON 结构：
{
  "chapterAnalyses": [
    { "type": "...", "chapterNumber": N, "severity": "...", "title": "...", "description": "...", "originalText": "...", "suggestion": "...", "confidence": 0.9, "relatedGuideline": "..." }
  ],
  "summary": {
    "totalIssues": 0,
    "criticalCount": 0,
    "majorCount": 0,
    "minorCount": 0,
    "overallHealthScore": 85
  }
}`

    const chaptersText = chapters
      .map((ch) => `===== 第${ch.number}章 =====\n${ch.content.slice(0, 3000)}`)
      .join('\n\n')

    const prompt = [
      '请分析以下章节与设计文档的一致性。',
      '',
      '## 设计文档（核心设定）',
      designDoc.slice(0, 10000),
      '',
      ...(earlySummary ? ['## 前18章关键信息', earlySummary, ''] : []),
      '## 待检查章节',
      chaptersText,
      '',
      '请逐章检查，输出每章发现的所有不一致问题。',
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
            temperature: 0.2,
          }),
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) {
          log('WARN', 'chapter_collector_llm_api_error', {
            attempt,
            status: res.status,
          })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
        const reply = data.choices?.[0]?.message?.content?.trim() || ''

        // 尝试从 markdown 围栏中提取 JSON
        const jsonStr = this.extractJSON(reply)
        if (!jsonStr) {
          log('WARN', 'chapter_collector_llm_no_json', { attempt })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        const parsed = JSON.parse(jsonStr) as AnalysisReport

        // 验证结构完整性
        if (!parsed.chapterAnalyses || !Array.isArray(parsed.chapterAnalyses)) {
          log('WARN', 'chapter_collector_invalid_structure', { attempt })
          if (attempt < MAX_RETRIES) continue
          return null
        }

        return parsed
      } catch (err: any) {
        log('WARN', 'chapter_collector_llm_error', {
          attempt,
          error: err.message,
        })
        if (attempt < MAX_RETRIES) continue
      }
    }

    return null
  }

  /**
   * 从 LLM 回复中提取 JSON（支持 markdown 围栏和纯 JSON）。
   */
  private extractJSON(reply: string): string | null {
    // 尝试 markdown 围栏
    const fenceMatch = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) return fenceMatch[1].trim()

    // 尝试顶层 { ... }
    const braceMatch = reply.match(/\{[\s\S]*\}/)
    if (braceMatch) return braceMatch[0]

    return null
  }

  // ─────────────────────────────────────────────
  //  Problem 转换
  // ─────────────────────────────────────────────

  /**
   * 将 LLM 分析报告转换为 Problem[]。
   * 只包含 confidence >= 0.6 的问题（降低误报率）。
   */
  private reportToProblems(report: AnalysisReport | null, chapters: ChapterFile[]): Problem[] {
    if (!report || !report.chapterAnalyses || report.chapterAnalyses.length === 0) {
      return []
    }

    const MIN_CONFIDENCE = 0.6

    const validIssues = report.chapterAnalyses.filter((issue) => issue.confidence >= MIN_CONFIDENCE)

    if (validIssues.length === 0) {
      log('INFO', 'chapter_collector_all_low_confidence')
      return []
    }

    // 按章节分组，每章产出一个问题（包含该章所有不一致项）
    const byChapter = new Map<number, ChapterInconsistency[]>()
    for (const issue of validIssues) {
      const list = byChapter.get(issue.chapterNumber) || []
      list.push(issue)
      byChapter.set(issue.chapterNumber, list)
    }

    const severityMap: Record<string, Severity> = {
      critical: 'error',
      major: 'warning',
      minor: 'info',
    }

    const problems: Problem[] = []

    for (const [chapterNumber, issues] of byChapter) {
      const chapter = chapters.find((c) => c.number === chapterNumber)
      const worstSeverity = issues.reduce((worst, i) => {
        const order = { critical: 3, major: 2, minor: 1 }
        return order[i.severity] > order[worst] ? i.severity : worst
      }, 'minor' as 'critical' | 'major' | 'minor')

      const issueSummaries = issues.map((i) => `[${i.severity}] ${i.title}: ${i.description.slice(0, 100)}`)

      problems.push({
        id: `chapter:${chapterNumber}:${Date.now()}`,
        source: 'chapter',
        severity: severityMap[worstSeverity] || 'warning',
        title: `第${chapterNumber}章一致性偏差 (${issues.length}项)`,
        description: issueSummaries.join('\n'),
        file: chapter?.path || '',
        line: 0,
        estimatedCostChars: issues.reduce((s, i) => s + i.description.length + i.suggestion.length, 0),
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: JSON.stringify(issues, null, 2),
          snippet: issues
            .slice(0, 3)
            .map((i) => `[${i.severity}] ${i.title}\n原文: ${i.originalText.slice(0, 200)}\n建议: ${i.suggestion.slice(0, 200)}`)
            .join('\n---\n'),
          metadata: {
            chapterNumber: String(chapterNumber),
            issueCount: String(issues.length),
            criticalCount: String(issues.filter((i) => i.severity === 'critical').length),
            majorCount: String(issues.filter((i) => i.severity === 'major').length),
            healthScore: String(report.summary?.overallHealthScore ?? -1),
          },
        },
      })
    }

    return problems
  }
}
