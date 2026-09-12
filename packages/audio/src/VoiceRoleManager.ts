/**
 * VoiceRoleManager — 角色化多任务语音引擎管理器
 *
 * ── 职责 ──
 *
 * 1. 管理预定义的语音角色（VoiceRole）目录
 * 2. 管理角色方案（VoiceRoleScheme），支持实时切换
 * 3. 根据任务类型解析应使用的角色和 TTS 参数
 * 4. 方案切换时自动预加载对应的 Piper 模型
 * 5. 通知系统各组件角色方案变更事件
 *
 * ── 与现有系统的关系 ──
 *
 * - PiperOrchestrator: 预加载角色对应的模型，加速首次合成
 * - TtsPiperBridge: 根据角色 ID 构建合成请求（model/speed/pitch）
 * - TtsService: 接收角色解析后的 EmotionTtsParams（云端路由时使用）
 * - PiperTtsTool: MCP 工具层查询角色/切换方案
 * - TrayManager: 系统托盘切换角色方案
 * - ChatExecutor: 在 applySentimentToTts() 中融合角色参数
 *
 * ── 使用示例 ──
 *
 * ```ts
 * import { voiceRoleManager } from './VoiceRoleManager'
 *
 * // 获取当前角色的 TTS 参数
 * const params = voiceRoleManager.getTtsParamsForTask('reminder')
 * ttsService.setEmotion(params)
 *
 * // 切换方案（自动预加载）
 * await voiceRoleManager.setActiveScheme('geek')
 *
 * // Agent 显式指定角色
 * const roleId = voiceRoleManager.getRoleIdForTask('warning')
 * ```
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { piperOrchestrator } from './PiperOrchestrator'
import type { VoiceRole, VoiceRoleScheme, TaskRoleType, VoiceSchemeChangedEvent } from './VoiceRoleTypes'
import { BUILTIN_VOICE_ROLES, BUILTIN_VOICE_SCHEMES, DEFAULT_SCHEME_ID, VOICE_ROLE_MAP } from './VoiceRoleTypes'
import type { EmotionTtsParams } from './types'

// ══════════════════════════════════════════
//  事件名
// ══════════════════════════════════════════

/** 角色方案变更事件名 — 系统各组件通过 EventBus 订阅 */
export const VOICE_SCHEME_CHANGED = 'voice:scheme:changed'

// ══════════════════════════════════════════
//  VoiceRoleManager
// ══════════════════════════════════════════

export class VoiceRoleManager {
  /** 当前活跃角色方案 */
  private activeScheme: VoiceRoleScheme

  /** 已预热缓存的 Piper 模型集合（model name → true） */
  private preloadedModels = new Set<string>()

  /** 角色方案变更时的回调列表 */
  private onChangeCallbacks: Array<(scheme: VoiceRoleScheme) => void> = []

  /** 是否已初始化 */
  private initialized = false

