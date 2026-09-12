/**
 * PatternExtractor — 智能任务模式提取器
 *
 * 职责：
 * 1. 从 UserBehaviorAnalyzer 收集的工具调用序列中聚类重复模式
 * 2. 通过 DB 消息历史分析对话模式
 * 3. 生成命名的任务模板
 * 4. 对当前用户输入进行模板匹配
 *
 * 算法：
 * - 工具序列匹配：将工具调用序列编码为逗号分隔的签名，用精确/前缀匹配聚类
 * - 话题意图提取：复用 UserBehaviorAnalyzer 的 TOPIC_PATTERNS
 * - 模板生成：对高频序列生成带触发关键词和工具步骤的模板
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRecentMessages, getMessagesBySession, getSessions, type StoredMessage, type SessionItem } from '@akemi-mio/core/db/messages'
import {
  type ToolCallSequence,
  type SequenceCluster,
  type TaskTemplate,
  type TemplateStep,
  type TemplateMatch,
  type PatternExtractOptions,
} from './types'

// =============================================================================
// 配置常量
// =============================================================================

/** 最小序列长度：少于该工具数的序列忽略 */
const DEFAULT_MIN_SEQUENCE_LENGTH = 2

/** 最小聚类出现次数：少于该次数不生成模板 */
const DEFAULT_MIN_OCCURRENCES = 2

/** 分析窗口：最多检查多少条近期消息 */
const DEFAULT_ANALYSIS_WINDOW = 200

/** 消息时间窗口（7 天，毫秒） */
const DEFAULT_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 最近会话数量上限 */
const MAX_SESSIONS_TO_ANALYZE = 30

/** 序列截断长度（工具数），防止噪声 */
const MAX_SEQUENCE_TOOLS = 15

/** 模板名最大长度 */
const MAX_TEMPLATE_NAME_LENGTH = 50

/** 模板标签关键词来源：UserBehaviorAnalyzer 的 TOPIC_PATTERNS 标签 */
const TOPIC_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /天气/g, label: '天气查询' },
  { pattern: /代码|编程|写.*程序|开发|实现.*功能/g, label: '软件开发' },
  { pattern: /调试|debug|bug|报错|错误|异常|修复/g, label: '调试修复' },
  { pattern: /部署|deploy|上线|发布/g, label: '部署发布' },
  { pattern: /测试|test|单元测试|集成测试|验证/g, label: '测试验证' },
  { pattern: /重构|refactor|优化|改进|改善/g, label: '代码重构' },
  { pattern: /文档|doc|readme|说明|注释/g, label: '文档编写' },
  { pattern: /搜索|查找|找.*文件|grep/g, label: '代码搜索' },
  { pattern: /配置|config|设置|环境变量/g, label: '配置管理' },
  { pattern: /数据库|database|sql|mongo|redis/g, label: '数据存储' },
  { pattern: /API|接口|REST|GraphQL|端点/g, label: 'API 开发' },
  { pattern: /语音|TTS|ASR|说话|朗读|识别/g, label: '语音交互' },
  { pattern: /图片|图像|生成.*图/g, label: '图像生成' },
  { pattern: /记忆|remember|记住|回忆|知识/g, label: '知识记忆' },
  { pattern: /计划|plan|任务|task|安排|日程/g, label: '任务管理' },
  { pattern: /工作流|workflow|流程|自动化|编排/g, label: '工作流自动化' },
  { pattern: /GitHub|git|commit|push|pull|分支|仓库/g, label: '版本控制' },
  { pattern: /SSH|远程|centos|服务器|server/g, label: '远程管理' },
  { pattern: /写作|writing|写.*小说|创作|故事|章节/g, label: '创意写作' },
  { pattern: /进化|evolution|自.*进化|自我.*改进/g, label: '系统进化' },
  { pattern: /翻译|translate/g, label: '翻译' },
  { pattern: /截图|截图|screenshot|屏幕/g, label: '屏幕截图' },
  { pattern: /合并|merge|cherry.?pick|rebase/g, label: 'Git 操作' },
]

