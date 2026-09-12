import { getRawDb, markDirty } from './connection'
import { log } from '@akemi-mio/core/logger/Logger'

export interface StoredMessage {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  category: string
  sessionId?: string
  telegramChatId?: number | null
  telegramUserId?: number | null
  telegramFrom?: string | null
  telegramMessageId?: number | null
  createdAt: number
}

export interface SessionItem {
  id: string
  source: 'electron' | 'telegram'
  category: string
  label: string
  messageCount: number
  lastActivityAt: number
  createdAt: number
}

export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export function insertMessage(msg: StoredMessage): void {
  try {
    const db = getRawDb()
    db.run(
      `INSERT INTO messages (id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.source,
        msg.role,
        msg.content,
        msg.category,
        msg.sessionId ?? null,
        msg.telegramChatId ?? null,
        msg.telegramUserId ?? null,
        msg.telegramFrom ?? null,
        msg.telegramMessageId ?? null,
        msg.createdAt,
      ],
    )
    markDirty()
  } catch (err) {
    log('ERROR', 'db_insert_message_failed', { error: String(err) })
  }
}

interface StoredMessageRow {
  id: string
  source: string
  role: string
  content: string
  category: string
  session_id: string | null
  telegram_chat_id: number | null
  telegram_user_id: number | null
  telegram_from: string | null
  telegram_message_id: number | null
  created_at: number
}

export function getRecentMessages(limit = 100): StoredMessage[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages ORDER BY created_at ASC LIMIT ?`,
      [limit],
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return rowToMessage(obj as StoredMessageRow)
    })
  } catch (err) {
    log('ERROR', 'db_get_messages_failed', { error: String(err) })
    return []
  }
}

