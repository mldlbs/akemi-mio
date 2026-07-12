/**
 * Plan:清理工作区 - 整理文件目录 — 类型定义
 *
 * 清理工作区层 作为 Agent 的上层增强层，拦截其输入输出
 * 进行预处理/后处理增强，通过 feature flag 控制开放范围。
 *
 * 设计原则（遵循 IndustrialOdeLayer / UserBehaviorLayer 模式）：
 * 1. 不侵入 Agent 核心逻辑
 * 2. 通过环境变量 WORKSPACE_CLEANUP_FEATURES 控制特性
 * 3. 预处理/后处理钩子可独立注册
 *
 * 【模式抽取】
 * 通用类型和函数已迁移到 core/patterns：
 * - parseFeaturesFromEnv → core/patterns 的统一实现
 */

import { parseFeaturesFromEnv as coreParseFeaturesFromEnv } from '../core/patterns'

// ════════════════════════════════════════════════════════════════
// Feature Flag 配置
// ════════════════════════════════════════════════════════════════

/**
 * 清理工作区功能开关（环境变量驱动）
 *
 * WORKSPACE_CLEANUP_FEATURES — 逗号分隔的启用特性列表
 * 示例: "intent_detect,inject_stats,auto_organize,report_summary"
 *
 * 所有特性默认关闭，仅在显式声明后激活。
 */
export type WorkspaceCleanupFeature =
  /** 检测用户输入中是否涉及工作区整理需求（预处理） */
  | 'intent_detect'
  /** 注入工作区状态统计（文件分布、大小等）到 Agent 上下文（预处理） */
  | 'inject_stats'
  /** 自动触发文件整理流程（后处理） */
  | 'auto_organize'
  /** 在 Agent 回复后附加整理报告摘要（后处理） */
  | 'report_summary'
  /** 扫描工作区并返回整理的变更摘要 */
  | 'scan_and_report'
  /** 使用 LLM 分析工作区并提出整理建议 */
  | 'llm_analyze'

export type WorkspaceCleanupFeatureMap = ReadonlySet<WorkspaceCleanupFeature>

// ════════════════════════════════════════════════════════════════
//  工作区统计类型
// ════════════════════════════════════════════════════════════════

/** 工作区文件分布统计 */
export interface WorkspaceStats {
  /** 总文件数 */
  totalFiles: number
  /** 总目录数 */
  totalDirs: number
  /** 按扩展名分组的文件计数 */
  byExtension: Record<string, number>
  /** 按顶级目录分组的文件计数 */
  byTopDir: Record<string, number>
  /** 根目录下松散文件列表 */
  rootLevelFiles: string[]
  /** 大文件列表（>100KB） */
  largeFiles: { name: string; sizeKB: number }[]
  /** 空目录列表 */
  emptyDirs: string[]
  /** 扫描时间戳 */
  scannedAt: number
}

/** 文件整理结果 */
export interface CleanupResult {
  /** 是否发生了整理操作 */
  performed: boolean
  /** 移动/整理的文件数 */
  movedCount: number
  /** 整理的摘要描述 */
  summary: string
  /** 具体的变更列表 */
  changes: { from: string; to: string }[]
  /** 执行耗时 (ms) */
  durationMs: number
}

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
  /** 是否需要清理工作区 */
  needsCleanup: boolean
  /** 当前工作区统计（由 inject_stats 钩子填充） */
  workspaceStats?: WorkspaceStats
}

/** 后处理上下文 — Agent 执行后 */
export interface PostProcessContext {
  /** Agent 原始回复 */
  rawReply: string
  /** 格式化后的回复（默认 = rawReply，可被钩子修改） */
  formattedReply: string
  /** 请求 ID */
  requestId: string
  /** 预处理阶段附加的数据 */
  preProcessData?: Record<string, unknown>
  /** 清理结果（由 auto_organize 钩子填充） */
  cleanupResult?: CleanupResult
}

/** 后处理结果 */
export interface PostProcessResult {
  /** 处理后的文本 */
  text: string
  /** 是否发生了格式化/增强 */
  enhanced: boolean
  /** 增强描述信息 */
  description?: string
  /** 后处理附加数据 */
  extraData?: Record<string, unknown>
}

/** 预处理钩子签名 */
export type PreProcessHook = (ctx: PreProcessContext) => PreProcessContext | Promise<PreProcessContext>

/** 后处理钩子签名 */
export type PostProcessHook = (ctx: PostProcessContext) => PostProcessResult | Promise<PostProcessResult>

// ════════════════════════════════════════════════════════════════
//  配置
// ════════════════════════════════════════════════════════════════

export interface WorkspaceCleanupLayerConfig {
  /** 启用特性集合（空集合 = 层存在但不生效） */
  features: WorkspaceCleanupFeature[]
  /** 注册的预处理钩子 */
  preHooks?: PreProcessHook[]
  /** 注册的后处理钩子 */
  postHooks?: PostProcessHook[]
  /** 调试模式 */
  debug?: boolean
  /** LLM 服务引用（用于 LLM 分析等） */
  llmService?: { chatJson(prompt: string, opts?: unknown): Promise<unknown> }
  /** 工作区根目录（默认使用 config.WORKSPACE） */
  workspaceRoot?: string
}

// ════════════════════════════════════════════════════════════════
//  特性注册表
// ════════════════════════════════════════════════════════════════

/** 解析 WORKSPACE_CLEANUP_FEATURES 环境变量为特性集合 */
export function parseFeaturesFromEnv(): WorkspaceCleanupFeature[] {
  return coreParseFeaturesFromEnv<WorkspaceCleanupFeature>({
    envVar: 'WORKSPACE_CLEANUP_FEATURES',
    allowed: [
      'intent_detect',
      'inject_stats',
      'auto_organize',
      'report_summary',
      'scan_and_report',
      'llm_analyze',
    ],
  })
}
