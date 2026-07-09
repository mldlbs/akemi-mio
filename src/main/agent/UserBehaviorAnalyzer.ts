/**
 * UserBehaviorAnalyzer — 行为驱动工具预激活
 *
 * 在 Agent 处理用户请求前，分析最近 N 次交互，提取高频工具和话题模式。
 * 根据模式动态调整 Agent 的初始 prompt 或工具优先级。
 *
 * 例如：若用户连续多次询问天气，Agent 自动将天气工具设为优先，
 * 并在回复中主动询问是否需要天气详情。
 *
 * 集成点：
 * 1. ChatExecutor.toolLoop() 中 recordToolCall() 记录每次工具调用
 * 2. ChatExecutor.refreshMemory() 中调用 analyze() 获取模式，注入 extraModules
 * 3. analyze() 返回的 suggestedToolHints 以 prompt 片段形式追加到 system prompt
 */

import { log } from '../logger/Logger'
import type { StoredMessage } from '../db/messages'

// ── 配置常量 ──

/** 分析窗口大小（最近 N 次交互） */
const ANALYSIS_WINDOW = 16

/** 高频阈值：工具调用次数 >= 此值视为高频 */
const HIGH_FREQ_TOOL_THRESHOLD = 3

/** 话题关键词的最小出现次数 */
const TOPIC_MIN_OCCURRENCES = 2

/** 提示注入的最大工具数 */
const MAX_SUGGESTED_TOOLS = 5

/** 提示注入的最大话题数 */
const MAX_SUGGESTED_TOPICS = 3

/** 重复模式检测：检查最近 N 条消息 */
const REPEAT_DETECTION_WINDOW = 8

/** 重复模式检测：Jaccard 相似度阈值（超过此值视为重复提问） */
const REPEAT_SIMILARITY_THRESHOLD = 0.55

/** 重复模式检测：最小消息长度（字符数，低于此值跳过检测） */
const REPEAT_MIN_MESSAGE_LENGTH = 6

// ── 话题关键词提取（中文 + 英文） ──

/**
 * 从用户消息中提取话题关键词。
 * 使用简单的名词短语 + 关键词匹配策略，
 * 不依赖 LLM（避免在热路径上增加延迟）。
 */
const TOPIC_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // 中文模式
  { pattern: /天气/g, label: '天气查询' },
  { pattern: /代码|编程|写.*程序|开发|实现.*功能/g, label: '软件开发' },
  { pattern: /调试|debug|bug|报错|错误|异常|修复/g, label: '调试修复' },
  { pattern: /部署|deploy|上线|发布|发布.*版本/g, label: '部署发布' },
  { pattern: /测试|test|单元测试|集成测试|验证/g, label: '测试验证' },
  { pattern: /重构|refactor|优化|改进|改善/g, label: '代码重构' },
  { pattern: /文档|doc|readme|说明|注释/g, label: '文档编写' },
  { pattern: /搜索|查找|找.*文件|grep|搜索.*代码/g, label: '代码搜索' },
  { pattern: /配置|config|设置|环境变量|.env/g, label: '配置管理' },
  { pattern: /数据库|database|sql|mongo|redis|存储/g, label: '数据存储' },
  { pattern: /API|接口|REST|GraphQL|端点|endpoint/g, label: 'API 开发' },
  { pattern: /语音|TTS|ASR|说话|朗读|识别|听写/g, label: '语音交互' },
  { pattern: /图片|图像|生成.*图|画.*图|插图/g, label: '图像生成' },
  { pattern: /记忆|remember|记住|回忆|知识/g, label: '知识记忆' },
  { pattern: /计划|plan|任务|task|安排|日程/g, label: '任务管理' },
  { pattern: /工作流|workflow|流程|自动化|编排/g, label: '工作流自动化' },
  { pattern: /GitHub|git|commit|push|pull|分支|仓库/g, label: '版本控制' },
  { pattern: /SSH|远程|centos|服务器|server|连接/g, label: '远程管理' },
  { pattern: /写作|writing|写.*小说|创作|故事|章节/g, label: '创意写作' },
  { pattern: /进化|evolution|自.*进化|自我.*改进/g, label: '系统进化' },
]

// ── 工具→话题映射（用于反向推断） ──

