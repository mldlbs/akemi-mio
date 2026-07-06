/**
 * MemoryAnalysisCollector — 记忆驱动的定向进化采集器
 *
 * 从消息数据库拉取最近对话记录，使用轻量级规则引擎分析用户不满意的交互模式，
 * 生成可被 PipelineOrchestrator 消费的 Problem 项。
 *
 * 分析维度：
 * 1. 不满信号检测 — 用户纠正/否定关键词
 * 2. 短响应追踪 — 助手回复过短 + 用户立即追问（答案不够好）
 * 3. 重复提问 — 用户反复问相似问题（之前的回答未解决）
 * 4. 错误模式 — 工具调用失败、超时等
 *
 * 生成的 Problem 由现有的 ClaudeCodeExecutor / DeepSeekExecutor 执行修复。
 */

import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from './types'
import { getRecentMessages } from '../../db/messages'
import type { StoredMessage } from '../../db/messages'

// =============================================================================
// 分析配置
// =============================================================================

/** 每次采集拉取的消息数量上限 */
const MAX_MESSAGES = 200
/** 每次采集最多生成的问题数 */
const MAX_PROBLEMS_PER_CYCLE = 3
/** 两次采集最小间隔（30分钟） */
const MIN_INTERVAL_MS = 30 * 60 * 1000
/** 短响应阈值（字符数） */
const SHORT_RESPONSE_CHARS = 50
/** 用户追问时间窗口（ms，助手回复后多久内用户再发言视为追问） */
const FOLLOW_UP_WINDOW_MS = 60 * 1000

// =============================================================================
// 不满信号关键词（中文 + 英文）
// =============================================================================

const DISSATISFACTION_KEYWORDS = [
  // 中文否定/纠正
  '不对', '错了', '错误', '不是', '不行', '不好', '不正确',
  '重新', '再来', '再试', '重试', '换个', '换一个',
  '听不懂', '不理解', '没懂', '不明白', '没明白',
  '没用', '无效', '不工作', '坏了', '有问题',
  '修正', '更正', '改一下', '改改',
  // 英文否定/纠正
  'wrong', 'incorrect', 'not working', 'doesn\'t work',
  'try again', 'redo', 'retry', 'not right',
  'don\'t understand', 'doesn\'t make sense',
  'fix', 'correct', 'broken', 'error',
]

/** 主题关键词分组（用于聚类） */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  prompt: ['prompt', '提示词', '提示', '模板', 'template', 'system prompt'],
  tool: ['工具', 'tool', '调用', 'invoke', 'mcp', '函数', 'function'],
  response: ['回答', '回复', '响应', 'response', 'answer', '太长', '太短', '啰嗦'],
  speed: ['慢', '太慢', '卡', '超时', 'timeout', 'slow', '延迟', 'latency'],
  accuracy: ['准确', '精度', '精确', 'accuracy', '幻觉', 'hallucination', '编造'],
}

// =============================================================================
// 类型定义
// =============================================================================

interface DissatisfactionSignal {
  messageId: string
  timestamp: number
  type: 'correction' | 'short_response' | 'repeat_question' | 'error_pattern'
  sessionId?: string
  detail: string
  /** 关联的助手消息 ID */
  relatedAssistantMsgId?: string
}

interface SessionGroup {
  sessionId: string
  messages: StoredMessage[]
  signals: DissatisfactionSignal[]
}

// =============================================================================
// MemoryAnalysisCollector
// =============================================================================

export class MemoryAnalysisCollector implements SignalCollector {
  readonly name = 'memory-analysis'
  readonly source = 'log' as const

