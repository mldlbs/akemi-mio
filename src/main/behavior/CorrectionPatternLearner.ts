/**
 * CorrectionPatternLearner — 用户纠正模式学习器
 *
 * 侦测用户对 Agent 输出（工具参数、回复风格等）的纠正行为，
 * 并从纠正模式中提取偏好，写入 BehaviorPreferenceStore。
 *
 * ## 侦测模式
 * 1. 工具参数纠正：用户在执行某个工具后，立即以不同参数再次调用同一工具
 * 2. 回复风格纠正：用户明确要求"不要这样"、"简短点"等风格调整
 * 3. 语言偏好纠正：用户纠正翻译语言、输出语言等
 *
 * ## 学习机制
 * - 同一纠正模式出现 ≥2 次 → 记录为偏好（低置信度）
 * - 同一纠正模式出现 ≥3 次 → 晋升为偏好（中等置信度）
 * - 关联上下文记忆：记录纠正前后的参数/风格对比
 *
 * ## 示例
 * - 用户连续 3 次调用翻译工具后将目标语言从 en 改为 zh
 *   → 学习到 "translate:target_lang" = "zh"
 * - 用户每次回复后说"简短点"
 *   → 学习到 "detail:prefer_concise" 递增
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import { behaviorPreferenceStore } from './BehaviorPreferenceStore'
import type { PreferenceValue } from './BehaviorPreferenceStore'
import { eventBus, type EventPayload } from '../core/EventBus'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 工具调用快照，用于对比前后参数差异 */
export interface ToolCallSnapshot {
  toolName: string
  arguments: Record<string, unknown>
  timestamp: number
  success: boolean
}

/** 纠正事件记录 */
export interface CorrectionEvent {
  /** 工具名 */
  toolName: string
  /** 初始调用参数快照 */
  originalArgs: Record<string, unknown>
  /** 纠正后调用的新参数 */
  correctedArgs: Record<string, unknown>
  /** 发生改变的参数键列表 */
  changedParams: string[]
  /** 时间戳 */
  timestamp: number
}

/** 学习到的偏好条目（准备写入 BehaviorPreferenceStore） */
export interface LearnedPreference {
  /** 偏好键（如 'translate:target_lang'） */
  key: string
  /** 偏好值 */
  value: PreferenceValue
  /** 分类 */
  category: 'tool_default' | 'correction' | 'style_pref'
  /** 置信度 */
  confidence: number
  /** 学习依据 */
  metadata?: string
}

// ══════════════════════════════════════════
// 配置常量
// ══════════════════════════════════════════

/** 定义哪些工具参数是"可纠正的"（Agent 可学习用户偏好的） */
const CORRECTABLE_TOOL_PARAMS: Record<string, string[]> = {
  // 翻译工具（如果存在的话）
  translate_text: ['target_language', 'source_language', 'style'],
  // 搜索工具
  web_search: ['max_results', 'region'],
  // 阅读文件
  read_file: ['max_length', 'encoding'],
  // 代码相关
  run_command: ['timeout', 'shell'],
  edit_file: ['old_string', 'new_string'],
  // 写作相关
  writing_compose: ['style', 'length', 'language'],
  // 通用参数调整模式
  '*': ['detail_level', 'format', 'language', 'style', 'tone'],
}

/** 用户风格纠正关键词（从用户消息中检测） */
const STYLE_CORRECTION_PATTERNS = [
  { pattern: /简短|简洁|short|brief|concise|太长|简略/gi, preference: 'detail:prefer_concise' },
  { pattern: /详细|详细点|具体|detail|in.depth|深入|展开/gi, preference: 'detail:prefer_detailed' },
  { pattern: /不要.*工具|别.*调用|不要.*用.*工具/gi, preference: 'tool:prefer_no_tool' },
  { pattern: /用.*工具|调.*工具|使用.*工具/gi, preference: 'tool:prefer_use_tool' },
  { pattern: /中文|用中文|说中文|Chinese/gi, preference: 'style:prefer_language' },
  { pattern: /英文|用英文|说英文|English/gi, preference: 'style:prefer_language' },
  { pattern: /技术|专业|formal|正式/gi, preference: 'style:answer_mode' },
  { pattern: /简单|通俗|易懂|easy|simple/gi, preference: 'style:answer_mode' },
]

// ══════════════════════════════════════════
// CorrectionPatternLearner
// ══════════════════════════════════════════

export class CorrectionPatternLearner {
  /** 最近的工具调用历史（用于检测纠正模式） */
  private recentToolCalls: ToolCallSnapshot[] = []
  /** 已学习的偏好（避免重复写入） */
  private learnedPreferences: Map<string, LearnedPreference> = new Map()
  /** 用于检测纠正模式的时间窗口（毫秒） */
  private correctionWindowMs = 120_000 // 2 分钟内
  /** 最大保留的历史调用数 */
  private maxHistorySize = 50
  /** EventBus 取消订阅函数 */
  private unsubscribers: (() => void)[] = []
  /** 是否已启动 */
  private started = false

