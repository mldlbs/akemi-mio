/**
 * TtsConfigManager — TTS 配置文件管理器
 *
 * 职责：
 *   1. 管理持久化的 tts.config.json（存放在 evolution_workspace 中）
 *   2. 提供默认参数的读/写接口，供进化系统修改
 *   3. 记录每次进化调整的变更历史（version + timestamp + reason）
 *   4. 回滚到上一版本的能力
 *
 * 集成点：
 *   - TtsService 启动时读取配置作为默认参数
 *   - TtsConfigOptimizationExecutor 写入进化后的参数
 *   - VoicePreferenceModel 提供推荐参数来源
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import type { EmotionTtsParams } from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** TTS 配置文件路径 */
const TTS_CONFIG_DIR = join(WORKSPACE.evolution, 'tts_config')
const TTS_CONFIG_FILE = join(TTS_CONFIG_DIR, 'tts.config.json')

/** 默认出厂 TTS 参数（首次启动冷启动值） */
const FACTORY_DEFAULT_PARAMS: EmotionTtsParams = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+10%',
  pitch: '+8Hz',
  label: '出厂默认',
}

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** TTS 配置文件的持久化结构 */
export interface TtsPersistedConfig {
  /** 配置版本号（单调递增） */
  version: number
  /** 最后更新时间戳 */
  lastUpdated: number
  /** 当前生效的默认参数 */
  current: EmotionTtsParams
  /** 进化调整历史（最多保留 20 条） */
  history: TtsConfigChangeEntry[]
  /** 是否由进化系统管理 */
  evolutionManaged: boolean
  /** 进化实验启用/禁用 */
  experimentationEnabled: boolean
  /** 参数随机化幅度（百分比，0-50%） */
  randomizationMagnitude: number
}

/** 单次配置变更记录 */
export interface TtsConfigChangeEntry {
  /** 变更前的版本号 */
  version: number
  /** 变更时间戳 */
  timestamp: number
  /** 变更原因（如 "进化学习: 用户偏好 fast + high pitch"） */
  reason: string
  /** 变更前的参数 */
  previous: EmotionTtsParams
  /** 变更后的参数 */
  current: EmotionTtsParams
  /** 作出此推荐时的数据样本量 */
  sampleCount: number
  /** 推荐置信度 0-1 */
  confidence: number
}

// ══════════════════════════════════════════
//  TtsConfigManager
// ══════════════════════════════════════════

export class TtsConfigManager {
  /** 内存中的配置缓存 */
  private config: TtsPersistedConfig | null = null

  /** 初始化：确保目录存在，加载配置，必要时创建默认配置 */
  initialize(): void {
    if (!existsSync(TTS_CONFIG_DIR)) {
      mkdirSync(TTS_CONFIG_DIR, { recursive: true })
    }

    if (existsSync(TTS_CONFIG_FILE)) {
      this.loadFromDisk()
      log('INFO', 'tts_config_loaded', {
        version: this.config?.version,
        params: this.config?.current.label,
        evolutionManaged: this.config?.evolutionManaged,
      })
    } else {
      this.createDefaultConfig()
      log('INFO', 'tts_config_created_default', {
        params: FACTORY_DEFAULT_PARAMS.label,
      })
    }
  }

  /** 获取当前配置（惰性初始化） */
  getConfig(): TtsPersistedConfig {
    if (!this.config) {
      this.initialize()
    }
    return this.config!
  }

  /** 获取当前生效的默认 TTS 参数 */
  getDefaultParams(): EmotionTtsParams {
    const cfg = this.getConfig()
    return { ...cfg.current }
  }

