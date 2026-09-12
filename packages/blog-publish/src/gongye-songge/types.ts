/**
 * Plan:工业颂歌 公众号排版处理 — 类型定义
 *
 * 工业颂歌 作为 Agent 的上层增强层，拦截其输入输出
 * 进行预处理/后处理增强，通过 feature flag 控制开放范围。
 *
 * 设计原则（遵循 UserBehaviorLayer 模式）：
 * 1. 不侵入 Agent 核心逻辑
 * 2. 通过环境变量 GONGYE_SONGE_FEATURES 控制特性
 * 3. 预处理/后处理钩子可独立注册
 *
 * 【模式抽取】
 * 通用类型和函数已迁移到 core/patterns：
 * - parseFeaturesFromEnv → core/patterns 的统一实现
 */

import { parseFeaturesFromEnv as coreParseFeaturesFromEnv } from '@akemi-mio/core/core/patterns'

// ════════════════════════════════════════════════════════════════
// Feature Flag 配置
// ════════════════════════════════════════════════════════════════

/**
 * 工业颂歌功能开关（环境变量驱动）
 *
 * GONGYE_SONGE_FEATURES — 逗号分隔的启用特性列表
 * 示例: "content_format,style_inject,publish_ready"
 *
 * 所有特性默认关闭，仅在显式声明后激活。
 */
export type GongyeSonggeFeature =
  /** 对 Agent 输出进行公众号排版格式化 */
  | 'content_format'
  /** 注入工业颂歌风格指南到 Agent 上下文（预处理） */
  | 'style_inject'
  /** 输出内容附带微信公众号发布就绪标记 */
  | 'publish_ready'
  /** 启用自动摘要+排版优化（后处理） */
  | 'summary_format'

export type GongyeSonggeFeatureMap = ReadonlySet<GongyeSonggeFeature>

// ════════════════════════════════════════════════════════════════
//  钩子类型
// ════════════════════════════════════════════════════════════════

/** 预处理上下文 — Agent 执行前 */
export interface PreProcessContext {
  /** 用户原始输入文本 */
  rawText: string
  /** 请求来源 */
  source: 'electron' | 'telegram'
  /** 请求 ID */
  requestId: string
  /** 处理后的文本（默认 = rawText，可被钩子修改） */
  processedText: string
  /** 是否需要格式化输出 */
  needsFormatting: boolean
}

/** 后处理上下文 — Agent 执行后 */
export interface PostProcessContext {
  /** Agent 原始回复 */
  rawReply: string
  /** 格式化后的回复（默认 = rawReply，可被钩子修改） */
  formattedReply: string
  /** 是否成功格式化 */
  formatted: boolean
  /** 请求 ID */
  requestId: string
  /** 预处理阶段附加的数据 */
  preProcessData?: Record<string, unknown>
}

/** 后处理结果 */
export interface PostProcessResult {
  /** 格式化后的文本 */
  text: string
  /** 是否发生了格式化 */
  formatted: boolean
  /** 格式化描述信息 */
  description?: string
}

/** 预处理钩子签名 */
export type PreProcessHook = (ctx: PreProcessContext) => PreProcessContext | Promise<PreProcessContext>

/** 后处理钩子签名 */
export type PostProcessHook = (ctx: PostProcessContext) => PostProcessResult | Promise<PostProcessResult>

// ════════════════════════════════════════════════════════════════
//  配置
// ════════════════════════════════════════════════════════════════

export interface IndustrialOdeLayerConfig {
  /** 启用特性集合（空集合 = 层存在但不生效） */
  features: GongyeSonggeFeature[]
  /** 注册的预处理钩子 */
  preHooks?: PreProcessHook[]
  /** 注册的后处理钩子 */
  postHooks?: PostProcessHook[]
  /** 调试模式 */
  debug?: boolean
  /** LLM 服务引用（用于格式化调用） */
  llmService?: { chatJson(prompt: string, opts?: unknown): Promise<unknown> }
}

// ════════════════════════════════════════════════════════════════
//  特性注册表
// ════════════════════════════════════════════════════════════════

/** 解析 GONGYE_SONGE_FEATURES 环境变量为特性集合 */
export function parseFeaturesFromEnv(): GongyeSonggeFeature[] {
  return coreParseFeaturesFromEnv<GongyeSonggeFeature>({
    envVar: 'GONGYE_SONGE_FEATURES',
    allowed: ['content_format', 'style_inject', 'publish_ready', 'summary_format'],
  })
}
