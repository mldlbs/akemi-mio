/**
 * AsrHotwordManager — 短时行为驱动的ASR热词增强 + 长时个性化词表管理
 *
 * 根据用户最近N次交互中的文本内容，自动提取出现频率高的领域词汇，
 * 动态添加到ASR热词列表，提升这些词的识别准确率。
 *
 * 新增特性（v2）:
 * - 长时持久化：跨会话保留已学习词汇，实现逐步个性化
 * - 领域标签分类：自动将词汇归类到不同领域（代码、音乐、通用等）
 * - 隐私管理：提供接口查询/删除已学习词汇
 * - 自动保存：每次喂入文本或删除词条后自动持久化
 *
 * 特性:
 * - 滑动窗口：保留最近 16 次用户文本输入（短时行为感知）
 * - 长时积累：高置信度词汇持久化存储（跨会话个性化）
 * - 中文分词：基于字符 bigram/trigram + 正则提取
 * - 英文分词：正则单词提取
 * - 停用词过滤：中英文常见停用词
 * - 频次阈值：默认出现 >= 3 次
 * - 时间衰减：窗口外自动移除短时词，长时词持续积累
 * - 用户开关：支持手动关闭
 * - 领域标签：基于词汇特征自动归类
 *
 * 集成点:
 * 1. ChatExecutor.run() 中 feedUserText() 记录用户的文本输入
 * 2. asr:transcribe IPC handler 中将 ASR 识别结果回灌
 * 3. AsrService.setConversationContext() 合并频率热词
 * 4. 应用启动/关闭时自动加载/保存持久化词表
 */

import { log } from '../logger/Logger'
import { ASR_HOTWORD_WINDOW_SIZE, ASR_HOTWORD_FREQ_THRESHOLD, WORKSPACE } from '../config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

// ── 配置常量 ──

/** 分析窗口大小（最近 N 次交互） */
const DEFAULT_WINDOW_SIZE = 16

/** 高频阈值：词汇出现次数 >= 此值视为热词 */
const DEFAULT_FREQ_THRESHOLD = 3

/** 长时词表持久化路径 */
const VOCABULARY_FILE = join(WORKSPACE.cache, 'asr-vocabulary.json')

/** 最大热词数（避免热词过多降低其他词识别率） */
const MAX_HOTWORDS = 15

/** 最小词汇长度（字符数，低于此值跳过） */
const MIN_WORD_LENGTH = 2

/** 长时词置信度阈值：词汇在会话中出现次数 >= 此值才持久化 */
const LONG_TERM_CONFIDENCE_THRESHOLD = 5

/** 长时词最大数量 */
const MAX_LONG_TERM_WORDS = 100

/** 领域标签枚举 */
export const DOMAIN_LABELS = [
  '编程开发',
  '系统运维',
  '音乐娱乐',
  '图像创作',
  '社交沟通',
  '生活日常',
  '专业术语',
  '其他',
] as const
export type DomainLabel = (typeof DOMAIN_LABELS)[number]

// ── 停用词 ──

/** 中文停用词 */
const CN_STOPWORDS = new Set([
  '一个', '没有', '我们', '你们', '他们', '她们', '它们',
  '什么', '怎么', '怎么样', '为什么', '因为', '所以', '但是', '可是',
  '不过', '而且', '或者', '如果', '虽然', '然而', '于是', '因此',
  '可以', '可能', '应该', '必须', '需要', '能够', '已经', '曾经',
  '正在', '将要', '一直', '还是', '就是', '只是', '不是', '不用',
  '不能', '不会', '不行', '不要', '不敢', '不一定',
  '这个', '那个', '这些', '那些', '这里', '那里', '哪里',
  '自己', '大家', '别人', '所有', '一些', '一点', '很多', '很少',
  '时候', '时间', '地方', '东西', '事情', '问题', '方法', '方式',
  '今天', '昨天', '明天', '现在', '以前', '以后', '刚才',
  '知道', '觉得', '认为', '希望', '喜欢', '想要', '告诉',
  '请问', '帮忙', '谢谢', '你好', '好的', '嗯', '啊', '吧', '吗', '呢', '哦',
  '的', '了', '在', '是', '有', '和', '与', '或', '对', '把', '被', '让', '给', '从', '到', '用',
])

