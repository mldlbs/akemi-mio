/**
 * BehaviorProfileGenerator — 行为驱动的冷启动画像生成器
 *
 * 在 Memory 初始化或为空时，通过分析用户的前几次交互推断偏好，
 * 生成结构化记忆条目加速冷启动个性化。每积累 10 次交互后自动更新。
 *
 * 核心功能：
 * 1. 分析高频主题（复用 TOPIC_PATTERNS 匹配策略）
 * 2. 检测语言偏好（中文 vs 英文使用比例）
 * 3. 推断回复风格偏好（简洁 vs 详细 vs 技术导向）
 * 4. 发现常用命令/工具模式
 * 5. 返回可存储为 Memory 条目的结构化画像数据
 *
 * 输出记忆类型：
 * - style:      回复风格偏好（如"偏好简洁回答"）
 * - language:   语言偏好（如"偏好中文交流"）
 * - preference: 内容偏好（如"关注编程话题"）
 * - detail:     详略偏好（如"偏好技术性解答"）
 *
 * 隐私考虑：
 * - 仅分析最近 10 次交互，避免过度保留
 * - 以概括性标签而非原始文本存储
 * - 生成 ephemeral 层记忆，低置信度，可被后续更新覆盖
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import type { InteractionRecord } from '../memory/types'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 单个画像条目，对应 UserProfileData 风格的 key-value + category */
export interface BehaviorProfileEntry {
  /** 唯一标识 key（如 'answer_style', 'language_preference'） */
  key: string
  /** 推断值（如 '简洁回答', '中文为主', '编程偏好'） */
  value: string
  /** 置信度 0-1（数据越多置信度越高） */
  confidence: number
  /** 分类 */
  category: 'style' | 'detail' | 'language' | 'preference' | 'other'
  /** 来源标记（如 'cold_start', 'milestone_10'） */
  source: string
  /** 用于 MemoryService 存储的展示内容 */
  content: string
  /** 推断依据摘要（调试用，不存储） */
  rationale?: string
}

/** 一次完整画像生成的结果 */
export interface ProfileResult {
  entries: BehaviorProfileEntry[]
  /** 生成时间戳 */
  generatedAt: number
  /** 分析的交互数 */
  totalInteractions: number
  /** 是否成功 */
  success: boolean
  /** 失败原因 */
  error?: string
}

// ══════════════════════════════════════════
// 话题模式（复用 UserBehaviorAnalyzer 的匹配策略）
// ══════════════════════════════════════════

const TOPIC_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /天气/g, label: '天气查询' },
  { pattern: /代码|编程|写.*程序|开发|实现.*功能/g, label: '软件开发' },
  { pattern: /调试|debug|bug|报错|错误|异常|修复/g, label: '调试修复' },
  { pattern: /部署|deploy|上线|发布|发布.*版本/g, label: '部署发布' },
  { pattern: /测试|test|单元测试|集成测试|验证/g, label: '测试验证' },
  { pattern: /重构|refactor|优化|改进|改善/g, label: '代码重构' },
  { pattern: /文档|doc|readme|说明|注释/g, label: '文档编写' },
  { pattern: /配置|config|设置|环境变量|.env/g, label: '配置管理' },
  { pattern: /数据库|database|sql|mongo|redis|存储/g, label: '数据存储' },
  { pattern: /API|接口|REST|GraphQL|端点|endpoint/g, label: 'API 开发' },
  { pattern: /语音|TTS|ASR|说话|朗读|识别|听写/g, label: '语音交互' },
  { pattern: /图片|图像|生成.*图|画.*图|插图/g, label: '图像生成' },
  { pattern: /记忆|remember|记住|回忆|知识/g, label: '知识记忆' },
  { pattern: /计划|plan|任务|task|安排|日程/g, label: '任务管理' },
  { pattern: /写作|writing|写.*小说|创作|故事|章节/g, label: '创意写作' },
  { pattern: /进化|evolution|自.*进化|自我.*改进/g, label: '系统进化' },
  { pattern: /聊天|对话|聊天|hello|hi|你好/g, label: '日常聊天' },
  { pattern: /学习|教程|tutorial|how.?to|示例/g, label: '学习探究' },
  { pattern: /GitHub|git|commit|push|pull|分支|仓库/g, label: '版本控制' },
  { pattern: /SSH|远程|centos|服务器|server|连接/g, label: '远程管理' },
]

