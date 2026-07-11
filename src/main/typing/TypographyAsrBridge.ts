/**
 * TypographyAsrBridge — 反 ASR 原型：排版计划上下文 → ASR 热词增强
 *
 * ── 设计意图（反 ASR） ──
 *
 * 当前关系的前提假设：
 *   假设 1) ASR 是"主"（输入管道），排版是"从"（输出格式化）
 *   假设 2) ASR 先执行（语音输入在前），排版后执行（TTS 格式化在后）
 *   假设 3) ASR 做决策（识别什么词），排版执行（格式化文本）
 *
 * 本模块反转【假设 1 和 3】，原型验证方向：
 *   "排版计划的上文（当前处理的文章）驱动 ASR 热词增强"
 *
 * 具体反转内容：
 *   - 反转之前：ASR（用户语音输入）→ LLM → 排版（格式化输出），单向流水线
 *   - 反转之后：排版计划（如"工业颂歌 公众号"）→ ASR（播种领域词汇热词）
 *     → 用户语音输入时 ASR 更准确识别文章相关术语 → LLM 理解更精准
 *
 * 即：排版计划的上文不再是 ASR 结果的被动消费者，而是主动为 ASR 提供领域先验知识。
 * 排版不再"从属于"ASR，而是通过注入上下文来"主导"ASR 的识别倾向。
 *
 * ── 集成模式 ──
 * 与 LearningAsrBridge 相同：在 AppRuntime 启动时调用 seedFromActiveTypography()，
 * 将当前排版计划的上下文注入 ASR 热词管理器。
 *
 * @see LearningAsrBridge — 类似模式，种子词来源不同（学习知识点 vs 排版计划上下文）
 */

import { log } from '../logger/Logger'
import { asrHotwordManager } from '../asr/AsrHotwordManager'
import { ttsTypographyFeedbackLoop } from '../tts/TtsTypographyFeedbackLoop'
import { TypographyMemoryManager } from '../creativity/TypographyMemoryManager'
import type { DomainLabel } from '../asr/AsrHotwordManager'

// ══════════════════════════════════════════════════════════════
//  预定义的领域词汇映射表
//
//  每个故事预置一批高优先级热词。
//  这些词来自文章自身的领域术语，确保 ASR 在用户讨论文章时能准确识别。
//
//  扩展方式：新增故事时只需在此添加条目，无需修改核心逻辑。
// ══════════════════════════════════════════════════════════════

interface StorySeedWord {
  word: string
  domain?: DomainLabel
}

const STORY_SEED_WORDS: Record<string, StorySeedWord[]> = {
  '工业颂歌': [
    // 故事标题 & 核心概念
    { word: '工业颂歌', domain: '社交沟通' },
  ],
}

/** 默认领域标签（当词汇未指定领域时使用） */
const DEFAULT_DOMAIN: DomainLabel = '专业术语'

// ══════════════════════════════════════════════════════════════
//  桥接器
// ══════════════════════════════════════════════════════════════

export class TypographyAsrBridge {
  /** 上次播种的故事 ID（避免重复播种） */
  private lastSeededStoryId: string | null = null
  /** 是否已初始化 */
  private initialized = false
  /** TypographyMemory 查询器 */
  private typographyManager: TypographyMemoryManager

  constructor() {
    this.typographyManager = new TypographyMemoryManager()
  }

  // ── 主入口 ──

