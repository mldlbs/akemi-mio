/**
 * Piper 推理链 — 共享类型
 *
 * 反向应用 Experiment 43 的中断恢复流程模式：
 * 原来 ASR 用推理链处理识别错误，现在 PiperTTS 用推理链处理合成故障。
 *
 * ── 反转前提（反 PiperTTS） ──
 *
 * 原假设：Evolution 拥有复杂的 Plan 状态机 + 中断恢复能力，
 *         PiperTTS 只有简单的 reset/switch 修复。
 *
 * 反转后：PiperTTS 拥有与 ASR 同等的中断恢复推理链，
 *         Evolution 的修复函数降级为推理链的叶节点操作。
 *
 * ── 推理链步骤（5 步 + 验证） ──
 *
 *   0. 诊断故障模式 (Diagnose)     — 分析失败/延迟/队列特征
 *   1. 根因分析 (Root Cause)       — 判断故障类型
 *   2. 生成恢复方案 (Generate)     — 列出候选恢复策略
 *   3. 方案兼容性验证 (Validate)   — 检查与当前状态的冲突
 *   4. 执行恢复 (Execute)          — 应用选定的恢复策略
 *   5. 恢复验证 (Verify)           — 确认恢复成功
 */

import type { ReasoningStepStatus } from '@akemi-mio/evolution/automation/types'

// ═══════════════════════════════════════════
//  Piper 故障分类
// ═══════════════════════════════════════════

/** Piper 故障大类 */
export type PiperFailureCategory =
  | 'model_failure' // 模型失败率过高
  | 'high_latency' // 合成延迟过高
  | 'queue_overload' // 队列过载
  | 'fallback_chain' // 回退链异常
  | 'model_unavailable' // 模型不可用
  | 'degradation' // 整体性能退化
  | 'unknown' // 未分类

/** Piper 故障严重度 */
export type PiperFailureSeverity = 'critical' | 'error' | 'warning' | 'info'

// ═══════════════════════════════════════════
//  推理链类型（对应 AsrReasoningChain）
// ═══════════════════════════════════════════

/** Pipper 推理链单步 */
export interface PiperReasoningStep {
  /** 步骤标识 (格式: prs_{index}_{timestamp}) */
  id: string
  /** 步骤序号（从 0 开始） */
  index: number
  /** 步骤描述 */
  description: string
  /** 步骤详细说明 */
  detail: string
  /** 当前状态 */
  status: ReasoningStepStatus
  /** 执行结果文本 */
  result?: string
  /** 执行耗时 (毫秒) */
  durationMs?: number
  /** 该步骤产生的输出 */
  output?: Record<string, string>
  /** 是否关键步骤（失败后应停止后续执行） */
  critical: boolean
}

/** Piper 完整推理链 */
export interface PiperReasoningChain {
  /** 关联的问题来源（piper:xxx） */
  problemId: string
  /** 源问题标题 */
  problemTitle: string
  /** 推理链标题 */
  title: string
  /** 故障分类 */
  failureCategory: PiperFailureCategory
  /** 故障严重度 */
  severity: PiperFailureSeverity
  /** 步骤列表 */
  steps: PiperReasoningStep[]
  /** 创建时间戳 */
  createdAt: number
  /** 完成时间戳 */
  completedAt?: number
  /** 是否所有步骤成功 */
  allSucceeded: boolean
  /** 最终结论摘要 */
  conclusion?: string
  /** 关联的 Plan ID (由 PlanManager 创建) */
  planId?: string
}

// ═══════════════════════════════════════════
//  推理链执行上下文
// ═══════════════════════════════════════════

/** 推理链执行时传递的上下文 */
export interface PiperReasoningContext {
  /** 问题 ID */
  problemId: string
  /** 故障分类 */
  failureCategory: PiperFailureCategory
  /** 当前值（故障指标的实际值） */
  currentValue: number
  /** 阈值 */
  threshold: number
  /** 涉及的具体模型（如果有） */
  model?: string
  /** 源问题的详细描述 */
  detail: string
  /** 严重度 */
  severity: PiperFailureSeverity
  /** 附加元数据 */
  metadata?: Record<string, string>
}

// ═══════════════════════════════════════════
//  步骤执行结果
// ═══════════════════════════════════════════

/** 单步执行结果 */
export interface PiperStepResult {
  success: boolean
  summary: string
  output?: string
}

/** 推理链执行结果摘要 */
export interface PiperChainSummary {
  totalSteps: number
  succeeded: number
  allSucceeded: boolean
  planId?: string
  durationMs: number
  stepResults: Array<{
    index: number
    description: string
    success: boolean
    durationMs: number
  }>
}

// ═══════════════════════════════════════════
//  恢复选项
// ═══════════════════════════════════════════

/** 候选恢复策略 */
export interface PiperRecoveryOption {
  name: string
  description: string
  score: number // 0-100 推荐度
  risks: string[] // 风险描述
  sideEffects: string[]
  compatible: boolean
}