/** 工具名到话题标签的映射，用于从工具调用反推用户意图 */
const TOOL_TOPIC_MAP: Record<string, string> = {
  read_file: '代码阅读',
  write_file: '代码编写',
  edit_file: '代码修改',
  grep: '代码搜索',
  list_files: '文件浏览',
  run_command: '命令执行',
  create_dev_plan: '任务规划',
  update_plan_progress: '任务执行',
  analyze_codebase: '代码分析',
  analyze_task: '任务分析',
  remember_fact: '知识记忆',
  generate_image: '图像生成',
  writing_system: '创意写作',
  auto_schedule_workflow: '工作流编排',
  grep_centos: '远程搜索',
  read_file_centos: '远程读取',
  write_file_centos: '远程写入',
  exec_centos: '远程执行',
  social_pipeline: '社交媒体',
  query_trends: '趋势查询',
}

// ── 类型定义 ──

export interface ToolCallRecord {
  name: string
  timestamp: number
  /** 调用是否成功 */
  success?: boolean
  /** 失败时的错误信息（截断） */
  error?: string
}

export interface BehaviorPattern {
  /** 高频工具列表（按调用次数降序） */
  highFrequencyTools: string[]
  /** 每个高频工具的调用次数 */
  toolCallCounts: Record<string, number>
  /** 话题关键词列表（按出现次数降序） */
  recentTopics: string[]
  /** 每个话题的出现次数 */
  topicCounts: Record<string, number>
  /** 注入 system prompt 的工具提示片段 */
  suggestedToolHints: string[]
  /** 是否检测到足够的交互数据 */
  hasSufficientData: boolean
  /** 总分析窗口内的交互次数 */
  totalInteractions: number
}

export interface AnalysisOptions {
  /** 分析窗口大小，默认 16 */
  windowSize?: number
  /** 高频阈值，默认 3 */
  highFreqThreshold?: number
  /** 话题最小出现次数，默认 2 */
  topicMinOccurrences?: number
}

/** 重复提问检测结果 */
export interface RepeatedPattern {
  /** 是否检测到重复提问模式 */
  detected: boolean
  /** 与当前消息最相似的历史消息索引（在 recentUserMessages 中的位置） */
  matchedIndex: number
  /** Jaccard 相似度 (0-1) */
  similarity: number
  /** 当前消息提取的话题标签 */
  currentTopics: string[]
  /** 匹配到的历史消息的话题标签 */
  matchedTopics: string[]
  /** 合并去重后的话题标签（用于记忆强化） */
  mergedTopics: string[]
  /** 当前消息文本（截断） */
  currentText: string
  /** 匹配的历史消息文本（截断） */
  matchedText: string
}

// ── UserBehaviorAnalyzer ──

export class UserBehaviorAnalyzer {
  /** 最近 N 次工具调用记录（仅记录名称和时间戳） */
  private recentToolCalls: ToolCallRecord[] = []

  /** 最近 N 条用户消息（从 DB 或运行时收集） */
  private recentUserMessages: { content: string; timestamp: number }[] = []

  /** 最大保留记录数 */
  private maxRecords: number

  /** 用户反馈：被标记为"不相关"的工具模式（用于降低误判） */
  private suppressedTools: Set<string> = new Set()

  /** 用户反馈：被确认的优先工具 */
  private confirmedTools: Set<string> = new Set()

  constructor(maxRecords = ANALYSIS_WINDOW * 2) {
    this.maxRecords = maxRecords
  }

  // ── 数据采集 ──

  /** 记录一次工具调用（仅跟踪频率） */
  recordToolCall(name: string): void {
    this.recentToolCalls.push({ name, timestamp: Date.now() })
    if (this.recentToolCalls.length > this.maxRecords) {
      this.recentToolCalls = this.recentToolCalls.slice(-this.maxRecords)
    }
  }

  /**
   * 记录一次工具调用的结果（含质量信息）。
   * 供 ToolFeedbackLoop 等反馈回路使用。
   */
  recordToolCallResult(name: string, success: boolean, error?: string): void {
    this.recentToolCalls.push({
      name,
      timestamp: Date.now(),
      success,
      error: error ? error.slice(0, 500) : undefined,
    })
    if (this.recentToolCalls.length > this.maxRecords) {
      this.recentToolCalls = this.recentToolCalls.slice(-this.maxRecords)
    }
  }