  /**
   * 更新 TTS 默认参数（由进化执行器调用）。
   *
   * @param params 推荐的新参数
   * @param reason 变更原因描述
   * @param sampleCount 作出推荐时的样本量
   * @param confidence 推荐置信度
   */
  updateParams(
    params: EmotionTtsParams,
    reason: string,
    sampleCount: number,
    confidence: number,
  ): boolean {
    const cfg = this.getConfig()
    const previous = { ...cfg.current }

    // 如果参数相同则跳过
    if (previous.voice === params.voice && previous.rate === params.rate && previous.pitch === params.pitch) {
      log('INFO', 'tts_config_no_change_needed', { reason })
      return false
    }

    // 记录变更历史
    const entry: TtsConfigChangeEntry = {
      version: cfg.version,
      timestamp: Date.now(),
      reason,
      previous,
      current: { ...params },
      sampleCount,
      confidence,
    }

    cfg.history.push(entry)

    // 限制历史记录
    if (cfg.history.length > 20) {
      cfg.history = cfg.history.slice(-20)
    }

    // 更新当前参数
    cfg.version++
    cfg.lastUpdated = Date.now()
    cfg.current = { ...params }
    cfg.evolutionManaged = true

    // 持久化
    this.saveToDisk()

    log('INFO', 'tts_config_updated', {
      version: cfg.version,
      from: `${previous.voice} ${previous.rate}/${previous.pitch}`,
      to: `${params.voice} ${params.rate}/${params.pitch}`,
      reason,
      sampleCount,
      confidence: confidence.toFixed(2),
    })

    return true
  }

  /** 回滚到上一版本 */
  rollback(): { success: boolean; previousParams?: EmotionTtsParams } {
    const cfg = this.getConfig()

    if (cfg.history.length === 0) {
      log('WARN', 'tts_config_rollback_no_history')
      return { success: false }
    }

    // 找到上次变更的记录
    const lastEntry = cfg.history[cfg.history.length - 1]
    const rolledBack = { ...lastEntry.previous }

    // 从历史记录中移除
    cfg.history.pop()
    cfg.version++
    cfg.lastUpdated = Date.now()
    cfg.current = rolledBack

    this.saveToDisk()

    log('INFO', 'tts_config_rolled_back', {
      version: cfg.version,
      params: rolledBack.label,
    })

    return { success: true, previousParams: rolledBack }
  }

  /** 启用/禁用进化管理 */
  setEvolutionManaged(enabled: boolean): void {
    const cfg = this.getConfig()
    cfg.evolutionManaged = enabled
    this.saveToDisk()
    log('INFO', 'tts_config_evolution_managed', { enabled })
  }

  /** 启用/禁用参数实验 */
  setExperimentationEnabled(enabled: boolean): void {
    const cfg = this.getConfig()
    cfg.experimentationEnabled = enabled
    this.saveToDisk()
    log('INFO', 'tts_config_experimentation', { enabled })
  }

  /** 设置随机化幅度 */
  setRandomizationMagnitude(magnitude: number): void {
    const clamped = Math.max(0, Math.min(50, magnitude))
    const cfg = this.getConfig()
    cfg.randomizationMagnitude = clamped
    this.saveToDisk()
    log('INFO', 'tts_config_randomization_magnitude', { magnitude: clamped })
  }

  /** 获取变更历史 */
  getHistory(): TtsConfigChangeEntry[] {
    return [...this.getConfig().history]
  }

  /** 重置为出厂默认值（保留历史记录中的回滚点） */
  resetToFactory(): void {
    this.updateParams(
      { ...FACTORY_DEFAULT_PARAMS },
      '重置为出厂默认值',
      0,
      0,
    )
  }

  // ── 私有方法 ──

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(TTS_CONFIG_FILE, 'utf-8')
      this.config = JSON.parse(raw) as TtsPersistedConfig
    } catch (err: any) {
      log('ERROR', 'tts_config_load_error', { error: err.message })
      this.createDefaultConfig()
    }
  }

  private saveToDisk(): void {
    try {
      if (!this.config) return
      writeFileSync(TTS_CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err: any) {
      log('ERROR', 'tts_config_save_error', { error: err.message })
    }
  }

  private createDefaultConfig(): void {
    this.config = {
      version: 1,
      lastUpdated: Date.now(),
      current: { ...FACTORY_DEFAULT_PARAMS },
      history: [],
      evolutionManaged: false,
      experimentationEnabled: true,
      randomizationMagnitude: 15,
    }
    this.saveToDisk()
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const ttsConfigManager = new TtsConfigManager()