// =============================================================================
// 工具名→简短标签映射（用于序列命名）
// =============================================================================

const TOOL_SHORT_LABEL: Record<string, string> = {
  read_file: '读文件',
  write_file: '写文件',
  edit_file: '改文件',
  grep: '搜索',
  list_files: '浏览',
  run_command: '命令',
  create_dev_plan: '建计划',
  update_plan_progress: '更新计划',
  analyze_codebase: '分析代码',
  analyze_task: '分析任务',
  remember_fact: '记事实',
  generate_image: '生成图',
  writing_system: '写作',
  auto_schedule_workflow: '工作流',
  social_pipeline: '社交',
  query_trends: '趋势',
  centosExec: '远程执行',
  centosReadFile: '远程读',
  centosWriteFile: '远程写',
  centosGrep: '远程搜索',
  remember_procedure: '记过程',
  list_procedures: '列过程',
  store_memory: '存记忆',
  retrieve_memory: '取记忆',
  search_memories: '搜记忆',
  speak_with_piper: '语音',
  create_workflow: '创建工作流',
  start_workflow: '运行工作流',
  list_workflows: '列工作流',
}

// =============================================================================
// 工具→话题映射（与 UserBehaviorAnalyzer 保持一致）
// =============================================================================

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
  social_pipeline: '社交媒体',
  query_trends: '趋势查询',
}

// =============================================================================
// PatternExtractor
// =============================================================================

export class PatternExtractor {
  /** 最近工具调用序列（由外部 feed） */
  private recentSequences: ToolCallSequence[] = []

  /** 最大保留的序列数 */
  private maxSequences = 50

  constructor(maxSequences?: number) {
    if (maxSequences) this.maxSequences = maxSequences
  }

  // ── 数据采集 ──

  /**
   * 记录一次工具调用序列（由 ChatExecutor 在每次 tool batch 后调用）。
   * @param sessionId 当前会话 ID
   * @param toolNames 本次 batch 中的工具名列表（有序）
   * @param intentLabel 意图标签（提取自用户消息）
   * @param userInputSummary 用户输入摘要
   */
  recordSequence(sessionId: string, toolNames: string[], intentLabel: string, userInputSummary: string): void {
    if (toolNames.length === 0) return
    this.recentSequences.push({
      sessionId,
      toolNames: toolNames.slice(0, MAX_SEQUENCE_TOOLS),
      intentLabel,
      userInputSummary,
      timestamp: Date.now(),
    })
    if (this.recentSequences.length > this.maxSequences) {
      this.recentSequences = this.recentSequences.slice(-this.maxSequences)
    }
  }

  /**
   * 从 DB 消息历史加载序列数据。
   * 分析最近的会话，提取用户消息 + 辅助消息中的工具调用。
   */
  loadFromHistory(options?: PatternExtractOptions): ToolCallSequence[] {
    const timeWindow = options?.timeWindowMs ?? DEFAULT_TIME_WINDOW_MS
    const analysisWindow = options?.analysisWindow ?? DEFAULT_ANALYSIS_WINDOW
    const now = Date.now()
    const cutoff = now - timeWindow

    // 1. 获取最近的会话
    const sessions = getSessions().slice(0, MAX_SESSIONS_TO_ANALYZE)
    if (sessions.length === 0) return []

    const sequences: ToolCallSequence[] = []

    for (const session of sessions) {
      if (session.lastActivityAt < cutoff) continue

      const msgs = getMessagesBySession(session.id)
      if (msgs.length < 2) continue

      // 提取该会话中的工具调用序列
      const tools: string[] = []
      let lastUserContent = ''
      const intentLabels = new Set<string>()

      for (const msg of msgs) {
        if (msg.role === 'user') {
          lastUserContent = msg.content
          // 提取用户输入中的意图标签
          const labels = this._extractTopics(msg.content)
          for (const l of labels) intentLabels.add(l)
        } else if (msg.role === 'assistant') {
          // 从 assistant 消息内容中检测工具调用（序号格式）
          this._extractToolCalls(msg.content, tools)
        }
      }

      if (tools.length >= (options?.minSequenceLength ?? DEFAULT_MIN_SEQUENCE_LENGTH)) {
        const intentLabel = intentLabels.size > 0 ? Array.from(intentLabels).join(',') : 'general'
        sequences.push({
          sessionId: session.id,
          toolNames: tools.slice(0, MAX_SEQUENCE_TOOLS),
          intentLabel,
          userInputSummary: lastUserContent.slice(0, 100),
          timestamp: session.lastActivityAt,
        })
      }
    }

    // 合并到内部缓存
    this.recentSequences = [...this.recentSequences, ...sequences].slice(-this.maxSequences)

    return sequences
  }

