/**
 * RadarVoiceAlertTypes — 动态情感雷达语音预警类型定义
 *
 * 为「合并后的 telegram-bot」提供基于雷达数据的情感化 TTS 预警。
 *
 * ## 系统流
 *
 *   RadarPushScheduler.executePush()
 *       ↓ (已有文本推送)
 *   RadarVoiceAlertService.triggerVoiceAlert(signals, rule)
 *       ↓ urgency → PiperTTS prosody params
 *   PiperOrchestrator.synthesize({ model, speed, pitch })
 *       ↓ audio file
 *   TelegramService.sendVoice(chatId, audioFilePath)
 *       ↓ HTTP API
 *   Telegram Bot Proxy → /voice → Telegram User
 *
 * ## 情感参数映射
 *
 *   紧急度 (Urgency)  →  预警级别      →  Piper 模型          →  语速/音调
 *   hot               →  emergency    →  zh_CN-tx_mati-medium →  1.3x / 0.95
 *   warm              →  warning      →  zh_CN-huayan-medium  →  1.1x / 1.0
 *   cold              →  info         →  zh_CN-ling_ling-medium→ 0.85x / 0.95
 *
 * @module telegram/radar/RadarVoiceAlertTypes
 */

import type { SignalUrgency } from '../../startup-radar/types'

// ════════════════════════════════════════════════════════════════
// 语音预警级别
// ════════════════════════════════════════════════════════════════

/**
 * 语音预警级别 — 从 SignalUrgency 映射而来。
 *
 * - emergency: 紧急事件，需要立即注意（对应 hot）
 * - warning:   警示事件，建议关注（对应 warm）
 * - info:      普通信息，仅作告知（对应 cold）
 */
export type VoiceAlertLevel = 'emergency' | 'warning' | 'info'

/** SignalUrgency → VoiceAlertLevel 映射表 */
export const URGENCY_TO_ALERT_LEVEL: Record<SignalUrgency, VoiceAlertLevel> = {
  hot: 'emergency',
  warm: 'warning',
  cold: 'info',
}

// ════════════════════════════════════════════════════════════════
// PiperTTS 情感参数
// ════════════════════════════════════════════════════════════════

/**
 * 语音预警对应的 PiperTTS 合成参数。
 *
 * 通过 model/speed/pitch 的组合传递情感状态：
 * - emergency: 沉稳男声 + 快速 + 低沉音调 → 紧迫感
 * - warning:   通用女声 + 适中偏快 → 关注感
 * - info:      温柔女声 + 舒缓语速 → 平稳告知
 */
export interface VoiceAlertTtsParams {
  /** Piper 模型名 */
  piperModel: string
  /** 语速因子 (0.5–2.0)，紧急时加速，平稳时减速 */
  speed: number
  /** 音调因子，紧急时降低音调增强权威感 */
  pitch: number
  /** 人类可读描述 */
  description: string
}

/**
 * 预警级别 → PiperTTS 参数映射。
 *
 * 设计原则：
 * - 紧急（emergency）：使用沉稳男声 tx_mati，语速 1.3x 加快节奏，音调 0.95 降低
 *   以传递紧迫感但不刺耳
 * - 警示（warning）：使用通用女声 huayan，语速 1.1x 稍快，音调不变，传递关注感
 * - 信息（info）：使用温柔女声 ling_ling，语速 0.85x 舒缓，音调 0.95 柔和，
 *   配合低峰时段收听
 */
export const ALERT_LEVEL_TTS_MAP: Record<VoiceAlertLevel, VoiceAlertTtsParams> = {
  emergency: {
    piperModel: 'zh_CN-tx_mati-medium',
    speed: 1.3,
    pitch: 0.95,
    description: '紧急·沉稳加快',
  },
  warning: {
    piperModel: 'zh_CN-huayan-medium',
    speed: 1.1,
    pitch: 1.0,
    description: '警示·稍快关注',
  },
  info: {
    piperModel: 'zh_CN-ling_ling-medium',
    speed: 0.85,
    pitch: 0.95,
    description: '告知·舒缓平稳',
  },
}

// ════════════════════════════════════════════════════════════════
// 综合紧急度指标
// ════════════════════════════════════════════════════════════════

/**
 * 从雷达信号计算出的综合紧急度。
 *
 * 在 `compositeScore`（雷达系统已有）基础上叠加：
 * - 信号总量权重（量多则整体更紧急）
 * - hot 信号占比权重（高占比提升紧急感）
 * - 可扩展：未来可加入降雨强度、风速等外部指标
 */
export interface UrgencyMetrics {
  /** 综合紧急度分值 0–1 */
  score: number
  /** 对应的预警级别 */
  level: VoiceAlertLevel
  /** hot 信号占比 */
  hotRatio: number
  /** 信号总量 */
  signalCount: number
  /** 描述 */
  description: string
}

// ════════════════════════════════════════════════════════════════
// 用户语音预警偏好
// ════════════════════════════════════════════════════════════════

/**
 * 用户语音预警偏好 — 在对话中选择。
 *
 * 存储：
 * - preferredModel: 用户偏好的 Piper 模型名（覆盖预警级别默认映射）
 * - enabled: 是否启用语音预警（默认 true）
 * - minAlertLevel: 触发语音预警的最低级别（默认 'info' = 全部触发）
 * - quietHours: 静音时段（不触发语音）
 */
export interface VoiceAlertPreference {
  /** 偏好的 Piper 模型名（覆盖自动选择，可选） */
  preferredModel?: string
  /** 是否启用语音预警 */
  enabled: boolean
  /** 最低触发级别 */
  minAlertLevel: VoiceAlertLevel
  /** 静音时段开始 (0-23) */
  quietHourStart?: number
  /** 静音时段结束 (0-23) */
  quietHourEnd?: number
}

/** 默认语音预警偏好 */
export const DEFAULT_VOICE_ALERT_PREFERENCE: VoiceAlertPreference = {
  enabled: true,
  minAlertLevel: 'info',
}

// ════════════════════════════════════════════════════════════════
// 语音预警事件
// ════════════════════════════════════════════════════════════════

/**
 * 语音预警事件负载 — 通过 EventBus 传递。
 */
export interface VoiceAlertEvent {
  /** 触发规则的 ID */
  ruleId: string
  /** 触发规则的名称 */
  ruleName: string
  /** 信号数量 */
  signalCount: number
  /** 预警级别 */
  alertLevel: VoiceAlertLevel
  /** 合成的预警文本（已清理，适合语音朗读） */
  messageText: string
  /** 使用的 TTS 参数 */
  ttsParams: VoiceAlertTtsParams
  /** 触发时间戳 */
  timestamp: number
}

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** Piper 模型 — 紧急默认（沉稳男声） */
export const EMERGENCY_MODEL = 'zh_CN-tx_mati-medium'

/** Piper 模型 — 警示默认（通用女声） */
export const WARNING_MODEL = 'zh_CN-huayan-medium'

/** Piper 模型 — 信息默认（温柔女声） */
export const INFO_MODEL = 'zh_CN-ling_ling-medium'

/** 语音预警的 EventBus 事件名 */
export const VOICE_ALERT_EVENT = 'radar.push.voice_alert'
