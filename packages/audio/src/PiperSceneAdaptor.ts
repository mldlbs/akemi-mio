/**
 * PiperSceneAdaptor — 行为感知语音自适应模块
 *
 * ── 功能 ──
 *
 * 基于用户活动模式（窗口切换、键盘鼠标活动、系统时间等信号），
 * 动态调整 PiperTTS 语音参数（模型、语速、音调、音量）的核心模块。
 *
 * ── 与现有分类器的关系 ──
 *
 * 本模块不重新实现分类逻辑，而是读取现有分类器的信号做更细粒度的场景推导：
 *
 *   UserContextClassifier  ─→ work / leisure / rest（情境基线）
 *   BehaviorEmotionDetector → focused / anxious / calm / neutral（情绪维度）
 *   ContextualTtsAdvisor    → rapid / normal / low（交互节奏）
 *   活跃窗口信息            → 会议检测
 *
 * ── 场景推导层次 ──
 *
 * 从组合信号推导出最细粒度的 PiperScene：
 *   1. meeting（会议）:  窗口匹配 MEETING_PROCESS_PATTERNS
 *   2. focus（专注）:    BehaviorEmotion=focused + UserContext=work
 *   3. late_night（深夜）: DayPeriod=late_night
 *   4. work/leisure/rest: 直接映射 UserContextClassifier 结果
 *
 * ── 学习机制 ──
 *
 * 记录用户手动覆盖（setOverrideMode），统计各场景被手动选择的次数。
 * 当自动检测置信度低时，倾向用户历史偏好场景。
 * 学习数据持久化到本地 JSON。
 *
 * ── 集成点 ──
 *
 * - TtsService: 通过 setSceneAdaptor() 注入，合成时查询场景参数
 * - IPC handlers: 查询/设置覆盖模式、获取学习数据
 * - 所有数据本地缓存，不上传云端
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { userContextClassifier } from './UserContextClassifier'
import { behaviorEmotionDetector } from './BehaviorEmotionDetector'
import {
  type PiperScene,
  type PiperSceneConfig,
  type PiperSceneResult,
  type PiperSceneOverrideMode,
  type PiperSceneAdaptorConfig,
  type SceneOverrideRecord,
  PIPER_SCENE_MAP,
  DEFAULT_PIPER_SCENE_ADAPTOR_CONFIG,
  MEETING_PROCESS_PATTERNS,
} from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 场景结果缓存有效期（毫秒） */
const RESULT_CACHE_TTL_MS = 3000

/** 学习数据持久化文件名 */
const LEARNING_DATA_FILENAME = 'piper-scene-learning.json'

// ══════════════════════════════════════════
//  PiperSceneAdaptor
// ══════════════════════════════════════════

export class PiperSceneAdaptor {
  /** 当前配置 */
  private config: PiperSceneAdaptorConfig

  /** 手动覆盖的学习记录（scene → 统计） */
  private learningData = new Map<PiperScene, SceneOverrideRecord>()

  /** 最近一次场景结果（缓存去抖） */
  private lastResult: PiperSceneResult | null = null
  private lastResultTime = 0

  /** 去抖状态 */
  private stableScene: PiperScene | null = null
  private stableSince = 0

  /** 学习数据是否已加载 */
  private learningLoaded = false

  constructor(config?: Partial<PiperSceneAdaptorConfig>) {
    this.config = { ...DEFAULT_PIPER_SCENE_ADAPTOR_CONFIG, ...config }
  }

  // ════════════════════════════════════════
  //  配置管理
  // ════════════════════════════════════════

  /** 更新配置 */
  updateConfig(partial: Partial<PiperSceneAdaptorConfig>): void {
    this.config = { ...this.config, ...partial }
    if (partial.learningDataPath) {
      // 路径变化时重新加载
      this.learningLoaded = false
      this.loadLearningData()
    }
    log('INFO', 'piper_scene_adaptor_config_updated', {
      enabled: this.config.enabled,
      overrideMode: this.config.overrideMode,
      learningEnabled: this.config.learningEnabled,
    })
  }

  /** 获取当前配置 */
  getConfig(): PiperSceneAdaptorConfig {
    return { ...this.config }
  }

  // ════════════════════════════════════════
  //  覆盖模式管理
  // ════════════════════════════════════════

