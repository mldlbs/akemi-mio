/**
 * VoiceRoleTypes — 角色化多任务语音引擎类型定义
 *
 * 定义任务角色（VoiceRole）、任务类型（TaskRoleType）和角色方案（VoiceRoleScheme），
 * 使 Agent 能根据不同任务场景动态切换 PiperTTS 语音模型与参数。
 *
 * ── 三层概念 ──
 *
 * 1. VoiceRole（角色）：一个命名的语音角色配置。
 *    绑定 Piper 模型、语速、音调及 Edge-TTS 参数。
 *    例：{ id: 'gentle_female', name: '温柔女声', piperModel: 'zh_CN-ling_ling-medium', ... }
 *
 * 2. TaskRoleType（任务类型）：Agent 执行的各类任务场景标签。
 *    例：'reminder'（日程提醒）、'warning'（系统警告）、'entertainment'（娱乐播报）
 *
 * 3. VoiceRoleScheme（角色方案）：任务类型 → 角色 的映射集合。
 *    用户可切换不同方案来改变 Agent 在各任务场景下的语音表现。
 *    例：默认方案中将 reminder 映射到 gentle_female，
 *        「极客方案」中将 reminder 映射到 calm_male。
 *
 * ── 与现有系统的关系 ──
 *
 * - PiperOrchestrator: 使用角色解析出的 model/speed/pitch 进行合成
 * - TtsService: 接收角色 ID，在自动 TTS 中应用角色参数
 * - PiperTtsTool: Agent 显式调用时可指定 role_id
 * - TrayManager: 提供角色方案切换菜单
 * - ChatExecutor.applySentimentToTts(): 在其中融合角色参数
 */

import type { VoiceStyle } from './types'

// ══════════════════════════════════════════
//  任务角色类型
// ══════════════════════════════════════════

/**
 * 任务角色类型 — Agent 各类任务的场景标签。
 *
 * 每个标签对应一种典型交互场景，由 VoiceRoleScheme 映射到具体角色。
 * 扩展此类型时同步更新 DEFAULT_TASK_ROLE_DESCRIPTIONS。
 */
export type TaskRoleType =
  | 'reminder'       // 日程提醒、闹钟、定时通知
  | 'warning'        // 系统警告、错误通知、安全警报
  | 'notification'   // 普通通知、信息播报、状态更新
  | 'entertainment'  // 娱乐播报、趣味内容、故事朗读
  | 'teaching'       // 教学解释、知识讲解、技术指导
  | 'casual_chat'    // 日常闲聊、自由对话、陪伴
  | 'greeting'       // 问候、告别、日常寒暄
  | 'analysis'       // 数据分析、报告阅读、统计播报

/** 任务类型的人类可读描述 */
export const TASK_ROLE_DESCRIPTIONS: Record<TaskRoleType, string> = {
  reminder: '日程提醒 — 闹钟、定时通知、事件提醒',
  warning: '系统警告 — 错误通知、安全警报、异常提示',
  notification: '普通通知 — 信息播报、状态更新、推送消息',
  entertainment: '娱乐播报 — 趣味内容、故事朗读、创意分享',
  teaching: '教学解释 — 知识讲解、技术指导、步骤说明',
  casual_chat: '日常闲聊 — 自由对话、陪伴交流、轻松话题',
  greeting: '问候 — 早晚问候、告别、日常寒暄',
  analysis: '数据分析 — 报告阅读、统计播报、数据解读',
}

// ══════════════════════════════════════════
//  语音角色定义
// ══════════════════════════════════════════

/**
 * 语音角色配置 — 一个命名的角色，绑定完整的 TTS 参数。
 *
 * 包含 Edge-TTS（云端）和 Piper（本地）两套参数，
 * 无论 TTS 路由到哪个引擎都能保持角色一致性。
 */
export interface VoiceRole {
  /** 角色唯一标识（如 'gentle_female'） */
  id: string
  /** 人类可读的显示名（如 '温柔女声'） */
  name: string
  /** 角色描述 */
  description: string
  /** 语义风格标签 */
  voiceStyle: VoiceStyle

  // ── Edge-TTS 参数（云端路由时使用） ──
  /** Edge-TTS voice 名 */
  voice: string
  /** 语速 */
  rate: string
  /** 音调偏移 */
  pitch: string

  // ── Piper 参数（本地路由时使用） ──
  /** Piper 模型名 */
  piperModel: string
  /** Piper 语速因子 */
  piperSpeed: number
  /** Piper 音调因子 */
  piperPitch: number
}

/**
 * 预定义的语音角色目录。
 *
 * 用户可通过角色方案（VoiceRoleScheme）自定义各任务类型对应的角色。
 * 角色目录内置 5 个基础角色，覆盖主要音色类型：
 *
 * - gentle_female（温柔女声）: 适合提醒、安抚、关怀
 * - calm_male（沉稳男声）: 适合警告、通知、数据分析
 * - lively_child（活泼童声）: 适合娱乐、趣味内容
 * - warm_female（温暖女声）: 适合问候、日常闲聊
 * - professional_male（专业男声）: 适合教学、技术讲解
 */
