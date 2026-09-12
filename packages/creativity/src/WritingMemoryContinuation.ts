/**
 * WritingMemoryContinuation — 创作记忆驱动续写
 *
 * 职责：
 * 1. 查询 Memory 中与特定故事相关的用户反馈/讨论记忆
 * 2. 生成「读者期望摘要」注入 writing prompt
 * 3. 接受用户续写后反馈并存入 Memory
 *
 * 使用方式：
 * - 续写前调用 getReaderExpectationContext(storyName) 获取格式化摘要
 * - 续写后调用 storeFeedback(storyName, feedback, category) 存储新一轮反馈
 *
 * 风险注意：
 * - 记忆噪声干扰核心叙事 → 只检索 explicit writing_feedback 类型和含故事名的 user_fact
 * - 初始记忆为空 → 功能降级返回空字符串，调用方自行处理
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory/types'

// ===== 导出类型 =====

/** 写作反馈分类 */
export type FeedbackCategory =
  | 'emotion_preference' // 情绪偏好
  | 'setting_disagreement' // 背景设定分歧
  | 'style_feedback' // 文风反馈
  | 'plot_suggestion' // 情节建议
  | 'general' // 一般反馈

/** 故事反馈条目 */
export interface StoryFeedbackEntry {
  id: string
  storyName: string
  feedback: string
  category: FeedbackCategory
  timestamp: number
}

/** 读者期望摘要 */
export interface ReaderExpectationSummary {
  summary: string
  entryCount: number
  isEmpty: boolean
}

// ===== 服务 =====