  /**
   * 设置手动覆盖模式。
   *
   * 当用户从 auto 切换到某个手动场景时，记录此次覆盖行为用于学习。
   * 覆盖模式可以随时切换回 auto 恢复自动检测。
   */
  setOverrideMode(mode: PiperSceneOverrideMode): void {
    const prev = this.config.overrideMode
    if (prev === mode) return

    this.config.overrideMode = mode

    // 记录手动覆盖行为（仅从 auto 切换到特定场景时记录）
    if (prev === 'auto' && mode !== 'auto') {
      this.recordOverride(mode as PiperScene)
    }

    // 切换覆盖模式时重置缓存，确保立即生效
    this.lastResult = null
    this.lastResultTime = 0
    this.stableScene = null
    this.stableSince = 0

    log('INFO', 'piper_scene_override', {
      from: prev,
      to: mode,
      isLearningRecorded: prev === 'auto' && mode !== 'auto',
    })
  }

  /** 获取当前覆盖模式 */
  getOverrideMode(): PiperSceneOverrideMode {
    return this.config.overrideMode
  }

  // ════════════════════════════════════════
  //  核心 API：获取场景自适应参数
  // ════════════════════════════════════════

  /**
   * 获取当前场景自适应的 PiperTTS 参数。
   *
   * 如果已禁用或覆盖模式为 auto 但尚未初始化，返回基于 UserContext 的默认值。
   *
   * @returns 场景自适应结果（场景、Piper 配置、置信度、描述）
   */
  getAdaptedConfig(): PiperSceneResult {
    // ── 禁用状态：回退到默认 leisure 配置 ──
    if (!this.config.enabled) {
      return this.buildResult('leisure', 0, '场景自适应已禁用', false)
    }

    // ── 手动覆盖模式 ──
    if (this.config.overrideMode !== 'auto') {
      const scene = this.config.overrideMode as PiperScene
      const config = PIPER_SCENE_MAP[scene]
      return {
        scene,
        config: { ...config },
        confidence: 1.0,
        description: `手动·${config.label}`,
        isManualOverride: true,
      }
    }

    // ── 缓存（3秒内有效） ──
    const now = Date.now()
    if (this.lastResult && now - this.lastResultTime < RESULT_CACHE_TTL_MS) {
      return this.lastResult
    }

    // ── 执行场景检测 ──
    const rawResult = this.detectScene()
    const debounced = this.applyDebounce(rawResult)

    // ── 应用学习偏好 ──
    const finalResult = this.applyLearningPreference(debounced)

    this.lastResult = finalResult
    this.lastResultTime = now
    return finalResult
  }

  /**
   * 强制刷新场景检测（忽略缓存）。
   */
  refresh(): PiperSceneResult {
    this.lastResult = null
    this.lastResultTime = 0
    return this.getAdaptedConfig()
  }

  // ════════════════════════════════════════
  //  场景检测（核心逻辑）
  // ════════════════════════════════════════

  /**
   * 从现有分类器信号推导最细粒度的 PiperScene。
   *
   * 检测优先级（高 → 低）：
   *   1. 会议场景：活跃窗口匹配 MEETING_PROCESS_PATTERNS
   *   2. 专注场景：BehaviorEmotion=focused + UserContext=work
   *   3. 深夜场景：DayPeriod=late_night
   *   4. 工作/休闲/休息：直接映射 UserContextClassifier 结果
   */
  private detectScene(): PiperSceneResult {
    // ── 读取现有分类器信号 ──
    const contextResult = userContextClassifier.getClassification()
    const emotionResult = behaviorEmotionDetector.getEmotion()
    const windowInfo = userContextClassifier.getLastActiveWindow()

    // ── 规则 1：会议检测 ──
    if (windowInfo) {
      const combined = `${windowInfo.processName} ${windowInfo.title}`.toLowerCase()
      if (this.isMeetingWindow(combined)) {
        const conf = Math.min(0.8, 0.55 + this.countPatternMatches(combined, MEETING_PROCESS_PATTERNS) * 0.1)
        return this.buildResult('meeting', conf, `会议应用: ${windowInfo.processName}`, false)
      }
    }

    // ── 规则 2：专注检测 ──
    // BehaviorEmotion=focused + UserContext=work + 高置信度 → focus 场景
    if (emotionResult.emotion === 'focused' && emotionResult.confidence > 0.4 && contextResult.context === 'work') {
      const confidence = Math.min(0.85, emotionResult.confidence * 0.7 + contextResult.confidence * 0.3)
      return this.buildResult('focus', confidence, '专注工作', false)
    }

    // ── 规则 3：深夜检测 ──
    if (contextResult.indicators.dayPeriod === 'late_night') {
      return this.buildResult('late_night', 0.7, '深夜时段·自动', false)
    }

    // ── 规则 4：映射 UserContextClassifier 结果 ──
    switch (contextResult.context) {
      case 'work':
        return this.buildResult('work', contextResult.confidence, contextResult.description, false)
      case 'leisure':
        return this.buildResult('leisure', contextResult.confidence, contextResult.description, false)
      case 'rest':
        return this.buildResult('rest', contextResult.confidence, contextResult.description, false)
      default:
        return this.buildResult('leisure', 0.3, '默认·休闲', false)
    }
  }

