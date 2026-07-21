/**
 * BlogWorkflowConfig — 博客工作流可调参数空间
 *
 * 定义可自优化的博客工作流参数，包括发布平台优先级、最佳发布时间、
 * 内容格式偏好等。遵循 WritingParameterSpace 的 epsilon-greedy 模式。
 *
 * 由 BlogOptimizationExecutor 在每次 Evolution 循环中调整参数组合，
 * 基于 BlogAnalyticsTracker 的历史效果数据驱动优化。
 *
 * 工作流：
 *   1. 初始使用默认参数组合
 *   2. BlogOptimizationCollector 采集效果数据
 *   3. BlogOptimizationExecutor 推荐并应用新参数组合
 *   4. 效果提升的参数组合被保留，下降的回退
 *   5. 参数状态持久化到 JSON，重启不丢失
 */

import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

// =============================================================================
// 类型定义
// =============================================================================

/** 单个可调优参数的定义 */
export interface BlogParameterDef<T = number | string> {
  /** 参数唯一标识 */
  key: string
  /** 可读名称 */
  label: string
  /** 参数类型 */
  type: 'float' | 'int' | 'enum'
  /** 参数描述 */
  description: string
  /** 最小值（float/int） */
  min?: number
  /** 最大值（float/int） */
  max?: number
  /** 步长（float/int） */
  step?: number
  /** 枚举值列表（enum 类型） */
  enumValues?: T[]
  /** 默认值 */
  defaultValue: T
  /** 当前值（运行时可修改） */
  currentValue: T
}

/** 完整的参数空间快照 */
export interface BlogParameterSnapshot {
  timestamp: number
  values: Record<string, number | string>
  label: string
}

/** 参数组合评分记录 */
export interface BlogParameterScoreEntry {
  snapshot: BlogParameterSnapshot
  score: number
  dimensions: {
    engagementRate: number
    avgViews: number
    postCount: number
  }
  sampleSize: number
  timestamp: number
}

// =============================================================================
// 参数空间默认配置路径
// =============================================================================

const DEFAULT_STATE_FILE = join(WORKSPACE.evolution, 'blog_optimization', 'workflow_params.json')
const DEFAULT_MAX_HISTORY = 20

// =============================================================================
// BlogWorkflowConfig
// =============================================================================

export class BlogWorkflowConfig {
  /** 参数定义列表 */
  private parameters: BlogParameterDef[] = []
  /** 历史评分记录 */
  private scoreHistory: BlogParameterScoreEntry[] = []
  /** 最大历史记录数 */
  private readonly maxHistory: number
  /** 参数状态文件路径 */
  private stateFilePath: string = ''
  /** 当前参数组合标签 */
  private currentLabel: string = 'default'

  constructor(stateFilePath?: string, maxHistory?: number) {
    this.stateFilePath = stateFilePath || DEFAULT_STATE_FILE
    this.maxHistory = maxHistory || DEFAULT_MAX_HISTORY
    this.initDefaults()
  }

  /** 初始化默认参数 */
  private initDefaults(): void {
    this.parameters = [
      {
        key: 'platform_priority',
        label: '发布平台优先级',
        type: 'enum',
        description: '优先发布的目标平台，影响分发策略',
        enumValues: ['csdn', 'zhihu', 'juejin', 'cnblogs', 'wechat', 'generic'],
        defaultValue: 'generic',
        currentValue: 'generic',
      },
      {
        key: 'publish_hour',
        label: '最佳发布时段',
        type: 'int',
        description: '最佳发布小时（0-23），数据驱动优化',
        min: 0,
        max: 23,
        step: 1,
        defaultValue: 20,
        currentValue: 20,
      },
      {
        key: 'publish_day',
        label: '最佳发布日',
        type: 'int',
        description: '最佳发布日（1=周一，7=周日），数据驱动优化',
        min: 1,
        max: 7,
        step: 1,
        defaultValue: 3,
        currentValue: 3,
      },
      {
        key: 'content_style',
        label: '内容风格偏好',
        type: 'enum',
        description: '内容格式/风格偏好，包括标题风格、段落结构等',
        enumValues: ['tutorial', 'opinion', 'news', 'review', 'story', 'mixed'],
        defaultValue: 'mixed',
        currentValue: 'mixed',
      },
      {
        key: 'content_length_target',
        label: '目标文章长度',
        type: 'int',
        description: '目标文章字数，影响内容规划',
        min: 500,
        max: 8000,
        step: 500,
        defaultValue: 2000,
        currentValue: 2000,
      },
      {
        key: 'engagement_focus',
        label: '互动导向',
        type: 'float',
        description: '0.0=纯阅读导向，1.0=纯互动导向。影响话题选择和内容设计',
        min: 0.0,
        max: 1.0,
        step: 0.1,
        defaultValue: 0.5,
        currentValue: 0.5,
      },
    ]
  }