/** 英文停用词 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'this', 'that', 'these', 'those', 'here', 'there', 'where', 'when', 'why', 'how',
  'what', 'which', 'who', 'whom', 'whose',
  'and', 'but', 'or', 'not', 'no', 'if', 'then', 'else', 'so', 'for',
  'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'into',
  'about', 'above', 'after', 'before', 'between', 'during', 'without',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'too', 'very', 'just', 'than',
  'please', 'thanks', 'hello', 'ok', 'okay', 'yes', 'no', 'yeah', 'well',
  'also', 'still', 'now', 'then', 'here', 'very', 'really', 'quite',
])

// ── 领域分类规则 ──

/**
 * 领域关键词映射表：词汇命中任意关键词即归入该领域。
 * 匹配优先级由上到下（先匹配先归类）。
 */
const DOMAIN_RULES: Array<{ label: DomainLabel; patterns: RegExp[] }> = [
  {
    label: '编程开发',
    patterns: [
      /^(api|sdk|cli|ide|json|yaml|toml|xml|html|css|sql|git|npm|yarn|pnpm|bun|node|deno|rust|java|go|py|php|ruby|cpp|csharp|swift|kt|ts|js|vue|react|angular|svelte|next|nuxt|nest|spring|django|flask|fastapi|redis|mongo|mysql|postgres|docker|k8s|kubernetes|aws|gcp|azure)$/i,
      /^(debug|deploy|compile|build|test|lint|format|commit|push|pull|merge|branch|config|middleware|endpoint|migration|schema|query|hook|component|service|module|interface|type|enum|class|function|async|await|promise|callback|thread|process)$/i,
      /^[a-z]+\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h|css|scss|vue|svelte)$/i,
    ],
  },
  {
    label: '系统运维',
    patterns: [
      /^(ssh|centos|linux|ubuntu|debian|server|cluster|proxy|nginx|caddy|pm2|systemd|docker|podman|k8s|helm|ansible|terraform|cron|bash|zsh|shell)$/i,
      /^(deploy|rollback|scale|monitor|alert|backup|restore|migration|firewall|cert|ssl|tls|dns|vpn|port|daemon|service|process|pid|log|audit)$/i,
      /^[a-z]+\..+\..+$/,
    ],
  },
  {
    label: '音乐娱乐',
    patterns: [
      /^(贝斯|和弦|旋律|节拍|调式|音阶|琶音|鼓点|前奏|副歌|间奏|尾奏|独奏|合奏|伴奏|即兴|滑音|颤音|泛音|延音|休止)/,
      /^(guitar|bass|piano|drum|synth|mix|mastering|reverb|delay|compressor|eq|filter|osc|midi|vst|plugin|track|loop|sample|beat)$/i,
      /^(吉他|钢琴|架子鼓|合成器|混音|母带|效果器|失真|过载|延迟|混响|合唱|镶边|相位|声场)/,
    ],
  },
  {
    label: '图像创作',
    patterns: [
      /^(comfyui|stable.?diffusion|sd|flux|pulid|img2img|txt2img|inpaint|outpaint|controlnet|lorah|dreambooth|vae|clip|unet)$/i,
      /^(prompt|seed|steps|cfg|sampler|checkpoint|model|vae|clip|embedding|lycoris|textual.?inversion|upscale|denoise|latent|vram)$/i,
      /^(图片|图像|生成|渲染|模型|采样|迭代|种子|提示词|负面)/,
    ],
  },
  {
    label: '社交沟通',
    patterns: [
      /^(wechat|微信|telegram|tg|discord|slack|群组|频道|好友|消息|转发|回复|@|#)/,
      /^(发送|分享|转发|评论|点赞|关注|订阅|邀请|通知|公告)/,
    ],
  },
]

// ── 类型定义 ──