// ══════════════════════════════════════════
// 配置常量
// ══════════════════════════════════════════

/** 最小交互数才开始分析（冷启动时至少 1 条即可，但置信度低） */
const MIN_INTERACTIONS = 1

/** 交互数达到此阈值后置信度进入"足够"区间 */
const CONFIDENCE_SUFFICIENT_THRESHOLD = 5

/** 交互数达到此阈值后置信度进入"高"区间 */
const CONFIDENCE_HIGH_THRESHOLD = 15

/** 每条 profile 的最大字符数 */
const MAX_PROFILE_CONTENT_LENGTH = 120

// ══════════════════════════════════════════
// BehaviorProfileGenerator
// ══════════════════════════════════════════

export class BehaviorProfileGenerator {
  /**
   * 从交互记录中生成用户画像条目。
   *
   * @param interactions 最近 N 次交互记录（包含 userText、topics、工具使用等）
   * @param source 来源标记（如 'cold_start', 'milestone_10', 'milestone_20'）
   * @returns ProfileResult 生成的画像条目
   */
  static generateProfile(
    interactions: InteractionRecord[],
    source: string = 'cold_start',
  ): ProfileResult {
    try {
      const userTexts = interactions
        .filter((r) => r.userText && r.userText.trim().length > 0)
        .map((r) => r.userText)

      const totalInteractions = userTexts.length
      if (totalInteractions < MIN_INTERACTIONS) {
        return {
          entries: [],
          generatedAt: Date.now(),
          totalInteractions,
          success: false,
          error: `Insufficient interactions: ${totalInteractions} < ${MIN_INTERACTIONS}`,
        }
      }

      const entries: BehaviorProfileEntry[] = []

      // 1. 语言偏好分析
      const langEntry = BehaviorProfileGenerator.analyzeLanguagePreference(userTexts, source, totalInteractions)
      if (langEntry) entries.push(langEntry)

      // 2. 回复风格偏好分析
      const styleEntry = BehaviorProfileGenerator.analyzeReplyStyle(userTexts, source, totalInteractions)
      if (styleEntry) entries.push(styleEntry)

      // 3. 高频话题偏好
      const topicEntries = BehaviorProfileGenerator.analyzeTopicPreferences(userTexts, source, totalInteractions)
      entries.push(...topicEntries)

      // 4. 消息长度模式（详略偏好）
      const detailEntry = BehaviorProfileGenerator.analyzeDetailPreference(userTexts, source, totalInteractions)
      if (detailEntry) entries.push(detailEntry)

      log('INFO', 'behavior_profile_generated', {
        entries: entries.length,
        interactions: totalInteractions,
        source,
        keys: entries.map((e) => e.key).join(', '),
      })

      return {
        entries,
        generatedAt: Date.now(),
        totalInteractions,
        success: true,
      }
    } catch (err: any) {
      log('WARN', 'behavior_profile_generation_error', {
        error: String(err).slice(0, 300),
      })
      return {
        entries: [],
        generatedAt: Date.now(),
        totalInteractions: interactions.length,
        success: false,
        error: String(err).slice(0, 300),
      }
    }
  }

  /**
   * 根据交互数量计算基础置信度。
   * 1 条交互 → 0.3（低可信），5 条 → 0.6（可参考），15+ 条 → 0.8（较可信）
   */
  private static computeBaseConfidence(interactionCount: number): number {
    if (interactionCount <= 0) return 0.1
    if (interactionCount >= CONFIDENCE_HIGH_THRESHOLD) return 0.8
    if (interactionCount >= CONFIDENCE_SUFFICIENT_THRESHOLD) return 0.6
    // 1-4 条：从 0.3 线性增长到 0.55
    return 0.3 + (interactionCount / CONFIDENCE_SUFFICIENT_THRESHOLD) * 0.3
  }