  /** 获取所有参数定义 */
  getParameters(): BlogParameterDef[] {
    return this.parameters
  }

  /** 获取指定参数 */
  getParameter(key: string): BlogParameterDef | undefined {
    return this.parameters.find((p) => p.key === key)
  }

  /** 获取当前参数值的快照 */
  getCurrentSnapshot(): BlogParameterSnapshot {
    const values: Record<string, number | string> = {}
    for (const p of this.parameters) {
      values[p.key] = p.currentValue
    }
    return {
      timestamp: Date.now(),
      values,
      label: this.currentLabel,
    }
  }

  /** 设置当前参数值 */
  setParameter(key: string, value: number | string): boolean {
    const param = this.parameters.find((p) => p.key === key)
    if (!param) {
      log('WARN', 'blog_param_not_found', { key })
      return false
    }
    // 校验范围
    if (param.type === 'float' || param.type === 'int') {
      if (typeof value !== 'number') return false
      if (param.min !== undefined && value < param.min) return false
      if (param.max !== undefined && value > param.max) return false
      // 校验步长
      if (param.step && param.step > 0) {
        const stepped = Math.round((value - (param.min ?? 0)) / param.step) * param.step + (param.min ?? 0)
        param.currentValue = Math.round(stepped * 10) / 10
      } else {
        param.currentValue = value
      }
    } else if (param.type === 'enum') {
      if (!param.enumValues?.includes(value as any)) return false
      param.currentValue = value
    }
    log('INFO', 'blog_param_set', { key, value: param.currentValue, label: this.currentLabel })
    return true
  }

  /** 批量设置参数 */
  applySnapshot(snapshot: BlogParameterSnapshot): void {
    for (const [key, value] of Object.entries(snapshot.values)) {
      this.setParameter(key, value)
    }
    this.currentLabel = snapshot.label
    log('INFO', 'blog_param_snapshot_applied', { label: snapshot.label })
  }

  /** 记录一次参数组合的评分 */
  recordScore(entry: BlogParameterScoreEntry): void {
    this.scoreHistory.push(entry)
    // 限制历史记录数
    if (this.scoreHistory.length > this.maxHistory) {
      this.scoreHistory = this.scoreHistory.slice(-this.maxHistory)
    }
    log('INFO', 'blog_param_score_recorded', {
      label: entry.snapshot.label,
      score: entry.score,
      dimensions: entry.dimensions,
    })
  }

  /** 获取历史评分记录 */
  getScoreHistory(): BlogParameterScoreEntry[] {
    return this.scoreHistory
  }

  /**
   * 推荐下一组待测试的参数组合
   *
   * 策略：
   * 1. 如果历史记录不足 3 条，生成随机探索组合
   * 2. 如果有足够历史，选择评分最高的参数组合附近做局部搜索
   * 3. 定期引入随机扰动避免局部最优
   */
  recommendNext(): BlogParameterSnapshot {
    const history = this.scoreHistory

    // 探索模式：历史不足，随机生成一组参数
    if (history.length < 3) {
      return this.generateExplorationCandidate()
    }

    // 利用模式：选择当前最高分组合，在其附近做微调
    const bestEntry = this.getBestEntry()
    if (bestEntry) {
      // 70% 概率在最优附近微调，30% 概率随机探索
      if (Math.random() < 0.7) {
        return this.mutateFrom(bestEntry.snapshot)
      }
    }

    return this.generateExplorationCandidate()
  }

