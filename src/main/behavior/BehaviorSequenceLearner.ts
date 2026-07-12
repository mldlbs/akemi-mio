/**
 * BehaviorSequenceLearner — 行为序列学习器
 *
 * 从 UserBehaviorAnalyzer 的工具调用记录中学习高频操作序列，
 * 自动生成语义标签和语音触发短语，并注册为动态语音意图。
 *
 * 工作流程：
 * 1. 读取 __behaviorToolRecords 全局钩子中的工具调用历史
 * 2. 滑动窗口提取 2-4 步连续调用序列（间隙 ≤ 30s）
 * 3. 统计频率，筛选高频序列
 * 4. 生成中文语义标签和自然语言触发短语
 * 5. 注册为动态语音意图（通过 voice-intent-map 的动态注册 API）
 * 6. 定期自动刷新（默认 30 分钟）
 * 7. 持久化已学习模式到 cache 目录
 *
 * 集成点：
 * - 依赖 registerBehaviorRecordHook() 注入的 __behaviorToolRecords
 * - 调用 voice-intent-map 的 registerDynamicIntent / unregisterDynamicIntent
 * - 可在 SelfEvolutionService 的周期中或独立定时器触发
 */

import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import {
  type VoiceIntentDef,
  registerDynamicIntent,
  unregisterDynamicIntent,
  clearDynamicIntents,
} from '../tool/voice-intent-map'

// =============================================================================
// 常量
// =============================================================================

/** 序列分析：最小长度 */
const MIN_SEQUENCE_LEN = 2
/** 序列分析：最大长度 */
const MAX_SEQUENCE_LEN = 4
/** 连续调用判定阈值（ms）— 超过此间隔视为不连续 */
const SEQUENCE_GAP_MS = 30_000
/** 高频序列最小出现次数 */
const MIN_FREQUENCY = 3
/** 学习窗口（最近 N 条工具调用记录） */
const LEARNING_WINDOW = 96
/** 语音意图最大数量（限制误触发） */
const MAX_VOICE_INTENTS = 8
/** 自动刷新间隔（ms），默认 30 分钟 */
const DEFAULT_REFRESH_MS = 30 * 60 * 1000
/** 持久化文件路径 */
const PATTERNS_FILE = join(WORKSPACE.cache, 'behavior-learned-patterns.json')

// =============================================================================
// 工具名 → 中文动作描述映射
// =============================================================================

const TOOL_ACTION_MAP: Record<string, string> = {
  // 文件操作
  read_file: '读取文件',
  read_file_centos: '读取远程文件',
  write_file: '编写文件',
  write_file_centos: '编写远程文件',
  edit_file: '编辑代码',
  // 搜索
  grep: '搜索代码',
  grep_centos: '搜索远程代码',
  // 目录
  list_files: '列出文件',
  // 命令执行
  run_command: '执行命令',
  exec_centos: '执行远程命令',
  // 开发
  create_dev_plan: '创建计划',
  update_plan_progress: '更新进度',
  analyze_codebase: '分析代码',
  analyze_task: '分析任务',
  // 知识
  remember_fact: '记住知识',
  // 图像
  generate_image: '生成图片',
  // 写作
  writing_system: '创意写作',
  // 工作流
  auto_schedule_workflow: '调度工作流',
  // 学习
  learning_query: '学习查询',
  oral_code_generate: '生成代码',
  // 系统
  get_system_health: '系统健康检查',
  list_plans: '查看计划',
  list_workflows: '查看工作流',
  // 社交
  social_pipeline: '社交媒体',
  query_trends: '查询趋势',
  // 默认
  get_credential: '获取凭证',
  list_credentials: '列出凭证',
  list_mcp_servers: '列出服务',
  list_skills: '列出技能',
}

/** 部分工具可以直接映射为更自然的动词短语 */
const TOOL_VERB_PHRASE: Record<string, string> = {
  grep: '查找',
  read_file: '阅读',
  write_file: '创建',
  edit_file: '修改',
  run_command: '运行',
  generate_image: '画图',
}

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 已学习的操作序列模式
 */
