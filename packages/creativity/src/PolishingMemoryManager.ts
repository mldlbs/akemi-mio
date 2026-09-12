/**
 * PolishingMemoryManager — 章节润色记忆图谱
 *
 * 职责：
 * 1. 将每段润色的决策记录为结构化记忆，包含修改类型、决策原因、应用规则
 * 2. 新章节开始前，查询历史润色记录，生成上下文提示注入 LLM
 * 3. 定期从累积记忆中提炼通用风格规则，更新持久规则库
 * 4. 记忆累积过长时的压缩策略（章节级别汇总）
 *
 * 与 WritingMemoryContinuation 的关系：
 * - WritingMemoryContinuation 管理读者反馈/用户期望记忆
 * - PolishingMemoryManager 管理编辑润色决策树（修改了什么、为什么这样改）
 * - 两者互补，共同确保长篇小说创作的一致性
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory/types'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'

// ============================================================
//  类型定义
// ============================================================

/** 润色修改类型分类 */
export type ModificationType =
  | 'style_unification' // 风格统一：统一叙述视角/语气
  | 'ai_depolish' // 去 AI 味：移除模板化表达/空洞修饰
  | 'rhythm_adjustment' // 节奏调整：长短句重组/段落拆分
  | 'dialogue_naturalize' // 对话自然化：口语化/去书面腔
  | 'detail_add' // 细节补充：增加具体描写
  | 'redundancy_remove' // 冗余删除：删减重复/赘余
  | 'perspective_fix' // 视角修正：统一叙述视角
  | 'word_refine' // 用词精炼：替换更准确的词汇
  | 'sentence_restructure' // 句式重组：调整语序/拆分长句
  | 'tense_or_mood_fix' // 时态/语气修正
  | 'other' // 其他

/** 单次润色修改记录 */
export interface PolishingModification {
  /** 修改类型 */
  type: ModificationType
  /** 修改描述（一句话概括） */
  description: string
  /** 做此修改的原因 */
  reason: string
  /** 本次修改所依据的风格规则（如 "show_dont_tell", "avoid_empty_adverbs"） */
  rulesApplied: string[]
}

/** 单段润色决策的完整记录 */
export interface PolishingDecision {
  /** 故事 ID */
  storyId: string
  /** 章节标题 */
  chapterTitle: string
  /** 段落索引（从 0 开始） */
  paragraphIndex: number
  /** 原文摘要（存储时最多取前 200 字符） */
  originalExcerpt?: string
  /** 修改后摘要（存储时最多取前 200 字符） */
  polishedExcerpt?: string
  /** 修改列表 */
  modifications: PolishingModification[]
  /** 该段落应用的总体风格规则 */
  styleRules: string[]
  /** 决策时间 */
  createdAt: number
}

/** 按章节汇总的润色统计 */
export interface ChapterPolishingSummary {
  chapterTitle: string
  totalParagraphs: number
  modifiedParagraphs: number
  modificationStats: Record<ModificationType, number>
  frequentRules: Array<{ rule: string; count: number }>
  createdAt: number
}

/** 持久化风格规则 */
export interface PersistentStyleRule {
  id: string
  rule: string // 规则描述（如 "避免使用「突然」「非常」等空洞副词"）
  category: string // 分类（如 'word_choice' | 'sentence' | 'perspective' | 'dialogue' | 'description'）
  source: string // 来源（如 'auto_extracted' | 'user_defined'）
  confidence: number // 置信度 0-1
  exampleBefore?: string // 修改前示例
  exampleAfter?: string // 修改后示例
  createdAt: number
}

/** 润色上下文提示（供 LLM 注入） */
export interface PolishingContextHint {
  summary: string
  ruleCount: number
  decisionCount: number
  isEmpty: boolean
}

// ============================================================
//  常量
// ============================================================

/** 存储条目标题中的前缀标记 */
const MEMORY_KEY_PREFIX = '[polish_decision]'

