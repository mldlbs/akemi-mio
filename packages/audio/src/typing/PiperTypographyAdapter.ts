/**
 * PiperTypographyAdapter — PiperTTS 算法在排版处理场景的兼容适配层
 *
 * 功能：
 * 1. 提取 PiperTTS 核心算法（PiperOrchestrator.synthesize）的输入输出接口模式
 * 2. 为「工业颂歌公众号排版处理」上下文实现格式转换适配
 * 3. 排版参数（TypographyParameters）↔ PiperTTS 参数（PiperSynthesizeRequest）自动映射
 * 4. 平台标签（公众号/知乎/小红书）→ 语音模型智能选择
 *
 * 适配方向：
 *   TypographyInput（排版参数 + 平台标签 + 文本）
 *     → toPiperRequest()   [输入格式转换]
 *     → PiperOrchestrator.synthesize()   [核心算法：队列调度 / 模型选择 / 自动回退]
 *     → toTypographyOutput()   [输出格式转换]
 *     → TypographySynthesisOutput（排版友好结果）
 *
 * 设计原则：
 * - 不改动 PiperOrchestrator 核心算法代码
 * - 适配层仅做输入输出格式映射，不参与算法逻辑
 * - 映射策略集中管理（平台→模型、排版参数→语速微调），便于扩展
 * - 全局单例模式，与 PiperOrchestrator 同步
 *
 * 集成关系：
 * - PiperTypographyAdapter → PiperOrchestrator（调用关系，适配层消费核心算法）
 * - TypographyVerificationService → PiperTypographyAdapter（替换原来的直接调用）
 * - TtsTypographyFeedbackLoop ↔ PiperTypographyAdapter（反馈回路可共用映射配置）
 */

import { piperOrchestrator, type PiperSynthesizeRequest, type PiperSynthesizeResult } from '@akemi-mio/audio/PiperOrchestrator'
import type { TypographyParameters } from '@akemi-mio/creativity/TypographyMemoryManager'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════════════════════════
//  适配层专属类型定义
// ══════════════════════════════════════════════════════════════

/** 排版合成输入 — 排版系统传入的参数格式 */
export interface TypographySynthesisInput {
  /** 排版后的文本（可含格式标记） */
  text: string
  /** 平台标签：公众号 / 知乎 / 小红书 等 */
  platformTag: string
  /** 排版参数（可选，用于映射语速/音调微调） */
  typographyParams?: Partial<TypographyParameters>
  /** 内容类别：影响 Piper 任务标签选择 */
  contentCategory?: 'article' | 'notification' | 'dialogue'
  /** 故事/文章 ID（日志追踪用） */
  storyId?: string
}

/** 排版合成输出 — 适配层返回给排版系统的结果格式 */
export interface TypographySynthesisOutput {
  /** 是否合成成功 */
  success: boolean
  /** 音频文件路径（成功时） */
  audioFile?: string
  /** 合成耗时毫秒 */
  durationMs: number
  /** 实际使用的语音模型 */
  model: string
  /** 实际使用的语速因子 */
  speed: number
  /** 实际使用的音调因子 */
  pitch: number
  /** 错误信息（失败时） */
  error?: string
  /** 是否触发了模型回退 */
  fallbackUsed: boolean
  /** 适配层映射信息（用于日志/调试/决策追踪） */
  mappingInfo: {
    platformTag: string
    recommendedModel: string
    recommendedSpeed: number
    recommendedPitch: number
    resolvedModel: string
  }
}

/** 平台语音配置 — 单个平台到 Piper 参数的完整映射 */
export interface PlatformVoiceConfig {
  model: string
  speed: number
  pitch: number
  taskTag: 'chat' | 'story' | 'alert'
  description: string
}

// ══════════════════════════════════════════════════════════════
//  映射策略表
// ══════════════════════════════════════════════════════════════

/**
 * 平台标签 → Piper 语音模型映射表。
 *
 * 映射逻辑（复用了 PiperOrchestrator 中 taskTag→model 的映射模式，
 * 但以平台为中心重新组织映射维度）：
 * - 公众号 → ling_ling（温柔女声，高表现力，适合长文朗读）
 * - 知乎 → huayan（通用女声，平实清晰）
 * - 小红书 → huayan（通用女声，略高音调，保持活力）
 *
 * 扩展方式：新增平台时只需添加条目，无需修改算法逻辑。
 */