export interface LearnedPattern {
  /** 唯一 ID（基于工具名序列） */
  id: string
  /** 工具名序列 */
  tools: string[]
  /** 出现次数 */
  frequency: number
  /** 语义标签（如 "搜索代码并编辑"） */
  label: string
  /** 语音触发短语列表 */
  voicePhrases: string[]
  /** 用户可见的描述 */
  description: string
  /** 置信度 0-1（基于频率和稳定性） */
  confidence: number
  /** 首次学习时间戳 */
  firstLearned: number
  /** 最近活跃时间戳 */
  lastActive: number
  /** 是否已激活（低频时自动停用） */
  isActive: boolean
}

/**
 * 学习器配置
 */
export interface LearnerConfig {
  /** 高频序列最小出现次数 */
  minFrequency?: number
  /** 最大语音意图数 */
  maxVoiceIntents?: number
  /** 自动刷新间隔 ms */
  refreshIntervalMs?: number
  /** 学习窗口大小 */
  learningWindow?: number
}

/**
 * 学习器统计数据
 */
export interface LearnerStats {
  totalSequencesAnalyzed: number
  uniqueSequences: number
  activePatterns: number
  registeredIntents: number
  lastLearnedAt: number | null
  refreshIntervalMs: number
}

// =============================================================================
// BehaviorSequenceLearner
// =============================================================================

export class BehaviorSequenceLearner {
  private patterns: LearnedPattern[] = []
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private lastLearnedAt: number | null = null

  private minFrequency: number
  private maxVoiceIntents: number
  private refreshIntervalMs: number
  private learningWindow: number

  // 去重：避免同一序列在注册后反复注册
  private registeredIntentIds = new Set<string>()

  constructor(config?: LearnerConfig) {
    this.minFrequency = config?.minFrequency ?? MIN_FREQUENCY
    this.maxVoiceIntents = config?.maxVoiceIntents ?? MAX_VOICE_INTENTS
    this.refreshIntervalMs = config?.refreshIntervalMs ?? DEFAULT_REFRESH_MS
    this.learningWindow = config?.learningWindow ?? LEARNING_WINDOW

    // 启动时加载已持久化的模式
    this.load()
  }

  // ==================== 核心学习接口 ====================

  /**
   * 执行一次完整的学习周期：
   * 1. 读取工具调用记录
   * 2. 提取并聚类高频序列
   * 3. 生成语义标签和语音短语
   * 4. 注册/更新动态语音意图
   * 5. 持久化
   *
   * @returns 本次学到的新模式（包括更新的已有模式）
   */
  learn(): LearnedPattern[] {
    const calls = this.getToolCallRecords()
    if (calls.length < 3) {
      log('INFO', 'behavior_learner_insufficient_data', { calls: calls.length })
      return []
    }

    // 1. 提取序列并统计频率
    const sequenceMap = this.extractSequences(calls)
    const totalUnique = sequenceMap.size

    // 2. 过滤高频序列
    const frequent = Array.from(sequenceMap.entries())
      .filter(([, data]) => data.count >= this.minFrequency)
      .sort((a, b) => b[1].count - a[1].count)

    if (frequent.length === 0) {
      log('INFO', 'behavior_learner_no_patterns', {
        totalUnique,
        minThreshold: this.minFrequency,
      })
      return []
    }

    // 3. 生成/更新模式
    const now = Date.now()
    const newPatterns: LearnedPattern[] = []
    const seenIds = new Set<string>()

    for (const [key, data] of frequent.slice(0, this.maxVoiceIntents * 2)) {
      const tools = key.split('→')
      const patternId = `bp_${key.replace(/[→]/g, '_')}`

      const existing = this.patterns.find((p) => p.id === patternId)
      const label = this.generateLabel(tools)
      const phrases = this.generateVoicePhrases(tools, label)

      const pattern: LearnedPattern = {
        id: patternId,
        tools,
        frequency: data.count,
        label,
        voicePhrases: phrases,
        description: this.generateDescription(tools, label),
        confidence: this.calculateConfidence(data.count, calls.length),
        firstLearned: existing?.firstLearned ?? now,
        lastActive: now,
        isActive: data.count >= this.minFrequency,
      }

      seenIds.add(patternId)
      newPatterns.push(pattern)
    }

    // 4. 合并到已有模式列表
    const updatedPatterns: LearnedPattern[] = []
    for (const np of newPatterns) {
      const idx = this.patterns.findIndex((p) => p.id === np.id)
      if (idx >= 0) {
        // 更新已有模式
        this.patterns[idx] = np
        updatedPatterns.push(np)
      } else {
        this.patterns.push(np)
        updatedPatterns.push(np)
      }
    }

    // 5. 停用不再频繁的模式
    for (const p of this.patterns) {
      if (!seenIds.has(p.id)) {
        // 连续两次不活跃才停用（给恢复机会）
        if (p.isActive && p.lastActive < now - this.refreshIntervalMs * 2) {
          p.isActive = false
          log('INFO', 'behavior_learner_deactivated', {
            id: p.id,
            label: p.label,
            lastActive: new Date(p.lastActive).toISOString(),
          })
        }
      }
    }

    // 6. 注册语音意图
    this.registerVoiceCommands()

    // 7. 持久化
    this.save()

    this.lastLearnedAt = now

    log('INFO', 'behavior_learner_complete', {
      uniqueSequences: totalUnique,
      activePatterns: this.patterns.filter((p) => p.isActive).length,
      newPatterns: updatedPatterns.length,
      totalPatterns: this.patterns.length,
      registeredIntents: this.registeredIntentIds.size,
    })

    return updatedPatterns
  }

