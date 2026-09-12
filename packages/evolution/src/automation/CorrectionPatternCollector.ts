/**
 * CorrectionPatternCollector — 重复纠正模式采集器
 *
 * 职责：
 * 读取记忆系统中的用户重复纠正模式，生成进化管道的 Problem，
 * 使 Evolution 系统能自动识别用户反复纠正的痛点并优先优化。
 *
 * 数据流：
 *   User 反复纠正同一问题
 *     → MemoryService 记录为 user_fact（含 'error_pattern' / '纠正' 等标签）
 *     → MemoryEvolutionBridge 发出 repeated_correction_pattern 事件
 *     → CorrectionPatternCollector.collect() 查询记忆系统
 *     → 聚类话题，生成 Problem[]（source='behavior'）
 *     → BehaviorOptimizationExecutor 执行优化
 *
 * 安全设计：
 * - 仅在 hasSufficientData（有至少 2 条纠正记录）时产出问题
 * - 仅对出现 >= 2 次的话题生成问题（单次纠正可能为偶然）
 * - 采集间隔至少 1 小时，避免每周期重复采集相同问题
 * - 已见过的问题通过 occurrenceCount 累计，不重复添加
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'
import { memoryEvolutionBridge } from '@akemi-mio/intelligence-memory/MemoryEvolutionBridge'

// ════════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════════

/** 最小运行间隔（毫秒），避免每周期重复采集 */
const MIN_INTERVAL_MS = 60 * 60 * 1000 // 1 小时

/** 话题最低出现次数：至少出现这么多次才视为重复纠正模式 */
const MIN_TOPIC_OCCURRENCES = 2

/** 纠正关键词列表（与 MemoryEvolutionBridge 一致） */
const CORRECTION_KEYWORDS = [
  '不满',
  '纠正',
  '重复提问',
  'error_pattern',
  'short_response',
  '不正确',
  '错了',
  '不对',
  '不是这样',
  '重做',
  '不对吧',
  '重复错误',
  '同样的错误',
  '又错了',
  '修复失败',
  '回滚',
]

/** 模块推断映射（话题 → 模块名） */
const TOPIC_TO_MODULE: Record<string, string> = {
  语音: 'tts',
  语音合成: 'tts',
  TTS: 'tts',
  语音识别: 'asr',
  ASR: 'asr',
  记忆: 'memory',
  记忆系统: 'memory',
  进化: 'evolution',
  自进化: 'evolution',
  壁纸: 'wallpaper',
  壁纸系统: 'wallpaper',
  写作: 'writing',
  写作系统: 'writing',
  创意: 'creativity',
  创意系统: 'creativity',
  工具: 'tool',
  工具调用: 'tool',
  代理: 'agent',
  Agent: 'agent',
  行为: 'behavior',
  行为分析: 'behavior',
}

// ════════════════════════════════════════════════════════════════
//  CorrectionPatternCollector
// ════════════════════════════════════════════════════════════════

export class CorrectionPatternCollector implements SignalCollector {
  readonly name = 'correction-pattern-collector'
  readonly source = 'behavior' as const

  /** 上次运行时间 */
  private lastRun = 0

  /** 已见过的话题 ID 集合（用于去重/累计 occurrenceCount） */
  private seenTopics = new Map<string, number>()