  /**
   * 获取指定工具在分析窗口内的质量指标。
   * 返回成功率、总调用次数的快照，供反馈回路消费。
   */
  getToolQualityMetrics(windowSize?: number): Map<string, { successRate: number; totalCalls: number; lastSuccess: boolean }> {
    const size = windowSize ?? ANALYSIS_WINDOW
    const recent = this.recentToolCalls.slice(-size)
    const perTool = new Map<string, { ok: number; total: number; lastOk: boolean }>()

    for (const tc of recent) {
      let entry = perTool.get(tc.name)
      if (!entry) {
        entry = { ok: 0, total: 0, lastOk: true }
        perTool.set(tc.name, entry)
      }
      entry.total++
      if (tc.success !== false) entry.ok++ // undefined → true (backward compat)
      if (tc.success !== undefined) entry.lastOk = tc.success
    }

    const result = new Map<string, { successRate: number; totalCalls: number; lastSuccess: boolean }>()
    for (const [name, stats] of perTool) {
      result.set(name, {
        successRate: stats.total > 0 ? stats.ok / stats.total : 1,
        totalCalls: stats.total,
        lastSuccess: stats.lastOk,
      })
    }
    return result
  }

  /** 记录一条用户消息 */
  recordUserMessage(content: string): void {
    if (!content || content.trim().length === 0) return
    this.recentUserMessages.push({ content: content.trim(), timestamp: Date.now() })
    if (this.recentUserMessages.length > this.maxRecords) {
      this.recentUserMessages = this.recentUserMessages.slice(-this.maxRecords)
    }
  }

