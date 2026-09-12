/**
 * PreferenceRevisionMemory — 偏好记忆驱动写作修订助手
 *
 * 职责：
 * 1. 记录用户对 Agent 修订建议的接受/拒绝（正负样本及用户评论文本）
 * 2. 从累积的记忆数据构建简短的偏好提示，附加到后续章节生成提示
 * 3. 记录已修订章节的摘要，避免重复处理相同内容
 * 4. 随着修订进行，偏好模型逐步细化，使后期生成更符合用户意图
 * 5. 数据持久化为 JSON 文件，支持跨会话复用
 *
 * 与 WritingMemoryContinuation 的区别：
 * - WritingMemoryContinuation 管理「读者对故事内容的反馈」记忆
 * - PolishingMemoryManager 管理「润色决策树」记忆
 * - WritingDecisionService 管理「写作设定变更」记忆
 * - PreferenceRevisionMemory 管理「用户对 Agent 修订建议的偏好」记忆
 *   关注的是用户对修订风格/方向的接受模式，而非内容本身
 *
 * 使用方式：
 * - 每次 Agent 给出修订建议后，调用 recordPreference() 记录用户的选择
 * - 每个章节修订完成后，调用 recordRevisedChapter() 记录修订摘要
 * - 开始新一轮修订前，调用 getPreferenceContext() 获取偏好提示注入 prompt
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { WORKSPACE } from '@akemi-mio/core/config'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory/types'

// ============================================================
//  类型定义
// ============================================================

/** 反馈类型：accept（接受）| reject（拒绝） */
export type FeedbackType = 'accept' | 'reject'

/** 单条修订偏好记录 */
export interface RevisionPreferenceEntry {
  id: string
  /** 故事/作品名称 */
  storyName: string
  /** 章节标识（如 "ch19" 或 "第19章"） */
  chapterId: string
  /** Agent 给出的修订建议摘要 */
  suggestion: string
  /** 用户反馈：接受/拒绝 */
  feedbackType: FeedbackType
  /** 用户可选评论文本 */
  userComment: string
  /** 反馈分类：style / detail / plot / dialogue / character / other */
  category: string
  /** 记录时间戳 */
  timestamp: number
}

/** 已修订章节记录 */
export interface RevisedChapterRecord {
  /** 故事/作品名称 */
  storyName: string
  /** 章节标识 */
  chapterId: string
  /** 修订内容摘要 */
  summary: string
  /** 修订时间 */
  revisedAt: number
}

/** 偏好提示（从累积反馈中提炼） */
export interface PreferenceHint {
  /** 偏好分类 */
  category: string
  /** 提示文本 */
  hint: string
  /** 置信度 0-1 */
  confidence: number
  /** 支撑该提示的样本数 */
  sampleCount: number
  /** 最后更新时间 */
  lastUpdated: number
}

/** 修订进度统计 */
export interface RevisionProgress {
  /** 故事名 */
  storyName: string
  /** 已修订章节数 */
  revisedCount: number
  /** 已修订章节 ID 列表 */
  revisedChapters: string[]
  /** 总偏好记录数 */
  totalPreferences: number
  /** 接受率 */
  acceptRate: number
  /** 拒绝率 */
  rejectRate: number
}

/** JSON 持久化格式 */
export interface PreferenceRevisionStore {
  version: number
  updatedAt: number
  preferences: RevisionPreferenceEntry[]
  revisedChapters: RevisedChapterRecord[]
}

// ============================================================
//  常量
// ============================================================

/** Memory 类型标签 */
const MEMORY_TYPE = 'revision_preference' as const

/** Memory 修订章节标记前缀 */
const REVISED_MEMORY_PREFIX = '[revised_chapter]'

/** 偏好提炼所需的最小样本数 */
const MIN_SAMPLES_FOR_HINT = 2

/** 偏好提炼所需的最小接受/拒绝样本数（单类） */
const MIN_PATTERN_SAMPLES = 2

/** 偏好置信度提升因子 */
const CONFIDENCE_FACTOR = 0.1

