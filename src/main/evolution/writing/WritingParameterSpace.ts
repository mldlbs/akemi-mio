/**
 * WritingParameterSpace — 改写参数空间定义
 *
 * 定义可调优的改写参数，以及参数的约束范围、默认值和推荐组合。
 * 由 WritingStrategyOptimizer 在每次循环中对比不同参数组合的效果，
 * 选出最优组合并持久化。
 */

import { log } from '../../logger/Logger'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'

// =============================================================================
// 参数定义
// =============================================================================

/** 单个可调优参数的定义 */
export interface ParameterDef<T = number> {
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
export interface ParameterSnapshot {
  timestamp: number
  values: Record<string, number | string>
  label: string
}

/** 参数组合评分记录 */
export interface ParameterScoreEntry {
  snapshot: ParameterSnapshot
  score: number
  dimensions: {
    coherence: number
    keywordCoverage: number
    structurePreservation: number
    dialoguePreservation: number
  }
  sampleSize: number
  timestamp: number
}

// =============================================================================
// 参数空间定义
// =============================================================================

/**
 * 改写参数空间单例
 *
 * 管理所有可调优改写参数，记录历史参数组合与评分的对应关系，
 * 支持自动选择最优组合。
 */
export class WritingParameterSpace {
  /** 参数定义列表 */
  private parameters: ParameterDef[] = []
  /** 历史评分记录 */
  private scoreHistory: ParameterScoreEntry[] = []
  /** 最大历史记录数 */
  private readonly maxHistory: number = 20
  /** 参数状态文件路径 */
  private stateFilePath: string = ''
  /** 当前参数组合标签 */
  private currentLabel: string = 'default'

  constructor(stateFilePath?: string) {
    this.stateFilePath = stateFilePath || ''
    this.initDefaults()
  }

  /** 初始化默认参数 */
  private initDefaults(): void {
    this.parameters = [
      {
        key: 'rewrite_intensity',
        label: '改写强度',
        type: 'float',
        description: '改写强度：0.3=保守(仅润色)，0.6=中等，1.0=大幅度重写',
        min: 0.3,
        max: 1.0,
        step: 0.1,
        defaultValue: 0.6,
        currentValue: 0.6,
      },
      {
        key: 'retrieval_frequency',
        label: '检索频率',
        type: 'int',
        description: '每章节检索背景资料的次数：1=最少，5=频繁检索',
        min: 1,
        max: 5,
        step: 1,
        defaultValue: 2,
        currentValue: 2,
      },
      {
        key: 'structure_preservation',
        label: '结构保留度',
        type: 'float',
        description: '保留原始章节结构的程度：0.3=自由重组，1.0=严格保持',
        min: 0.3,
        max: 1.0,
        step: 0.1,
        defaultValue: 0.7,
        currentValue: 0.7,
      },
      {
        key: 'keyword_weight',
        label: '关键词权重',
        type: 'float',
        description: '改写时优先保留/插入关键词的程度：0.0=不关注，1.0=严格覆盖',
        min: 0.0,
        max: 1.0,
        step: 0.1,
        defaultValue: 0.5,
        currentValue: 0.5,
      },
      {
        key: 'dialogue_preservation',
        label: '对话保留度',
        type: 'float',
        description: '保留原始对话细节的程度：0.0=可重写，1.0=严格保留',
        min: 0.0,
        max: 1.0,
        step: 0.1,
        defaultValue: 0.8,
        currentValue: 0.8,
      },
      {
        key: 'search_depth',
        label: '检索深度',
        type: 'enum',
        description: '背景资料检索的深度范围',
        enumValues: ['shallow', 'medium', 'deep'],
        defaultValue: 'medium',
        currentValue: 'medium',
      },
    ]
  }

  /** 获取所有参数定义 */
  getParameters(): ParameterDef[] {
    return this.parameters
  }

  /** 获取指定参数 */
  getParameter(key: string): ParameterDef | undefined {
    return this.parameters.find((p) => p.key === key)
  }