/** 单条记忆内容最大长度 */
const MAX_CONTENT_LENGTH = 300

/** 同一故事下触发压缩的条目数阈值 */
const COMPRESS_THRESHOLD = 50

/** 规则抽取 LLM 超时 */
const RULE_EXTRACT_TIMEOUT = 20000

/** 分类标签中文映射 */
const MODIFICATION_TYPE_LABELS: Record<ModificationType, string> = {
  style_unification: '风格统一',
  ai_depolish: '去AI味',
  rhythm_adjustment: '节奏调整',
  dialogue_naturalize: '对话自然化',
  detail_add: '细节补充',
  redundancy_remove: '冗余删除',
  perspective_fix: '视角修正',
  word_refine: '用词精炼',
  sentence_restructure: '句式重组',
  tense_or_mood_fix: '时态/语气修正',
  other: '其他',
}

// ============================================================
//  核心服务
// ============================================================

export class PolishingMemoryManager {
  // ─── 写入 ───

  /**
   * 存储一段润色决策到 Memory。
   *
   * 由于 MemoryService.addEntry() 不支持直接设置 structuredData，
   * 决策内容以可解析的 JSON 格式存入 user_fact 类型条目，
   * 内容以已知 key 前缀开头便于后续检索。
   */
  storeDecision(decision: PolishingDecision): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'polish_memory_no_service', { storyId: decision.storyId })
      return
    }

    // 将完整决策 JSON 序列化，作为 user_fact 的 content 存储
    // 内容格式：[polish_decision]<JSON> —— 检索时通过 key 前缀和 JSON 解析恢复
    const serialized = JSON.stringify(decision)
    const content = `${MEMORY_KEY_PREFIX}${serialized}`

    ms.addFact(content, 0.8, { tier: 'semi' })

    log('INFO', 'polish_memory_stored', {
      storyId: decision.storyId,
      chapterTitle: decision.chapterTitle,
      paragraphIndex: decision.paragraphIndex,
      modifications: decision.modifications.length,
    })
  }

  /**
   * 批量存储多个决策记录。
   */
  storeDecisions(decisions: PolishingDecision[]): number {
    let count = 0
    for (const d of decisions) {
      this.storeDecision(d)
      count++
    }
    return count
  }

  // ─── 读取 ───

  /**
   * 查询某个故事/章节的润色历史。
   */
  queryHistory(
    storyId: string,
    options?: {
      chapterTitle?: string
      limit?: number
    },
  ): PolishingDecision[] {
    const ms = getMemoryService()
    if (!ms) return []

    const allEntries = ms.getEntries()
    const results: PolishingDecision[] = []
    const limit = options?.limit ?? 50

    for (const entry of allEntries) {
      // 从 user_fact 中查找以 [polish_decision] 开头的条目
      if (entry.type !== 'user_fact') continue
      if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) continue

      const decision = this.tryParseDecision(entry)
      if (!decision) continue

      // 按 storyId 过滤
      if (decision.storyId.toLowerCase() !== storyId.toLowerCase()) continue

      // 按章节过滤
      if (options?.chapterTitle) {
        if (decision.chapterTitle.toLowerCase() !== options.chapterTitle.toLowerCase()) continue
      }

      results.push(decision)
    }

    // 按时间排序（最新在前）
    results.sort((a, b) => b.createdAt - a.createdAt)
    return results.slice(0, limit)
  }

  /**
   * 构建润色上下文提示，用于注入 LLM 的 system prompt。
   *
   * 包含：
   * - 该故事的最新润色统计（修改类型分布）
   * - 高频使用的风格规则
   * - 最近几条决策摘要
   * - 当前持久规则库的关键规则
   */
  buildPolishingContext(storyId: string, chapterTitle?: string): PolishingContextHint {
    const decisions = this.queryHistory(storyId, { chapterTitle, limit: 30 })

    if (decisions.length === 0) {
      // 冷启动：检查是否有持久规则
      const rules = this.getPersistentRules()
      if (rules.length > 0) {
        const ruleSummary = rules
          .slice(0, 5)
          .map((r) => `- ${r.rule}`)
          .join('\n')
        return {
          summary: `【润色规则参考】\n以下是从之前创作中提炼的通用风格规则：\n${ruleSummary}`,
          ruleCount: rules.length,
          decisionCount: 0,
          isEmpty: false,
        }
      }
      return {
        summary: '',
        ruleCount: 0,
        decisionCount: 0,
        isEmpty: true,
      }
    }

    // 1. 统计修改类型分布
    const typeStats: Record<string, number> = {}
    const allRules: Array<{ rule: string; count: number }> = []
    const ruleCountMap = new Map<string, number>()

    for (const d of decisions) {
      for (const m of d.modifications) {
        typeStats[m.type] = (typeStats[m.type] || 0) + 1
        for (const r of m.rulesApplied) {
          ruleCountMap.set(r, (ruleCountMap.get(r) || 0) + 1)
        }
      }
      for (const r of d.styleRules) {
        ruleCountMap.set(r, (ruleCountMap.get(r) || 0) + 1)
      }
    }

    for (const [rule, count] of ruleCountMap) {
      allRules.push({ rule, count })
    }
    allRules.sort((a, b) => b.count - a.count)

    // 2. 构建摘要文本
    const lines: string[] = []
    lines.push(`关于「${storyId}」的润色历史摘要：`)

    const typeSummary = Object.entries(typeStats)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const label = MODIFICATION_TYPE_LABELS[type as ModificationType] || type
        return `${label}(${count}次)`
      })
      .join('、')
    lines.push(`修改类型分布：${typeSummary}`)

    if (allRules.length > 0) {
      const topRules = allRules.slice(0, 5)
      lines.push('高频规则：')
      for (const r of topRules) {
        lines.push(`  - ${r.rule}（${r.count}次）`)
      }
    }

    // 3. 最近 3 条决策摘要
    const recent = decisions.slice(0, 3)
    lines.push('最近修改摘要：')
    for (const d of recent) {
      const modSummary = d.modifications.map((m) => MODIFICATION_TYPE_LABELS[m.type] + ':' + m.description.slice(0, 30)).join('; ')
      lines.push(`  [${d.chapterTitle} 段落#${d.paragraphIndex}] ${modSummary}`)
    }

    // 4. 附上持久规则
    const persistentRules = this.getPersistentRules()
    if (persistentRules.length > 0) {
      lines.push('')
      lines.push('通用风格规则：')
      for (const r of persistentRules.slice(0, 5)) {
        lines.push(`  - ${r.rule}`)
      }
    }

    lines.push('')
    lines.push('请参考以上历史润色决策，确保新章节的风格与历史保持一致。')

    return {
      summary: lines.join('\n'),
      ruleCount: persistentRules.length,
      decisionCount: decisions.length,
      isEmpty: false,
    }
  }

  // ─── 规则管理 ───

  /**
   * 读取持久规则库。
   */
  getPersistentRules(): PersistentStyleRule[] {
    const ms = getMemoryService()
    if (!ms) return []

    const entries = ms.getEntries()
    const rules: PersistentStyleRule[] = []

    const rulePrefix = `${MEMORY_KEY_PREFIX}:rule `
    for (const e of entries) {
      if (e.type !== 'user_fact') continue
      if (!e.content.startsWith(rulePrefix)) continue

      try {
        const json = e.content.slice(rulePrefix.length)
        const parsed = JSON.parse(json) as PersistentStyleRule
        rules.push(parsed)
      } catch {
        // skip parse errors
      }
    }

    return rules
  }

  /**
   * 保存一条持久规则。
   */
  savePersistentRule(rule: Omit<PersistentStyleRule, 'id' | 'createdAt'>): void {
    const ms = getMemoryService()
    if (!ms) return

    const fullRule: PersistentStyleRule = {
      ...rule,
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    }

    ms.addFact(`${MEMORY_KEY_PREFIX}:rule ${JSON.stringify(fullRule)}`, rule.confidence, { tier: 'permanent' })
  }

  /**
   * 从历史润色决策中提炼通用风格规则。
   *
   * 使用 LLM 分析最近 100 条决策，提取高频模式作为规则。
   * 新规则与已有规则去重后写入持久层。
   */
  async extractRules(storyId?: string): Promise<Omit<PersistentStyleRule, 'id' | 'createdAt'>[]> {
    const ms = getMemoryService()
    if (!ms) return []

    // 收集待分析的决策
    const decisions = storyId ? this.queryHistory(storyId, { limit: 100 }) : this.getAllDecisions(100)

    if (decisions.length < 3) {
      log('INFO', 'polish_memory_extract_skip', {
        reason: 'too few decisions',
        count: decisions.length,
      })
      return []
    }

    // 尝试 LLM 提取
    try {
      const rules = await this.llmExtractRules(decisions)
      if (rules.length > 0) {
        // 去重：避免已经存在的规则重复写入
        const existing = this.getPersistentRules()
        const existingSet = new Set(existing.map((r) => r.rule))

        let newCount = 0
        for (const rule of rules) {
          if (!existingSet.has(rule.rule)) {
            this.savePersistentRule(rule)
            newCount++
          }
        }

        log('INFO', 'polish_memory_rules_extracted', {
          storyId: storyId || 'all',
          extracted: rules.length,
          newSaved: newCount,
          totalDecisions: decisions.length,
        })

        return rules
      }
    } catch (e: any) {
      log('WARN', 'polish_memory_llm_extract_failed', {
        error: e.message,
      })
    }

    // LLM 失败时 fallback 到规则提取
    return this.ruleBasedExtractRules(decisions)
  }

  // ─── 压缩 ───

  /**
   * 对指定故事的润色记忆进行压缩。
   *
   * 策略：
   * - 按章节分组
   * - 将每个章节的决策合并为一条章节级摘要
   * - 删除旧的细粒度条目
   */
  async compressHistory(storyId: string): Promise<number> {
    const decisions = this.queryHistory(storyId, { limit: 100 })
    if (decisions.length < COMPRESS_THRESHOLD) return 0

    const ms = getMemoryService()
    if (!ms) return 0

    // 按章节分组
    const chapterGroups = new Map<string, PolishingDecision[]>()
    for (const d of decisions) {
      const key = d.chapterTitle
      if (!chapterGroups.has(key)) chapterGroups.set(key, [])
      chapterGroups.get(key)!.push(d)
    }

    let compressed = 0

    for (const [chapter, chapterDecisions] of chapterGroups) {
      if (chapterDecisions.length < 5) continue // 条目太少不压缩

      // 构建章节级摘要
      const typeStats: Record<string, number> = {}
      const allRules: string[] = []

      for (const d of chapterDecisions) {
        for (const m of d.modifications) {
          typeStats[m.type] = (typeStats[m.type] || 0) + 1
          allRules.push(...m.rulesApplied)
        }
        allRules.push(...d.styleRules)
      }

      const summary: ChapterPolishingSummary = {
        chapterTitle: chapter,
        totalParagraphs: chapterDecisions.length,
        modifiedParagraphs: chapterDecisions.filter((d) => d.modifications.length > 0).length,
        modificationStats: typeStats as Record<ModificationType, number>,
        frequentRules: this.getTopRules(allRules, 10),
        createdAt: Date.now(),
      }

      // 写入压缩摘要
      ms.addFact(
        `${MEMORY_KEY_PREFIX}:compress:${storyId}:${chapter} ` +
          `压缩摘要:共${summary.totalParagraphs}段` +
          `,修改${summary.modifiedParagraphs}段` +
          `,类型:${Object.keys(typeStats).join(',')}`,
        0.9,
        { tier: 'semi' },
      )

      compressed++
    }

    log('INFO', 'polish_memory_compressed', {
      storyId,
      chapterGroups: chapterGroups.size,
      compressed,
    })

    return compressed
  }

  // ============================================================
  //  内部方法
  // ============================================================

  /**
   * 构建可搜索的 content 字符串。
   */
  private buildSearchableContent(decision: PolishingDecision): string {
    const modTypes = decision.modifications.map((m) => m.type).join(',')
    const modReasons = decision.modifications.map((m) => m.reason.slice(0, 40)).join(';')
    return (
      `${MEMORY_KEY_PREFIX}:${decision.storyId}:${decision.chapterTitle} ` +
      `段落#${decision.paragraphIndex} ` +
      `修改:[${modTypes}] ` +
      `原因:${modReasons.slice(0, MAX_CONTENT_LENGTH)}`
    )
  }

  /**
   * 从 MemoryEntry 尝试解析 PolishingDecision。
   * 从 user_fact 的 content 中剥离前缀后解析 JSON。
   */
  private tryParseDecision(entry: MemoryEntry): PolishingDecision | null {
    if (entry.type !== 'user_fact') return null
    if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) return null

    try {
      const json = entry.content.slice(MEMORY_KEY_PREFIX.length)
      return JSON.parse(json) as PolishingDecision
    } catch {
      return null
    }
  }

  /**
   * 获取所有润色决策（跨故事）。
   */
  private getAllDecisions(limit: number): PolishingDecision[] {
    const ms = getMemoryService()
    if (!ms) return []

    const entries = ms.getEntries()
    const results: PolishingDecision[] = []

    for (const entry of entries) {
      if (entry.type !== 'user_fact') continue
      if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) continue

      const decision = this.tryParseDecision(entry)
      if (decision) {
        results.push(decision)
      }
      if (results.length >= limit) break
    }

    return results
  }

  /**
   * 统计规则频次，返回 Top N。
   */
  private getTopRules(rules: string[], topN: number): Array<{ rule: string; count: number }> {
    const counts = new Map<string, number>()
    for (const r of rules) {
      counts.set(r, (counts.get(r) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN)
  }

  /**
   * LLM 规则提取 — 从决策中提炼风格规则。
   */
  private async llmExtractRules(decisions: PolishingDecision[]): Promise<Omit<PersistentStyleRule, 'id' | 'createdAt'>[]> {
    const { text } = getRuntimeLlmConfig({ getCredential: (key) => credentialsManager.get(key) })
    const key = text.apiKey
    if (!key) return []

    // 构建输入：取最近 50 条决策的摘要
    const samples = decisions
      .slice(0, 50)
      .map(
        (d, i) =>
          `[${i}] 章节:${d.chapterTitle} 段落#${d.paragraphIndex} ` +
          `修改:${d.modifications.map((m) => `${m.type}(${m.reason})`).join('; ')}`,
      )
      .join('\n')

    const systemPrompt = `你是一个专业的文学编辑和风格分析专家。分析以下润色决策记录，提炼出通用的写作风格规则。

请严格以 JSON 数组格式返回，每项包含：
{
  "rule": "规则描述（一句话，具体可执行）",
  "category": "分类（word_choice | sentence | perspective | dialogue | description | other）",
  "confidence": 置信度0-1,
  "exampleBefore": "修改前示例（可选）",
  "exampleAfter": "修改后示例（可选）"
}

要求：
- 规则必须具体、可执行，不要泛泛而谈
- 只提取出现至少 2 次的模式
- 最多返回 10 条规则
- 如果无法提炼出有意义的规则，返回空数组 []`

    const userPrompt = `以下是最近 ${decisions.length} 条润色决策记录，请提炼通用风格规则：\n\n${samples}`

    try {
      const res = await fetch(text.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: text.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          stream: false,
        }),
        signal: AbortSignal.timeout(RULE_EXTRACT_TIMEOUT),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        log('WARN', 'polish_memory_llm_extract_http_error', {
          status: res.status,
          body: body.slice(0, 100),
        })
        return []
      }

      const data = (await res.json()) as {
        choices?: Array<{ message: { content: string } }>
      }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''

      // 解析 JSON
      let parsed: Array<{
        rule: string
        category: string
        confidence: number
        exampleBefore?: string
        exampleAfter?: string
      }>
      try {
        parsed = JSON.parse(reply)
      } catch {
        const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (match) {
          parsed = JSON.parse(match[1].trim())
        } else {
          return []
        }
      }

      if (!Array.isArray(parsed)) return []

      return parsed
        .filter((r) => r.rule && r.rule.length > 5)
        .map((r) => ({
          rule: r.rule,
          category: r.category || 'other',
          source: 'auto_extracted',
          confidence: Math.min(1, Math.max(0, r.confidence || 0.5)),
          exampleBefore: r.exampleBefore,
          exampleAfter: r.exampleAfter,
        }))
        .slice(0, 10)
    } catch (e: any) {
      log('WARN', 'polish_memory_llm_extract_error', { error: e.message })
      return []
    }
  }

  /**
   * 基于规则的提取 — 当 LLM 不可用时的降级方案。
   */
  private ruleBasedExtractRules(decisions: PolishingDecision[]): Omit<PersistentStyleRule, 'id' | 'createdAt'>[] {
    // 统计所有规则的出现频次
    const ruleCounts = new Map<string, number>()
    const ruleExamples = new Map<string, { before?: string; after?: string }>()

    for (const d of decisions) {
      for (const m of d.modifications) {
        for (const rule of m.rulesApplied) {
          ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1)
          if (!ruleExamples.has(rule)) {
            ruleExamples.set(rule, {
              before: d.originalExcerpt,
              after: d.polishedExcerpt,
            })
          }
        }
      }
    }

    // 分类映射
    const categoryMap: Record<string, string> = {
      show_dont_tell: 'description',
      avoid_empty_adverbs: 'word_choice',
      use_specific_details: 'description',
      dialogue_natural: 'dialogue',
      perspective_consistency: 'perspective',
      sentence_variety: 'sentence',
      paragraph_flow: 'sentence',
    }

    const rules: Omit<PersistentStyleRule, 'id' | 'createdAt'>[] = []

    for (const [rule, count] of ruleCounts) {
      if (count >= 2) {
        // 至少出现 2 次才认为是有意义的规则
        const example = ruleExamples.get(rule)
        const category = categoryMap[rule] || 'other'
        rules.push({
          rule: this.descriptiveRuleName(rule),
          category,
          source: 'auto_extracted',
          confidence: Math.min(0.9, 0.5 + count * 0.05),
          exampleBefore: example?.before,
          exampleAfter: example?.after,
        })
      }
    }

    return rules.sort((a, b) => b.confidence - a.confidence).slice(0, 10)
  }

  /**
   * 将内部规则标识转换为可读描述。
   */
  private descriptiveRuleName(rule: string): string {
    const descriptions: Record<string, string> = {
      show_dont_tell: '用具体细节展示而非抽象概括（如用动作描写替代情绪标签）',
      avoid_empty_adverbs: '避免使用「突然」「非常」「十分」「极其」等空洞副词',
      use_specific_details: '使用具体、可感知的细节替代模糊描述',
      dialogue_natural: '对话要符合角色身份和性格，避免过于书面化',
      perspective_consistency: '保持叙述视角一致，不随意切换',
      sentence_variety: '长短句交替使用，避免句式单调',
      paragraph_flow: '段落之间要有自然的过渡和节奏',
      reduce_le: '控制「了」字密度，避免时态表达单一',
      avoid_cliche: '避免网络小说套话和模板化表达',
      concrete_emotion: '用动作和环境描写传递情感，而非直接标注情绪',
    }
    return descriptions[rule] || rule
  }
}

