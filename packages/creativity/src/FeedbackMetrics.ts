/**
 * FeedbackMetrics — 正向反馈闭环验证指标（spec §八，P3 收官）
 *
 * 把"三类验证指标"里能在本地数据上回答的部分落成纯函数：
 *   - Pair Precision@K：快照中反馈调整幅度最大的 K 个概念对里，
 *     已有终局（validated/rejected）假设的对的通过率（无终局样本 → null，
 *     无样本 ≠ 0；hypothesis_only 键不是概念对，不参与排名）。
 *   - Novelty@K：top-K 概念对里未被窗口内假设探索过的比例。
 *   - Validation Pass Rate：窗口内终局假设的通过率。
 *   - Event Ingestion Completeness：JSONL 原始行 vs 可解析行（损坏行=丢失）。
 *
 * 身份规则与快照一致（types.ts sourceConceptId/conceptPairKey）：
 * 概念对键 = conceptPairKey(sourceConceptId)，hypothesis_only 键带
 * `hypothesis:` 前缀被排除；无 provenance 的假设回退 sourceLabels 的
 * `name:` 键（与 sourceConceptId 的无 origin 回退同空间）。
 *
 * 纯函数：不读写文件、不碰 DB、不进 checkPromotionGate/checkSubmitGate
 * 输入（spec §二.2 反馈权限隔离）。
 */

import {
  DEFAULT_FEEDBACK_LEARNING_CONFIG,
  replayFeedbackAdjustment,
  type FeedbackLearningConfig,
  type FeedbackSnapshot,
} from './FeedbackLearning'
import { conceptPairKey, sourceConceptId } from './types'

// ══════════════════════════════════════════
// 配置（R6 纪律：进配置 + 解析校验 + fail-closed）
// ══════════════════════════════════════════

export interface FeedbackMetricsConfig {
  /** Pair Precision@K / Novelty@K 的 K */
  precisionK: number
  /** 通过率与探索集的回看窗口（天） */
  windowDays: number
}

export const DEFAULT_FEEDBACK_METRICS_CONFIG: FeedbackMetricsConfig = {
  precisionK: 10,
  windowDays: 30,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

/** 解析并校验指标配置；两个字段都缺失返回 null（fail-closed，调用方回退默认）。 */
export function parseFeedbackMetricsConfig(raw: unknown): FeedbackMetricsConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const hasAny = ['precisionK', 'windowDays'].some((k) => obj[k] !== undefined)
  if (!hasAny) return null
  return {
    precisionK: Math.floor(clampNumber(obj.precisionK, 1, 1000, DEFAULT_FEEDBACK_METRICS_CONFIG.precisionK)),
    windowDays: Math.floor(clampNumber(obj.windowDays, 1, 3650, DEFAULT_FEEDBACK_METRICS_CONFIG.windowDays)),
  }
}

/** 从环境变量解析（MIO_FEEDBACK_PRECISION_K / MIO_FEEDBACK_WINDOW_DAYS，缺省全默认）。 */
export function resolveFeedbackMetricsConfig(
  env: Record<string, string | undefined> = process.env,
): FeedbackMetricsConfig {
  return (
    parseFeedbackMetricsConfig({
      precisionK: env.MIO_FEEDBACK_PRECISION_K,
      windowDays: env.MIO_FEEDBACK_WINDOW_DAYS,
    }) ?? DEFAULT_FEEDBACK_METRICS_CONFIG
  )
}

// ══════════════════════════════════════════
// 输入
// ══════════════════════════════════════════

/** 结构子集：主进程 Hypothesis 与 CLI store 行都满足（只要求用到的字段）。 */
export interface FeedbackMetricsHypothesis {
  id: string
  status?: string
  createdAt?: number
  sourceLabels?: readonly string[]
  provenance?: { sources?: ReadonlyArray<{ name: string; origin?: string }> }
}

/** 证据事件 JSONL 的行统计（调用方做原始扫描；本模块纯计算）。 */
export interface FeedbackIngestionCounts {
  /** 非空行总数 */
  rawLines: number
  /** 可 JSON 解析的行数 */
  validRows: number
}

export interface FeedbackTopPair {
  pairKey: string
  /** λ clamp 后的调整量（排名依据取绝对值） */
  adjustment: number
  validated: number
  rejected: number
  /** 无终局样本 → null（无样本 ≠ 0） */
  precision: number | null
  /** 是否未被窗口内假设探索过 */
  novel: boolean
}

export interface FeedbackGenerationMetrics {
  precisionK: number
  windowDays: number
  snapshotVersion: string | null
  pairPrecisionAtK: number | null
  evaluatedPairs: number
  noveltyAtK: number | null
  validationPassRate: number | null
  /** 窗口内终局假设数（validationPassRate 的分母） */
  terminalHypotheses: number
  ingestion: {
    rawLines: number
    validRows: number
    droppedRows: number
    completeness: number | null
  }
  topPairs: FeedbackTopPair[]
}

const TERMINAL_STATUSES = new Set(['validated', 'rejected'])
const DAY_MS = 86_400_000
const HYPOTHESIS_ONLY_PREFIX = 'hypothesis:'

/** 由 provenance 来源推导概念对键（与 buildFeedbackSnapshot 的归因同一规则）。 */
function pairKeysFromSources(
  sources: ReadonlyArray<{ name: string; origin?: string }>,
): string[] {
  const ids = sources.map(sourceConceptId)
  const keys: string[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (ids[i] === ids[j]) continue
      keys.push(conceptPairKey(ids[i], ids[j]))
    }
  }
  return keys
}