  private lastRun = 0
  private minIntervalMs = MIN_INTERVAL_MS
  /** 已生成过的 signal 指纹集合（防重复） */
  private emittedFingerprints = new Set<string>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    try {
      // Step 1: 拉取最近消息
      const messages = getRecentMessages(MAX_MESSAGES)
      if (messages.length < 10) {
        log('INFO', 'memory_analysis_insufficient_data', { count: messages.length })
        return []
      }

      // Step 2: 按 session 分组
      const sessions = this.groupBySession(messages)

      // Step 3: 分析每个 session
      const allSignals: DissatisfactionSignal[] = []
      for (const session of sessions) {
        this.detectCorrections(session, allSignals)
        this.detectShortResponses(session, allSignals)
        this.detectRepeatQuestions(session, allSignals)
        this.detectErrorPatterns(session, allSignals)
      }

      // Step 4: 去重 + 转 Problem
      const newSignals = allSignals.filter((s) => {
        const fp = this.signalFingerprint(s)
        if (this.emittedFingerprints.has(fp)) return false
        this.emittedFingerprints.add(fp)
        return true
      })

      // 清理旧指纹（保留最近 200 个）
      if (this.emittedFingerprints.size > 200) {
        const entries = Array.from(this.emittedFingerprints)
        this.emittedFingerprints = new Set(entries.slice(-100))
      }

      const problems = this.signalsToProblems(newSignals, messages)

      log('INFO', 'memory_analysis_collect_done', {
        totalMessages: messages.length,
        sessions: sessions.length,
        signals: allSignals.length,
        newSignals: newSignals.length,
        problems: problems.length,
      })

      return problems.slice(0, MAX_PROBLEMS_PER_CYCLE)
    } catch (err: any) {
      log('ERROR', 'memory_analysis_collect_error', { error: err.message })
      return []
    }
  }

  // =============================================================================
  // Session 分组
  // =============================================================================

  private groupBySession(messages: StoredMessage[]): SessionGroup[] {
    const map = new Map<string, StoredMessage[]>()
    for (const m of messages) {
      const sid = m.sessionId || '_no_session'
      if (!map.has(sid)) map.set(sid, [])
      map.get(sid)!.push(m)
    }
    return Array.from(map.entries()).map(([sessionId, msgs]) => ({
      sessionId,
      messages: msgs,
      signals: [],
    }))
  }

  // =============================================================================
  // 检测 1: 用户纠正/否定
  // =============================================================================

  private detectCorrections(session: SessionGroup, out: DissatisfactionSignal[]): void {
    for (const msg of session.messages) {
      if (msg.role !== 'user') continue
      const content = msg.content.toLowerCase()
      for (const kw of DISSATISFACTION_KEYWORDS) {
        if (content.includes(kw.toLowerCase())) {
          out.push({
            messageId: msg.id,
            timestamp: msg.createdAt,
            type: 'correction',
            sessionId: session.sessionId,
            detail: `用户消息包含不满关键词 "${kw}"：${this.truncate(msg.content, 100)}`,
          })
          break // 一条消息只算一个 correction 信号
        }
      }
    }
  }

  // =============================================================================
  // 检测 2: 短响应 + 用户追问
  // =============================================================================

  private detectShortResponses(session: SessionGroup, out: DissatisfactionSignal[]): void {
    const msgs = session.messages
    for (let i = 0; i < msgs.length - 1; i++) {
      const curr = msgs[i]
      const next = msgs[i + 1]

      // 助手回复过短
      if (curr.role !== 'assistant') continue
      if (curr.content.length >= SHORT_RESPONSE_CHARS) continue

      // 下一条是用户消息且在时间窗口内
      if (next.role !== 'user') continue
      const gap = next.createdAt - curr.createdAt
      if (gap > FOLLOW_UP_WINDOW_MS) continue

      out.push({
        messageId: curr.id,
        timestamp: curr.createdAt,
        type: 'short_response',
        sessionId: session.sessionId,
        relatedAssistantMsgId: curr.id,
        detail: `助手回复仅${curr.content.length}字"${this.truncate(curr.content, 40)}"，用户${gap}ms后追问"${this.truncate(next.content, 60)}"`,
      })
    }
  }

  // =============================================================================
  // 检测 3: 重复提问
  // =============================================================================

  private detectRepeatQuestions(session: SessionGroup, out: DissatisfactionSignal[]): void {
    const userMsgs = session.messages.filter((m) => m.role === 'user')
    if (userMsgs.length < 2) return

    // 滑动窗口检测：相邻用户消息相似度
    for (let i = 0; i < userMsgs.length - 1; i++) {
      for (let j = i + 1; j < Math.min(i + 5, userMsgs.length); j++) {
        const similarity = this.textSimilarity(userMsgs[i].content, userMsgs[j].content)
        if (similarity >= 0.6) {
          out.push({
            messageId: userMsgs[j].id,
            timestamp: userMsgs[j].createdAt,
            type: 'repeat_question',
            sessionId: session.sessionId,
            detail: `用户重复提问（相似度${(similarity * 100).toFixed(0)}%）："${this.truncate(userMsgs[i].content, 60)}" → "${this.truncate(userMsgs[j].content, 60)}"`,
          })
          break // 每对只报告一次
        }
      }
    }
  }

  // =============================================================================
  // 检测 4: 错误模式（工具调用失败 / 超时）
  // =============================================================================

  private detectErrorPatterns(session: SessionGroup, out: DissatisfactionSignal[]): void {
    for (const msg of session.messages) {
      if (msg.role !== 'assistant') continue
      const content = msg.content.toLowerCase()

      // 错误/超时关键词
      const errorPatterns = [
        { kw: 'timeout', label: '超时' },
        { kw: '超时', label: '超时' },
        { kw: 'error', label: '错误' },
        { kw: '失败', label: '失败' },
        { kw: 'failed', label: '失败' },
        { kw: 'exception', label: '异常' },
        { kw: '异常', label: '异常' },
        { kw: '无法', label: '无法执行' },
        { kw: '不能', label: '无法执行' },
        { kw: '抱歉', label: '道歉式回复' },
        { kw: 'sorry', label: '道歉式回复' },
      ]

      for (const { kw, label } of errorPatterns) {
        if (content.includes(kw)) {
          out.push({
            messageId: msg.id,
            timestamp: msg.createdAt,
            type: 'error_pattern',
            sessionId: session.sessionId,
            detail: `助手回复包含${label}信号"${kw}"：${this.truncate(msg.content, 100)}`,
          })
          break
        }
      }
    }
  }

  // =============================================================================
  // Signal → Problem 转换
  // =============================================================================

  private signalsToProblems(signals: DissatisfactionSignal[], allMessages: StoredMessage[]): Problem[] {
    // 按类型聚合
    const byType = new Map<string, DissatisfactionSignal[]>()
    for (const s of signals) {
      if (!byType.has(s.type)) byType.set(s.type, [])
      byType.get(s.type)!.push(s)
    }

    const problems: Problem[] = []

    for (const [type, group] of byType) {
      const topic = this.inferTopic(group, allMessages)
      const problem = this.buildProblem(type, group, topic)
      if (problem) problems.push(problem)
    }

    return problems
  }

  private inferTopic(signals: DissatisfactionSignal[], messages: StoredMessage[]): string {
    // 收集相关上下文
    const contextWords = new Set<string>()
    for (const s of signals) {
      const related = messages.find((m) => m.id === s.relatedAssistantMsgId || m.id === s.messageId)
      if (related) {
        for (const w of related.content.toLowerCase().split(/\s+/)) {
          contextWords.add(w)
        }
      }
    }

    // 匹配主题关键词
    const scores: Record<string, number> = {}
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      scores[topic] = 0
      for (const kw of keywords) {
        if (contextWords.has(kw)) scores[topic]++
      }
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
    return best && best[1] > 0 ? best[0] : 'general'
  }

  private buildProblem(type: string, signals: DissatisfactionSignal[], topic: string): Problem | null {
    const count = signals.length
    if (count === 0) return null

    const latest = signals.reduce((a, b) => (a.timestamp > b.timestamp ? a : b))
    const examples = signals
      .slice(0, 3)
      .map((s) => `  - [${new Date(s.timestamp).toLocaleTimeString('zh-CN')}] ${s.detail}`)
      .join('\n')

    const typeLabel: Record<string, string> = {
      correction: '用户频繁纠正/否定助手回答',
      short_response: '助手短回复导致用户追问',
      repeat_question: '用户重复提问（前次回答未解决问题）',
      error_pattern: '助手回复包含错误/异常/道歉',
    }

    const title = `[记忆分析] ${typeLabel[type] || type}（${count}次）`
    const description = [
      `## 问题类型`,
      typeLabel[type] || type,
      '',
      `## 检测到 ${count} 次信号`,
      '',
      `## 最近示例`,
      examples,
      '',
      `## 推断主题领域`,
      topic,
      '',
      `## 建议修复方向`,
      this.suggestFix(type, topic),
    ].join('\n')

    return {
      id: `memory:${type}:${latest.timestamp}`,
      source: 'log',
      severity: count >= 3 ? 'error' : 'warning',
      title,
      description,
      estimatedCostChars: description.length,
      lastSeen: latest.timestamp,
      occurrenceCount: count,
      context: {
        raw: description,
        snippet: examples,
        metadata: {
          signalType: type,
          signalCount: String(count),
          topic,
          latestTimestamp: String(latest.timestamp),
        },
      },
    }
  }

  private suggestFix(type: string, topic: string): string {
    const suggestions: Record<string, string> = {
      correction: `- 检查 ${topic === 'prompt' ? 'system prompt / 提示词模板' : topic === 'tool' ? '工具调用顺序和参数' : '响应生成逻辑'}是否需要调整
- 考虑添加更明确的指令或约束
- 如果是特定领域频繁出错，考虑添加领域知识或 few-shot 示例`,
      short_response: `- 检查 prompt 中是否要求了过短的回复格式
- 增加最小回复长度约束
- 对于工具调用结果，要求助手进行适当解释而非仅输出原始数据`,
      repeat_question: `- 用户重复提问说明前次回答不够充分
- 检查回答是否遗漏了用户问题的关键部分
- 考虑增加追问检测和上下文延续机制
- ${topic === 'tool' ? '检查工具返回的数据是否完整、准确' : '检查回答是否覆盖了用户的所有子问题'}`,
      error_pattern: `- 分析导致错误/超时的根本原因
- 如果是工具超时，考虑增加超时时间或拆分大请求
- 如果是模型异常，检查 prompt 长度是否超出限制
- 减少"抱歉"类无意义回复，替换为具体的错误信息和下一步建议`,
    }

    return suggestions[type] || '- 根据信号模式分析并优化相关代码'
  }

  // =============================================================================
  // 工具方法
  // =============================================================================

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '…'
  }

  /** 简单的 Jaccard 相似度（基于词袋） */
  private textSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => {
      // 简单分词：按空白/标点分割，去停用词
      return new Set(
        s
          .toLowerCase()
          .split(/[\s,，。！？、；：""''（）\(\)\[\]【】]+/)
          .filter((w) => w.length >= 2),
      )
    }
    const setA = tokenize(a)
    const setB = tokenize(b)
    if (setA.size === 0 || setB.size === 0) return 0
    const intersection = new Set([...setA].filter((x) => setB.has(x)))
    const union = new Set([...setA, ...setB])
    return intersection.size / union.size
  }

  /** 生成 signal 去重指纹 */
  private signalFingerprint(s: DissatisfactionSignal): string {
    return `${s.type}:${s.sessionId}:${s.detail.slice(0, 60)}`
  }
}