  /**
   * 开始监听 EventBus 工具调用事件。
   */
  start(): void {
    if (this.started) return
    this.started = true

    this.unsubscribers.push(
      eventBus.on('agent.tool.completed', (p: EventPayload['agent.tool.completed']) => {
        try {
          const args = typeof p.args === 'string' ? JSON.parse(p.args) : (p.args || {})
          this.recordToolCall({
            toolName: p.tool,
            arguments: args as Record<string, unknown>,
            timestamp: Date.now(),
            success: true,
          })
        } catch {
          // 参数解析失败，跳过
        }
      }),
    )

    this.unsubscribers.push(
      eventBus.on('agent.tool.invoked', (p: EventPayload['agent.tool.invoked']) => {
        // 也记录调用开始（即使后续可能失败），用于纠正检测
        try {
          const args = typeof p.args === 'string' ? JSON.parse(p.args) : (p.args || {})
          this.recordToolCall({
            toolName: p.tool,
            arguments: args as Record<string, unknown>,
            timestamp: Date.now(),
            success: true, // 乐观假设，后续 completed/failed 事件会更新
          })
        } catch {
          // 跳过
        }
      }),
    )

    log('INFO', 'correction_pattern_learner_started')
  }

  /**
   * 停止监听。
   */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub() } catch {}
    }
    this.unsubscribers = []
    this.started = false
  }

  /**
   * 手动记录一次工具调用（供 ChatExecutor 在工具循环中调用）。
   */
  recordToolCall(snapshot: ToolCallSnapshot): void {
    this.recentToolCalls.push(snapshot)
    if (this.recentToolCalls.length > this.maxHistorySize) {
      this.recentToolCalls = this.recentToolCalls.slice(-this.maxHistorySize)
    }

    // 检查是否有纠正模式
    this.detectCorrection(snapshot)
  }

  /**
   * 手动记录一条用户消息中的风格纠正。
   * 供 ChatExecutor 在收到用户消息后调用。
   */
  recordUserMessage(userText: string): void {
    if (!userText || userText.length < 2) return

    for (const { pattern, preference } of STYLE_CORRECTION_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(userText)) {
        // 递增偏好计数器
        if (preference === 'detail:prefer_concise' || preference === 'detail:prefer_detailed') {
          behaviorPreferenceStore.increment(preference, 'detail_trend', `detected: ${userText.slice(0, 60)}`)
        } else if (preference.startsWith('tool:')) {
          behaviorPreferenceStore.increment(preference, 'tool_default', `detected: ${userText.slice(0, 60)}`)
        } else if (preference.startsWith('style:')) {
          const match = pattern.exec(userText)
          const detectedValue = match ? match[0].toLowerCase() : 'detected'
          if (preference === 'style:prefer_language') {
            const isChinese = /中文|说中文|Chinese/gi.test(userText)
            behaviorPreferenceStore.set(
              'style:language_pair',
              isChinese ? 'zh' : 'en',
              'style_pref',
              `corrected by: ${userText.slice(0, 80)}`,
            )
          } else if (preference === 'style:answer_mode') {
            const isTechnical = /技术|专业|formal|正式/gi.test(userText)
            behaviorPreferenceStore.set(
              'style:answer_mode',
              isTechnical ? 'technical' : 'simple',
              'style_pref',
              `corrected by: ${userText.slice(0, 80)}`,
            )
          }
        }
        log('DEBUG', 'correction_pattern_style_detected', {
          preference,
          sample: userText.slice(0, 60),
        })
      }
    }
  }

  /**
   * 获取已学习的所有偏好列表。
   */
  getLearnedPreferences(): LearnedPreference[] {
    return Array.from(this.learnedPreferences.values())
  }

  /**
   * 获取某个工具的推荐参数默认值。
   */
  getToolDefaults(toolName: string): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    const snapshot = behaviorPreferenceStore.getSnapshot()

    // 查找以 "{toolName}:" 为前缀的偏好
    const prefix = `${toolName}:`
    for (const [key, value] of Object.entries(snapshot.toolDefaults)) {
      if (key.startsWith(prefix)) {
        const paramName = key.slice(prefix.length)
        defaults[paramName] = value
      }
    }

    return defaults
  }

  /**
   * 获取推荐的工具默认参数上下文（注入 system prompt）。
   */
  getToolDefaultsContext(): string {
    const allDefaults = behaviorPreferenceStore.getSnapshot().toolDefaults
    const toolGroups = new Map<string, string[]>()

    for (const [key, value] of Object.entries(allDefaults)) {
      const colonIdx = key.indexOf(':')
      if (colonIdx > 0) {
        const tool = key.slice(0, colonIdx)
        const param = key.slice(colonIdx + 1)
        if (!toolGroups.has(tool)) toolGroups.set(tool, [])
        toolGroups.get(tool)!.push(`  ${param}: ${value}`)
      }
    }

    if (toolGroups.size === 0) return ''

    const parts = ['---', '【工具参数偏好】根据历史交互学习到的工具参数默认值：']
    for (const [tool, lines] of toolGroups) {
      parts.push(`- ${tool}:`)
      parts.push(...lines)
    }
    parts.push('（用户可能希望这些参数被自动应用，如有误请在对话中纠正）')
    parts.push('---')
    return parts.join('\n')
  }

  /**
   * 检测当前工具调用是否为对前一次调用的纠正。
   * 核心逻辑：
   * 1. 查找与当前调用相同工具名的最近调用
   * 2. 比较参数差异
   * 3. 如果只有一个参数不同且该参数是可纠正参数列表中的，判定为纠正
   */
  private detectCorrection(current: ToolCallSnapshot): void {
    const windowStart = current.timestamp - this.correctionWindowMs

    // 查找同工具名的前一次调用
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      const prev = this.recentToolCalls[i]
      if (prev.toolName !== current.toolName) continue
      if (prev.timestamp < windowStart) break

      // 比较参数
      const changedParams = this.findChangedParams(prev.arguments, current.arguments)
      if (changedParams.length === 0) continue

      // 检查这些参数是否属于"可纠正"参数列表
      const correctableParams = CORRECTABLE_TOOL_PARAMS[current.toolName] || CORRECTABLE_TOOL_PARAMS['*'] || []
      const correctableChanges = changedParams.filter((p) => correctableParams.includes(p))

      if (correctableChanges.length > 0 && correctableChanges.length <= 2) {
        // 记录纠正事件
        const event: CorrectionEvent = {
          toolName: current.toolName,
          originalArgs: prev.arguments,
          correctedArgs: current.arguments,
          changedParams: correctableChanges,
          timestamp: current.timestamp,
        }

        this.processCorrectionEvent(event)
        return // 只检测一次
      }
    }
  }

  /**
   * 查找两个参数对象之间值发生变化的键。
   */
  private findChangedParams(
    original: Record<string, unknown>,
    corrected: Record<string, unknown>,
  ): string[] {
    const changed: string[] = []
    const allKeys = new Set([...Object.keys(original), ...Object.keys(corrected)])

    for (const key of allKeys) {
      const ov = original[key]
      const cv = corrected[key]

      // 如果一个有值另一个没有，或者值不同，视为变化
      if (ov === undefined && cv !== undefined) {
        changed.push(key)
      } else if (ov !== undefined && cv === undefined) {
        changed.push(key)
      } else if (ov !== cv && JSON.stringify(ov) !== JSON.stringify(cv)) {
        changed.push(key)
      }
    }

    return changed
  }

  /**
   * 处理纠正事件：更新偏好统计和学习偏好。
   */
  private processCorrectionEvent(event: CorrectionEvent): void {
    const { toolName, correctedArgs, changedParams } = event

    for (const param of changedParams) {
      const newValue = correctedArgs[param]
      if (newValue === undefined) continue

      const prefKey = `${toolName}:${param}`

      // 使用 BehaviorPreferenceStore 递增该偏好的观察计数
      // 注意：这里使用 set 而不是 increment，因为我们记录的是"被选中的值"
      const existing = behaviorPreferenceStore.get<string>(prefKey)
      if (existing !== undefined && existing !== String(newValue)) {
        // 值变化：记录新的偏好值
        behaviorPreferenceStore.set(
          prefKey,
          newValue as PreferenceValue,
          'tool_default',
          `corrected_from_${JSON.stringify(existing)}`,
        )
        log('INFO', 'correction_pattern_learned_param_change', {
          tool: toolName,
          param,
          from: existing,
          to: newValue,
        })
      } else if (existing === undefined) {
        // 首次纠正：低置信度记录
        const learned: LearnedPreference = {
          key: prefKey,
          value: newValue as PreferenceValue,
          category: 'tool_default',
          confidence: 0.3,
          metadata: `first_correction: ${toolName}.${param}`,
        }
        this.learnedPreferences.set(prefKey, learned)
        behaviorPreferenceStore.set(prefKey, newValue as PreferenceValue, 'tool_default', learned.metadata)
        log('INFO', 'correction_pattern_first_detected', {
          tool: toolName,
          param,
          value: newValue,
        })
      }
    }
  }

  /** 获取调试统计 */
  getStats(): { historySize: number; learnedPrefs: number; active: boolean } {
    return {
      historySize: this.recentToolCalls.length,
      learnedPrefs: this.learnedPreferences.size,
      active: this.started,
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

/** 全局 CorrectionPatternLearner 单例 */
export const correctionPatternLearner = new CorrectionPatternLearner()