  /**
   * 从工具调用记录中提取 2-4 步连续序列。
   * 滑动窗口 + 时间间隔过滤（≥30s 不视为连续）。
   */
  private extractSequences(
    calls: Array<{ name: string; timestamp: number }>,
  ): Map<string, { count: number; latestGapMs: number }> {
    const seqMap = new Map<string, { count: number; latestGapMs: number }>()

    for (let n = MIN_SEQUENCE_LEN; n <= MAX_SEQUENCE_LEN; n++) {
      for (let i = 0; i <= calls.length - n; i++) {
        const window = calls.slice(i, i + n)

        // 检查连续性：内部任意两步间隔不超过 SEQUENCE_GAP_MS
        let continuous = true
        for (let j = 1; j < window.length; j++) {
          if (window[j].timestamp - window[j - 1].timestamp > SEQUENCE_GAP_MS) {
            continuous = false
            break
          }
        }
        if (!continuous) continue

        const totalGapMs = window[window.length - 1].timestamp - window[0].timestamp
        const key = window.map((c) => c.name).join('→')

        const existing = seqMap.get(key)
        if (existing) {
          existing.count++
          existing.latestGapMs = Math.max(existing.latestGapMs, totalGapMs)
        } else {
          seqMap.set(key, { count: 1, latestGapMs: totalGapMs })
        }
      }
    }

    return seqMap
  }

  // ==================== 标签和短语生成 ====================

  /**
   * 为工具序列生成语义标签。
   * 例如：['grep', 'read_file', 'edit_file'] → "搜索代码并编辑"
   */
  private generateLabel(tools: string[]): string {
    if (tools.length === 0) return ''

    const descriptions = tools.map((t) => TOOL_ACTION_MAP[t] || t)
    const verbPhrases = tools.map((t) => TOOL_VERB_PHRASE[t] || TOOL_ACTION_MAP[t] || t)

    if (tools.length === 2) {
      // 搜索并读取、编写并运行
      return `${verbPhrases[0]}并${verbPhrases[1]}`
    }

    if (tools.length === 3) {
      // 搜索代码、读取并编辑
      if (verbPhrases[0] === descriptions[0]) {
        return `${descriptions[0]}、${verbPhrases[1]}并${verbPhrases[2]}`
      }
      return `${verbPhrases[0]}、${verbPhrases[1]}并${verbPhrases[2]}`
    }

    if (tools.length === 4) {
      return `${descriptions[0]}、${descriptions[1]}、${verbPhrases[2]}并${verbPhrases[3]}`
    }

    return descriptions.join('→')
  }