  /**
   * 检查窗口信息是否匹配会议应用模式。
   */
  private isMeetingWindow(combined: string): boolean {
    return this.countPatternMatches(combined, MEETING_PROCESS_PATTERNS) > 0
  }

  /**
   * 计算文本匹配给定模式列表的数量。
   */
  private countPatternMatches(text: string, patterns: RegExp[]): number {
    let count = 0
    for (const p of patterns) {
      p.lastIndex = 0
      if (p.test(text)) count++
    }
    return count
  }

  // ════════════════════════════════════════
  //  去抖机制
  // ════════════════════════════════════════

  /**
   * 应用去抖逻辑：场景必须持续一段时间才切换，防止频繁抖动。
   */
  private applyDebounce(raw: PiperSceneResult): PiperSceneResult {
    const now = Date.now()
    const debounceMs = this.config.debounceSec * 1000

    if (this.stableScene === raw.scene) {
      // 同场景持续中
      this.stableSince = this.stableSince || now

      // 去抖期已过 → 允许
      if (now - this.stableSince >= debounceMs) {
        return raw
      }

      // 高置信度可提前通过去抖
      if (raw.confidence >= 0.7) {
        return raw
      }

      // 仍在去抖中 → 返回上一次结果（如果有）
      if (this.lastResult) {
        return {
          ...this.lastResult,
          confidence: raw.confidence * 0.8,
          description: `去抖·${raw.description}`,
        }
      }

      return raw
    }

    // 场景变化：记录新场景起始时间
    this.stableScene = raw.scene
    this.stableSince = now

    // 高置信度直接切换
    if (raw.confidence >= 0.65) {
      return raw
    }

    // 低置信度切换 → 保留上次结果
    if (this.lastResult && this.lastResult.scene !== raw.scene) {
      return {
        ...this.lastResult,
        confidence: raw.confidence * 0.5,
        description: `过渡·${raw.description}`,
      }
    }

    return raw
  }

  // ════════════════════════════════════════
  //  学习机制
  // ════════════════════════════════════════

  /**
   * 记录一次手动覆盖行为。
   * 当用户从 auto 切换到特定场景时调用。
   */
  recordOverride(scene: PiperScene): void {
    if (!this.config.learningEnabled) return

    const existing = this.learningData.get(scene) || {
      scene,
      count: 0,
      lastOverride: 0,
    }

    existing.count++
    existing.lastOverride = Date.now()
    this.learningData.set(scene, existing)

    log('INFO', 'piper_scene_learning_recorded', {
      scene,
      totalCount: existing.count,
    })

    // 异步持久化
    this.saveLearningData()
  }

  /**
   * 应用学习偏好：当检测结果置信度低时，倾向用户历史偏好的场景。
   *
   * 如果当前检测到的场景置信度低于阈值，且用户历史上多次覆盖到另一个场景，
   * 则提升备选场景的置信度。
   */
  private applyLearningPreference(result: PiperSceneResult): PiperSceneResult {
    if (!this.config.learningEnabled) return result
    if (result.isManualOverride) return result
    if (result.confidence >= 0.7) return result // 高置信度无需修正

    // 找出用户最偏好的场景
    let mostPreferredScene: PiperScene | null = null
    let mostPreferredCount = 0

    for (const [scene, record] of this.learningData) {
      if (record.count > mostPreferredCount) {
        mostPreferredCount = record.count
        mostPreferredScene = scene
      }
    }

    // 没有学习数据或偏好计数不足
    if (!mostPreferredScene || mostPreferredCount < this.config.minRecordsForLearning) {
      return result
    }

    // 如果当前结果与用户偏好不同，提升偏好场景
    if (mostPreferredScene !== result.scene) {
      const preferredConfig = PIPER_SCENE_MAP[mostPreferredScene]
      return {
        scene: mostPreferredScene,
        config: { ...preferredConfig },
        confidence: Math.max(result.confidence, 0.5),
        description: `${result.description}·学习偏好`,
        isManualOverride: false,
      }
    }

    return result
  }