  /**
   * 从 DB 的 StoredMessage 数组批量加载用户消息。
   * 用于冷启动时从持久化存储恢复分析状态。
   */
  loadFromStoredMessages(messages: StoredMessage[]): void {
    const userMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ content: m.content, timestamp: m.createdAt }))
    // 只取最近 maxRecords 条
    this.recentUserMessages = userMessages.slice(-this.maxRecords)
  }

  // ── 分析 ──

  /**
   * 分析最近的交互模式。
   * @param options 可选配置覆盖
   * @returns BehaviorPattern 分析结果
   */
  analyze(options?: AnalysisOptions): BehaviorPattern {
    const windowSize = options?.windowSize ?? ANALYSIS_WINDOW
    const highFreqThreshold = options?.highFreqThreshold ?? HIGH_FREQ_TOOL_THRESHOLD
    const topicMinOccurrences = options?.topicMinOccurrences ?? TOPIC_MIN_OCCURRENCES

    // 1. 分析工具调用频率
    const recentTools = this.recentToolCalls.slice(-windowSize)
    const toolCounts: Record<string, number> = {}
    for (const tc of recentTools) {
      toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1
    }

    // 过滤高频工具（超过阈值 & 未被抑制）
    const highFreqTools = Object.entries(toolCounts)
      .filter(([name, count]) => count >= highFreqThreshold && !this.suppressedTools.has(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SUGGESTED_TOOLS)
      .map(([name]) => name)

    // 已确认的工具总是排在前面
    highFreqTools.sort((a, b) => {
      const aConfirmed = this.confirmedTools.has(a) ? 1 : 0
      const bConfirmed = this.confirmedTools.has(b) ? 1 : 0
      return bConfirmed - aConfirmed
    })

    // 2. 分析话题模式
    const recentUserMsgs = this.recentUserMessages.slice(-windowSize)
    const topicCounts: Record<string, number> = {}

    for (const msg of recentUserMsgs) {
      for (const { pattern, label } of TOPIC_PATTERNS) {
        // 重置 regex lastIndex（因为用了 /g flag）
        pattern.lastIndex = 0
        const matches = msg.content.match(pattern)
        if (matches) {
          topicCounts[label] = (topicCounts[label] || 0) + matches.length
        }
      }
    }

    // 从工具调用推断话题（补充用户消息未覆盖的）
    for (const tc of recentTools) {
      const topic = TOOL_TOPIC_MAP[tc.name]
      if (topic) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1
      }
    }

    // 过滤高频话题
    const recentTopics = Object.entries(topicCounts)
      .filter(([, count]) => count >= topicMinOccurrences)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SUGGESTED_TOPICS)
      .map(([label]) => label)

    // 3. 生成提示片段
    const suggestedToolHints = this._buildToolHints(highFreqTools, recentTopics, toolCounts)

    // 4. 数据充足性判断
    const totalInteractions = recentUserMsgs.length
    const hasSufficientData = totalInteractions >= 3

    const result: BehaviorPattern = {
      highFrequencyTools: highFreqTools,
      toolCallCounts: toolCounts,
      recentTopics,
      topicCounts,
      suggestedToolHints,
      hasSufficientData,
      totalInteractions,
    }

    if (hasSufficientData && (highFreqTools.length > 0 || recentTopics.length > 0)) {
      log('INFO', 'behavior_pattern_detected', {
        tools: highFreqTools.slice(0, 5),
        topics: recentTopics.slice(0, 3),
        interactions: totalInteractions,
      })
    }

    return result
  }

  /**
   * 生成用于注入 system prompt 的工具提示片段。
   * 按优先级从高到低排列，每条约 60-120 字。
   */
  private _buildToolHints(
    tools: string[],
    topics: string[],
    toolCounts: Record<string, number>,
  ): string[] {
    const hints: string[] = []

    if (tools.length > 0) {
      const toolList = tools
        .map((t) => {
          const count = toolCounts[t] || 0
          return `\`${t}\`（最近使用 ${count} 次）`
        })
        .join('、')

      hints.push(
        `【行为预判 · 工具优先级】检测到你最近频繁使用以下工具：${toolList}。` +
          `在回复用户前，优先考虑这些工具是否能直接满足当前需求。若适用，主动调用而非等待用户明确指定。`,
      )
    }

    if (topics.length > 0) {
      const topicList = topics.join('、')
      hints.push(
        `【行为预判 · 话题感知】当前活跃话题：${topicList}。` +
          `回复时可结合这些话题提供更相关的建议。如果检测到用户可能在延续同一话题，` +
          `主动使用相关工具获取最新信息。`,
      )
    }

    // 如果工具和话题都有模式，生成主动建议提示
    if (tools.length > 0 && topics.length > 0) {
      hints.push(
        `【行为预判 · 主动服务】基于你的使用习惯，如果当前请求与「${topics[0]}」相关，` +
          `建议在完成用户请求后，主动询问是否需要进一步操作（如深度分析、生成报告等）。`,
      )
    }

    return hints
  }

  // ── 重复模式检测 ──

  /**
   * 检测用户是否在短时间内重复提问相似问题。
   * 使用字符 bigram Jaccard 相似度进行快速比较，
   * 不依赖 LLM（避免在热路径上增加延迟）。
   *
   * @param currentText 当前用户消息
   * @returns RepeatedPattern 检测结果
   */
  detectRepeatedPattern(currentText: string): RepeatedPattern {
    const emptyResult: RepeatedPattern = {
      detected: false,
      matchedIndex: -1,
      similarity: 0,
      currentTopics: [],
      matchedTopics: [],
      mergedTopics: [],
      currentText: currentText.slice(0, 80),
      matchedText: '',
    }

    if (!currentText || currentText.trim().length < REPEAT_MIN_MESSAGE_LENGTH) {
      return emptyResult
    }

    const normalized = currentText.trim().toLowerCase()
    // 检查最近 N 条消息（排除自身）
    const recent = this.recentUserMessages.slice(-REPEAT_DETECTION_WINDOW)
    if (recent.length < 2) return emptyResult

    // 提取当前消息的话题标签
    const currentTopics = this._extractTopicsFromText(currentText)

    let bestSimilarity = 0
    let bestIndex = -1
    let bestText = ''

    // 倒序遍历（最近的优先），找到最高相似度的匹配
    for (let i = recent.length - 1; i >= 0; i--) {
      const past = recent[i]
      // 跳过自己（同一时间戳的相同消息）
      if (past.content === currentText.trim()) continue
      if (past.content.length < REPEAT_MIN_MESSAGE_LENGTH) continue

      const similarity = computeBigramJaccard(
        normalized,
        past.content.toLowerCase(),
      )

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestIndex = i
        bestText = past.content
      }
    }

    if (bestSimilarity < REPEAT_SIMILARITY_THRESHOLD || bestIndex < 0) {
      return { ...emptyResult, similarity: bestSimilarity, currentTopics }
    }

    // 提取匹配消息的话题标签
    const matchedTopics = this._extractTopicsFromText(bestText)
    // 合并去重话题标签
    const mergedTopics = [...new Set([...currentTopics, ...matchedTopics])]

    log('INFO', 'behavior_repeat_detected', {
      similarity: bestSimilarity.toFixed(3),
      currentTopics,
      matchedTopics,
      mergedTopics,
      currentSnippet: normalized.slice(0, 40),
      matchedSnippet: bestText.slice(0, 40),
    })

    return {
      detected: true,
      matchedIndex: bestIndex,
      similarity: bestSimilarity,
      currentTopics,
      matchedTopics,
      mergedTopics,
      currentText: normalized.slice(0, 80),
      matchedText: bestText.slice(0, 80),
    }
  }

  /**
   * 从单条文本中提取话题标签（供 detectRepeatedPattern 使用）。
   * 复用 TOPIC_PATTERNS + TOOL_TOPIC_MAP（工具不可用，仅做文本匹配）。
   */
  private _extractTopicsFromText(text: string): string[] {
    const topics: string[] = []
    const lower = text.toLowerCase()
    for (const { pattern, label } of TOPIC_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(lower)) {
        topics.push(label)
      }
    }
    return [...new Set(topics)].slice(0, MAX_SUGGESTED_TOPICS)
  }

  // ── 用户反馈调节 ──

  /**
   * 用户标记某个工具模式为"不相关"。
   * 该工具将被抑制一段时间（由外部定时器管理），减少误判。
   */
  suppressTool(toolName: string): void {
    this.suppressedTools.add(toolName)
    log('INFO', 'behavior_tool_suppressed', { tool: toolName })
  }

  /**
   * 用户确认某个工具优先。
   * 该工具在后续分析中将排在前面。
   */
  confirmTool(toolName: string): void {
    this.confirmedTools.add(toolName)
    log('INFO', 'behavior_tool_confirmed', { tool: toolName })
  }

  /**
   * 取消对某工具的确认（恢复普通优先级）。
   * 供 ToolFeedbackLoop 在成功率下降时调用。
   */
  unconfirmTool(toolName: string): void {
    this.confirmedTools.delete(toolName)
    log('INFO', 'behavior_tool_unconfirmed', { tool: toolName })
  }

  /**
   * 清除对某工具的抑制（超时后由外部调用）。
   */
  unsuppressTool(toolName: string): void {
    this.suppressedTools.delete(toolName)
    log('INFO', 'behavior_tool_unsuppressed', { tool: toolName })
  }

  /** 重置所有用户反馈 */
  resetFeedback(): void {
    this.suppressedTools.clear()
    this.confirmedTools.clear()
  }

  /** 获取当前抑制列表（用于持久化） */
  getSuppressedTools(): string[] {
    return [...this.suppressedTools]
  }

  /** 获取当前确认列表（用于持久化） */
  getConfirmedTools(): string[] {
    return [...this.confirmedTools]
  }

  // ── 状态管理 ──

  /** 清除所有运行时数据（不重置用户反馈） */
  clear(): void {
    this.recentToolCalls = []
    this.recentUserMessages = []
  }

  /** 完全重置 */
  reset(): void {
    this.clear()
    this.resetFeedback()
  }
}

// ── 文本相似度工具 ──

/**
 * 计算两个文本的字符 bigram Jaccard 相似度。
 * 纯字符串运算，不依赖任何外部库，适合在热路径上使用。
 *
 * 算法：
 * 1. 将文本转为小写并提取所有相邻字符对（bigram）
 * 2. Jaccard = |交集| / |并集|
 * 3. 返回 0~1 之间的相似度
 *
 * 示例：
 *   "hello" → ["he","el","ll","lo"]
 *   "helo"  → ["he","el","lo"]
 *   Jaccard = 3/5 = 0.6
 */
export function computeBigramJaccard(a: string, b: string): number {
  if (a === b) return 1.0
  if (!a || !b) return 0

  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()

  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2))
  }
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2))
  }

  if (bigramsA.size === 0 && bigramsB.size === 0) return 0

  // 计算交集大小
  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  const union = bigramsA.size + bigramsB.size - intersection
  if (union === 0) return 0

  return intersection / union
}

// ── 单例 ──

/** 全局单例，供 ChatExecutor 和 AgentService 共享 */
export const userBehaviorAnalyzer = new UserBehaviorAnalyzer()