  /**
   * 生成语音触发短语列表。
   * 每个短语都是自然语言命令，供 matchIntents 做关键词匹配。
   */
  private generateVoicePhrases(tools: string[], label: string): string[] {
    const phrases: string[] = [label]

    // 基于首尾工具生成简写
    if (tools.length >= 2) {
      const firstVerb = TOOL_VERB_PHRASE[tools[0]] || TOOL_ACTION_MAP[tools[0]] || tools[0]
      const lastVerb = TOOL_VERB_PHRASE[tools[tools.length - 1]] || TOOL_ACTION_MAP[tools[tools.length - 1]] || tools[tools.length - 1]
      phrases.push(`${firstVerb}并${lastVerb}`)
    }

    // 如果是代码工作流，添加通用别名
    const codeTools = ['grep', 'read_file', 'write_file', 'edit_file', 'run_command', 'create_dev_plan']
    const isCodeFlow = tools.some((t) => codeTools.includes(t))
    if (isCodeFlow && tools.length >= 2) {
      const lastName = tools[tools.length - 1]
      const lastVerb = TOOL_VERB_PHRASE[lastName] || TOOL_ACTION_MAP[lastName] || lastName
      phrases.push(`开始${lastVerb}`)
      // 如果涉及多个步骤，添加"开始工作"作为别名
      if (tools.length >= 3 && !phrases.includes('开始工作')) {
        phrases.push('开始工作')
      }
    }

    // 去重（保留顺序）
    return [...new Set(phrases)]
  }

  /**
   * 生成用户可见的描述文本（展示给用户看，供确认消息使用）
   */
  private generateDescription(tools: string[], label: string): string {
    const steps = tools
      .map((t) => {
        const desc = TOOL_ACTION_MAP[t] || t
        return `- ${desc}`
      })
      .join('\n')
    return `将自动执行以下步骤：\n${steps}`
  }

  /**
   * 计算模式置信度。
   * 基于频率占比（在总调用中的比例）和稳定性。
   */
  private calculateConfidence(freq: number, totalCalls: number): number {
    if (totalCalls === 0) return 0
    const ratio = freq / totalCalls
    // 频率越高置信度越高，但使用平方根让早期增长更快
    return Math.min(1, Math.sqrt(ratio * 10) * 0.5 + 0.1)
  }

  // ==================== 语音意图注册 ====================

  /**
   * 将活跃的学习模式注册为动态语音意图。
   * 已注册且未变更的意图会跳过。
   */
  private registerVoiceCommands(): void {
    // 先清除旧注册
    for (const id of this.registeredIntentIds) {
      unregisterDynamicIntent(id)
    }
    this.registeredIntentIds.clear()

    // 获取活跃且高频的模式
    const activePatterns = this.patterns
      .filter((p) => p.isActive && p.frequency >= this.minFrequency)
      .slice(0, this.maxVoiceIntents)

    for (const pattern of activePatterns) {
      const intentId = pattern.id
      const slots: Record<string, RegExp> = {}

      // 如果有文件路径类参数，添加基本的槽位提取
      const hasFileOps = pattern.tools.some((t) =>
        t.includes('read_file') || t.includes('write_file') || t.includes('edit_file'),
      )
      if (hasFileOps) {
        slots.path = /(?:路径|文件|目录)\s*[""'']?([^\s""'']+)[""'']?/
      }

      const intentDef: VoiceIntentDef = {
        intent: intentId,
        description: pattern.label,
        patterns: pattern.voicePhrases,
        slotExtractors: Object.keys(slots).length > 0 ? slots : undefined,
        tools: pattern.tools.map((tool) => ({
          tool,
          args: {},
        })),
        confirmMessage: `将执行「${pattern.label}」工作流\n${pattern.description}`,
        requireConfirmation: true,
      }

      registerDynamicIntent(intentId, intentDef)
      this.registeredIntentIds.add(intentId)
    }

    log('INFO', 'behavior_learner_intents_registered', {
      registered: activePatterns.length,
      maxSlots: this.maxVoiceIntents,
      patterns: activePatterns.map((p) => ({ label: p.label, freq: p.frequency })),
    })
  }

  // ==================== 定时刷新 ====================

  /**
   * 启动自动刷新周期。
   * 会立即执行一次学习，然后按间隔重复。
   */
  startAutoRefresh(intervalMs?: number): void {
    this.stopAutoRefresh()

    const ms = intervalMs ?? this.refreshIntervalMs

    // 立即执行一次
    setImmediate(() => {
      try {
        this.learn()
      } catch (err) {
        log('WARN', 'behavior_learner_initial_run', { error: String(err) })
      }
    })

    this.refreshTimer = setInterval(() => {
      try {
        this.learn()
      } catch (err) {
        log('WARN', 'behavior_learner_refresh', { error: String(err) })
      }
    }, ms)

    log('INFO', 'behavior_learner_auto_refresh_started', {
      intervalMs: ms,
      intervalMin: Math.round(ms / 60_000),
    })
  }

