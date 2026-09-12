/**
 * ParameterRegistry — 可调参数注册中心
 *
 * 集中管理所有可由自进化系统自动调优的系统参数。
 * 每个参数定义了安全边界（min/max）、步长和单次最大调整量。
 *
 * 设计原则：
 * - 所有参数值通过 clamp 限制在安全范围内
 * - 单次调整量受 maxDeltaPerAdjustment 约束
 * - 参数变更会创建快照，支持回滚
 *
 * 集成方式：
 * - 静态定义的默认参数列表
 * - 运行时可动态注册/注销参数
 * - 外部系统通过 getParameter() / getAll() 读取
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { TunableParameter, ParameterCategory } from './types'

// ═══════════════════════════════════════════════
//  默认可调参数列表
// ═══════════════════════════════════════════════

const DEFAULT_PARAMETERS: TunableParameter[] = [
  // ── Agent 行为参数 ──
  {
    key: 'agent.temperature',
    name: 'Agent 温度',
    description: 'LLM 回复的随机性/创造性。值越高回复越随机，越低越确定的。',
    currentValue: 0.7,
    min: 0.1,
    max: 1.0,
    step: 0.05,
    unit: '',
    category: 'agent',
    maxDeltaPerAdjustment: 0.15,
  },
  {
    key: 'agent.max_response_tokens',
    name: '最大回复长度',
    description: '单次 LLM 回复的最大 token 数。',
    currentValue: 2048,
    min: 512,
    max: 4096,
    step: 128,
    unit: 'tokens',
    category: 'agent',
    maxDeltaPerAdjustment: 512,
  },
  {
    key: 'agent.conversation_timeout_ms',
    name: '对话超时时间',
    description: '等待用户下一次输入的最大时间（毫秒），超时后对话自动结束。',
    currentValue: 300_000,
    min: 60_000,
    max: 600_000,
    step: 30_000,
    unit: 'ms',
    category: 'agent',
    maxDeltaPerAdjustment: 60_000,
  },

  // ── TTS 语音参数 ──
  {
    key: 'tts.speech_rate',
    name: 'TTS 语速',
    description: '语音合成速度倍率。值越高语速越快，越低越慢。',
    currentValue: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.1,
    unit: 'x',
    category: 'tts',
    maxDeltaPerAdjustment: 0.2,
  },
  {
    key: 'tts.pitch',
    name: 'TTS 音高',
    description: '语音合成音高偏移量。正值升高音高，负值降低音高。',
    currentValue: 0.0,
    min: -0.5,
    max: 0.5,
    step: 0.05,
    unit: '',
    category: 'tts',
    maxDeltaPerAdjustment: 0.1,
  },

  // ── 记忆系统参数 ──
  {
    key: 'memory.behavior_decay',
    name: '行为得分衰减率',
    description: '记忆行为得分每日衰减量。值越高低价值记忆消失越快。',
    currentValue: 0.015,
    min: 0.001,
    max: 0.1,
    step: 0.002,
    unit: '',
    category: 'memory',
    maxDeltaPerAdjustment: 0.01,
  },
  {
    key: 'memory.utility_decay',
    name: '效用每日衰减率',
    description: '记忆效用分数每日衰减率。值越高不常用记忆衰减越快。',
    currentValue: 0.02,
    min: 0.001,
    max: 0.1,
    step: 0.002,
    unit: '',
    category: 'memory',
    maxDeltaPerAdjustment: 0.01,
  },
  {
    key: 'memory.max_semi',
    name: '半永久层容量',
    description: '半永久记忆层最大条目数。超过此值会触发自动清理。',
    currentValue: 30,
    min: 10,
    max: 100,
    step: 5,
    unit: '条',
    category: 'memory',
    maxDeltaPerAdjustment: 10,
  },
  {
    key: 'memory.max_ephemeral',
    name: '临时层容量',
    description: '临时记忆层最大条目数。超过此值会触发自动清理。',
    currentValue: 50,
    min: 10,
    max: 200,
    step: 10,
    unit: '条',
    category: 'memory',
    maxDeltaPerAdjustment: 20,
  },

  // ── ASR 参数 ──
  {
    key: 'asr.hotword_freq_threshold',
    name: '热词频次阈值',
    description: '词汇出现次数≥此值视为热词，用于 ASR 识别增强。',
    currentValue: 2,
    min: 1,
    max: 10,
    step: 1,
    unit: '次',
    category: 'asr',
    maxDeltaPerAdjustment: 2,
  },
  {
    key: 'asr.hotword_max_count',
    name: '最大热词数量',
    description: '为避免过多热词降低其他词汇识别率而设置的上限。',
    currentValue: 15,
    min: 5,
    max: 30,
    step: 3,
    unit: '个',
    category: 'asr',
    maxDeltaPerAdjustment: 5,
  },

  // ── 工具系统参数 ──
  {
    key: 'tool.personalization_level',
    name: '工具个性化强度',
    description: '记忆驱动工具推荐的个性化强度（0=关闭, 1=保守, 2=平衡, 3=激进）。',
    currentValue: 1,
    min: 0,
    max: 3,
    step: 1,
    unit: '',
    category: 'tool',
    maxDeltaPerAdjustment: 1,
  },
  {
    key: 'tool.cache_ttl_ms',
    name: '工具缓存 TTL',
    description: '工具调用结果缓存的存活时间（毫秒）。',
    currentValue: 120_000,
    min: 10_000,
    max: 600_000,
    step: 10_000,
    unit: 'ms',
    category: 'tool',
    maxDeltaPerAdjustment: 60_000,
  },
]

// ═══════════════════════════════════════════════
//  ParameterRegistry
// ═══════════════════════════════════════════════

export class ParameterRegistry {
  private params = new Map<string, TunableParameter>()

  constructor() {
    // 注册默认参数
    for (const p of DEFAULT_PARAMETERS) {
      this.params.set(p.key, { ...p })
    }
  }

  /** 获取所有已注册参数 */
  getAll(): TunableParameter[] {
    return Array.from(this.params.values())
  }

  /** 按分类获取参数 */
  getByCategory(category: ParameterCategory): TunableParameter[] {
    return this.getAll().filter((p) => p.category === category)
  }

  /** 按 key 获取参数 */
  get(key: string): TunableParameter | undefined {
    return this.params.get(key)
  }

  /** 注册参数（如已存在则跳过） */
  register(param: TunableParameter): boolean {
    if (this.params.has(param.key)) {
      log('WARN', 'param_registry_already_registered', { key: param.key })
      return false
    }
    this.params.set(param.key, { ...param })
    log('INFO', 'param_registry_registered', { key: param.key, category: param.category })
    return true
  }

  /** 注销参数 */
  unregister(key: string): boolean {
    return this.params.delete(key)
  }

  /** 更新参数当前值（不创建快照，仅运行时更新） */
  updateCurrentValue(key: string, newValue: number): boolean {
    const param = this.params.get(key)
    if (!param) {
      log('WARN', 'param_registry_update_unknown', { key })
      return false
    }

    // clamp 到安全范围
    const clamped = Math.max(param.min, Math.min(param.max, newValue))
    if (clamped !== newValue) {
      log('WARN', 'param_registry_clamped', { key, original: newValue, clamped })
    }

    param.currentValue = clamped
    return true
  }

  /** 获取所有参数的当前值快照 */
  getSnapshotValues(): Record<string, number> {
    const values: Record<string, number> = {}
    for (const [key, param] of this.params) {
      values[key] = param.currentValue
    }
    return values
  }

  /** 批量恢复参数值（用于回滚） */
  restoreValues(values: Record<string, number>): number {
    let restoredCount = 0
    for (const [key, value] of Object.entries(values)) {
      const param = this.params.get(key)
      if (param) {
        const clamped = Math.max(param.min, Math.min(param.max, value))
        param.currentValue = clamped
        restoredCount++
      }
    }
    log('INFO', 'param_registry_restored', { count: restoredCount })
    return restoredCount
  }

  /** 获取参数总数 */
  get size(): number {
    return this.params.size
  }

  /** 重置为默认值 */
  resetToDefaults(): void {
    this.params.clear()
    for (const p of DEFAULT_PARAMETERS) {
      this.params.set(p.key, { ...p })
    }
    log('INFO', 'param_registry_reset_to_defaults', { count: this.params.size })
  }
}

/** 全局单例 */
export const parameterRegistry = new ParameterRegistry()