  /**
   * 获取最优参数组合
   * 综合评分最高的参数组合，附带采样量加权
   */
  getBestEntry(): BlogParameterScoreEntry | null {
    if (this.scoreHistory.length === 0) return null
    // 按综合评分降序排列，样本量作为加权因子
    const weighted = this.scoreHistory
      .filter((e) => e.sampleSize >= 1)
      .sort((a, b) => {
        const aWeighted = a.score * Math.min(a.sampleSize / 2, 1)
        const bWeighted = b.score * Math.min(b.sampleSize / 2, 1)
        return bWeighted - aWeighted
      })
    return weighted[0] || null
  }

  /** 生成随机探索参数组合 */
  private generateExplorationCandidate(): BlogParameterSnapshot {
    const values: Record<string, number | string> = {}
    for (const p of this.parameters) {
      if (p.type === 'float' && p.min !== undefined && p.max !== undefined && p.step !== undefined) {
        const steps = Math.round((p.max - p.min) / p.step)
        const randStep = Math.floor(Math.random() * (steps + 1))
        values[p.key] = Math.round((p.min + randStep * p.step) * 10) / 10
      } else if (p.type === 'int' && p.min !== undefined && p.max !== undefined) {
        values[p.key] = Math.floor(Math.random() * (p.max - p.min + 1)) + p.min
      } else if (p.type === 'enum' && p.enumValues) {
        values[p.key] = p.enumValues[Math.floor(Math.random() * p.enumValues.length)]
      } else {
        values[p.key] = p.defaultValue
      }
    }
    const label = `blog_explore_${Date.now().toString(36)}`
    return { timestamp: Date.now(), values, label }
  }

  /** 在指定参数组合附近做微调 */
  private mutateFrom(snapshot: BlogParameterSnapshot): BlogParameterSnapshot {
    const values: Record<string, number | string> = { ...snapshot.values }
    // 随机选 1-2 个参数做微调
    const keys = Object.keys(values)
    const mutateCount = Math.min(2, Math.max(1, Math.floor(Math.random() * keys.length)))
    const shuffled = [...keys].sort(() => Math.random() - 0.5)
    for (let i = 0; i < mutateCount; i++) {
      const key = shuffled[i]
      const param = this.parameters.find((p) => p.key === key)
      if (!param) continue
      if (param.type === 'float' && param.step && param.min !== undefined && param.max !== undefined) {
        const current = values[key] as number
        const delta = (Math.random() < 0.5 ? -1 : 1) * param.step
        values[key] = Math.round(Math.min(param.max, Math.max(param.min, current + delta)) * 10) / 10
      } else if (param.type === 'int' && param.min !== undefined && param.max !== undefined) {
        const current = values[key] as number
        const delta = Math.random() < 0.5 ? -1 : 1
        values[key] = Math.min(param.max, Math.max(param.min, current + delta))
      } else if (param.type === 'enum' && param.enumValues) {
        const current = values[key] as string
        const idx = param.enumValues.indexOf(current)
        if (idx >= 0) {
          const newIdx = (idx + (Math.random() < 0.5 ? -1 : 1) + param.enumValues.length) % param.enumValues.length
          values[key] = param.enumValues[newIdx]
        }
      }
    }
    const label = `blog_mutate_${Date.now().toString(36)}`
    return { timestamp: Date.now(), values, label }
  }

  /** 设置当前参数组合标签 */
  setLabel(label: string): void {
    this.currentLabel = label
  }

  /** 获取当前标签 */
  getLabel(): string {
    return this.currentLabel
  }

  /** 将参数格式化为可读字符串 */
  formatForPrompt(): string {
    const lines: string[] = ['【当前博客工作流参数配置】']
    for (const p of this.parameters) {
      lines.push(`  - ${p.label}(${p.key}): ${p.currentValue}  # ${p.description}`)
    }
    const best = this.getBestEntry()
    if (best) {
      lines.push('')
      lines.push(`【历史最优参数配置】(评分: ${best.score.toFixed(1)})`)
      for (const [key, value] of Object.entries(best.snapshot.values)) {
        const param = this.parameters.find((p) => p.key === key)
        if (param) {
          lines.push(`  - ${param.label}: ${value}`)
        }
      }
    }
    return lines.join('\n')
  }