  /**
   * 读取当前活动的排版计划上下文，将领域词汇注入 ASR 热词管理器。
   *
   * - 从 TtsTypographyFeedbackLoop 获取当前故事 ID（如 "工业颂歌"）
   * - 从预定义词表（STORY_SEED_WORDS）播种基础热词
   * - 从 TypographyMemory 历史记录中提取章节标题作为补充热词
   * - 同一故事 ID 不会重复播种（幂等）
   *
   * 反转效果：排版计划不再只是 ASR 输出结果的消费者，
   * 而是通过提供领域先验知识来主动影响 ASR 的识别倾向。
   */
  seedFromActiveTypography(): void {
    const diagnostics = ttsTypographyFeedbackLoop.getDiagnostics()
    const storyId = diagnostics.storyId

    if (!storyId) {
      log('DEBUG', 'typography_asr_bridge_no_active_plan')
      return
    }

    // 幂等检查：同一故事只播种一次
    if (storyId === this.lastSeededStoryId) {
      log('DEBUG', 'typography_asr_bridge_already_seeded', { storyId })
      return
    }
    this.lastSeededStoryId = storyId

    log('INFO', 'typography_asr_bridge_seeding_start', {
      storyId,
      planMode: diagnostics.mode,
      platformTag: diagnostics.platformTag,
    })

    // 阶段 1：从预定义词表播种
    this.seedPredefinedTerms(storyId)

    // 阶段 2：从排版历史记录中提取章节标题
    this.seedFromTypographyHistory(storyId, diagnostics.platformTag)

    // 阶段 3：播种常用故事描述词（保底）
    this.seedFallbackTerms(storyId)

    this.initialized = true
    log('INFO', 'typography_asr_bridge_seeding_complete', {
      storyId,
      hotwordCount: asrHotwordManager.getHotwords().length,
      longTermSize: asrHotwordManager.getLongTermVocabSize(),
    })
  }

  // ── 内部播种阶段 ──

  /**
   * 阶段 1：从预定义的 STORY_SEED_WORDS 映射表中播种。
   * 提供该故事最核心的顶层词汇，确保 ASR 从首轮对话就能识别。
   */
  private seedPredefinedTerms(storyId: string): void {
    const words = STORY_SEED_WORDS[storyId]
    if (!words || words.length === 0) {
      log('DEBUG', 'typography_asr_bridge_no_predefined', { storyId })
      return
    }

    asrHotwordManager.seedVocabulary(words)
    log('INFO', 'typography_asr_bridge_seeded_predefined', {
      storyId,
      count: words.length,
      sample: words.slice(0, 5).map(w => w.word),
    })
  }

  /**
   * 阶段 2：从 TypographyMemory 历史记录中提取章节标题的关键词。
   * 文章各章节标题往往包含该领域的高价值词汇。
   *
   * 反转意义：排版系统的历史积累（已处理章节的排版记录）反向输入到 ASR，
   * 这正是"排版决定 ASR 倾向"的体现——文章排版越多，ASR 对相关领域词汇越敏感。
   */
  private seedFromTypographyHistory(storyId: string, platformTag: string): void {
    const records = this.typographyManager.queryRecords(storyId, platformTag, { limit: 20 })

    if (records.length === 0) {
      log('DEBUG', 'typography_asr_bridge_no_history', { storyId, platformTag })
      return
    }

    const seen = new Set<string>()
    const chapterTerms: StorySeedWord[] = []

    for (const record of records) {
      // 从章节标题提取关键词
      const terms = this.extractKeyTerms(record.chapterTitle)
      for (const term of terms) {
        const key = term.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          chapterTerms.push({ word: term, domain: DEFAULT_DOMAIN })
        }
      }

      // 从用户修正文本中提取关键词（用户反复修正的往往是对 ASR 识别有问题的术语）
      if (record.userCorrections) {
        const correctionTerms = this.extractKeyTerms(record.userCorrections)
        for (const term of correctionTerms) {
          const key = term.toLowerCase()
          if (!seen.has(key)) {
            seen.add(key)
            chapterTerms.push({ word: term, domain: DEFAULT_DOMAIN })
          }
        }
      }
    }