  shouldRun(): boolean {
    // 检查桥接器是否就绪
    if (!memoryEvolutionBridge.isReady()) return false
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  getSkipReason(): string {
    if (!memoryEvolutionBridge.isReady()) return 'memory_bridge_not_ready'
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) {
      const remaining = Math.round((MIN_INTERVAL_MS - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    try {
      this.lastRun = Date.now()

      // 1. 检查桥接器就绪状态
      const ms = memoryEvolutionBridge.getMemoryService()
      if (!ms) {
        log('INFO', 'correction_collector_no_memory_service')
        return []
      }

      // 2. 从记忆系统读取所有 user_fact 条目
      const entries = ms.getEntries().filter((e) => e.type === 'user_fact')

      if (entries.length < 2) {
        log('INFO', 'correction_collector_insufficient_entries', {
          totalEntries: entries.length,
        })
        return []
      }

      // 3. 筛选纠正相关的条目并按话题聚类
      const topicCounts = new Map<string, { count: number; samples: string[] }>()

      for (const entry of entries) {
        // 检查 content 是否包含纠正关键词
        const matchedKeyword = CORRECTION_KEYWORDS.find((kw) => entry.content.includes(kw))
        if (!matchedKeyword) continue

        // 从 topics 和 content 提取话题
        const topics = entry.topics ?? []
        if (topics.length > 0) {
          for (const topic of topics) {
            this.incrementTopic(topicCounts, topic, entry.content)
          }
        } else {
          // 从 content 推断话题
          const inferred = this.inferTopicFromContent(entry.content)
          if (inferred) {
            this.incrementTopic(topicCounts, inferred, entry.content)
          }
        }
      }

      if (topicCounts.size === 0) {
        log('INFO', 'correction_collector_no_patterns')
        return []
      }

      // 4. 过滤低频率话题
      const significantTopics = Array.from(topicCounts.entries())
        .filter(([, data]) => data.count >= MIN_TOPIC_OCCURRENCES)
        .sort(([, a], [, b]) => b.count - a.count)

      if (significantTopics.length === 0) {
        log('INFO', 'correction_collector_no_significant_patterns', {
          topicCounts: topicCounts.size,
        })
        return []
      }

      log('INFO', 'correction_collector_patterns_found', {
        topics: significantTopics.length,
        totalCorrectionEntries: topicCounts.size,
      })

      // 5. 构建 Problem
      const problems: Problem[] = []

      for (const [topic, data] of significantTopics) {
        const topicId = `correction:${topic.replace(/[^a-zA-Z0-9_一-鿿]/g, '_')}`
        const isSeen = this.seenTopics.has(topicId)

        // 更新 seen 记录
        if (!isSeen) {
          this.seenTopics.set(topicId, 0)
        }

        const module = this.inferModuleFromTopic(topic)
        const severity = data.count >= 5 ? 'error' : data.count >= 3 ? 'warning' : 'info'

        problems.push({
          id: topicId,
          source: 'behavior',
          severity,
          title: `用户反复纠正「${topic}」相关问题`,
          description: this.buildDescription(topic, data, module),
          estimatedCostChars: 200,
          lastSeen: Date.now(),
          occurrenceCount: isSeen ? (this.seenTopics.get(topicId) ?? 0) + 1 : data.count,
          context: {
            raw: [
              `重复纠正模式分析:`,
              `话题: ${topic}`,
              `纠正次数: ${data.count}`,
              `关联模块: ${module}`,
              `最近纠正样本:`,
              ...data.samples.slice(0, 3).map((s) => `  - ${s.slice(0, 150)}`),
              ``,
              `建议: 分析 "${topic}" 的纠正原因，从根源修复问题。`,
            ].join('\n'),
            metadata: {
              correctionTopic: topic,
              correctionCount: String(data.count),
              relatedModule: module,
              sampleEntries: JSON.stringify(data.samples.slice(0, 3)),
            },
          },
        })
      }

      log('INFO', 'correction_collector_done', {
        problemsCreated: problems.length,
        topTopic: significantTopics[0]?.[0],
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'correction_collector_error', { error: err.message })
      return []
    }
  }

  // ==================== 内部方法 ====================

  /** 递增话题计数并记录样本 */
  private incrementTopic(map: Map<string, { count: number; samples: string[] }>, topic: string, content: string): void {
    const existing = map.get(topic)
    if (existing) {
      existing.count++
      if (existing.samples.length < 5) {
        existing.samples.push(content.slice(0, 200))
      }
    } else {
      map.set(topic, { count: 1, samples: [content.slice(0, 200)] })
    }
  }

  /** 从日志内容推断话题 */
  private inferTopicFromContent(content: string): string | null {
    const lower = content.toLowerCase()
    // 先检查更具体的匹配，再检查通用匹配（避免 '语音识别' 被 '语音' 误吞）
    if (lower.includes('语音识别') || lower.includes('asr')) return '语音识别'
    if (lower.includes('tts') || lower.includes('语音合成') || lower.includes('语音') || lower.includes('朗读')) return '语音'
    if (lower.includes('壁纸') || lower.includes('wallpaper')) return '壁纸'
    if (lower.includes('记忆') || lower.includes('memory')) return '记忆'
    if (lower.includes('进化') || lower.includes('evolution')) return '进化'
    if (lower.includes('写作') || lower.includes('writing')) return '写作'
    if (lower.includes('工具') || lower.includes('tool')) return '工具'
    if (lower.includes('agent') || lower.includes('代理')) return 'agent'
    return null
  }

  /** 从话题推断关联的功能模块 */
  private inferModuleFromTopic(topic: string): string {
    for (const [key, module] of Object.entries(TOPIC_TO_MODULE)) {
      if (topic.includes(key)) return module
    }
    return 'behavior'
  }

  /** 构建问题描述 */
  private buildDescription(topic: string, data: { count: number; samples: string[] }, module: string): string {
    const lines: string[] = [
      `检测到用户对「${topic}」相关功能反复纠正（${data.count} 次），`,
      `表明该功能在用户体验上存在可改进的空间。`,
      ``,
      `关联模块: ${module}`,
      `纠正次数: ${data.count} 次`,
      ``,
      `建议的改进方向：`,
      `1. 分析纠正的具体原因（是功能缺陷还是用户预期偏差）`,
      `2. 评估是否需要优化 ${module} 模块的响应质量`,
      `3. 如果 ${data.count >= 5 ? '高频' : '持续'} 出现，建议优先处理`,
    ]

    if (data.samples.length > 0) {
      lines.push(``, `最近纠正样本：`)
      for (const s of data.samples.slice(0, 2)) {
        lines.push(`  · ${s.slice(0, 100)}`)
      }
    }

    return lines.join('\n')
  }
}

/** 模块级单例 */
export const correctionPatternCollector = new CorrectionPatternCollector()
