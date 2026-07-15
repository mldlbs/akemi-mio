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

// ── 场景分类与自适应回复模式 ──

/**
 * 交互场景标签 — 根据用户行为分析得出的场景判断
 */
export type SceneLabel =
  | 'code_debugging' // 代码调试/修复
  | 'quick_qa' // 快速问答
  | 'casual_chat' // 日常闲聊
  | 'deep_discussion' // 深入讨论
  | 'creative_writing' // 创意写作
  | 'system_evolution' // 系统进化
  | 'task_execution' // 任务执行
  | 'unknown' // 未知/默认

/**
 * 回复模式 — 由场景决定的 Agent 输出风格
 */
export type ResponseMode =
  | 'concise' // 简洁直接
  | 'detailed' // 详细深入
  | 'technical' // 技术优先
  | 'warm_chat' // 温暖聊天

/** 交互详情记录（用于后续统计） */
export interface InteractionDetail {
  type: 'user_message' | 'tool_call'
  length: number
  domainLabel: string
  timestamp: number
  text?: string
}

/** 场景分析完整结果 */
export interface SceneAnalysisResult {
  /** 判定场景 */
  scene: SceneLabel
  /** 置信度 0-1 */
  confidence: number
  /** 推荐的回复模式 */
  responseMode: ResponseMode
  /** 近窗口内用户消息平均长度（字符数） */
  avgUserMessageLength: number
  /** 近窗口内工具调用占比（0-1） */
  toolUsageRatio: number
  /** 近窗口内的主导话题（最多 3 个） */
  dominantTopics: string[]
  /** 分析用词频快照（最高频的前 5 个词） */
  topKeywords: string[]
  /** 数据是否足够做判断 */
  hasSufficientData: boolean
}

// ── 场景判定阈值 ──

/** 快速问答：用户消息平均长度低于此值（字符数） */
const QUICK_QA_MAX_AVG_LENGTH = 30
/** 深入讨论：用户消息平均长度高于此值 */
const DEEP_DISCUSS_MIN_AVG_LENGTH = 120
/** 工具使用占比高阈值 */
const HIGH_TOOL_USAGE_RATIO = 0.4
/** 工具使用占比低阈值 */
const LOW_TOOL_USAGE_RATIO = 0.05
/** 场景分析最小交互数 */
const SCENE_MIN_INTERACTIONS = 3

// ── 场景 → 回复模式映射 ──

const SCENE_TO_MODE: Record<SceneLabel, ResponseMode> = {
  code_debugging: 'technical',
  quick_qa: 'concise',
  casual_chat: 'warm_chat',
  deep_discussion: 'detailed',
  creative_writing: 'warm_chat',
  system_evolution: 'technical',
  task_execution: 'detailed',
  unknown: 'warm_chat',
}

// ── 场景感知系统 Prompt 模板 ──