export function getSessions(): SessionItem[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT session_id,
              (SELECT content FROM messages AS sub WHERE sub.session_id = m.session_id AND sub.role = 'user' ORDER BY sub.created_at ASC LIMIT 1) AS label,
              (SELECT source FROM messages AS sub2 WHERE sub2.session_id = m.session_id ORDER BY sub2.created_at ASC LIMIT 1) AS source,
              COALESCE(
                (SELECT category FROM messages AS sub3 WHERE sub3.session_id = m.session_id AND sub3.category != 'chat' ORDER BY sub3.created_at ASC LIMIT 1),
                (SELECT category FROM messages AS sub4 WHERE sub4.session_id = m.session_id ORDER BY sub4.created_at ASC LIMIT 1)
              ) AS category,
              COUNT(*) AS message_count,
              MAX(created_at) AS last_activity_at,
              MIN(created_at) AS created_at
       FROM messages m
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY last_activity_at DESC`,
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return {
        id: obj.session_id as string,
        source: (obj.source as string) === 'telegram' ? 'telegram' : 'electron',
        category: (obj.category as string) || 'chat',
        label: (obj.label as string)?.slice(0, 40) || '新对话',
        messageCount: obj.message_count as number,
        lastActivityAt: obj.last_activity_at as number,
        createdAt: obj.created_at as number,
      }
    })
  } catch (err) {
    log('ERROR', 'db_get_sessions_failed', { error: String(err) })
    return []
  }
}

export function getMessagesBySession(sessionId: string): StoredMessage[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId],
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return rowToMessage(obj as StoredMessageRow)
    })
  } catch (err) {
    log('ERROR', 'db_get_messages_by_session_failed', { error: String(err), sessionId })
    return []
  }
}

/** 获取最后一条消息的 session_id（用于自动分组） */
export function getLastSessionId(): string | null {
  try {
    const db = getRawDb()
    const rows = db.exec(`SELECT session_id FROM messages ORDER BY created_at DESC LIMIT 1`)
    if (!rows.length || !rows[0].values.length) return null
    return (rows[0].values[0] as any[])[0] as string | null
  } catch {
    return null
  }
}

/** 获取最后一条消息的时间戳 */
export function getLastMessageTime(): number | null {
  try {
    const db = getRawDb()
    const rows = db.exec(`SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1`)
    if (!rows.length || !rows[0].values.length) return null
    return (rows[0].values[0] as any[])[0] as number
  } catch {
    return null
  }
}

// =============================================================================
// 对话分析 API（供 Evolution / MemoryAnalysisCollector 使用）
// =============================================================================

/** 意图类别（基于关键词启发式分类，与 MemoryAnalysisCollector 一致） */
export type IntentCategory =
  | 'prompt' // 提示词/模板相关
  | 'tool' // 工具调用相关
  | 'response' // 响应质量相关
  | 'speed' // 速度/超时相关
  | 'accuracy' // 准确度相关
  | 'general' // 通用/其他

/** 单个类别的分析摘要 */
export interface CategoryAnalytics {
  category: IntentCategory
  /** 该类别涉及的会话数 */
  sessionCount: number
  /** 涉及的消息总数（用户+助手） */
  messageCount: number
  /** 检测到的失败信号数（不满/纠正/错误） */
  failureSignals: number
  /** 失败率 = failureSignals / (该类别助手消息数) */
  failureRate: number
  /** 示例问题摘要 */
  topIssues: string[]
}

/** 对话分析报告 */
export interface ConversationAnalytics {
  /** 分析的消息总数 */
  totalMessages: number
  /** 分析的会话数 */
  totalSessions: number
  /** 按意图分类的分布 */
  categoryDistribution: CategoryAnalytics[]
  /** 整体失败率 */
  overallFailureRate: number
  /** 重复出现的问题模式（去重后） */
  repeatedPatterns: Array<{
    pattern: string
    count: number
    category: IntentCategory
    lastSeen: number
  }>
  /** 分析时间戳 */
  analyzedAt: number
}

// 意图关键词（与 MemoryAnalysisCollector.TOPIC_KEYWORDS 保持一致）
const INTENT_KEYWORDS: Record<IntentCategory, string[]> = {
  prompt: ['prompt', '提示词', '提示', '模板', 'template', 'system prompt'],
  tool: ['工具', 'tool', '调用', 'invoke', 'mcp', '函数', 'function'],
  response: ['回答', '回复', '响应', 'response', 'answer', '太长', '太短', '啰嗦'],
  speed: ['慢', '太慢', '卡', '超时', 'timeout', 'slow', '延迟', 'latency'],
  accuracy: ['准确', '精度', '精确', 'accuracy', '幻觉', 'hallucination', '编造'],
  general: [],
}

// 失败信号关键词
const FAILURE_KEYWORDS = [
  '不对',
  '错了',
  '错误',
  '不是',
  '不行',
  '不好',
  '不正确',
  '重新',
  '再来',
  '再试',
  '重试',
  '没用',
  '无效',
  '不工作',
  '坏了',
  '有问题',
  '听不懂',
  '不理解',
  '没懂',
  '不明白',
  '没明白',
  'timeout',
  '超时',
  'error',
  '失败',
  'failed',
  'exception',
  '异常',
  '无法',
  '不能',
  '抱歉',
  'sorry',
  'wrong',
  'incorrect',
  'not working',
  "doesn't work",
  'broken',
]

/** 对最近 N 轮对话进行意图分布和失败率分析 */
export function getConversationAnalytics(limit = 200): ConversationAnalytics {
  const messages = getRecentMessages(limit)
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      totalSessions: 0,
      categoryDistribution: [],
      overallFailureRate: 0,
      repeatedPatterns: [],
      analyzedAt: Date.now(),
    }
  }

  // 按 session 分组
  const sessionMap = new Map<string, StoredMessage[]>()
  for (const m of messages) {
    const sid = m.sessionId || '_no_session'
    if (!sessionMap.has(sid)) sessionMap.set(sid, [])
    sessionMap.get(sid)!.push(m)
  }

  // 初始化分类计数器
  const catStats: Record<
    IntentCategory,
    { sessions: Set<string>; msgCount: number; failures: number; assistantMsgs: number; issues: Map<string, number> }
  > = {
    prompt: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
    tool: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
    response: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
    speed: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
    accuracy: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
    general: { sessions: new Set(), msgCount: 0, failures: 0, assistantMsgs: 0, issues: new Map() },
  }

  // 重复模式检测
  const patternMap = new Map<string, { count: number; category: IntentCategory; lastSeen: number }>()

  // 逐 session 分析
  for (const [sessionId, msgs] of sessionMap) {
    // 为该 session 推断主要意图类别
    const primaryCategory = inferSessionCategory(msgs)
    catStats[primaryCategory].sessions.add(sessionId)

    for (const msg of msgs) {
      catStats[primaryCategory].msgCount++

      // 检测失败信号
      if (msg.role === 'assistant') {
        catStats[primaryCategory].assistantMsgs++
        const content = msg.content.toLowerCase()
        for (const kw of FAILURE_KEYWORDS) {
          if (content.includes(kw.toLowerCase())) {
            catStats[primaryCategory].failures++
            // 记录 issue pattern
            const issueKey = `${kw}:${msg.content.slice(0, 60)}`
            catStats[primaryCategory].issues.set(issueKey, (catStats[primaryCategory].issues.get(issueKey) || 0) + 1)
            break
          }
        }
      }

      // 用户消息也检测失败信号（用户表达不满）
      if (msg.role === 'user') {
        const content = msg.content.toLowerCase()
        for (const kw of FAILURE_KEYWORDS) {
          if (content.includes(kw.toLowerCase())) {
            catStats[primaryCategory].failures++
            break
          }
        }
      }
    }

    // 检测重复问题模式（同一 session 内用户相似消息）
    const userMsgs = msgs.filter((m) => m.role === 'user')
    for (let i = 0; i < userMsgs.length - 1; i++) {
      for (let j = i + 1; j < Math.min(i + 5, userMsgs.length); j++) {
        const sim = jaccardSimilarity(userMsgs[i].content, userMsgs[j].content)
        if (sim >= 0.5) {
          const patternKey = userMsgs[i].content.slice(0, 80)
          const existing = patternMap.get(patternKey)
          if (existing) {
            existing.count++
            if (userMsgs[j].createdAt > existing.lastSeen) existing.lastSeen = userMsgs[j].createdAt
          } else {
            patternMap.set(patternKey, {
              count: 1,
              category: primaryCategory,
              lastSeen: userMsgs[j].createdAt,
            })
          }
          break
        }
      }
    }
  }

  // 构建分类分布
  const categoryDistribution: CategoryAnalytics[] = (
    Object.entries(catStats) as [IntentCategory, (typeof catStats)[keyof typeof catStats]][]
  )
    .map(([category, stats]) => ({
      category,
      sessionCount: stats.sessions.size,
      messageCount: stats.msgCount,
      failureSignals: stats.failures,
      failureRate: stats.assistantMsgs > 0 ? stats.failures / stats.assistantMsgs : 0,
      topIssues: Array.from(stats.issues.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key, count]) => `[${count}次] ${key.slice(0, 80)}`),
    }))
    .filter((c) => c.messageCount > 0)

  // 整体失败率
  const totalFailures = categoryDistribution.reduce((s, c) => s + c.failureSignals, 0)
  const totalAssistantMsgs = (Object.values(catStats) as (typeof catStats)[keyof typeof catStats][]).reduce(
    (s, c) => s + c.assistantMsgs,
    0,
  )
  const overallFailureRate = totalAssistantMsgs > 0 ? totalFailures / totalAssistantMsgs : 0

  // 重复模式（取 top 10）
  const repeatedPatterns = Array.from(patternMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([pattern, info]) => ({
      pattern: pattern.length > 100 ? pattern.slice(0, 100) + '…' : pattern,
      count: info.count,
      category: info.category,
      lastSeen: info.lastSeen,
    }))

  return {
    totalMessages: messages.length,
    totalSessions: sessionMap.size,
    categoryDistribution,
    overallFailureRate,
    repeatedPatterns,
    analyzedAt: Date.now(),
  }
}

// =============================================================================
// 辅助函数
// =============================================================================

/** 根据 session 消息内容推断主要意图类别 */
function inferSessionCategory(msgs: StoredMessage[]): IntentCategory {
  const allText = msgs.map((m) => m.content.toLowerCase()).join(' ')
  const scores: Record<IntentCategory, number> = {
    prompt: 0,
    tool: 0,
    response: 0,
    speed: 0,
    accuracy: 0,
    general: 0,
  }
  for (const [cat, keywords] of Object.entries(INTENT_KEYWORDS) as [IntentCategory, string[]][]) {
    for (const kw of keywords) {
      if (allText.includes(kw)) scores[cat]++
    }
  }
  const best = (Object.entries(scores) as [IntentCategory, number][]).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : 'general'
}

/** Jaccard 相似度（基于词袋） */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[\s,，。！？、；：""''（）()[\]【】]+/)
        .filter((w) => w.length >= 2),
    )
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = new Set([...setA].filter((x) => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return intersection.size / union.size
}

export { createSessionId }

function rowToMessage(row: StoredMessageRow): StoredMessage {
  return {
    id: row.id,
    source: row.source as 'electron' | 'telegram',
    role: row.role as 'user' | 'assistant',
    content: row.content,
    category: row.category || 'chat',
    sessionId: row.session_id ?? undefined,
    telegramChatId: row.telegram_chat_id,
    telegramUserId: row.telegram_user_id,
    telegramFrom: row.telegram_from,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
  }
}