    if (chapterTerms.length > 0) {
      asrHotwordManager.seedVocabulary(chapterTerms)
      log('INFO', 'typography_asr_bridge_seeded_history', {
        storyId,
        source: 'typography_history',
        termCount: chapterTerms.length,
        sample: chapterTerms.slice(0, 5).map(t => t.word),
      })
    }
  }

  /**
   * 阶段 3：播种常用保底词汇。
   * 即使没有预定义词表也没有历史记录，至少保证 ASR 能识别故事名。
   */
  private seedFallbackTerms(storyId: string): void {
    // 如果还没有播种任何词汇，将故事名本身作为保底热词
    const currentHotwords = asrHotwordManager.getHotwords()
    const storyParts = this.extractKeyTerms(storyId)

    for (const part of storyParts) {
      if (!currentHotwords.some(h => h.toLowerCase() === part.toLowerCase())) {
        asrHotwordManager.seedVocabulary([{ word: part, domain: DEFAULT_DOMAIN }])
        log('INFO', 'typography_asr_bridge_seeded_fallback', {
          storyId,
          term: part,
        })
      }
    }
  }

  // ── 工具 ──

  /**
   * 从文本中提取有意义的词汇作为潜在热词。
   * 提取策略：
   *   - 中文：2~4 字的有意义片段（通过滤除停用词减少噪音）
   *   - 英文/数字：连续的字母数字序列
   */
  private extractKeyTerms(text: string): string[] {
    const terms: string[] = []
    const seen = new Set<string>()

    // 提取中文词汇（2~4 字）
    const chineseMatches = text.match(/[一-鿿]{2,4}/g)
    if (chineseMatches) {
      for (const w of chineseMatches) {
        const trimmed = w.trim()
        if (trimmed.length >= 2 && !seen.has(trimmed) && !this.isCnStopword(trimmed)) {
          seen.add(trimmed)
          terms.push(trimmed)
        }
      }
    }

    // 提取英文/数字词汇
    const asciiMatches = text.match(/[a-zA-Z0-9_]{2,}/g)
    if (asciiMatches) {
      for (const w of asciiMatches) {
        const lower = w.toLowerCase()
        if (!seen.has(lower) && !this.isEnStopword(lower)) {
          seen.add(lower)
          terms.push(lower)
        }
      }
    }

    return terms
  }

  /** 简单中文停用词（与 AsrHotwordManager 保持一致） */
  private isCnStopword(word: string): boolean {
    return [
      '一个', '没有', '什么', '怎么', '为什么', '因为', '所以',
      '但是', '而且', '或者', '如果', '虽然', '可以', '可能',
      '应该', '已经', '正在', '还是', '就是', '只是', '不是',
      '这个', '那个', '这些', '那些', '这里', '那里', '哪里',
      '自己', '大家', '所有', '一些', '一点', '时候', '时间',
      '今天', '昨天', '明天', '现在', '请问', '帮忙', '谢谢',
      '的', '了', '在', '是', '有', '和', '与', '对', '把', '被',
      '让', '给', '从', '到', '用', '的', '地', '得',
    ].includes(word)
  }

  /** 简单英文停用词 */
  private isEnStopword(word: string): boolean {
    return [
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'can', 'could', 'may', 'might', 'shall', 'should',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
      'and', 'but', 'or', 'for', 'to', 'of', 'in', 'on', 'at',
      'with', 'from', 'as', 'into', 'about', 'after', 'before',
      'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
      'some', 'such', 'only', 'own', 'same', 'just', 'than',
      'also', 'still', 'now', 'then', 'very', 'really',
    ].includes(word)
  }

  // ── 状态查询 ──

  /**
   * 是否已完成播种。
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * 获取上次播种的故事 ID。
   */
  getLastSeededStoryId(): string | null {
    return this.lastSeededStoryId
  }

  /**
   * 重置桥接器状态（当需要重新播种时调用）。
   */
  reset(): void {
    this.lastSeededStoryId = null
    this.initialized = false
    log('DEBUG', 'typography_asr_bridge_reset')
  }
}

// ══════════════════════════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════════════════════════

/** 全局单例 */
export const typographyAsrBridge = new TypographyAsrBridge()