export class WritingMemoryContinuation {
  /**
   * 查询与给定故事名相关的记忆条目。
   *
   * 检索范围：
   * - type 为 'writing_feedback' 且 content 包含 storyName 的记忆
   * - type 为 'user_fact' 且 content 同时包含 storyName 和反馈关键词的记忆
   */
  queryStoryFeedback(storyName: string): StoryFeedbackEntry[] {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'writing_memory_no_service', { storyName })
      return []
    }

    const allEntries = ms.getEntries()
    const results: StoryFeedbackEntry[] = []

    // 反馈关键词集合（用于从 user_fact 中识别反馈相关条目）
    const feedbackKeywords = [
      '反馈',
      '意见',
      '建议',
      '修改',
      '改',
      '喜欢',
      '不喜欢',
      '觉得',
      '感觉',
      '情绪',
      '偏好',
      '风格',
      '设定',
      '情节',
      '角色',
      '描写',
      '节奏',
      '氛围',
      '画面',
    ]

    for (const entry of allEntries) {
      // 只处理写作反馈或用户事实类型
      if (entry.type !== 'writing_feedback' && entry.type !== 'user_fact') continue

      const content = entry.content.toLowerCase()
      const name = storyName.toLowerCase()

      // 必须包含故事名
      if (!content.includes(name)) continue

      let category: FeedbackCategory = 'general'
      let feedback = entry.content

      if (entry.type === 'writing_feedback') {
        // 从结构化数据中解析分类（如果有）
        if (entry.structuredData) {
          try {
            const parsed = JSON.parse(entry.structuredData)
            category = parsed.category || 'general'
            feedback = parsed.feedback || entry.content
          } catch {
            category = 'general'
          }
        }
      } else {
        // user_fact: 必须匹配反馈关键词
        const hasFeedbackKeyword = feedbackKeywords.some((kw) => content.includes(kw))
        if (!hasFeedbackKeyword) continue

        // 根据内容关键词推断分类
        if (/情绪|喜欢|不喜欢|感觉/.test(content)) category = 'emotion_preference'
        else if (/设定|背景|世界/.test(content)) category = 'setting_disagreement'
        else if (/文笔|文风|风格|描写|修辞/.test(content)) category = 'style_feedback'
        else if (/情节|剧情|走向|发展|建议/.test(content)) category = 'plot_suggestion'
      }

      results.push({
        id: entry.id,
        storyName,
        feedback,
        category,
        timestamp: entry.updatedAt || entry.createdAt,
      })
    }

    // 按时间排序（最新的在前）
    results.sort((a, b) => b.timestamp - a.timestamp)

    log('INFO', 'writing_memory_query', {
      storyName,
      found: results.length,
    })

    return results
  }

  /**
   * 将记忆结果按时间排序并压缩为 300 字以内摘要。
   *
   * 策略：
   * - 以「最近的反馈优先」原则排列
   * - 按分类分组展示关键意见
   * - 超过 300 字时截断，保留最新的条目
   */
  buildReaderExpectationSummary(storyName: string): ReaderExpectationSummary {
    const entries = this.queryStoryFeedback(storyName)
    if (entries.length === 0) {
      return { summary: '', entryCount: 0, isEmpty: true }
    }

    // 按分类分组
    const byCategory: Record<string, StoryFeedbackEntry[]> = {}
    for (const entry of entries) {
      if (!byCategory[entry.category]) byCategory[entry.category] = []
      byCategory[entry.category].push(entry)
    }

    // 分类标签映射
    const categoryLabels: Record<string, string> = {
      emotion_preference: '情绪偏好',
      setting_disagreement: '背景设定',
      style_feedback: '文风反馈',
      plot_suggestion: '情节建议',
      general: '其他反馈',
    }

    const parts: string[] = []
    const MAX_LENGTH = 300

    // 先加入最新的前 3 条单条反馈（时间排序）
    const recentEntries = entries.slice(0, 3)
    const recentLines: string[] = []
    for (const e of recentEntries) {
      const label = categoryLabels[e.category] || '反馈'
      const truncated = e.feedback.length > 80 ? e.feedback.slice(0, 80) + '…' : e.feedback
      recentLines.push(`[${label}] ${truncated}`)
    }

    if (recentLines.length > 0) {
      parts.push(`关于《${storyName}》的最新读者反馈：`)
      parts.push(...recentLines)
    }

    // 按分类汇总
    const categorySummary: string[] = []
    for (const [cat, items] of Object.entries(byCategory)) {
      const label = categoryLabels[cat] || '反馈'
      // 汇总该分类下的常见意见
      const opinionCount = items.length
      if (opinionCount >= 2) {
        categorySummary.push(`${label}(${opinionCount}条)`)
      }
    }

    if (categorySummary.length > 0) {
      parts.push(`反馈分布：${categorySummary.join('、')}。`)
    }

    // 总体强调 — 如果总条数较多，提示用户反馈很丰富
    if (entries.length > 5) {
      parts.push(`共 ${entries.length} 条相关反馈。`)
    }

    // 压缩到 300 字
    let summary = parts.join('\n')
    if (summary.length > MAX_LENGTH) {
      // 截断到 MAX_LENGTH，保留完整行
      const lines = summary.split('\n')
      const result: string[] = []
      let len = 0
      for (const line of lines) {
        if (len + line.length + 1 > MAX_LENGTH) break
        result.push(line)
        len += line.length + 1
      }
      // 如果截断后少于 2 行，强制截断字符
      if (result.length < 2) {
        summary = summary.slice(0, MAX_LENGTH - 3) + '…'
      } else {
        summary = result.join('\n') + '\n…'
      }
    }

    log('INFO', 'writing_memory_summary_built', {
      storyName,
      entryCount: entries.length,
      summaryLength: summary.length,
    })

    return {
      summary,
      entryCount: entries.length,
      isEmpty: false,
    }
  }

  /**
   * 获取格式化的读者期望上下文（用于注入 system prompt / writing prompt）
   *
   * 格式示例：
   * ---
   * 【读者期望摘要】
   * 关于《工业颂歌》的最新读者反馈：
   * [情绪偏好] 前几章的工业感很强，但希望第九章加入一些日常生活场景。
   * [背景设定] 主角的工作环境可以更具体一些。
   * ...
   * 请参考以上反馈调整续写方向，让故事更贴合读者期待。
   * ---
   */
  getReaderExpectationContext(storyName: string): string {
    const result = this.buildReaderExpectationSummary(storyName)
    if (result.isEmpty) return ''

    const lines: string[] = [
      '---',
      '【读者期望摘要】',
      result.summary,
      '',
      '以上是读者对前几章的反馈汇总。续写时请参考以上意见调整方向，',
      '使新章节更贴合读者偏好。',
      '---',
    ]

    return lines.join('\n')
  }

  /**
   * 存储用户对故事的反馈到 Memory。
   *
   * 存储为 writing_feedback 类型的记忆条目，
   * 包含结构化数据（故事名、反馈内容、分类）。
   * tier 默认为 semi（半永久层），确保不会被快速清理。
   */
  storeFeedback(storyName: string, feedback: string, category: FeedbackCategory = 'general'): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'writing_memory_store_no_service', { storyName })
      return
    }

    const content = `【${storyName}反馈】${category}: ${feedback.slice(0, 200)}`
    const structuredData = JSON.stringify({
      storyName,
      feedback: feedback.slice(0, 500),
      category,
    })

    // 使用 addEntry 存储为 writing_feedback 类型，半永久层
    ms.addEntry('writing_feedback', content, 0.8, { tier: 'semi' })

    // 同时写入 user_fact 作为后备（保持向量检索兼容）
    ms.addFact(`用户对《${storyName}》的${category}反馈：${feedback.slice(0, 150)}`, 0.6, { tier: 'semi' })

    log('INFO', 'writing_memory_feedback_stored', {
      storyName,
      category,
      feedbackLength: feedback.length,
    })
  }

  /**
   * 批量存储多个反馈条目。
   */
  storeFeedbackBatch(storyName: string, feedbacks: Array<{ feedback: string; category: FeedbackCategory }>): number {
    let count = 0
    for (const f of feedbacks) {
      this.storeFeedback(storyName, f.feedback, f.category)
      count++
    }
    return count
  }
}