  // ══════════════════════════════════════════
  //  1. 语言偏好分析
  // ══════════════════════════════════════════

  /**
   * 分析用户语言使用偏好。
   * 通过统计中文字符和英文字符的比例来推断。
   */
  private static analyzeLanguagePreference(
    texts: string[],
    source: string,
    totalCount: number,
  ): BehaviorProfileEntry | null {
    if (texts.length === 0) return null

    let chineseChars = 0
    let englishChars = 0
    let totalChars = 0

    for (const text of texts) {
      for (const char of text) {
        totalChars++
        if (/[一-鿿]/.test(char)) chineseChars++
        else if (/[a-zA-Z]/.test(char)) englishChars++
      }
    }

    if (totalChars === 0) return null

    const chineseRatio = chineseChars / totalChars
    const englishRatio = englishChars / totalChars

    let value: string
    let confidence = this.computeBaseConfidence(totalCount)

    if (chineseRatio > 0.6) {
      value = '偏好中文交流'
      confidence = Math.min(confidence + 0.1, 0.9)
    } else if (englishRatio > 0.6) {
      value = '偏好英文交流'
      confidence = Math.min(confidence + 0.1, 0.9)
    } else if (chineseRatio > 0.3 && englishRatio > 0.3) {
      value = '中英混合交流'
      confidence = Math.max(confidence - 0.1, 0.2)
    } else {
      return null // 无法判断
    }

    return {
      key: 'language_preference',
      value,
      confidence,
      category: 'language',
      source,
      content: `【语言偏好】${value}`,
      rationale: `chinese=${(chineseRatio * 100).toFixed(0)}%, english=${(englishRatio * 100).toFixed(0)}%`,
    }
  }

  // ══════════════════════════════════════════
  //  2. 回复风格偏好分析
  // ══════════════════════════════════════════

  /**
   * 分析用户偏好的回复风格。
   * - 短消息 + 明确指令 → 简洁模式
   * - 开放式提问 + 较长消息 → 详细/深入模式
   * - 包含技术关键词 → 技术模式
   * - 闲聊/寒暄 → 聊天模式
   */
  private static analyzeReplyStyle(
    texts: string[],
    source: string,
    totalCount: number,
  ): BehaviorProfileEntry | null {
    if (texts.length === 0) return null

    const avgLength = texts.reduce((s, t) => s + t.length, 0) / texts.length

    // 检测指令关键词
    const commandPatterns = [
      { pattern: /修复|fix|改|写|create|make|implement/gi, type: 'directive' },
      { pattern: /为什么|how|what|能否|可以|请/gi, type: 'question' },
      { pattern: /聊天|hello|hi|你好|怎么样/gi, type: 'chat' },
      { pattern: /调试|debug|error|报错/gi, type: 'debug' },
    ]

    const typeScores: Record<string, number> = {
      directive: 0,
      question: 0,
      chat: 0,
      debug: 0,
    }

    for (const text of texts) {
      for (const { pattern, type } of commandPatterns) {
        if (pattern.test(text)) typeScores[type]++
      }
    }

    let value: string
    let confidence = this.computeBaseConfidence(totalCount)

    // 调试模式：高频 debug/error 关键词
    if (typeScores.debug >= 2 || (typeScores.debug >= 1 && avgLength > 50)) {
      value = '偏好技术性解答'
      confidence = Math.min(confidence + 0.15, 0.9)
    }
    // 简短指令模式
    else if (typeScores.directive > typeScores.question && avgLength < 60) {
      value = '偏好简洁回答'
      confidence = Math.min(confidence + 0.1, 0.85)
    }
    // 探索问答模式
    else if (typeScores.question > typeScores.directive && avgLength > 40) {
      value = '偏好详细分析'
      confidence = Math.min(confidence + 0.1, 0.8)
    }
    // 聊天模式
    else if (typeScores.chat >= Math.ceil(texts.length * 0.5)) {
      value = '偏好轻松聊天'
      confidence = Math.min(confidence + 0.05, 0.7)
    }
    // 混合或无法判断
    else {
      return null
    }

    return {
      key: 'answer_style',
      value,
      confidence,
      category: 'style',
      source,
      content: `【行为偏好】${value}`,
      rationale: `avgLen=${avgLength.toFixed(0)}, types=${JSON.stringify(typeScores)}`,
    }
  }