export interface HotwordEntry {
  word: string
  count: number
  domain: DomainLabel
  firstSeenAt: number
  lastSeenAt: number
}

export interface HotwordManagerState {
  enabled: boolean
  windowSize: number
  freqThreshold: number
  entries: HotwordEntry[]
  totalInputs: number
}

/** 导出给 UI 使用的词汇条目 */
export interface VocabEntry {
  word: string
  count: number
  domain: DomainLabel
  lastSeen: number
  firstSeen: number
}

/** 词汇领域统计（给UI展示） */
export interface DomainStats {
  label: DomainLabel
  count: number
}

// ── 分词工具 ──

/**
 * 从文本中提取词汇。
 * - 中文：字符 bigram + trigram（滑动窗口）
 * - 英文/数字：正则提取连续的字母数字序列
 */
function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return []

  const tokens: string[] = []

  // 提取英文/数字词汇（连续的ASCII字母数字）
  const asciiWords = text.match(/[a-zA-Z0-9_]{2,}/g)
  if (asciiWords) {
    for (const w of asciiWords) {
      const lower = w.toLowerCase()
      if (!EN_STOPWORDS.has(lower) && lower.length >= MIN_WORD_LENGTH) {
        tokens.push(lower)
      }
    }
  }

  // 提取中文片段（连续的CJK字符）
  const cjkRuns = text.match(/[一-鿿㐀-䶿]{2,}/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      // Bigram（2-gram）
      for (let i = 0; i <= run.length - 2; i++) {
        const bigram = run.slice(i, i + 2)
        if (!CN_STOPWORDS.has(bigram)) {
          tokens.push(bigram)
        }
      }
      // Trigram（3-gram），仅在 run 长度 >= 3 时
      for (let i = 0; i <= run.length - 3; i++) {
        const trigram = run.slice(i, i + 3)
        if (!CN_STOPWORDS.has(trigram)) {
          tokens.push(trigram)
        }
      }
    }
  }

  return tokens
}

/**
 * 判断词汇是否为噪音（标点、纯数字、过短等）。
 */
function isNoiseToken(token: string): boolean {
  if (token.length < MIN_WORD_LENGTH) return true
  // 纯数字
  if (/^\d+$/.test(token)) return true
  // 纯标点/空白
  if (/^[\s\p{P}\p{S}]+$/u.test(token)) return true
  return false
}

// ── 领域分类 ──

/**
 * 对词汇进行领域分类。
 * 使用关键词匹配规则表，从上到下匹配，先匹配先归类。
 * 不依赖 LLM（避免在热路径上增加延迟）。
 */
function classifyDomain(word: string): DomainLabel {
  for (const { label, patterns } of DOMAIN_RULES) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      if (pattern.test(word)) {
        return label
      }
    }
  }
  return '其他'
}

// ── AsrHotwordManager ──

export class AsrHotwordManager {
  /** 是否启用 */
  private enabled = true

  /** 分析窗口大小 */
  private windowSize: number

  /** 频率阈值 */
  private freqThreshold: number

  /** 当前热词条目（按 lastSeenAt 排序） */
  private entries: HotwordEntry[] = []

  /** 记录的用户输入文本（用于窗口计算） */
  private recentTexts: string[] = []

  /** 总计输入次数（用于调试） */
  private totalInputs = 0

  /** 长时积累词表（跨会话持久化） */
  private longTermVocab: Map<string, HotwordEntry> = new Map()

  /** 持久化文件路径 */
  private vocabFilePath: string

  constructor(
    windowSize = DEFAULT_WINDOW_SIZE,
    freqThreshold = DEFAULT_FREQ_THRESHOLD,
    vocabFilePath?: string,
  ) {
    this.windowSize = windowSize
    this.freqThreshold = freqThreshold
    this.vocabFilePath = vocabFilePath || VOCABULARY_FILE
  }

  // ── 初始化 ──