  // ── 聚类分析 ──

  /**
   * 对工具调用序列进行聚类。
   * 使用序列签名匹配：将工具名列表序列化为字符串，找共同前缀。
   */
  clusterSequences(options?: PatternExtractOptions): SequenceCluster[] {
    const minSeqLen = options?.minSequenceLength ?? DEFAULT_MIN_SEQUENCE_LENGTH
    const minOccurrences = options?.minOccurrences ?? DEFAULT_MIN_OCCURRENCES
    const allSequences = this.recentSequences

    if (allSequences.length < minOccurrences) return []

    // 按签名分组
    const groups = new Map<string, ToolCallSequence[]>()

    for (const seq of allSequences) {
      if (seq.toolNames.length < minSeqLen) continue

      // 生成签名：工具名序列 + 主要意图标签
      const toolSig = seq.toolNames.join(',')
      const primaryIntent = seq.intentLabel.split(',')[0] || 'general'
      const groupKey = `${toolSig}::${primaryIntent}`

      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey)!.push(seq)
    }

    // 过滤低频聚类，构建聚类结果
    const clusters: SequenceCluster[] = []

    for (const [key, sequences] of groups) {
      if (sequences.length < minOccurrences) continue

      const [toolSig, intentLabel] = key.split('::')
      const toolNames = toolSig.split(',')

      // 找共同工具模式（取交集，即完整匹配）
      const commonToolPattern = this._findCommonPattern(sequences.map((s) => s.toolNames))

      clusters.push({
        id: `cluster_${Date.now()}_${clusters.length}`,
        sequences,
        commonToolPattern,
        commonIntentLabel: intentLabel || 'general',
        occurrenceCount: sequences.length,
      })
    }

    // 按出现次数降序排列
    clusters.sort((a, b) => b.occurrenceCount - a.occurrenceCount)