  /** 停止自动刷新 */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /** 是否正在自动刷新 */
  isAutoRefreshActive(): boolean {
    return this.refreshTimer !== null
  }

  // ==================== 持久化 ====================

  /**
   * 将已学习的模式持久化到磁盘。
   */
  save(): void {
    try {
      const data = this.patterns.map((p) => ({
        id: p.id,
        tools: p.tools,
        frequency: p.frequency,
        label: p.label,
        voicePhrases: p.voicePhrases,
        description: p.description,
        confidence: p.confidence,
        firstLearned: p.firstLearned,
        lastActive: p.lastActive,
        isActive: p.isActive,
      }))

      const dir = dirname(PATTERNS_FILE)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2), 'utf-8')

      log('INFO', 'behavior_learner_saved', {
        patterns: data.length,
        path: PATTERNS_FILE,
      })
    } catch (err) {
      log('WARN', 'behavior_learner_save_failed', { error: String(err) })
    }
  }

  /**
   * 从磁盘加载已学习的模式。
   */
  load(): void {
    try {
      if (!existsSync(PATTERNS_FILE)) return

      const raw = readFileSync(PATTERNS_FILE, 'utf-8')
      const data = JSON.parse(raw)

      if (!Array.isArray(data)) {
        log('WARN', 'behavior_learner_load_invalid_format')
        return
      }

      this.patterns = data.map((item: any) => ({
        id: item.id,
        tools: item.tools,
        frequency: item.frequency || 0,
        label: item.label || '',
        voicePhrases: item.voicePhrases || [],
        description: item.description || '',
        confidence: item.confidence || 0,
        firstLearned: item.firstLearned || Date.now(),
        lastActive: item.lastActive || Date.now(),
        isActive: item.isActive !== false,
      }))

      log('INFO', 'behavior_learner_loaded', {
        patterns: this.patterns.length,
        active: this.patterns.filter((p) => p.isActive).length,
      })
    } catch (err) {
      log('WARN', 'behavior_learner_load_failed', { error: String(err) })
    }
  }

  // ==================== 查询接口 ====================

  /**
   * 获取当前所有学习到的模式。
   */
  getPatterns(): LearnedPattern[] {
    return [...this.patterns]
  }

  /**
   * 获取活跃的已注册模式。
   */
  getActivePatterns(): LearnedPattern[] {
    return this.patterns.filter((p) => p.isActive)
  }

  /**
   * 获取学习器统计数据。
   */
  getStats(): LearnerStats {
    const totalUnique = this.patterns.length
    const totalAnalyzed = this.patterns.reduce((s, p) => s + p.frequency, 0)
    return {
      totalSequencesAnalyzed: totalAnalyzed,
      uniqueSequences: totalUnique,
      activePatterns: this.patterns.filter((p) => p.isActive).length,
      registeredIntents: this.registeredIntentIds.size,
      lastLearnedAt: this.lastLearnedAt,
      refreshIntervalMs: this.refreshIntervalMs,
    }
  }

  /**
   * 手动触发一次学习/刷新。
   */
  learnNow(): LearnedPattern[] {
    return this.learn()
  }

  /**
   * 清除所有已学习模式和已注册意图。
   */
  reset(): void {
    // 清除注册的语音意图
    for (const id of this.registeredIntentIds) {
      unregisterDynamicIntent(id)
    }
    this.registeredIntentIds.clear()
    this.patterns = []
    this.lastLearnedAt = null

    // 清除持久化文件
    try {
      if (existsSync(PATTERNS_FILE)) {
        writeFileSync(PATTERNS_FILE, JSON.stringify([], null, 2), 'utf-8')
      }
    } catch {
      // 忽略
    }

    log('INFO', 'behavior_learner_reset')
  }

  // ==================== 内部辅助 ====================

  /**
   * 从全局钩子读取工具调用记录。
   */
  private getToolCallRecords(): Array<{ name: string; timestamp: number }> {
    const records = (globalThis as any).__behaviorToolRecords
    if (Array.isArray(records) && records.length > 0) {
      return records.slice(-this.learningWindow)
    }

    // 降级：返回空数组（学习将在有足够数据后自动触发）
    return []
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局单例，供进化管道和生命周期使用 */
export const behaviorSequenceLearner = new BehaviorSequenceLearner()