  /**
   * 从持久化存储加载长时词表。
   * 在应用启动时调用。
   */
  loadPersistedVocabulary(): void {
    try {
      if (!existsSync(this.vocabFilePath)) {
        log('INFO', 'asr_vocab_no_file', { path: this.vocabFilePath })
        return
      }
      const raw = readFileSync(this.vocabFilePath, 'utf-8')
      const data: Array<{ word: string; count: number; domain: string; firstSeenAt: number; lastSeenAt: number }> =
        JSON.parse(raw)
      if (!Array.isArray(data)) {
        log('WARN', 'asr_vocab_invalid_format')
        return
      }
      let loaded = 0
      for (const item of data) {
        if (!item.word || typeof item.word !== 'string') continue
        const domain = DOMAIN_LABELS.includes(item.domain as DomainLabel)
          ? (item.domain as DomainLabel)
          : '其他'
        this.longTermVocab.set(item.word, {
          word: item.word,
          count: item.count || 1,
          domain,
          firstSeenAt: item.firstSeenAt || Date.now(),
          lastSeenAt: item.lastSeenAt || Date.now(),
        })
        loaded++
      }
      log('INFO', 'asr_vocab_loaded', {
        count: loaded,
        path: this.vocabFilePath,
      })
    } catch (err) {
      log('ERROR', 'asr_vocab_load_failed', {
        error: String(err),
        path: this.vocabFilePath,
      })
    }
  }

  /**
   * 将长时词表持久化到磁盘。
   * 在每次有意义的变更后自动调用。
   */
  savePersistedVocabulary(): void {
    try {
      const data = Array.from(this.longTermVocab.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_LONG_TERM_WORDS)
        .map((entry) => ({
          word: entry.word,
          count: entry.count,
          domain: entry.domain,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
        }))
      const dir = dirname(this.vocabFilePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.vocabFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'asr_vocab_save_failed', {
        error: String(err),
        path: this.vocabFilePath,
      })
    }
  }

  // ── 数据采集 ──

  /**
   * 喂入一条用户文本（包括 ASR 识别结果或手动输入）。
   * 自动提取词汇、更新频次统计、持久化高置信度词条。
   */
  feedUserText(text: string): void {
    if (!this.enabled) return
    if (!text || text.trim().length === 0) return

    const trimmed = text.trim()
    this.recentTexts.push(trimmed)
    this.totalInputs++

    // 保持窗口大小
    while (this.recentTexts.length > this.windowSize) {
      this.recentTexts.shift()
    }

    // 重新统计频次
    this.rebuildEntries()

    // 更新长时词表（将窗口中高置信度词持久化）
    this.updateLongTermVocab()

    log('INFO', 'asr_hotword_fed', {
      text_snippet: trimmed.slice(0, 50),
      total_inputs: this.totalInputs,
      entry_count: this.entries.length,
      long_term_count: this.longTermVocab.size,
      window_size: this.recentTexts.length,
    })
  }

  /**
   * 从已有的多段文本重建词频统计（用于从 DB 冷启动）。
   */
  loadFromTexts(texts: string[]): void {
    this.recentTexts = texts.slice(-this.windowSize)
    this.totalInputs = texts.length
    this.rebuildEntries()
  }

  // ── 热词获取 ──

  /**
   * 获取当前频率超过阈值的热词列表。
   * 合并短时窗口热词 + 长时积累词表。
   * 按频次降序排列，限制最大数量。
   */
  getHotwords(): string[] {
    if (!this.enabled) return []

    const threshold = this.freqThreshold
    const wordSet = new Set<string>()
    const result: string[] = []

    // 1. 短时窗口热词（最高优先级）
    const shortTermHotwords = this.entries
      .filter((e) => e.count >= threshold)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_HOTWORDS)

    for (const entry of shortTermHotwords) {
      if (!wordSet.has(entry.word)) {
        wordSet.add(entry.word)
        result.push(entry.word)
      }
    }

    // 2. 长时积累词（补充短时窗口未覆盖的高频词）
    if (result.length < MAX_HOTWORDS) {
      const longTermWords = Array.from(this.longTermVocab.values())
        .filter((e) => e.count >= threshold && !wordSet.has(e.word))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_HOTWORDS - result.length)