const SCENE_PROMPTS: Record<ResponseMode, string> = {
  concise: `【自适应·简洁模式】
检测到当前为快速问答场景。回复要求：
- 一句话直接回答问题，不加开场白和结束语
- 不提供额外解释、选项或背景信息
- 长度控制在 50 字以内`,
  detailed: `【自适应·详细模式】
检测到当前为深入讨论场景。回复要求：
- 提供全面细致的分析和论证
- 可以分点展开，结构化输出
- 长度不限，以信息完整为准`,
  technical: `【自适应·技术模式】
检测到当前为编程/调试场景。回复要求：
- 回复集中在技术实现和问题解决上
- 回答直接，避免冗长；如已完成必要操作再说明结果
- 代码和命令优先于文字解释`,
  warm_chat: `【自适应·聊天模式】
检测到当前为日常聊天场景。回复要求：
- 用温暖自然的语气聊天，像朋友一样
- 不要输出代码、技术细节或格式标记
- 带有关怀感，适当关心用户状态`,
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

  // ── 场景分析与自适应 ──

  /** 交互详情队列（用于场景分析） */
  private interactionDetails: InteractionDetail[] = []

  /** 词频统计（窗口内每个词的 TF） */
  private wordFrequencyMap: Map<string, number> = new Map()

  /** 总词数（用于 TF 计算） */
  private totalWordCount = 0

  /** 上次分析缓存的场景结果 */
  private cachedSceneResult: SceneAnalysisResult | null = null

  /** 当前生效的回复模式 */
  private currentResponseMode: ResponseMode = 'warm_chat'

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
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => ({ content: m.content, timestamp: m.createdAt }))
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
  private _buildToolHints(tools: string[], topics: string[], toolCounts: Record<string, number>): string[] {
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

      const similarity = computeBigramJaccard(normalized, past.content.toLowerCase())

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

  /** 获取最近工具调用次数（供 ToolPolicyPlanner 信号检测使用） */
  getRecentToolCallCount(): number {
    return this.recentToolCalls.length
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

  // ── 场景分析与自适应 ──

  /**
   * 记录一次完整的交互详情（供场景分析用）。
   * 包括用户消息和工具调用两种类型。
   */
  recordInteractionDetail(detail: InteractionDetail): void {
    this.interactionDetails.push(detail)
    if (this.interactionDetails.length > this.maxRecords) {
      this.interactionDetails = this.interactionDetails.slice(-this.maxRecords)
    }
    // 更新词频
    if (detail.type === 'user_message' && detail.text) {
      this._updateWordFrequencies(detail.text)
    }
  }

  /**
   * 获取最近 N 次交互详情的窗口。
   * N 默认等于 ANALYSIS_WINDOW。
   */
  private _getInteractionWindow(size = ANALYSIS_WINDOW): InteractionDetail[] {
    return this.interactionDetails.slice(-size)
  }

  /**
   * 分析当前交互场景 — 基于近窗口内的交互模式。
   *
   * 判定依据：
   * 1. 用户消息平均长度
   * 2. 工具调用频率和类型
   * 3. 话题分布（复用 TOPIC_PATTERNS）
   * 4. 高频词特征
   *
   * 同步、轻量、无 LLM 调用。
   */
  analyzeScene(options?: AnalysisOptions): SceneAnalysisResult {
    const windowSize = options?.windowSize ?? ANALYSIS_WINDOW
    const window = this._getInteractionWindow(windowSize)

    // 数据充足性
    const userMsgs = window.filter((d) => d.type === 'user_message')
    const toolCalls = window.filter((d) => d.type === 'tool_call')
    const hasSufficientData = userMsgs.length >= SCENE_MIN_INTERACTIONS

    // 1. 计算平均用户消息长度
    const avgLength = userMsgs.length > 0 ? Math.round(userMsgs.reduce((s, d) => s + d.length, 0) / userMsgs.length) : 0

    // 2. 工具调用占比
    const toolRatio = window.length > 0 ? toolCalls.length / window.length : 0

    // 3. 从用户消息提取话题
    const recentUserTexts = this.recentUserMessages.slice(-windowSize).map((m) => m.content)
    const topicCounts: Record<string, number> = {}
    for (const text of recentUserTexts) {
      for (const { pattern, label } of TOPIC_PATTERNS) {
        pattern.lastIndex = 0
        const matches = text.match(pattern)
        if (matches) {
          topicCounts[label] = (topicCounts[label] || 0) + matches.length
        }
      }
    }
    // 从工具调用推断话题
    const recentTools = this.recentToolCalls.slice(-windowSize)
    for (const tc of recentTools) {
      const topic = TOOL_TOPIC_MAP[tc.name]
      if (topic) topicCounts[topic] = (topicCounts[topic] || 0) + 1
    }
    const dominantTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label)

    // 4. 提取高频关键词
    const topKeywords = this._getTopKeywords(5)

    // 5. 场景判定
    const { scene, confidence } = this._classifyScene({
      avgUserMessageLength: avgLength,
      toolUsageRatio: toolRatio,
      dominantTopics,
      topKeywords,
      totalInteractions: window.length,
      userMessageCount: userMsgs.length,
      hasTools: toolCalls.length > 0,
    })

    // 6. 选择回复模式
    const responseMode = SCENE_TO_MODE[scene]

    // 缓存结果
    const result: SceneAnalysisResult = {
      scene,
      confidence,
      responseMode,
      avgUserMessageLength: avgLength,
      toolUsageRatio: toolRatio,
      dominantTopics,
      topKeywords,
      hasSufficientData,
    }
    this.cachedSceneResult = result
    this.currentResponseMode = responseMode

    if (hasSufficientData) {
      log('INFO', 'behavior_scene_analyzed', {
        scene,
        confidence: confidence.toFixed(2),
        mode: responseMode,
        avgLen: avgLength,
        toolRatio: toolRatio.toFixed(2),
        topics: dominantTopics.slice(0, 2),
      })
    }

    return result
  }

  /** 获取缓存的场景分析结果（不重新计算） */
  getCachedSceneResult(): SceneAnalysisResult | null {
    return this.cachedSceneResult
  }

  /** 获取当前回复模式 */
  getCurrentResponseMode(): ResponseMode {
    return this.currentResponseMode
  }

  /**
   * 获取适应当前场景的系统 Prompt 片段。
   * 会包含场景模式指令 + 活跃话题提示。
   */
  getScenePrompt(scene?: SceneLabel, mode?: ResponseMode): string {
    const s = scene ?? this.cachedSceneResult?.scene ?? 'unknown'
    const m = mode ?? this.currentResponseMode
    const basePrompt = SCENE_PROMPTS[m] || SCENE_PROMPTS.warm_chat

    // 如果有活跃话题，追加话题感知提示
    const topics = this.cachedSceneResult?.dominantTopics
    if (topics && topics.length > 0) {
      return `${basePrompt}\n\n【自适应·话题感知】当前活跃话题：${topics.join('、')}。回复时可结合这些话题语境。`
    }
    return basePrompt
  }

  // ── 私有辅助 ──

  /** 更新词频统计（简单的窗口内词频） */
  private _updateWordFrequencies(text: string): void {
    if (!text) return
    // 分词：匹配中英文词、数字
    const words = text.toLowerCase().match(/[\w一-鿿]+/g)
    if (!words) return

    // 中文停用词（高频无意义词）
    const stopWords = new Set([
      '的',
      '了',
      '在',
      '是',
      '我',
      '有',
      '和',
      '就',
      '不',
      '人',
      '都',
      '一',
      '一个',
      '上',
      '也',
      '很',
      '到',
      '说',
      '要',
      '去',
      '你',
      '会',
      '着',
      '没有',
      '看',
      '好',
      '自己',
      '这',
      '他',
      '她',
      '它',
      '们',
      '那',
      '些',
      '吧',
      '吗',
      '啊',
      '呢',
      '哦',
      '嗯',
      '哈',
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'can',
      'could',
      'may',
      'might',
      'shall',
      'should',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'and',
      'or',
      'but',
      'not',
      'so',
      'if',
      'than',
      'that',
      'this',
      'these',
      'those',
      'it',
      'its',
      'what',
      'which',
      'who',
      'whom',
      'how',
      'when',
      'where',
      'why',
    ])

    for (const word of words) {
      if (word.length < 2) continue
      if (stopWords.has(word)) continue
      this.wordFrequencyMap.set(word, (this.wordFrequencyMap.get(word) || 0) + 1)
      this.totalWordCount++
    }
  }

  /** 获取词频最高的前 N 个关键词（简单的 TF 排名） */
  private _getTopKeywords(n: number): string[] {
    return Array.from(this.wordFrequencyMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([word]) => word)
  }

  /** 场景判定引擎 — 基于多维度信号判定当前场景 */
  private _classifyScene(signals: {
    avgUserMessageLength: number
    toolUsageRatio: number
    dominantTopics: string[]
    topKeywords: string[]
    totalInteractions: number
    userMessageCount: number
    hasTools: boolean
  }): { scene: SceneLabel; confidence: number } {
    const { avgUserMessageLength, toolUsageRatio, dominantTopics, userMessageCount } = signals

    // 数据太少，无法判断
    if (userMessageCount < SCENE_MIN_INTERACTIONS) {
      return { scene: 'unknown', confidence: 0.3 }
    }

    // 按优先级从高到低检测

    // 1. 系统进化 — 基于显式话题标签
    if (dominantTopics.includes('系统进化')) {
      return { scene: 'system_evolution', confidence: 0.75 }
    }

    // 2. 创意写作
    if (dominantTopics.includes('创意写作')) {
      return { scene: 'creative_writing', confidence: 0.7 }
    }

    // 3. 任务执行 — 任务管理话题 + 高频工具
    if (dominantTopics.includes('任务管理') || dominantTopics.includes('工作流自动化')) {
      return { scene: 'task_execution', confidence: 0.7 }
    }

    // 4. 代码调试 — 高工具使用率 + 调试/开发话题
    const isDebugTopic = dominantTopics.includes('调试修复') || dominantTopics.includes('软件开发')
    if (isDebugTopic && toolUsageRatio >= HIGH_TOOL_USAGE_RATIO) {
      return { scene: 'code_debugging', confidence: 0.75 }
    }

    // 5. 代码调试（无明确话题但高工具使用）
    if (toolUsageRatio >= HIGH_TOOL_USAGE_RATIO && avgUserMessageLength > 20) {
      return { scene: 'code_debugging', confidence: 0.6 }
    }

    // 6. 快速问答 — 短消息 + 低工具使用
    if (avgUserMessageLength <= QUICK_QA_MAX_AVG_LENGTH && toolUsageRatio <= LOW_TOOL_USAGE_RATIO) {
      return { scene: 'quick_qa', confidence: 0.65 }
    }

    // 7. 深入讨论 — 长消息
    if (avgUserMessageLength >= DEEP_DISCUSS_MIN_AVG_LENGTH) {
      return { scene: 'deep_discussion', confidence: 0.6 }
    }

    // 8. 日常闲聊 — 中等长度、低工具使用
    if (toolUsageRatio <= LOW_TOOL_USAGE_RATIO) {
      return { scene: 'casual_chat', confidence: 0.55 }
    }

    // 默认
    return { scene: 'unknown', confidence: 0.4 }
  }

  // ── 状态管理 ──

  /** 清除所有运行时数据（不重置用户反馈） */
  clear(): void {
    this.recentToolCalls = []
    this.recentUserMessages = []
    this.interactionDetails = []
    this.wordFrequencyMap.clear()
    this.totalWordCount = 0
    this.cachedSceneResult = null
    this.currentResponseMode = 'warm_chat'
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