  /** 获取当前参数值的快照 */
  getCurrentSnapshot(): ParameterSnapshot {
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
      log('WARN', 'writing_param_not_found', { key })
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
    log('INFO', 'writing_param_set', { key, value: param.currentValue, label: this.currentLabel })
    return true
  }

  /** 批量设置参数 */
  applySnapshot(snapshot: ParameterSnapshot): void {
    for (const [key, value] of Object.entries(snapshot.values)) {
      this.setParameter(key, value)
    }
    this.currentLabel = snapshot.label
    log('INFO', 'writing_param_snapshot_applied', { label: snapshot.label })
  }

  /** 记录一次参数组合的评分 */
  recordScore(entry: ParameterScoreEntry): void {
    this.scoreHistory.push(entry)
    // 限制历史记录数
    if (this.scoreHistory.length > this.maxHistory) {
      this.scoreHistory = this.scoreHistory.slice(-this.maxHistory)
    }
    log('INFO', 'writing_param_score_recorded', {
      label: entry.snapshot.label,
      score: entry.score,
      dimensions: entry.dimensions,
    })
  }

  /** 获取历史评分记录 */
  getScoreHistory(): ParameterScoreEntry[] {
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
  recommendNext(): ParameterSnapshot {
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
  getBestEntry(): ParameterScoreEntry | null {
    if (this.scoreHistory.length === 0) return null
    // 按综合评分降序排列，样本量作为加权因子（样本量 >= 2 才可信）
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
  private generateExplorationCandidate(): ParameterSnapshot {
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
    const label = `explore_${Date.now().toString(36)}`
    return { timestamp: Date.now(), values, label }
  }

  /** 在指定参数组合附近做微调 */
  private mutateFrom(snapshot: ParameterSnapshot): ParameterSnapshot {
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
    const label = `mutate_${Date.now().toString(36)}`
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

  /** 将参数格式化为可读字符串（用于 LLM 提示注入） */
  formatForPrompt(): string {
    const lines: string[] = ['【当前改写参数配置】']
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

  /** 获取可用参数组合列表（用于循环测试） */
  getCandidateCombinations(): ParameterSnapshot[] {
    const candidates: ParameterSnapshot[] = []

    // 生成一些预定义的参数组合用于对比测试
    const presets: Array<{ label: string; overrides: Partial<Record<string, number | string>> }> = [
      { label: 'conservative', overrides: { rewrite_intensity: 0.4, retrieval_frequency: 2, structure_preservation: 0.9, keyword_weight: 0.3, dialogue_preservation: 0.9, search_depth: 'shallow' } },
      { label: 'balanced', overrides: { rewrite_intensity: 0.6, retrieval_frequency: 3, structure_preservation: 0.7, keyword_weight: 0.5, dialogue_preservation: 0.8, search_depth: 'medium' } },
      { label: 'aggressive', overrides: { rewrite_intensity: 0.9, retrieval_frequency: 5, structure_preservation: 0.4, keyword_weight: 0.8, dialogue_preservation: 0.4, search_depth: 'deep' } },
      { label: 'keyword_focus', overrides: { rewrite_intensity: 0.7, retrieval_frequency: 4, structure_preservation: 0.6, keyword_weight: 0.9, dialogue_preservation: 0.6, search_depth: 'deep' } },
      { label: 'structure_focus', overrides: { rewrite_intensity: 0.5, retrieval_frequency: 2, structure_preservation: 0.9, keyword_weight: 0.4, dialogue_preservation: 0.9, search_depth: 'medium' } },
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
  persist(filePath: string): void {
    try {
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(
        filePath,
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
      log('INFO', 'writing_param_persisted', { filePath })
    } catch (err: any) {
      log('WARN', 'writing_param_persist_failed', { error: String(err) })
    }
  }

  /**
   * 从 JSON 文件加载参数空间状态
   */
  load(filePath: string): void {
    try {
      if (!existsSync(filePath)) return
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
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
      log('INFO', 'writing_param_loaded', { filePath, label: this.currentLabel })
    } catch (err: any) {
      log('WARN', 'writing_param_load_failed', { error: String(err) })
    }
  }
}

/** 全局单例 */
export const writingParameterSpace = new WritingParameterSpace()