  constructor() {
    // 默认使用默认方案（回退到第一个方案）
    this.activeScheme = BUILTIN_VOICE_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID) ?? BUILTIN_VOICE_SCHEMES[0]
  }

  // ════════════════════════════════════════
  //  初始化
  // ════════════════════════════════════════

  /**
   * 初始化管理器。
   * 在启动时调用，主动预加载当前方案涉及的所有 Piper 模型。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    log('INFO', 'voice_role_manager_init', {
      scheme: this.activeScheme.name,
      roleCount: BUILTIN_VOICE_ROLES.length,
    })

    // 预加载当前方案涉及的模型
    await this.preloadSchemeModels(this.activeScheme)
  }

  // ════════════════════════════════════════
  //  角色查询
  // ════════════════════════════════════════

  /** 获取所有可用角色 */
  getRoles(): VoiceRole[] {
    return [...BUILTIN_VOICE_ROLES]
  }

  /** 根据角色 ID 获取角色定义 */
  getRole(roleId: string): VoiceRole | undefined {
    return VOICE_ROLE_MAP[roleId]
  }

  /** 获取所有可用方案 */
  getSchemes(): VoiceRoleScheme[] {
    return [...BUILTIN_VOICE_SCHEMES]
  }

  /** 获取当前活跃方案 */
  getActiveScheme(): VoiceRoleScheme {
    return { ...this.activeScheme }
  }

  // ════════════════════════════════════════
  //  根据任务类型解析角色
  // ════════════════════════════════════════

  /**
   * 获取指定任务类型应使用的角色 ID。
   *
   * 解析链：
   * 1. 当前方案中该任务类型的映射
   * 2. 默认方案中该任务类型的映射
   * 3. 回退到第一个可用角色
   */
  getRoleIdForTask(taskType: TaskRoleType): string {
    // 1. 当前方案
    const roleId = this.activeScheme.mappings[taskType]
    if (roleId && VOICE_ROLE_MAP[roleId]) return roleId

    // 2. 默认方案
    const defaultScheme = BUILTIN_VOICE_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)
    if (defaultScheme) {
      const defaultRoleId = defaultScheme.mappings[taskType]
      if (defaultRoleId && VOICE_ROLE_MAP[defaultRoleId]) return defaultRoleId
    }

    // 3. 回退
    return BUILTIN_VOICE_ROLES[0]?.id ?? 'gentle_female'
  }

  /**
   * 获取指定任务类型对应的完整角色配置。
   */
  getRoleForTask(taskType: TaskRoleType): VoiceRole | undefined {
    const roleId = this.getRoleIdForTask(taskType)
    return VOICE_ROLE_MAP[roleId]
  }

  /**
   * 获取指定任务类型的 TTS 参数（供 TtsService 云端路由时使用）。
   *
   * 将角色配置转换为 EmotionTtsParams 格式，
   * 与 TtsService.setEmotion() 的输入兼容。
   */
  getTtsParamsForTask(taskType: TaskRoleType): EmotionTtsParams {
    const role = this.getRoleForTask(taskType)
    if (!role) {
      return {
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+10%',
        pitch: '+8Hz',
        label: '角色·默认',
      }
    }

    return {
      voice: role.voice,
      rate: role.rate,
      pitch: role.pitch,
      label: `角色·${role.name}`,
    }
  }

  /**
   * 获取指定任务类型的 Piper 合成参数。
   * 供 TtsPiperBridge 构建 PiperSynthesizeRequest 时使用。
   */
  getPiperParamsForTask(taskType: TaskRoleType): {
    model: string
    speed: number
    pitch: number
  } {
    const role = this.getRoleForTask(taskType)
    if (!role) {
      return { model: 'zh_CN-huayan-medium', speed: 1.0, pitch: 1.0 }
    }

    return {
      model: role.piperModel,
      speed: role.piperSpeed,
      pitch: role.piperPitch,
    }
  }

  // ════════════════════════════════════════
  //  方案切换
  // ════════════════════════════════════════

  /**
   * 切换到指定角色方案。
   *
   * 步骤：
   * 1. 验证方案是否存在
   * 2. 预加载新方案涉及的 Piper 模型
   * 3. 更新当前活跃方案
   * 4. 通过 EventBus 广播变更事件
   * 5. 调用注册的回调
   *
   * @param schemeId 方案 ID
   * @returns 是否切换成功
   */
  async setActiveScheme(schemeId: string): Promise<{ success: boolean; message: string }> {
    const scheme = BUILTIN_VOICE_SCHEMES.find((s) => s.id === schemeId)
    if (!scheme) {
      return {
        success: false,
        message: `无效的方案 ID: ${schemeId}。可用方案: ${BUILTIN_VOICE_SCHEMES.map((s) => s.id).join(', ')}`,
      }
    }

    if (this.activeScheme.id === schemeId) {
      return { success: true, message: `已是 "${scheme.name}"` }
    }

    const prevScheme = this.activeScheme.id

    // 预加载新方案的模型
    await this.preloadSchemeModels(scheme)

    // 更新活跃方案
    this.activeScheme = scheme

    log('INFO', 'voice_role_scheme_switched', {
      from: prevScheme,
      to: schemeId,
      schemeName: scheme.name,
    })

    // 广播变更事件
    const event: VoiceSchemeChangedEvent = {
      schemeId: scheme.id,
      schemeName: scheme.name,
      mappings: { ...scheme.mappings },
      timestamp: Date.now(),
    }
    eventBus.emit(VOICE_SCHEME_CHANGED as any, event)

    // 通知注册的回调
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(scheme)
      } catch (err) {
        log('WARN', 'voice_role_change_callback_error', { error: String(err) })
      }
    }

    return { success: true, message: `已切换为 "${scheme.name}"` }
  }

  /**
   * 注册角色方案变更回调。
   * 当方案切换时，所有注册的回调会被依次调用。
   */
  onSchemeChange(callback: (scheme: VoiceRoleScheme) => void): () => void {
    this.onChangeCallbacks.push(callback)
    return () => {
      const idx = this.onChangeCallbacks.indexOf(callback)
      if (idx >= 0) this.onChangeCallbacks.splice(idx, 1)
    }
  }

  // ════════════════════════════════════════
  //  Agent 绑定：LLM 完成回复后，根据回复类别自动分配角色
  // ════════════════════════════════════════

  /**
   * 根据 ReplyCategory 推荐对应的 TaskRoleType。
   *
   * 将 ChatExecutor 中现有的 ReplyCategory 映射到 TaskRoleType，
   * 使情节自适应系统能自动选择合适的角色。
   */
  categoryToTaskType(category: string): TaskRoleType {
    switch (category) {
      case 'notification':
        return 'notification'
      case 'teaching':
        return 'teaching'
      case 'casual_chat':
        return 'casual_chat'
      case 'success':
        return 'notification'
      case 'error':
        return 'warning'
      case 'greeting':
        return 'greeting'
      case 'analysis':
        return 'analysis'
      case 'creative':
        return 'entertainment'
      default:
        return 'casual_chat'
    }
  }

  // ════════════════════════════════════════
  //  模型预加载
  // ════════════════════════════════════════

  /**
   * 预加载一个方案涉及的所有 Piper 模型。
   *
   * 方案切换和初始化时调用，通过提前触发模型加载
   * 减少首次合成时的切换延迟。
   *
   * PiperOrchestrator 不支持进程内缓存，但通过提前调用
   * synthesizeWithModel 预热模型文件所在目录的 OS 缓存，
   * 并确保模型路径有效，减少后续合成的冷启动延迟。
   *
   * @param scheme 要预加载的方案
   */
  private async preloadSchemeModels(scheme: VoiceRoleScheme): Promise<void> {
    const modelsToLoad = new Set<string>()

    // 收集方案中所有角色使用的 Piper 模型
    for (const roleId of Object.values(scheme.mappings)) {
      if (!roleId) continue
      const role = VOICE_ROLE_MAP[roleId]
      if (role && !this.preloadedModels.has(role.piperModel)) {
        modelsToLoad.add(role.piperModel)
      }
    }

    if (modelsToLoad.size === 0) return

    log('INFO', 'voice_role_preload_models', {
      count: modelsToLoad.size,
      models: Array.from(modelsToLoad),
    })

    // 通过 PiperOrchestrator 预热模型
    for (const model of modelsToLoad) {
      try {
        await piperOrchestrator.warmupModel(model)
        this.preloadedModels.add(model)
        log('DEBUG', 'voice_role_model_warmed', { model })
      } catch (err) {
        // 预热失败不阻止切换，用户首次使用时会有冷启动延迟
        log('WARN', 'voice_role_model_warmup_failed', {
          model,
          error: String(err),
        })
      }
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const voiceRoleManager = new VoiceRoleManager()
