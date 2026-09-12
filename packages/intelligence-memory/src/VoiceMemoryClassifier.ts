/**
 * VoiceMemoryClassifier — 语音触发记忆意图分类器
 *
 * 在 ASR 转录后运行，通过规则模式快速检测记忆操作意图。
 * 无需 LLM 参与，零延迟，保护隐私。
 *
 * 支持两种意图：
 * - write: 用户希望记住某些信息（"记住咖啡是拿铁"）
 * - read:  用户希望检索之前记住的信息（"上次的咖啡是什么"）
 *
 * 设计原则：
 * 1. 高精度优先：宁可漏判不可误判（误触发会误导用户）
 * 2. 中文优先：项目用户为中文母语者
 * 3. 实体/查询提取干净：去除语气词和命令前缀
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ===== 类型 =====

export type VoiceMemoryIntent =
  { type: 'write'; entity: string; confidence: number } | { type: 'read'; query: string; confidence: number } | { type: 'none' }

// ===== Write 模式定义 =====

interface WritePattern {
  regex: RegExp
  /** 实体提取函数：从匹配结果中提取要存储的文本 */
  extract: (match: RegExpExecArray) => string
  /** 最小置信度 (0-1) */
  minConfidence: number
}

const WRITE_PATTERNS: WritePattern[] = [
  // "记住{entity}" → 存储 entity
  { regex: /记住[：:，,\s]*([\s\S].+)/, extract: (m) => m[1].trim(), minConfidence: 0.9 },
  // "记得{entity}" → 存储 entity
  { regex: /^记得[：:，,\s]*([\s\S].+)/, extract: (m) => m[1].trim(), minConfidence: 0.85 },
  // "记一下{entity}" / "记下来{entity}"
  { regex: /记(?:一下|下来)[：:，,\s]*([\s\S].+)/, extract: (m) => m[1].trim(), minConfidence: 0.85 },
  // "别忘了{entity}" → 存储 entity
  { regex: /别忘了[：:，,\s]*([\s\S].+)/, extract: (m) => m[1].trim(), minConfidence: 0.9 },
  // "我叫{name}" → 存储 "用户的名字是{name}"
  { regex: /我(?:叫|是)(.{1,30})$/, extract: (m) => `用户的名字是${m[1].trim()}`, minConfidence: 0.8 },
  // "我喜欢{thing}" → 存储 "用户喜欢{thing}"
  { regex: /我喜欢([\s\S]{1,100})/, extract: (m) => `用户喜欢${m[1].trim()}`, minConfidence: 0.8 },
  // "我的{category}是{value}" → 存储 "用户的{category}是{value}"
  { regex: /我的(.{1,15})是([\s\S]{1,100})/, extract: (m) => `用户的${m[1].trim()}是${m[2].trim()}`, minConfidence: 0.85 },
  // "把{thing}记住" → 存储 thing
  { regex: /把(.{1,50})(?:记住|记下来|存起来)/, extract: (m) => m[1].trim(), minConfidence: 0.85 },
]

// ===== Read 模式定义 =====

interface ReadPattern {
  regex: RegExp
  /** 查询提取函数：从匹配结果中提取用于检索的关键词 */
  extractQuery: (match: RegExpExecArray) => string
  /** 最小置信度 (0-1) */
  minConfidence: number
}

const READ_PATTERNS: ReadPattern[] = [
  // "查一下{query}" / "查查{query}"
  { regex: /查(?:一下|一查|查|找|询)[：:，,\s]*([\s\S].+)/, extractQuery: (m) => m[1].trim(), minConfidence: 0.85 },
  // "上次的{thing}是什么|在哪|怎么样"
  { regex: /上次(?:的)?(.{1,30})(?:是啥|是什么|是哪|在哪里|在哪儿|怎么样|多少)/, extractQuery: (m) => m[1].trim(), minConfidence: 0.88 },
  // "上次{thing}"（无后缀问词，短文本）
  { regex: /^上次(.{1,30})$/, extractQuery: (m) => m[1].trim(), minConfidence: 0.8 },
  // "{thing}是什么" / "{thing}是啥"（需要去掉句末标点）
  { regex: /^(.{2,20})(?:是啥|是什么|是什么来着|是什么意思)$/, extractQuery: (m) => m[1].trim(), minConfidence: 0.7 },
  // "我之前说的{thing}" / "我刚才说的{thing}"
  { regex: /我(?:之前|刚才|以前)(?:说|讲|提)(?:过|的)?(.{1,30})/, extractQuery: (m) => m[1].trim(), minConfidence: 0.8 },
  // "关于{thing}的事|记忆|信息"
  { regex: /关于(.{1,30})(?:的|之事|的事|的记忆|的信息)/, extractQuery: (m) => m[1].trim(), minConfidence: 0.75 },
  // "我的{thing}是什么"（读己方属性）
  { regex: /我的(.{1,10})(?:是啥|是什么|是哪个|在哪里)/, extractQuery: (m) => m[1].trim(), minConfidence: 0.8 },
  // "还记得{query}吗"
  { regex: /还记(?:得|住)(.{1,30})(?:吗|么|的|$)/, extractQuery: (m) => m[1].trim(), minConfidence: 0.75 },
  // "之前{thing}"（无明确后缀，短文本做 read）
  { regex: /之前(?:的|说|提|讲|聊)(?:过|到|的)?(.{1,30})/, extractQuery: (m) => m[1].trim(), minConfidence: 0.72 },
]