const PLATFORM_VOICE_MAP: Record<string, PlatformVoiceConfig> = {
  公众号: {
    model: 'zh_CN-ling_ling-medium',
    speed: 0.9,
    pitch: 1.0,
    taskTag: 'story',
    description: '温柔女声，适合公众号文章朗读',
  },
  知乎: {
    model: 'zh_CN-huayan-medium',
    speed: 1.0,
    pitch: 1.0,
    taskTag: 'story',
    description: '通用女声，适合知乎文章朗读',
  },
  小红书: {
    model: 'zh_CN-huayan-medium',
    speed: 1.0,
    pitch: 1.05,
    taskTag: 'chat',
    description: '活力女声，适合小红书笔记朗读',
  },
}

/** 默认平台配置（未知平台时的回退） */
const DEFAULT_PLATFORM_CONFIG: PlatformVoiceConfig = {
  model: 'zh_CN-huayan-medium',
  speed: 1.0,
  pitch: 1.0,
  taskTag: 'story',
  description: '默认语音模型',
}

/**
 * 排版参数 → 语速微调系数。
 *
 * 排版参数中的语义信息可转换为 TTS 参数中的表现力调节：
 * - sentenceDensity: 段落密度越高语速可稍快，越低则稍慢（给听众思考空间）
 * - emphasisStyle: 背景高亮的内容往往需要稍慢的语速来突出
 */
const TYPOGRAPHY_SPEED_ADJUSTMENTS: Record<string, Record<string, number>> = {
  sentenceDensity: {
    dense: 0.05,
    normal: 0,
    sparse: -0.1,
  },
  emphasisStyle: {
    bold: 0,
    color_mark: 0,
    bg_mark: -0.05,
    none: 0,
  },
}

/**
 * 内容类别 → Piper 任务标签映射。
 *
 * 复用了 PiperTTS 的 taskTag 概念（chat/story/alert），
 * 但以排版内容类别为入口重新组织映射关系。
 */
const CONTENT_CATEGORY_TASK_TAG: Record<string, 'chat' | 'story' | 'alert'> = {
  article: 'story',
  notification: 'alert',
  dialogue: 'chat',
}

const DEFAULT_TASK_TAG: 'chat' | 'story' | 'alert' = 'story'

// ══════════════════════════════════════════════════════════════
//  核心适配器
// ══════════════════════════════════════════════════════════════

export class PiperTypographyAdapter {
  /**
   * 适配层主入口：以排版上下文输入调用 PiperTTS 核心算法，返回排版友好结果。
   *
   * 三步流程：
   * 1. toPiperRequest — 输入转换（Typography → PiperTTS 参数映射）
   * 2. piperOrchestrator.synthesize — 核心算法（队列调度 / 模型选择 / 自动回退）
   * 3. toTypographyOutput — 输出转换（PiperTTS → Typography 结果包装）
   *
   * @param input 排版合成输入
   * @returns 排版合成输出
   */
  async synthesize(input: TypographySynthesisInput): Promise<TypographySynthesisOutput> {
    const t0 = Date.now()

    // 1. 输入转换：Typography → PiperTTS
    const piperRequest = this.toPiperRequest(input)
    const resolvedSpeed = piperRequest.speed ?? this.resolveSpeed(input)
    const resolvedPitch = piperRequest.pitch ?? this.resolvePitch(input)

    log('INFO', 'piper_typography_adapter_calling', {
      platformTag: input.platformTag,
      storyId: input.storyId,
      text_len: input.text.length,
      model: piperRequest.model,
      speed: resolvedSpeed,
      pitch: resolvedPitch,
      taskTag: piperRequest.taskTag,
    })

    // 2. 核心算法调用（复用 PiperOrchestrator 的队列调度/模型选择/自动回退逻辑）
    //    适配层不修改算法内部逻辑，仅通过格式转换接入。
    const piperResult = await piperOrchestrator.synthesize(piperRequest)

    // 3. 输出转换：PiperTTS → Typography
    const output = this.toTypographyOutput(piperResult, input, resolvedSpeed, resolvedPitch, t0)

    log('INFO', 'piper_typography_adapter_done', {
      platformTag: input.platformTag,
      success: output.success,
      model: output.model,
      fallback: output.fallbackUsed,
      durationMs: output.durationMs,
      speed: output.speed,
      pitch: output.pitch,
    })

    return output
  }

  // ── 输入转换 ──

  /**
   * 将排版上下文输入转换为 PiperTTS 引擎能够处理的请求格式。
   *
   * 转换规则：
   * - platformTag → 推荐语音模型
   * - typographyParams → 语速/音调微调
   * - contentCategory → 任务标签（chat/story/alert）
   */
  toPiperRequest(input: TypographySynthesisInput): PiperSynthesizeRequest {
    const config = this.resolvePlatformConfig(input.platformTag)
    const speed = this.resolveSpeed(input)
    const pitch = this.resolvePitch(input)
    const taskTag = this.resolveTaskTag(input)

    return {
      text: input.text,
      model: config.model,
      speed,
      pitch,
      taskTag,
    }
  }