      for (const entry of longTermWords) {
        wordSet.add(entry.word)
        result.push(entry.word)
      }
    }

    return result
  }

  /**
   * 获取所有热词条目（含频次信息，用于调试）。
   */
  getEntries(): HotwordEntry[] {
    return [...this.entries].sort((a, b) => b.count - a.count)
  }

  /**
   * 判断是否有足够的数据进行热词推荐。
   */
  hasSufficientData(): boolean {
    return this.recentTexts.length >= 3 || this.longTermVocab.size > 0
  }

  // ── 长时词表管理（供 UI 使用） ──

  /**
   * 导出所有长时词汇（供 UI 展示）。
   * 按频次降序排列。
   */
  exportVocabulary(): VocabEntry[] {
    return Array.from(this.longTermVocab.values())
      .sort((a, b) => b.count - a.count)
      .map((e) => ({
        word: e.word,
        count: e.count,
        domain: e.domain,
        lastSeen: e.lastSeenAt,
        firstSeen: e.firstSeenAt,
      }))
  }

  /**
   * 获取词汇的领域分布统计（供 UI 展示）。
   */
  getDomainBreakdown(): DomainStats[] {
    const counts = new Map<DomainLabel, number>()
    for (const entry of this.longTermVocab.values()) {
      counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1)
    }
    // 按数量降序排列
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }))
  }

  /**
   * 删除指定词汇（从长时词表和短时窗口中同时移除）。
   * @returns true 如果确实删除了词条
   */
  deleteWord(word: string): boolean {
    const lowered = word.toLowerCase()
    let removed = false

    // 从长时词表移除
    if (this.longTermVocab.has(lowered)) {
      this.longTermVocab.delete(lowered)
      removed = true
    }

    // 从短时窗口条目中移除
    const before = this.entries.length
    this.entries = this.entries.filter(
      (e) => e.word.toLowerCase() !== lowered,
    )
    if (this.entries.length < before) removed = true

    if (removed) {
      this.savePersistedVocabulary()
      log('INFO', 'asr_vocab_word_deleted', { word: lowered })
    }
    return removed
  }

  /**
   * 清空所有已学习词汇（长时和短时）。
   */
  clearAllVocabulary(): void {
    this.longTermVocab.clear()
    this.entries = []
    this.recentTexts = []
    this.savePersistedVocabulary()
    log('INFO', 'asr_vocab_all_cleared')
  }

  /**
   * 获取长时词表总大小。
   */
  getLongTermVocabSize(): number {
    return this.longTermVocab.size
  }

  /**
   * 获取长时词表中频次最高的词条（供诊断）。
   */
  getTopLongTermWords(limit = 10): VocabEntry[] {
    return this.exportVocabulary().slice(0, limit)
  }

  // ── 种子词表（预设高优先级词汇） ──

  /**
   * 向热词管理器预置一批已知词汇（种子词表）。
   *
   * 用于在启动时直接注入已知的专业术语（如 TypeScript 高级类型名称），
   * 使 ASR 在首次使用时就能准确识别这些词汇，无需等待用户交互积累。
   *
   * 种子词直接进入长时词表（跨会话保留），且给予初始频次阈值。
   *
   * @param words - 要预置的词汇列表，每个元素可以是字符串或 { word, domain? }
   * @param initialCount - 初始频次（默认 freqThreshold，确保立即成为热词）
   */
  seedVocabulary(
    words: Array<string | { word: string; domain?: DomainLabel }>,
    initialCount?: number,
  ): void {
    const count = initialCount ?? this.freqThreshold
    const now = Date.now()

    for (const entry of words) {
      const word = typeof entry === 'string' ? entry : entry.word
      const domain = typeof entry === 'object' && entry.domain
        ? entry.domain
        : classifyDomain(word)
      const lower = word.toLowerCase()

      if (this.longTermVocab.has(lower)) continue

      this.longTermVocab.set(lower, {
        word: lower,
        count,
        domain,
        firstSeenAt: now,
        lastSeenAt: now,
      })
    }

    this.savePersistedVocabulary()
    log('INFO', 'asr_vocab_seeded', {
      count: words.length,
      threshold: count,
      sample: words.slice(0, 5).map(w => typeof w === 'string' ? w : w.word),
    })
  }

  // ── 控制 ──

  /** 启用/禁用热词管理器 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.clear()
    }
    log('INFO', 'asr_hotword_toggled', { enabled })
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.enabled
  }

  /** 获取当前状态（用于持久化/调试） */
  getState(): HotwordManagerState {
    return {
      enabled: this.enabled,
      windowSize: this.windowSize,
      freqThreshold: this.freqThreshold,
      entries: this.getEntries(),
      totalInputs: this.totalInputs,
    }
  }

  /** 清除所有数据 */
  clear(): void {
    this.recentTexts = []
    this.entries = []
    log('INFO', 'asr_hotword_cleared')
  }

  /** 完全重置（保留长时词表） */
  reset(): void {
    this.clear()
    this.totalInputs = 0
  }

  // ── 内部方法 ──

  /**
   * 从最近文本重新构建词频统计。
   * 只考虑窗口内的文本，窗口外的自动遗忘。
   */
  private rebuildEntries(): void {
    const freqMap = new Map<string, { count: number; firstSeenAt: number; lastSeenAt: number }>()

    for (let i = 0; i < this.recentTexts.length; i++) {
      const text = this.recentTexts[i]
      const tokens = tokenize(text)
      const seenInText = new Set<string>() // 同一段文本中重复只计1次

      for (const token of tokens) {
        if (isNoiseToken(token)) continue
        if (seenInText.has(token)) continue
        seenInText.add(token)

        const existing = freqMap.get(token)
        if (existing) {
          existing.count++
          existing.lastSeenAt = i
        } else {
          freqMap.set(token, { count: 1, firstSeenAt: i, lastSeenAt: i })
        }
      }
    }

    // 转换为条目数组，按 lastSeenAt 排序
    this.entries = Array.from(freqMap.entries())
      .map(([word, { count, firstSeenAt, lastSeenAt }]) => ({
        word,
        count,
        domain: classifyDomain(word),
        firstSeenAt,
        lastSeenAt,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)

    if (this.entries.length > 0) {
      log('INFO', 'asr_hotword_rebuilt', {
        total_tokens: this.entries.length,
        window_texts: this.recentTexts.length,
        top_words: this.entries.slice(0, 5).map((e) => `${e.word}(${e.count}, ${e.domain})`),
      })
    }
  }

  /**
   * 将窗口中高置信度词条同步到长时词表。
   * 高置信度条件：在窗口中出现 >= LONG_TERM_CONFIDENCE_THRESHOLD 次。
   */
  private updateLongTermVocab(): void {
    let updated = 0
    const now = Date.now()

    for (const entry of this.entries) {
      if (entry.count < LONG_TERM_CONFIDENCE_THRESHOLD) continue

      const existing = this.longTermVocab.get(entry.word)
      if (existing) {
        // 合并计数（防止跨会话重置）
        existing.count = Math.max(existing.count, entry.count)
        existing.lastSeenAt = now
        existing.domain = entry.domain // 更新领域分类（可能更准确）
      } else if (this.longTermVocab.size < MAX_LONG_TERM_WORDS) {
        this.longTermVocab.set(entry.word, {
          word: entry.word,
          count: entry.count,
          domain: entry.domain,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        updated++
      }
    }

    if (updated > 0) {
      this.savePersistedVocabulary()
      log('INFO', 'asr_vocab_long_term_updated', {
        new_words: updated,
        total_long_term: this.longTermVocab.size,
      })
    }
  }
}

// ── 单例 ──

/** 全局单例，供 ChatExecutor 和 IPC handler 共享 */
export const asrHotwordManager = new AsrHotwordManager(ASR_HOTWORD_WINDOW_SIZE, ASR_HOTWORD_FREQ_THRESHOLD)