// ===== 去重保护：防止同一段文本同时匹配写和读 =====

/** 去重保护用排除模式：如果匹配写，这些模式不应该再作为读触发 */
const WRITE_EXCLUSIVE_PREFIXES = ['记住', '记得', '记一下', '记下来', '别忘了']

/**
 * 检查文本是否包含写意图的前缀词。
 * 用于读意图匹配时的去重保护。
 */
function hasWritePrefix(text: string): boolean {
  const lower = text.toLowerCase()
  return WRITE_EXCLUSIVE_PREFIXES.some((p) => lower.startsWith(p))
}

// ===== 分类器 =====

/**
 * 对 ASR 转录文本进行记忆意图分类。
 *
 * 匹配逻辑：
 * 1. 先检测写意图（高优先级）
 * 2. 写意图未命中再检测读意图
 * 3. 两者都未命中返回 'none'
 *
 * @param text ASR 转录的纯文本
 * @returns 分类结果
 */
export function classifyVoiceMemoryIntent(text: string): VoiceMemoryIntent {
  if (!text || text.trim().length < 2) return { type: 'none' }

  const trimmed = text.trim()

  // ── 第一步：检测写意图 ──
  for (const pattern of WRITE_PATTERNS) {
    const match = pattern.regex.exec(trimmed)
    if (match) {
      const entity = pattern.extract(match)
      if (entity && entity.length >= 1) {
        log('DEBUG', 'voice_memory_write_detected', {
          pattern: pattern.regex.source.slice(0, 40),
          entity: entity.slice(0, 60),
          confidence: pattern.minConfidence,
        })
        return { type: 'write', entity, confidence: pattern.minConfidence }
      }
    }
  }

  // ── 第二步：检测读意图（排除已匹配写意图的前缀） ──
  // 如果文本以写前缀开头，但写模式没匹配到（如 "记住" 后面无内容），不降级为读
  if (hasWritePrefix(trimmed)) {
    return { type: 'none' }
  }

  for (const pattern of READ_PATTERNS) {
    const match = pattern.regex.exec(trimmed)
    if (match) {
      const query = pattern.extractQuery(match)
      if (query && query.length >= 1) {
        log('DEBUG', 'voice_memory_read_detected', {
          pattern: pattern.regex.source.slice(0, 40),
          query: query.slice(0, 60),
          confidence: pattern.minConfidence,
        })
        return { type: 'read', query, confidence: pattern.minConfidence }
      }
    }
  }

  return { type: 'none' }
}

/**
 * 将分类结果格式化为用户可听的 TTS 反馈文本。
 *
 * @param intent 分类结果
 * @param memoryResult 检索结果（仅读意图需要）
 * @returns TTS 播报文本，或 null（不应播报）
 */
export function formatMemoryFeedback(intent: VoiceMemoryIntent, memoryResult?: string[]): string | null {
  switch (intent.type) {
    case 'write':
      // 写操作：短确认即可
      return `好的，我记住了${intent.entity.length > 30 ? intent.entity.slice(0, 30) + '等' : intent.entity}`

    case 'read':
      if (memoryResult && memoryResult.length > 0) {
        // 读操作有结果：直接读出第一条
        const first = memoryResult[0]
        // 如果有更推荐的结果，提示一下
        const hint = memoryResult.length > 1 ? `，另外还有${memoryResult.length - 1}条相关的记忆` : ''
        return `我记得${first}${hint}`
      }
      // 读操作无结果：礼貌提示
      return `抱歉，我没有找到关于${intent.query}的记忆`

    case 'none':
      return null
  }
}