    return clusters
  }

  /**
   * 根据聚类结果生成任务模板。
   * 每个高频聚类生成一个命名模板。
   */
  generateTemplatesFromClusters(clusters: SequenceCluster[]): Omit<TaskTemplate, 'id'>[] {
    const templates: Omit<TaskTemplate, 'id'>[] = []

    for (const cluster of clusters) {
      if (cluster.occurrenceCount < DEFAULT_MIN_OCCURRENCES) continue
      if (cluster.commonToolPattern.length < DEFAULT_MIN_SEQUENCE_LENGTH) continue

      const name = this._generateTemplateName(cluster)
      const description = this._generateDescription(cluster)
      const keywords = this._extractClusterKeywords(cluster)
      const toolSequence = cluster.commonToolPattern.map((tn) => ({
        toolName: tn,
        description: TOOL_SHORT_LABEL[tn] || tn,
      }))

      templates.push({
        name,
        description,
        triggerKeywords: keywords,
        toolSequence,
        source: 'auto',
        status: 'active',
        useCount: 0,
        successCount: 0,
        lastUsedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }

    return templates
  }

  // ── 模板匹配 ──

  /**
   * 对用户输入进行模板匹配。
   * 返回按匹配分数降序排列的模板列表。
   */
  matchTemplates(userInput: string, templates: TaskTemplate[]): TemplateMatch[] {
    if (!userInput || templates.length === 0) return []

    const inputLower = userInput.toLowerCase()
    const results: TemplateMatch[] = []

    for (const tmpl of templates) {
      if (tmpl.status !== 'active') continue

      const matchedKeywords: string[] = []
      let keywordScore = 0

      for (const kw of tmpl.triggerKeywords) {
        if (inputLower.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw)
          keywordScore += 1 / tmpl.triggerKeywords.length
        }
      }

      // 如果有匹配关键词，计算总分
      if (matchedKeywords.length > 0) {
        // 基础分数：关键词匹配比例
        let score = keywordScore

        // 加分：最近使用过的模板优先（热度衰减）
        if (tmpl.lastUsedAt) {
          const daysSinceLastUse = (Date.now() - tmpl.lastUsedAt) / (24 * 60 * 60 * 1000)
          if (daysSinceLastUse < 1)
            score += 0.1 // 今天用过
          else if (daysSinceLastUse < 3) score += 0.05 // 3天内用过
        }

        // 加分：高成功率
        if (tmpl.useCount > 0) {
          const successRate = tmpl.successCount / tmpl.useCount
          if (successRate > 0.8) score += 0.1
          else if (successRate > 0.5) score += 0.05
        }

        results.push({
          template: tmpl,
          score: Math.min(score, 1.0),
          reason: `匹配关键词: ${matchedKeywords.join(', ')}`,
          matchedKeywords,
        })
      }
    }

    // 按分数降序排列
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, 5) // 最多返回 5 个
  }

  // ── 模板名生成（从聚类推断） ──

  /**
   * 为用户输入生成模板匹配提示片段（用于注入 system prompt）。
   * 返回的提示片段告诉 LLM 有可复用的模板。
   */
  buildTemplateSuggestionPrompt(matches: TemplateMatch[]): string {
    if (matches.length === 0) return ''

    const top = matches[0]
    const lines: string[] = [
      `【任务模板匹配】检测到当前请求与已有模板「${top.template.name}」匹配（匹配度: ${(top.score * 100).toFixed(0)}%）。`,
      `该模板包含以下工具步骤:`,
    ]

    for (const step of top.template.toolSequence) {
      lines.push(`  - ${step.toolName}${step.description ? ': ' + step.description : ''}`)
    }

    lines.push(`如适用，可直接执行模板。若需修改后执行，请调整后执行。`, `可使用 list_task_templates 查看所有模板。`)

    return lines.join('\n')
  }

  // ── 私有辅助方法 ──

  /**
   * 从文本中提取话题标签。
   */
  private _extractTopics(text: string): string[] {
    const topics: string[] = []
    for (const { pattern, label } of TOPIC_PATTERNS) {
      pattern.lastIndex = 0
      const matches = text.match(pattern)
      if (matches && matches.length > 0) topics.push(label)
    }
    return [...new Set(topics)]
  }

  /**
   * 从 assistant 消息中提取工具调用名称。
   * 消息格式可能是 Markdown 列表格式：
   *   - 工具名 (read_file) → 参数...
   * 或 JSON 格式：{"function": {"name": "read_file", ...}}
   */
  private _extractToolCalls(content: string, tools: string[]): void {
    if (!content) return

    // 尝试匹配 JSON 格式的工具调用
    const jsonMatches = content.match(/"name"\s*:\s*"([^"]+)"/g)
    if (jsonMatches) {
      for (const m of jsonMatches) {
        const match = m.match(/"name"\s*:\s*"([^"]+)"/)
        if (match && match[1]) {
          const toolName = match[1]
          if (!tools.includes(toolName)) tools.push(toolName)
        }
      }
      return
    }

    // 尝试匹配 Markdown 列表格式: `- tool_name`
    const listMatches = content.match(/-\s*`?(\w+)`?(?:\s*[:：])?/g)
    if (listMatches) {
      for (const m of listMatches) {
        const match = m.match(/-?\s*`?(\w+)`?/)
        if (match && match[1]) {
          const toolName = match[1]
          if (!tools.includes(toolName)) tools.push(toolName)
        }
      }
    }
  }

  /**
   * 找多个序列的共同模式（前缀匹配）。
   * 取所有序列的共同前 N 个工具。
   */
  private _findCommonPattern(sequences: string[][]): string[] {
    if (sequences.length === 0) return []
    if (sequences.length === 1) return sequences[0]

    const minLen = Math.min(...sequences.map((s) => s.length))
    const common: string[] = []

    for (let i = 0; i < minLen; i++) {
      const tool = sequences[0][i]
      if (sequences.every((s) => s[i] === tool)) {
        common.push(tool)
      } else {
        break // 第一个不一致就停止
      }
    }

    return common
  }

  /**
   * 从聚类生成模板名。
   * 格式: "意图标签 + 工具摘要"
   */
  private _generateTemplateName(cluster: SequenceCluster): string {
    const intentLabel = cluster.commonIntentLabel || '通用'
    const toolSummary = cluster.commonToolPattern
      .map((t) => TOOL_SHORT_LABEL[t] || t)
      .slice(0, 3)
      .join('+')

    let name = `${intentLabel}·${toolSummary}`
    if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
      name = name.slice(0, MAX_TEMPLATE_NAME_LENGTH - 3) + '...'
    }
    return name
  }

  /**
   * 从聚类生成模板描述。
   */
  private _generateDescription(cluster: SequenceCluster): string {
    const toolNames = cluster.commonToolPattern.map((t) => `\`${t}\``).join(' → ')
    const intentLabel = cluster.commonIntentLabel
    const count = cluster.occurrenceCount
    return `自动发现的任务模式：${intentLabel}。工具序列: ${toolNames}。该模式已出现 ${count} 次。`
  }

  /**
   * 从聚类中提取关键词（作为模板的 triggerKeywords）。
   */
  private _extractClusterKeywords(cluster: SequenceCluster): string[] {
    const keywords = new Set<string>()

    // 从意图标签提取关键词
    const labels = cluster.commonIntentLabel.split(',')
    for (const label of labels) {
      const trimmed = label.trim()
      if (trimmed && trimmed !== 'general') keywords.add(trimmed)
    }

    // 从用户输入摘要提取高频词
    for (const seq of cluster.sequences) {
      const summary = seq.userInputSummary
      // 简单中文分词：匹配中英文词
      const words = summary.match(/[\w一-鿿]{2,}/g)
      if (words) {
        for (const word of words.slice(0, 5)) {
          if (word.length >= 2 && !this._isStopWord(word)) {
            keywords.add(word)
          }
        }
      }
    }

    // 从工具名推断关键词
    for (const tool of cluster.commonToolPattern) {
      const topic = TOOL_TOPIC_MAP[tool]
      if (topic) keywords.add(topic)
    }

    return Array.from(keywords).slice(0, 10)
  }

  /** 停用词过滤 */
  private _isStopWord(word: string): boolean {
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
      '那',
      '些',
      '吧',
      '吗',
      '啊',
      '呢',
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
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
      'how',
      'when',
      'where',
      'why',
      'do',
      'does',
      'did',
      'will',
      'would',
      'can',
      'could',
      'may',
      'might',
    ])
    return stopWords.has(word.toLowerCase())
  }

  /** 清除所有运行时数据 */
  clear(): void {
    this.recentSequences = []
  }
}

// =============================================================================
// 单例
// =============================================================================

export const patternExtractor = new PatternExtractor()