  // ══════════════════════════════════════════
  //  3. 高频话题分析
  // ══════════════════════════════════════════

  /**
   * 分析用户高频话题偏好。
   * 复用 TOPIC_PATTERNS 进行匹配，统计出现次数。
   * 每个突出的话题生成一条偏好条目。
   */
  private static analyzeTopicPreferences(
    texts: string[],
    source: string,
    totalCount: number,
  ): BehaviorProfileEntry[] {
    if (texts.length === 0) return []

    const topicCounts = new Map<string, number>()

    for (const text of texts) {
      for (const { pattern, label } of TOPIC_PATTERNS) {
        pattern.lastIndex = 0
        const matches = text.match(pattern)
        if (matches) {
          topicCounts.set(label, (topicCounts.get(label) || 0) + matches.length)
        }
      }
    }

    if (topicCounts.size === 0) return []

    const entries: BehaviorProfileEntry[] = []

    // 找 top 2 话题（出现次数 >= 2 或出现率 >= 50%）
    const sorted = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count >= 2 || (count / texts.length) >= 0.5)

    const topTopics = sorted.slice(0, 2)
    const baseConfidence = this.computeBaseConfidence(totalCount)

    for (const [topic, count] of topTopics) {
      // 跳过"日常聊天"作为次要话题（过于普遍）
      if (topic === '日常聊天' && sorted.length > 1) continue

      let value: string
      let confidence = Math.min(baseConfidence + 0.1, 0.85)

      if (topic === '软件开发' || topic === '调试修复') {
        value = '关注编程开发'
      } else if (topic === '创意写作') {
        value = '关注创意写作'
      } else if (topic === '图像生成') {
        value = '关注图像生成'
      } else if (topic === '系统进化') {
        value = '关注自进化'
      } else if (topic === '任务管理') {
        value = '关注任务管理'
      } else if (topic === '学习探究') {
        value = '关注学习研究'
      } else if (topic === '日常聊天') {
        value = '关注日常交流'
        confidence = Math.max(confidence - 0.2, 0.3)
      } else {
        value = `关注${topic}`
      }

      entries.push({
        key: 'topic_preference_' + topic.slice(0, 8),
        value,
        confidence,
        category: 'preference',
        source,
        content: `【内容偏好】${value}`,
        rationale: `${topic}=${count}次`,
      })
    }

    return entries
  }

  // ══════════════════════════════════════════
  //  4. 消息长度模式（详略偏好）
  // ══════════════════════════════════════════

  /**
   * 分析用户消息的详略偏好。
   * - 消息一贯较短（< 30 字符平均） → 偏好简洁
   * - 消息一贯较长（> 100 字符平均） → 偏好详细
   */
  private static analyzeDetailPreference(
    texts: string[],
    source: string,
    totalCount: number,
  ): BehaviorProfileEntry | null {
    if (texts.length < 2) return null // 需要至少 2 条消息判断模式

    const avgLength = texts.reduce((s, t) => s + t.length, 0) / texts.length

    if (avgLength < 30) {
      return {
        key: 'detail_preference',
        value: '偏好简洁输入',
        confidence: Math.min(this.computeBaseConfidence(totalCount), 0.6),
        category: 'detail',
        source,
        content: '【详略偏好】偏好简洁输入',
        rationale: `avgLen=${avgLength.toFixed(0)}`,
      }
    }

    if (avgLength > 100) {
      return {
        key: 'detail_preference',
        value: '偏好详细描述',
        confidence: Math.min(this.computeBaseConfidence(totalCount) + 0.05, 0.7),
        category: 'detail',
        source,
        content: '【详略偏好】偏好详细描述',
        rationale: `avgLen=${avgLength.toFixed(0)}`,
      }
    }

    return null
  }
}