export const BUILTIN_VOICE_ROLES: VoiceRole[] = [
  {
    id: 'gentle_female',
    name: '温柔女声',
    description: '轻柔温暖的女性声音，适合提醒、安抚、关怀场景',
    voiceStyle: 'gentle',
    // Edge-TTS
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-3%',
    pitch: '-2Hz',
    // Piper
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.85,
    piperPitch: 1.0,
  },
  {
    id: 'calm_male',
    name: '沉稳男声',
    description: '沉稳有力的男性声音，适合警告、通知、数据分析场景',
    voiceStyle: 'serious',
    // Edge-TTS
    voice: 'zh-CN-YunjianNeural',
    rate: '-5%',
    pitch: '-4Hz',
    // Piper
    piperModel: 'zh_CN-tx_mati-medium',
    piperSpeed: 1.0,
    piperPitch: 0.95,
  },
  {
    id: 'lively_child',
    name: '活泼童声',
    description: '活泼可爱的童声风格，适合娱乐播报、趣味内容场景',
    voiceStyle: 'playful',
    // Edge-TTS
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+20%',
    pitch: '+12Hz',
    // Piper
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.15,
    piperPitch: 1.1,
  },
  {
    id: 'warm_female',
    name: '温暖女声',
    description: '温暖亲切的女性声音，适合问候、日常闲聊场景',
    voiceStyle: 'warm',
    // Edge-TTS
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+8%',
    pitch: '+6Hz',
    // Piper
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 0.95,
    piperPitch: 1.05,
  },
  {
    id: 'professional_male',
    name: '专业男声',
    description: '清晰专业的男性声音，适合教学、技术讲解场景',
    voiceStyle: 'calm',
    // Edge-TTS
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    // Piper
    piperModel: 'zh_CN-tx_mati-medium',
    piperSpeed: 0.9,
    piperPitch: 1.0,
  },
]

/** 角色 ID → 角色 查找表 */
export const VOICE_ROLE_MAP: Record<string, VoiceRole> = Object.fromEntries(
  BUILTIN_VOICE_ROLES.map((r) => [r.id, r]),
)

// ══════════════════════════════════════════
//  角色方案
// ══════════════════════════════════════════

/**
 * 角色方案 — 任务类型到语音角色的映射集合。
 *
 * 用户可创建多套方案应对不同使用偏好，
 * 通过系统托盘或壁纸菜单实时切换。
 */
export interface VoiceRoleScheme {
  /** 方案唯一标识 */
  id: string
  /** 方案显示名 */
  name: string
  /** 方案描述 */
  description: string
  /** 各任务类型 → 角色 ID 的映射 */
  mappings: Partial<Record<TaskRoleType, string>>
}

/**
 * 默认方案 — 面向日常通用场景。
 *
 * 映射逻辑：
 * - 提醒 → 温柔女声（gentle_female）: 柔和提醒不打扰
 * - 警告 → 沉稳男声（calm_male）: 严肃有力，引起注意
 * - 通知 → 温暖女声（warm_female）: 亲切自然
 * - 娱乐 → 活泼童声（lively_child）: 生动有趣
 * - 教学 → 专业男声（professional_male）: 清晰专业
 * - 闲聊 → 温暖女声（warm_female）: 温暖陪伴
 * - 问候 → 温暖女声（warm_female）: 亲切问候
 * - 分析 → 沉稳男声（calm_male）: 冷静客观
 */
export const DEFAULT_VOICE_SCHEME: VoiceRoleScheme = {
  id: 'default',
  name: '默认方案',
  description: '面向日常通用场景的角色映射方案',
  mappings: {
    reminder: 'gentle_female',
    warning: 'calm_male',
    notification: 'warm_female',
    entertainment: 'lively_child',
    teaching: 'professional_male',
    casual_chat: 'warm_female',
    greeting: 'warm_female',
    analysis: 'calm_male',
  },
}

/**
 * 极客方案 — 面向开发者/技术用户。
 *
 * 所有技术相关任务使用沉稳男声，娱乐使用活泼童声。
 */
export const GEEK_VOICE_SCHEME: VoiceRoleScheme = {
  id: 'geek',
  name: '极客方案',
  description: '面向开发者的角色映射方案，技术场景使用沉稳男声',
  mappings: {
    reminder: 'calm_male',
    warning: 'calm_male',
    notification: 'calm_male',
    entertainment: 'lively_child',
    teaching: 'professional_male',
    casual_chat: 'warm_female',
    greeting: 'warm_female',
    analysis: 'professional_male',
  },
}

/**
 * 柔和方案 — 全场景使用温柔女声。
 */
export const GENTLE_VOICE_SCHEME: VoiceRoleScheme = {
  id: 'gentle',
  name: '柔和方案',
  description: '全场景使用温柔女声，安静舒适的听觉体验',
  mappings: {
    reminder: 'gentle_female',
    warning: 'gentle_female',
    notification: 'gentle_female',
    entertainment: 'gentle_female',
    teaching: 'gentle_female',
    casual_chat: 'gentle_female',
    greeting: 'gentle_female',
    analysis: 'gentle_female',
  },
}

/** 所有内置方案列表 */
export const BUILTIN_VOICE_SCHEMES: VoiceRoleScheme[] = [
  DEFAULT_VOICE_SCHEME,
  GEEK_VOICE_SCHEME,
  GENTLE_VOICE_SCHEME,
]

/** 默认方案 ID */
export const DEFAULT_SCHEME_ID = 'default'

// ══════════════════════════════════════════
//  事件类型
// ══════════════════════════════════════════

/** 角色方案切换事件载荷 */
export interface VoiceSchemeChangedEvent {
  /** 新方案 ID */
  schemeId: string
  /** 新方案名 */
  schemeName: string
  /** 变更后的完整映射表 */
  mappings: Partial<Record<TaskRoleType, string>>
  /** 变更时间戳 */
  timestamp: number
}

/** 角色方案相关 IPC 通道名 */
export const VOICE_ROLE_IPC_CHANNELS = {
  GET_SCHEMES: 'voice:role:schemes',
  SET_SCHEME: 'voice:role:setScheme',
  GET_ACTIVE_SCHEME: 'voice:role:activeScheme',
  GET_ROLES: 'voice:role:roles',
  GET_ROLE_FOR_TASK: 'voice:role:forTask',
} as const