  /**
   * 获取学习数据的只读快照。
   */
  getLearningData(): SceneOverrideRecord[] {
    return Array.from(this.learningData.values()).sort((a, b) => b.count - a.count)
  }

  /**
   * 重置学习数据。
   */
  resetLearningData(): void {
    this.learningData.clear()
    this.saveLearningData()
    log('INFO', 'piper_scene_learning_reset')
  }

  // ════════════════════════════════════════
  //  持久化
  // ════════════════════════════════════════

  /**
   * 从本地 JSON 文件加载学习数据。
   */
  private loadLearningData(): void {
    if (this.learningLoaded) return

    const filePath = this.getLearningDataPath()
    if (!filePath) return

    try {
      const { existsSync, readFileSync } = require('fs')
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8')
        const records: SceneOverrideRecord[] = JSON.parse(raw)
        this.learningData.clear()
        for (const r of records) {
          if (this.isValidScene(r.scene)) {
            this.learningData.set(r.scene as PiperScene, r)
          }
        }
        log('INFO', 'piper_scene_learning_loaded', {
          count: this.learningData.size,
          path: filePath,
        })
      }
    } catch (err) {
      log('WARN', 'piper_scene_learning_load_failed', {
        error: String(err),
        path: this.getLearningDataPath(),
      })
    }

    this.learningLoaded = true
  }

  /**
   * 将学习数据持久化到本地 JSON 文件。
   */
  private saveLearningData(): void {
    const filePath = this.getLearningDataPath()
    if (!filePath) return

    try {
      const { writeFileSync, mkdirSync, existsSync } = require('fs')
      const { dirname } = require('path')

      // 确保目录存在
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const records = Array.from(this.learningData.values())
      writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'piper_scene_learning_save_failed', {
        error: String(err),
        path: this.getLearningDataPath(),
      })
    }
  }

  /**
   * 获取学习数据持久化路径。
   * 优先级：配置路径 > userData 目录下的默认路径。
   */
  private getLearningDataPath(): string {
    if (this.config.learningDataPath) {
      return this.config.learningDataPath
    }
    // 尝试从 electron app 获取 userData
    try {
      const { app } = require('electron')
      const { join } = require('path')
      const path = join(app.getPath('userData'), LEARNING_DATA_FILENAME)
      this.config.learningDataPath = path
      return path
    } catch {
      return ''
    }
  }

  /**
   * 验证场景字符串是否是有效的 PiperScene。
   */
  private isValidScene(scene: string): boolean {
    const validScenes: PiperScene[] = ['focus', 'meeting', 'late_night', 'work', 'leisure', 'rest']
    return validScenes.includes(scene as PiperScene)
  }

  // ════════════════════════════════════════
  //  工具方法
  // ════════════════════════════════════════

  /** 构建场景结果 */
  private buildResult(scene: PiperScene, confidence: number, description: string, isManualOverride: boolean): PiperSceneResult {
    const config = PIPER_SCENE_MAP[scene]
    return {
      scene,
      config: { ...config },
      confidence: Math.min(1, Math.max(0, confidence)),
      description,
      isManualOverride,
    }
  }

  /** 获取当前场景结果的摘要信息 */
  getStatus(): {
    enabled: boolean
    overrideMode: PiperSceneOverrideMode
    currentScene: PiperScene | null
    learningRecords: number
  } {
    return {
      enabled: this.config.enabled,
      overrideMode: this.config.overrideMode,
      currentScene: this.lastResult?.scene ?? null,
      learningRecords: this.learningData.size,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 由 TtsService 在初始化时引用，用于在每次 TTS 合成前查询场景自适应参数。
 * 也可以在 IPC handler 中通过此单例读取/覆盖场景模式。
 */
export const piperSceneAdaptor = new PiperSceneAdaptor()