/** 同类别偏好提示的最大数量 */
const MAX_HINTS_PER_CATEGORY = 3

/** 总偏好提示最大数量 */
const MAX_HINTS_TOTAL = 8

/** JSON 持久化文件路径 */
const STORE_FILE = join(WORKSPACE.cache, 'preference-revision.json')

/** 默认的偏好存储版本 */
const STORE_VERSION = 1

/** 偏好分类中文映射 */
const CATEGORY_LABELS: Record<string, string> = {
  style: '文风',
  detail: '详略',
  plot: '情节',
  dialogue: '对话',
  character: '角色',
  other: '其他',
}

// ============================================================
//  核心服务
// ============================================================

export class PreferenceRevisionMemory {
  // 内存缓存（加载自 JSON 文件）
  private store: PreferenceRevisionStore = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    preferences: [],
    revisedChapters: [],
  }

  constructor() {
    this.loadFromJson()
  }

  // ════════════════════════════════════════════════════════════
  //  1. 偏好记录
  // ════════════════════════════════════════════════════════════

  /**
   * 记录用户对 Agent 修订建议的反馈。
   *
   * 同时写入：
   * 1. MemoryService（用于实时上下文注入）
   * 2. JSON 文件（用于跨会话持久化）
   *
   * @param storyName 故事名称
   * @param chapterId 章节标识
   * @param suggestion Agent 给出的修订建议摘要
   * @param feedbackType 接受或拒绝
   * @param userComment 用户可选的评论文本
   * @param category 反馈分类
   */
  recordPreference(
    storyName: string,
    chapterId: string,
    suggestion: string,
    feedbackType: FeedbackType,
    userComment: string = '',
    category: string = 'other',
  ): void {
    // 1. 构建内存条目
    const entry: RevisionPreferenceEntry = {
      id: `rev_pref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      storyName,
      chapterId,
      suggestion: suggestion.slice(0, 300),
      feedbackType,
      userComment: userComment.slice(0, 500),
      category,
      timestamp: Date.now(),
    }

    // 2. 写入内存缓存
    this.store.preferences.push(entry)

    // 3. 写入 MemoryService
    this.writeToMemory(entry)

    // 4. 持久化 JSON
    this.persistToJson()

    log('INFO', 'revision_preference_recorded', {
      storyName,
      chapterId,
      feedbackType,
      category,
      sampleCount: this.getStoryPreferences(storyName).length,
    })
  }

  /**
   * 批量记录多条偏好（例如一次修订会话的汇总）。
   * 返回实际写入的条目数。
   */
  recordPreferenceBatch(
    storyName: string,
    entries: Array<{
      chapterId: string
      suggestion: string
      feedbackType: FeedbackType
      userComment?: string
      category?: string
    }>,
  ): number {
    let count = 0
    for (const e of entries) {
      this.recordPreference(storyName, e.chapterId, e.suggestion, e.feedbackType, e.userComment, e.category)
      count++
    }
    return count
  }

  // ════════════════════════════════════════════════════════════
  //  2. 修订章节追踪
  // ════════════════════════════════════════════════════════════

  /**
   * 记录一个章节已完成修订。
   *
   * @param storyName 故事名称
   * @param chapterId 章节标识
   * @param summary 修订内容摘要
   */
  recordRevisedChapter(storyName: string, chapterId: string, summary: string): void {
    // 去重：避免重复标记同一章节
    const existing = this.store.revisedChapters.find((r) => r.storyName === storyName && r.chapterId === chapterId)
    if (existing) {
      existing.summary = summary
      existing.revisedAt = Date.now()
      this.persistToJson()
      return
    }

    const record: RevisedChapterRecord = {
      storyName,
      chapterId,
      summary: summary.slice(0, 500),
      revisedAt: Date.now(),
    }

    this.store.revisedChapters.push(record)

    // 同时写入 Memory 作为标记
    const ms = getMemoryService()
    if (ms) {
      ms.addEntry('revision_preference', `${REVISED_MEMORY_PREFIX}${storyName}:${chapterId}: ${summary.slice(0, 200)}`, 0.9, {
        tier: 'semi',
      })
    }

    this.persistToJson()

    log('INFO', 'revision_chapter_recorded', { storyName, chapterId })
  }

  /**
   * 检查某章节是否已被修订。
   *
   * @param storyName 故事名称
   * @param chapterId 章节标识
   */
  isChapterRevised(storyName: string, chapterId: string): boolean {
    // 检查内存缓存
    const inJson = this.store.revisedChapters.some((r) => r.storyName === storyName && r.chapterId === chapterId)
    if (inJson) return true

    // 后备检查 MemoryService
    const ms = getMemoryService()
    if (ms) {
      const entries = ms.getEntries()
      return entries.some(
        (e) => e.type === 'revision_preference' && e.content.startsWith(`${REVISED_MEMORY_PREFIX}${storyName}:${chapterId}:`),
      )
    }

    return false
  }

  // ════════════════════════════════════════════════════════════
  //  3. 偏好查询与提示构建
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某故事的所有偏好记录（按时间倒序）。
   */
  getStoryPreferences(storyName: string): RevisionPreferenceEntry[] {
    return this.store.preferences.filter((p) => p.storyName === storyName).sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * 获取所有故事的偏好记录。
   */
  getAllPreferences(): RevisionPreferenceEntry[] {
    return [...this.store.preferences].sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * 从累积的偏好记录中提炼偏好提示。
   *
   * 策略：
   * 1. 按分类分组统计接受/拒绝比例
   * 2. 对接受率高的模式生成正向提示
   * 3. 对拒绝率高的模式生成负向提示（避免型）
   * 4. 置信度随样本数递增
   *
   * @param storyName 可选的故事过滤（不传则返回所有故事的偏好提示）
   * @param minConfidence 最低置信度过滤（默认 0）
   */
  getPreferenceHints(storyName?: string, minConfidence: number = 0): PreferenceHint[] {
    const preferences = storyName ? this.getStoryPreferences(storyName) : this.getAllPreferences()

    if (preferences.length < MIN_SAMPLES_FOR_HINT) {
      return []
    }

    // 按 (category, suggestion 关键词) 分组统计接受/拒绝
    const patternStats = this.computePatternStats(preferences)

    const hints: PreferenceHint[] = []

    for (const [key, stats] of patternStats) {
      const total = stats.accept + stats.reject
      if (total < MIN_PATTERN_SAMPLES) continue

      const acceptRate = stats.accept / total
      const confidence = Math.min(0.95, 0.5 + total * CONFIDENCE_FACTOR)

      if (confidence < minConfidence) continue

      // 接受率高 → 正向偏好提示
      if (acceptRate >= 0.66) {
        hints.push({
          category: stats.category,
          hint: stats.description,
          confidence,
          sampleCount: total,
          lastUpdated: stats.lastUpdated,
        })
      }
      // 拒绝率高 → 负向偏好提示
      else if (acceptRate <= 0.33) {
        hints.push({
          category: stats.category,
          hint: `避免${stats.description}`,
          confidence,
          sampleCount: total,
          lastUpdated: stats.lastUpdated,
        })
      }
    }

    // 按置信度排序，截断
    return hints.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_HINTS_TOTAL)
  }

  /**
   * 获取格式化偏好上下文（用于注入后续章节的生成提示）。
   *
   * 格式示例：
   * ---
   * 【修订偏好参考】（基于 15 条历史反馈）
   * - 文风：用户偏好紧凑简洁的描写（置信度 85%，6 条样本）
   * - 对话：用户偏好自然口语化的对话（置信度 75%，4 条样本）
   * - 避免角色：用户不喜欢过于冗长的内心独白（置信度 70%，3 条样本）
   *
   * 当前已修订章节：第 19、20、21 章
   * 未修订章节：第 22、23、24 章 ← 请参考以上偏好调整后续修订方向
   * ---
   */
  getPreferenceContext(storyName: string): string {
    const hints = this.getPreferenceHints(storyName, 0.5)
    const preferences = this.getStoryPreferences(storyName)
    const revised = this.getRevisedChapters(storyName)
    const totalChapters = this.inferTotalChapters(storyName, revised)

    if (preferences.length === 0 && revised.length === 0) {
      return ''
    }

    const lines: string[] = ['---', '【修订偏好参考】']

    if (preferences.length > 0) {
      lines.push(`（基于 ${preferences.length} 条历史反馈）`)
    }

    if (hints.length > 0) {
      for (const hint of hints) {
        const catLabel = CATEGORY_LABELS[hint.category] || hint.category
        lines.push(`- ${catLabel}：${hint.hint}（置信度 ${Math.round(hint.confidence * 100)}%，${hint.sampleCount} 条样本）`)
      }
    }

    // 修订进度
    if (revised.length > 0) {
      lines.push('')
      lines.push(`当前已修订章节：${revised.map((r) => r.chapterId).join('、')}`)
    }

    if (totalChapters > revised.length) {
      const remaining = totalChapters - revised.length
      lines.push(`未修订章节：${remaining} 章 ← 请参考以上偏好调整后续修订方向`)
    } else if (revised.length > 0) {
      lines.push('所有章节已完成修订。')
    }

    // 添加近期反馈样本（最近 3 条）
    const recentFeedback = preferences.slice(0, 3)
    if (recentFeedback.length > 0) {
      lines.push('')
      lines.push('近期反馈样本：')
      for (const f of recentFeedback) {
        const icon = f.feedbackType === 'accept' ? '✓' : '✗'
        const catLabel = CATEGORY_LABELS[f.category] || f.category
        const truncatedSuggestion = f.suggestion.length > 50 ? f.suggestion.slice(0, 50) + '…' : f.suggestion
        const comment = f.userComment ? `（用户说：${f.userComment.slice(0, 40)}）` : ''
        lines.push(`  ${icon} [${catLabel}] ${truncatedSuggestion} ${comment}`)
      }
    }

    lines.push('---')
    return lines.join('\n')
  }

  // ════════════════════════════════════════════════════════════
  //  4. 修订进度查询
  // ════════════════════════════════════════════════════════════

  /**
   * 获取某故事的修订进度统计。
   */
  getRevisionProgress(storyName: string): RevisionProgress {
    const preferences = this.getStoryPreferences(storyName)
    const revised = this.getRevisedChapters(storyName)
    const accepts = preferences.filter((p) => p.feedbackType === 'accept').length
    const rejects = preferences.filter((p) => p.feedbackType === 'reject').length
    const total = preferences.length

    return {
      storyName,
      revisedCount: revised.length,
      revisedChapters: revised.map((r) => r.chapterId),
      totalPreferences: total,
      acceptRate: total > 0 ? accepts / total : 0,
      rejectRate: total > 0 ? rejects / total : 0,
    }
  }

  /**
   * 获取某故事已修订的章节列表。
   */
  getRevisedChapters(storyName: string): RevisedChapterRecord[] {
    return this.store.revisedChapters.filter((r) => r.storyName === storyName).sort((a, b) => a.revisedAt - b.revisedAt)
  }

  // ════════════════════════════════════════════════════════════
  //  5. 统计与配置
  // ════════════════════════════════════════════════════════════

  /**
   * 获取偏好记忆的统计概览。
   */
  getStats(): {
    totalPreferences: number
    totalRevisedChapters: number
    storiesCount: number
    storeFileSize: string
  } {
    const stories = new Set(this.store.preferences.map((p) => p.storyName))
    let fileSize = 'unknown'
    try {
      if (existsSync(STORE_FILE)) {
        const bytes = readFileSync(STORE_FILE).length
        fileSize = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
      }
    } catch {
      // ignore
    }

    return {
      totalPreferences: this.store.preferences.length,
      totalRevisedChapters: this.store.revisedChapters.length,
      storiesCount: stories.size,
      storeFileSize: fileSize,
    }
  }

  /**
   * 清空某故事的所有偏好记录与修订记录。
   */
  clearStoryData(storyName: string): number {
    const before = this.store.preferences.length + this.store.revisedChapters.length
    this.store.preferences = this.store.preferences.filter((p) => p.storyName !== storyName)
    this.store.revisedChapters = this.store.revisedChapters.filter((r) => r.storyName !== storyName)
    this.store.updatedAt = Date.now()
    this.persistToJson()
    const after = this.store.preferences.length + this.store.revisedChapters.length

    log('INFO', 'revision_preference_cleared', {
      storyName,
      removed: before - after,
    })

    return before - after
  }

  // ════════════════════════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════════════════════════

  /**
   * 将一条偏好记录写入 MemoryService。
   */
  private writeToMemory(entry: RevisionPreferenceEntry): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'revision_preference_no_memory_service')
      return
    }

    const structuredData = JSON.stringify(entry)
    const icon = entry.feedbackType === 'accept' ? '接受' : '拒绝'
    const content = `【修订偏好】${entry.storyName}/${entry.chapterId}: ${icon} "${entry.suggestion.slice(0, 100)}"`

    ms.addEntry('revision_preference', content, 0.8, {
      tier: 'semi',
      structuredData,
    })
  }

  /**
   * 统计偏好模式：按 (category, 摘要关键词) 分组，统计接受/拒绝比例。
   */
  private computePatternStats(
    preferences: RevisionPreferenceEntry[],
  ): Map<string, { category: string; description: string; accept: number; reject: number; lastUpdated: number }> {
    const stats = new Map<string, { category: string; description: string; accept: number; reject: number; lastUpdated: number }>()

    for (const p of preferences) {
      // 使用分类 + 用户评论关键词作为分组键
      const key = `${p.category}::${this.extractKeyPattern(p)}`

      const existing = stats.get(key)
      if (existing) {
        if (p.feedbackType === 'accept') existing.accept++
        else existing.reject++
        existing.lastUpdated = Math.max(existing.lastUpdated, p.timestamp)
      } else {
        stats.set(key, {
          category: p.category,
          description: this.buildPatternDescription(p),
          accept: p.feedbackType === 'accept' ? 1 : 0,
          reject: p.feedbackType === 'reject' ? 1 : 0,
          lastUpdated: p.timestamp,
        })
      }
    }

    return stats
  }

  /**
   * 从偏好记录中提取关键模式词。
   * 使用用户评论（优先）或建议摘要中的关键词。
   */
  private extractKeyPattern(entry: RevisionPreferenceEntry): string {
    // 优先使用用户评论中的关键内容
    if (entry.userComment) {
      const cleaned = entry.userComment.replace(/[喜欢讨厌不错可以好不行不要别不太非常很太更的了吧吗呢啊哦嗯]/g, '').trim()
      if (cleaned.length >= 4) return cleaned.slice(0, 20)
    }

    // 后备：从建议摘要中提取关键词
    const suggestion = entry.suggestion
    const keyTerms: string[] = []

    // 常见偏好模式关键词
    const patterns = [
      /(?:描写|描述|叙述)/g,
      /(?:对话|对白|台词)/g,
      /(?:节奏|语速|快慢)/g,
      /(?:细节|具体|抽象)/g,
      /(?:简洁|简练|精简|冗长|啰嗦)/g,
      /(?:生动|形象|画面|意象)/g,
      /(?:情节|剧情|故事|冲突)/g,
      /(?:角色|人物|性格|心理)/g,
      /(?:对话|口语|书面)/g,
      /(?:氛围|环境|气氛)/g,
    ]

    for (const pattern of patterns) {
      const match = suggestion.match(pattern)
      if (match) keyTerms.push(match[0])
    }

    return keyTerms.slice(0, 3).join('、') || 'general'
  }

  /**
   * 从偏好记录构建可读的模式描述。
   */
  private buildPatternDescription(entry: RevisionPreferenceEntry): string {
    if (entry.userComment) {
      return entry.userComment.slice(0, 40)
    }
    return entry.suggestion.slice(0, 40)
  }

  /**
   * 推断故事的总章节数（基于修订记录和偏好记录中的章节 ID）。
   */
  private inferTotalChapters(storyName: string, revised: RevisedChapterRecord[]): number {
    // 从已修订章节推断
    if (revised.length > 0) {
      // 尝试从 chapterId 提取数字
      const numbers = revised
        .map((r) => {
          const match = r.chapterId.match(/(\d+)/)
          return match ? parseInt(match[1], 10) : null
        })
        .filter((n): n is number => n !== null)

      if (numbers.length > 0) {
        const maxChapter = Math.max(...numbers)
        // 假设是连续章节，且可能还有未修订的章节
        return Math.max(maxChapter, revised.length + 2)
      }
    }

    return revised.length + 2 // 保守估计
  }

  // ════════════════════════════════════════════════════════════
  //  JSON 持久化
  // ════════════════════════════════════════════════════════════

  /**
   * 从 JSON 文件加载持久化数据。
   * 如果文件不存在，使用空存储。
   */
  private loadFromJson(): void {
    try {
      if (existsSync(STORE_FILE)) {
        const raw = readFileSync(STORE_FILE, 'utf-8')
        const parsed = JSON.parse(raw) as PreferenceRevisionStore

        // 版本兼容检查
        if (parsed.version !== STORE_VERSION) {
          log('WARN', 'revision_preference_version_mismatch', {
            fileVersion: parsed.version,
            currentVersion: STORE_VERSION,
          })
        }

        this.store = {
          version: STORE_VERSION,
          updatedAt: parsed.updatedAt || Date.now(),
          preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
          revisedChapters: Array.isArray(parsed.revisedChapters) ? parsed.revisedChapters : [],
        }

        log('INFO', 'revision_preference_loaded', {
          preferences: this.store.preferences.length,
          revisedChapters: this.store.revisedChapters.length,
          filePath: STORE_FILE,
        })
      }
    } catch (err) {
      log('WARN', 'revision_preference_load_failed', {
        error: String(err),
        filePath: STORE_FILE,
      })
      // 文件损坏时使用空存储
      this.store = {
        version: STORE_VERSION,
        updatedAt: Date.now(),
        preferences: [],
        revisedChapters: [],
      }
    }
  }

  /**
   * 将当前存储持久化到 JSON 文件。
   */
  private persistToJson(): void {
    try {
      // 确保缓存目录存在
      const dir = WORKSPACE.cache
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      this.store.updatedAt = Date.now()
      writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'revision_preference_persist_failed', {
        error: String(err),
        filePath: STORE_FILE,
      })
    }
  }

  /**
   * 强制刷新 — 从 JSON 文件重新加载所有数据。
   * 用于跨会话场景下获取最新数据。
   */
  refresh(): void {
    this.loadFromJson()
  }

  /**
   * 获取 JSON 文件的路径。
   */
  getStoreFilePath(): string {
    return STORE_FILE
  }

  /**
   * 同步 MemoryService 中遗漏的偏好记录到 JSON 存储。
   * 用于在 MemoryService 有数据但 JSON 文件缺失时恢复。
   */
  syncFromMemory(storyName?: string): number {
    const ms = getMemoryService()
    if (!ms) return 0

    const allEntries = ms.getEntries()
    let synced = 0

    for (const entry of allEntries) {
      if (entry.type !== 'revision_preference') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as RevisionPreferenceEntry
        if (storyName && data.storyName !== storyName) continue

        // 去重：避免重复导入
        const exists = this.store.preferences.some((p) => p.id === data.id)
        if (!exists) {
          this.store.preferences.push(data)
          synced++
        }
      } catch {
        // 跳过解析失败的条目
      }
    }

    if (synced > 0) {
      this.persistToJson()
      log('INFO', 'revision_preference_synced_from_memory', { synced })
    }

    return synced
  }
}

// ===== 单例导出 =====

export let preferenceRevisionMemory: PreferenceRevisionMemory | null = null

/**
 * 初始化并获取 PreferenceRevisionMemory 单例。
 * 首次调用时创建实例，后续复用。
 */
export function getPreferenceRevisionMemory(): PreferenceRevisionMemory {
  if (!preferenceRevisionMemory) {
    preferenceRevisionMemory = new PreferenceRevisionMemory()
  }
  return preferenceRevisionMemory
}