  /** 获取可用参数组合列表 */
  getCandidateCombinations(): BlogParameterSnapshot[] {
    const candidates: BlogParameterSnapshot[] = []

    const presets: Array<{ label: string; overrides: Partial<Record<string, number | string>> }> = [
      { label: 'default', overrides: { platform_priority: 'generic', publish_hour: 20, publish_day: 3, content_style: 'mixed', content_length_target: 2000, engagement_focus: 0.5 } },
      { label: 'csdn_focus', overrides: { platform_priority: 'csdn', publish_hour: 9, publish_day: 2, content_style: 'tutorial', content_length_target: 3000, engagement_focus: 0.3 } },
      { label: 'zhihu_focus', overrides: { platform_priority: 'zhihu', publish_hour: 20, publish_day: 4, content_style: 'opinion', content_length_target: 2500, engagement_focus: 0.7 } },
      { label: 'juejin_focus', overrides: { platform_priority: 'juejin', publish_hour: 10, publish_day: 3, content_style: 'tutorial', content_length_target: 2000, engagement_focus: 0.6 } },
      { label: 'wechat_focus', overrides: { platform_priority: 'wechat', publish_hour: 21, publish_day: 1, content_style: 'story', content_length_target: 1500, engagement_focus: 0.8 } },
      { label: 'evening', overrides: { platform_priority: 'generic', publish_hour: 21, publish_day: 5, content_style: 'mixed', content_length_target: 2000, engagement_focus: 0.5 } },
      { label: 'morning', overrides: { platform_priority: 'generic', publish_hour: 8, publish_day: 3, content_style: 'news', content_length_target: 1500, engagement_focus: 0.4 } },
      { label: 'long_form', overrides: { platform_priority: 'csdn', publish_hour: 10, publish_day: 2, content_style: 'tutorial', content_length_target: 5000, engagement_focus: 0.3 } },
      { label: 'short_form', overrides: { platform_priority: 'juejin', publish_hour: 12, publish_day: 4, content_style: 'review', content_length_target: 1000, engagement_focus: 0.6 } },
    ]

    for (const preset of presets) {
      const values: Record<string, number | string> = {}
      for (const p of this.parameters) {
        values[p.key] = (preset.overrides as any)[p.key] ?? p.defaultValue
      }
      candidates.push({ timestamp: Date.now(), values, label: preset.label })
    }

    return candidates
  }

  /**
   * 持久化当前参数空间状态到 JSON 文件
   */
  persist(filePath?: string): void {
    const fp = filePath || this.stateFilePath
    try {
      const dir = dirname(fp)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(
        fp,
        JSON.stringify(
          {
            parameters: this.parameters.map((p) => ({
              key: p.key,
              currentValue: p.currentValue,
              defaultValue: p.defaultValue,
            })),
            currentLabel: this.currentLabel,
            scoreHistory: this.scoreHistory,
            persistedAt: Date.now(),
          },
          null,
          2,
        ),
        'utf-8',
      )
      log('INFO', 'blog_param_persisted', { filePath: fp })
    } catch (err: any) {
      log('WARN', 'blog_param_persist_failed', { error: String(err) })
    }
  }

  /**
   * 从 JSON 文件加载参数空间状态
   */
  load(filePath?: string): void {
    const fp = filePath || this.stateFilePath
    try {
      if (!existsSync(fp)) return
      const data = JSON.parse(readFileSync(fp, 'utf-8'))
      if (data.parameters) {
        for (const saved of data.parameters) {
          const param = this.parameters.find((p) => p.key === saved.key)
          if (param) {
            param.currentValue = saved.currentValue
          }
        }
      }
      if (data.currentLabel) this.currentLabel = data.currentLabel
      if (data.scoreHistory) this.scoreHistory = data.scoreHistory
      log('INFO', 'blog_param_loaded', { filePath: fp, label: this.currentLabel })
    } catch (err: any) {
      log('WARN', 'blog_param_load_failed', { error: String(err) })
    }
  }
}

/** 全局单例 */
export const blogWorkflowConfig = new BlogWorkflowConfig()