/** 无 provenance 假设的回退：sourceLabels 是原始名，等价于无 origin 的概念身份。 */
function pairKeysFromLabels(labels: readonly string[]): string[] {
  const ids = labels.map((l) => `name:${l}`)
  const keys: string[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (ids[i] === ids[j]) continue
      keys.push(conceptPairKey(ids[i], ids[j]))
    }
  }
  return keys
}

// ══════════════════════════════════════════
// 计算
// ══════════════════════════════════════════

export interface ComputeFeedbackGenerationMetricsArgs {
  snapshot?: FeedbackSnapshot | null
  hypotheses?: readonly FeedbackMetricsHypothesis[]
  ingestion?: FeedbackIngestionCounts
  config?: FeedbackMetricsConfig
  /** 缺省 Date.now()；测试可注入固定时间 */
  now?: number
  learningConfig?: FeedbackLearningConfig
}

export function computeFeedbackGenerationMetrics(
  args: ComputeFeedbackGenerationMetricsArgs = {},
): FeedbackGenerationMetrics {
  const config = args.config ?? DEFAULT_FEEDBACK_METRICS_CONFIG
  const now = args.now ?? Date.now()
  const learningConfig = args.learningConfig ?? DEFAULT_FEEDBACK_LEARNING_CONFIG
  const hypotheses = args.hypotheses ?? []
  const snapshot = args.snapshot ?? null
  const cutoff = now - config.windowDays * DAY_MS

  // ── Validation Pass Rate（窗口内终局假设） ──
  let validatedTotal = 0
  let rejectedTotal = 0
  for (const h of hypotheses) {
    if (!h.status || !TERMINAL_STATUSES.has(h.status)) continue
    if (typeof h.createdAt !== 'number' || h.createdAt < cutoff) continue
    if (h.status === 'validated') validatedTotal++
    else rejectedTotal++
  }
  const terminalHypotheses = validatedTotal + rejectedTotal
  const validationPassRate = terminalHypotheses > 0 ? validatedTotal / terminalHypotheses : null

  // ── 终局假设 → 概念对链接（全量：配对证据来自快照，不受窗口裁剪） ──
  const pairToTerminal = new Map<string, { validated: number; rejected: number }>()
  for (const h of hypotheses) {
    if (!h.status || !TERMINAL_STATUSES.has(h.status)) continue
    const sources = h.provenance?.sources
    if (!sources || sources.length < 2) continue
    for (const key of pairKeysFromSources(sources)) {
      let counts = pairToTerminal.get(key)
      if (!counts) {
        counts = { validated: 0, rejected: 0 }
        pairToTerminal.set(key, counts)
      }
      if (h.status === 'validated') counts.validated++
      else counts.rejected++
    }
  }

  // ── 窗口内探索集（novelty 判定） ──
  const explored = new Set<string>()
  for (const h of hypotheses) {
    if (typeof h.createdAt !== 'number' || h.createdAt < cutoff) continue
    const sources = h.provenance?.sources
    if (sources && sources.length >= 2) {
      for (const key of pairKeysFromSources(sources)) explored.add(key)
    } else if (h.sourceLabels && h.sourceLabels.length >= 2) {
      for (const key of pairKeysFromLabels(h.sourceLabels)) explored.add(key)
    }
  }

  // ── top-K：快照概念对按 |clampedAdjustment| 排名（tie-break pairKey，稳定） ──
  const conceptPairs = (snapshot?.pairs ?? []).filter((p) => !p.pairKey.startsWith(HYPOTHESIS_ONLY_PREFIX))
  const topPairs: FeedbackTopPair[] = conceptPairs
    .map((p) => {
      const counts = pairToTerminal.get(p.pairKey)
      const validated = counts?.validated ?? 0
      const rejected = counts?.rejected ?? 0
      const total = validated + rejected
      return {
        pairKey: p.pairKey,
        adjustment: replayFeedbackAdjustment(p, learningConfig).clampedAdjustment,
        validated,
        rejected,
        precision: total > 0 ? validated / total : null,
        novel: !explored.has(p.pairKey),
      }
    })
    .sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment) || (a.pairKey < b.pairKey ? -1 : 1))
    .slice(0, config.precisionK)

  let evaluatedPairs = 0
  let precisionSum = 0
  let novelCount = 0
  for (const p of topPairs) {
    if (p.precision !== null) {
      evaluatedPairs++
      precisionSum += p.precision
    }
    if (p.novel) novelCount++
  }
  const pairPrecisionAtK = evaluatedPairs > 0 ? precisionSum / evaluatedPairs : null
  const noveltyAtK = topPairs.length > 0 ? novelCount / topPairs.length : null

  // ── 事件摄取完整度（原始行 vs 可解析行） ──
  const rawLines = args.ingestion?.rawLines ?? 0
  const validRows = args.ingestion?.validRows ?? 0
  const droppedRows = Math.max(0, rawLines - validRows)
  const completeness = rawLines > 0 ? Math.max(0, Math.min(1, validRows / rawLines)) : null

  return {
    precisionK: config.precisionK,
    windowDays: config.windowDays,
    snapshotVersion: snapshot?.version ?? null,
    pairPrecisionAtK,
    evaluatedPairs,
    noveltyAtK,
    validationPassRate,
    terminalHypotheses,
    ingestion: { rawLines, validRows, droppedRows, completeness },
    topPairs,
  }
}
