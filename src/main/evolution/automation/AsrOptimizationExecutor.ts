/**
 * AsrOptimizationExecutor — ASR 配置优化执行器
 *
 * 作为 FixExecutor 接入自动化管道：
 * 1. 接收 AsrLogCollector 生成的 Problem（包含 ASR 错误模式）
 * 2. 从 Problem context 中提取修正建议
 * 3. 生成 AsrConfigPatch 并通过 AsrEvolutionManager 热更新
 * 4. 创建评估快照用于下一周期的效果对比
 *
 * 支持的操作：
 * - hotword_add: 将频繁纠错的词添加到热词列表
 * - homophone_fix: 将易混淆词注册为同音字修正
 *
 * 安全机制：
 * - 仅处理 source='log' 类型的问题
 * - 校验 context.metadata 中必须包含 asr_original 和 asr_corrected
 * - 同一模式不重复执行（幂等性检查）
 * - 单次执行最大补丁数限制
 */

import { log } from '../../logger/Logger'
import { asrEvolutionManager } from '../../asr/AsrEvolutionManager'
import type { AsrConfigPatch } from '../../asr/AsrEvolutionManager'
import type { FixExecutor, AssignedProblem, FixResult } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 单次执行最大补丁数 */
const MAX_PATCHES_PER_EXECUTION = 3
/** 执行超时（毫秒） */
const EXECUTION_TIMEOUT_MS = 10000
/** 幂等缓存 — 最近已处理的 pattern key */
const RECENTLY_PATCHED = new Set<string>()
/** 幂等缓存 TTL（毫秒），避免同一模式在 1h 内重复执行 */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000

// =============================================================================
// AsrOptimizationExecutor
// =============================================================================

export class AsrOptimizationExecutor implements FixExecutor {
  readonly name = 'AsrOptimizationExecutor'
  readonly timeoutMs = EXECUTION_TIMEOUT_MS
  readonly supportedSources = ['log'] as const

  private isExecuting = false

  isAvailable(): boolean {
    return !this.isExecuting
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // 校验问题类型
      if (problem.source !== 'log') {
        return {
          problemId: problem.id,
          success: true,
          summary: '不是 ASR 日志问题，跳过',
          durationMs: Date.now() - startedAt,
        }
      }

      // 校验元数据
      const metadata = problem.context.metadata
      if (!metadata?.asr_original || !metadata?.asr_corrected) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少 ASR 纠错元数据 (asr_original, asr_corrected)',
          durationMs: Date.now() - startedAt,
          error: 'missing_metadata',
        }
      }

      const original = metadata.asr_original
      const corrected = metadata.asr_corrected

      // 幂等性检查
      const patternKey = `${original}|${corrected}`
      if (RECENTLY_PATCHED.has(patternKey)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `已处理过 "${original}" → "${corrected}"，跳过重复执行`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 生成补丁
      const patches = this.buildPatches(original, corrected, metadata.asr_category)

      if (patches.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: `无需优化：${original} → ${corrected}`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 应用补丁
      const result = asrEvolutionManager.applyPatches(patches)
      if (!result) {
        return {
          problemId: problem.id,
          success: false,
          summary: '应用 ASR 补丁失败（进化管理器不可用）',
          durationMs: Date.now() - startedAt,
          error: 'apply_failed',
        }
      }

      // 记录幂等缓存（1 小时内不重复处理同一模式）
      RECENTLY_PATCHED.add(patternKey)
      setTimeout(() => RECENTLY_PATCHED.delete(patternKey), IDEMPOTENCY_TTL_MS)

      const summary = this.buildSummary(patches, result.snapshotId)
      log('INFO', 'asr_optimization_executed', {
        problemId: problem.id,
        patches: patches.length,
        snapshotId: result.snapshotId,
        original,
        corrected,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startedAt,
        output: JSON.stringify({ snapshotId: result.snapshotId, patches: patches.map((p) => p.type) }),
      }
    } catch (err) {
      log('ERROR', 'asr_optimization_execute_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `ASR 优化执行异常: ${String(err)}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.isExecuting = false
    }
  }

  /**
   * 根据错误模式和分类生成配置补丁。
   */
  private buildPatches(original: string, corrected: string, category?: string): AsrConfigPatch[] {
    const patches: AsrConfigPatch[] = []

    // 1. 总是将正确文本添加为热词（提高后续识别率）
    patches.push({
      type: 'hotword_add',
      description: `ASR 自优化: 添加 "${corrected}" 为热词（原识别为 "${original}"）`,
      value: corrected,
    })

    // 2. 如果原文和修正文都是中文且有同音可能，添加同音字热词
    const chineseCorrected = /[一-鿿]/.test(corrected)
    if (chineseCorrected && category === 'homophone') {
      patches.push({
        type: 'homophone_fix',
        description: `ASR 自优化: 注册同音词 "${corrected}"（防混淆 "${original}"）`,
        value: corrected,
      })
    }

    // 3. 如果有完整短语（非单字），将整短语作为上下文热词
    if (corrected.length >= 3 && patches.length < MAX_PATCHES_PER_EXECUTION) {
      // 短语本身已作为热词添加，无需额外操作
    }

    // 限制最大补丁数
    return patches.slice(0, MAX_PATCHES_PER_EXECUTION)
  }

  /**
   * 生成人类可读的执行摘要。
   */
  private buildSummary(patches: AsrConfigPatch[], snapshotId: string): string {
    const items = patches.map((p) => `  - ${p.type}: ${p.description}`).join('\n')
    return `【ASR 优化执行】\n${items}\n\n评估快照: ${snapshotId}\n将在下一周期评估效果。`
  }
}