  // ── 输出转换 ──

  /**
   * 将 PiperTTS 合成结果包装为排版系统可消费的输出格式。
   *
   * 除了传递 PiperOrchestrator 返回的原始字段外，
   * 附加适配层的映射信息（mappingInfo）使调用方能追踪：
   * - 平台推荐的模型与最终使用的模型是否一致（回退检测）
   * - 推荐参数与实际参数的差异
   */
  private toTypographyOutput(
    result: PiperSynthesizeResult,
    input: TypographySynthesisInput,
    resolvedSpeed: number,
    resolvedPitch: number,
    startTime: number,
  ): TypographySynthesisOutput {
    const config = this.resolvePlatformConfig(input.platformTag)

    return {
      success: result.success,
      audioFile: result.audioFile,
      durationMs: result.durationMs,
      model: result.model,
      speed: resolvedSpeed,
      pitch: resolvedPitch,
      error: result.error,
      fallbackUsed: result.fallbackUsed,
      mappingInfo: {
        platformTag: input.platformTag,
        recommendedModel: config.model,
        recommendedSpeed: config.speed,
        recommendedPitch: config.pitch,
        resolvedModel: result.model,
      },
    }
  }

  // ── 映射解析 ──

  /**
   * 解析平台语音配置。
   * 已知平台返回对应配置，未知平台回退到默认配置。
   */
  private resolvePlatformConfig(platformTag: string): PlatformVoiceConfig {
    return PLATFORM_VOICE_MAP[platformTag] ?? DEFAULT_PLATFORM_CONFIG
  }

  /**
   * 根据排版参数和平台推荐解析语速。
   *
   * 基础值来自平台推荐，排版参数做微调：
   * - 稀疏段落（sentenceDensity=sparse）→ 语速微降 10%
   * - 背景高亮（emphasisStyle=bg_mark）→ 语速微降 5%
   * - 密集段落（sentenceDensity=dense）→ 语速微升 5%
   *
   * 输出钳制在 [0.5, 2.0] 范围内，与 PiperOrchestrator 的验证逻辑一致。
   */
  private resolveSpeed(input: TypographySynthesisInput): number {
    const config = this.resolvePlatformConfig(input.platformTag)
    let speed = config.speed

    if (input.typographyParams) {
      for (const [paramKey, adjustmentMap] of Object.entries(TYPOGRAPHY_SPEED_ADJUSTMENTS)) {
        const paramValue = (input.typographyParams as Record<string, any>)[paramKey]
        if (paramValue && adjustmentMap[String(paramValue)] !== undefined) {
          speed += adjustmentMap[String(paramValue)]
        }
      }
    }

    return Math.max(0.5, Math.min(2.0, speed))
  }

  /**
   * 解析音调因子。
   * 当前基于平台推荐值，后续可扩展根据排版参数微调。
   */
  private resolvePitch(input: TypographySynthesisInput): number {
    const config = this.resolvePlatformConfig(input.platformTag)
    return config.pitch
  }

  /**
   * 内容类别 → Piper 任务标签映射。
   */
  private resolveTaskTag(input: TypographySynthesisInput): 'chat' | 'story' | 'alert' {
    const category = input.contentCategory
    if (category && CONTENT_CATEGORY_TASK_TAG[category]) {
      return CONTENT_CATEGORY_TASK_TAG[category]
    }
    return DEFAULT_TASK_TAG
  }

  // ── 查询接口 ──

  /**
   * 获取指定平台的推荐语音配置（不执行合成，仅查询映射）。
   * 供 TypographyMemoryManager 或外部决策者使用。
   */
  getRecommendedConfig(platformTag: string): PlatformVoiceConfig {
    return { ...this.resolvePlatformConfig(platformTag) }
  }

  /**
   * 获取所有已知平台的语音配置列表。
   * 供 UI 展示或配置管理使用。
   */
  getAllPlatformConfigs(): Array<{
    platformTag: string
    config: PlatformVoiceConfig
  }> {
    return Object.entries(PLATFORM_VOICE_MAP).map(([platformTag, config]) => ({
      platformTag,
      config: { ...config },
    }))
  }
}

// ══════════════════════════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════════════════════════

/** 全局单例 */
export const piperTypographyAdapter = new PiperTypographyAdapter()
