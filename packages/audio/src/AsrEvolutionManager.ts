/**
 * AsrEvolutionManager — ASR 自进化编排组件
 *
 * 负责：
 * 1. 管理 ASR 配置热更新的生命期（apply → evaluate → keep/rollback）
 * 2. 协调 AsrLogStore 的评估快照与回滚判定
 * 3. 通过 AsrHotwordManager/AsrService 执行配置变更
 *
 * 与进化管道的关系：
 * - AsrLogCollector 读取 AsrLogStore 中的纠正记录并生成 Problem
 * - AsrOptimizationExecutor 调用本组件的 applyPatch() 应用变更
 * - 进化管道的下一轮评估通过本组件的 evaluateAndDecide() 完成
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { asrLogStore, type AsrEvalSnapshot } from './AsrLogStore'
import type { AsrService } from './AsrService'

// =============================================================================
// 补丁类型
// =============================================================================

export interface AsrConfigPatch {
  /** 补丁类型 */
  type: 'hotword_add' | 'homophone_fix' | 'vocab_weight_adjust' | 'domain_lm_boost'
  /** 操作描述 */
  description: string
  /** 要添加的值（热词文本或同音字规则原文） */
  value: string
  /**
   * 权重/优先级 0–1（可选）。
   * - hotword_add: 权重越高，在热词列表中排序越靠前
   * - domain_lm_boost: 权重越高，在 initial_prompt 中重复次数越多
   * - 省略时使用默认权重 0.5
   */
  weight?: number
}

// =============================================================================
// 变更历史条目
// =============================================================================

export interface AsrChangeLog {
  id: string
  timestamp: number
  patches: AsrConfigPatch[]
  snapshotId: string
  outcome?: 'improved' | 'worsened' | 'unchanged' | 'unknown'
  finalAction?: 'kept' | 'rolled_back' | 'pending'
}

// =============================================================================
// AsrEvolutionManager
// =============================================================================

export class AsrEvolutionManager {
  private asrService: AsrService | null = null
  private changeLog: AsrChangeLog[] = []
  private readonly lookbackHours = 2

  setAsrService(service: AsrService): void {
    this.asrService = service
  }

  // ==================== 补丁应用 ====================

  /**
   * 应用一组 ASR 配置补丁。
   * 1. 创建评估快照（记录变更前的纠错率基线）
   * 2. 通过 AsrService/AsrHotwordManager 执行热更新
   * 3. 记录变更日志
   *
   * @param patches - 要应用的补丁列表
   * @param options - 可选参数
   * @param options.batchLabel - 批量操作的描述标签（用于快照）
   * @returns 变更日志 ID 和快照 ID，失败返回 null
   */
  applyPatches(patches: AsrConfigPatch[], options?: { batchLabel?: string }): { changeId: string; snapshotId: string } | null {
    if (!this.asrService) {
      log('WARN', 'asr_evolution_no_service')
      return null
    }

    // 去重：按补丁描述去重，避免重复添加
    const uniquePatches = this.deduplicatePatches(patches)
    if (uniquePatches.length === 0) {
      log('INFO', 'asr_evolution_no_new_patches')
      return null
    }

    // 创建评估快照
    const appliedDescriptions = uniquePatches.map((p) => {
      const weightStr = p.weight !== undefined ? `@${p.weight.toFixed(2)}` : ''
      return `${p.type}:${p.value}${weightStr}`
    })
    // 附加批量标签（如果有）
    if (options?.batchLabel) {
      appliedDescriptions.unshift(`[${options.batchLabel}]`)
    }
    const snapshot = asrLogStore.createEvalSnapshot(appliedDescriptions, this.lookbackHours)

    // 应用每个补丁
    let appliedCount = 0
    for (const patch of uniquePatches) {
      const ok = this.applySinglePatch(patch)
      if (ok) appliedCount++
    }

    const changeId = `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const changeLog: AsrChangeLog = {
      id: changeId,
      timestamp: Date.now(),
      patches: uniquePatches,
      snapshotId: snapshot.id,
      finalAction: 'pending',
    }
    this.changeLog.push(changeLog)

    log('INFO', 'asr_evolution_patches_applied', {
      changeId,
      snapshotId: snapshot.id,
      total: uniquePatches.length,
      applied: appliedCount,
    })

    return { changeId, snapshotId: snapshot.id }
  }

  /**
   * 评估上一次变更的效果并决定保留还是回滚。
   * 在进化管道下一轮执行时调用。
   *
   * @returns 决策结果
   */
  evaluateAndDecide(snapshotId?: string): {
    verdict: 'improved' | 'worsened' | 'unchanged' | 'not_found'
    action: 'keep' | 'rollback' | 'no_action' | 'unknown'
  } {
    // 如果没有指定 snapshotId，找最近一个 pending 的
    const targetId = snapshotId || this.findPendingSnapshotId()
    if (!targetId) {
      return { verdict: 'not_found', action: 'no_action' }
    }

    const verdict = asrLogStore.evaluateSnapshot(targetId, this.lookbackHours)

    let action: 'keep' | 'rollback' | 'no_action' | 'unknown'
    switch (verdict) {
      case 'improved':
        asrLogStore.updateSnapshotStatus(targetId, 'kept')
        action = 'keep'
        break
      case 'worsened':
        asrLogStore.updateSnapshotStatus(targetId, 'rolled_back')
        this.rollbackSnapshot(targetId)
        action = 'rollback'
        break
      default:
        // unchanged → 保持现状，不做回滚
        asrLogStore.updateSnapshotStatus(targetId, 'kept')
        action = 'no_action'
        break
    }

    // 更新变更日志
    const changeLog = this.changeLog.find((c) => c.snapshotId === targetId)
    if (changeLog) {
      changeLog.outcome = verdict === 'not_found' ? 'unknown' : verdict
      changeLog.finalAction = verdict === 'improved' ? 'kept' : verdict === 'worsened' ? 'rolled_back' : 'kept'
    }

    log('INFO', 'asr_evolution_decision', {
      snapshotId: targetId,
      verdict,
      action,
    })

    return { verdict, action }
  }

  // ==================== 内部方法 ====================

  private findPendingSnapshotId(): string | null {
    const pending = asrLogStore.getPendingSnapshots()
    if (pending.length === 0) return null
    // 最早创建的优先评估（FIFO）
    return pending[0].id
  }

  /**
   * 对一组补丁去重：避免重复添加相同的热词或规则。
   */
  private deduplicatePatches(patches: AsrConfigPatch[]): AsrConfigPatch[] {
    const seen = new Set<string>()
    const result: AsrConfigPatch[] = []
    for (const p of patches) {
      const key = `${p.type}:${p.value}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(p)
      }
    }
    // 按权重降序排列（权重高的优先应用）
    return result.sort((a, b) => (b.weight ?? 0.5) - (a.weight ?? 0.5))
  }

  /**
   * 应用单个补丁。
   *
   * 支持的补丁类型：
   * - hotword_add: 将新词注入热词学习系统，带权重
   * - homophone_fix: 将正确写法注入热词管理器
   * - vocab_weight_adjust: 调整现有热词权重（通过重复喂入提高优先级）
   * - domain_lm_boost: 领域语言模型增强，将词以更高权重注入
   */
  private applySinglePatch(patch: AsrConfigPatch): boolean {
    try {
      const service = this.asrService!
      const weight = patch.weight ?? 0.5

      switch (patch.type) {
        case 'hotword_add': {
          // 通过 feedUserTextToHotwords 将新词注入热词学习系统
          service.feedUserTextToHotwords(patch.value)
          // 高权重词（>0.7）额外喂入一次以提高在热词列表中排序
          if (weight > 0.7) {
            service.feedUserTextToHotwords(patch.value)
          }
          log('INFO', 'asr_patch_hotword_add', {
            word: patch.value,
            weight: weight.toFixed(2),
          })
          return true
        }

        case 'homophone_fix': {
          // 同音字修正已经内置于 WhisperEngine/WhisperGpuEngine 的 HOMOPHONE_FIXES 常量中。
          // 运行时无法直接修改常量，但可以：
          // 1. 将正确文本以热词形式注入（有助于 ASR 引擎提高识别率）
          // 2. 或通过 feedUserTextToHotwords 让系统学习该词的正确写法
          service.feedUserTextToHotwords(patch.value)
          log('INFO', 'asr_patch_homophone', { word: patch.value })
          return true
        }

        case 'vocab_weight_adjust': {
          // 权重调整：通过多次喂入提高热词优先级
          const repeatCount = Math.max(1, Math.min(5, Math.round(weight * 5)))
          for (let i = 0; i < repeatCount; i++) {
            service.feedUserTextToHotwords(patch.value)
          }
          log('INFO', 'asr_patch_weight_adjust', {
            word: patch.value,
            weight: weight.toFixed(2),
            repeatCount,
          })
          return true
        }

        case 'domain_lm_boost': {
          // 领域语言模型增强：多次喂入（权重越高次数越多），
          // 然后刷新 ASR 上下文使热词立即生效
          const boostCount = Math.max(2, Math.min(10, Math.round(weight * 10)))
          for (let i = 0; i < boostCount; i++) {
            service.feedUserTextToHotwords(patch.value)
          }
          // 刷新 ASR 上下文使新热词立即生效
          service.refreshContext()
          log('INFO', 'asr_patch_domain_boost', {
            word: patch.value,
            weight: weight.toFixed(2),
            boostCount,
          })
          return true
        }

        default:
          log('WARN', 'asr_patch_unknown_type', { type: (patch as any).type })
          return false
      }
    } catch (err) {
      log('ERROR', 'asr_patch_apply_failed', { error: String(err), patch })
      return false
    }
  }

  /**
   * 回滚指定快照对应的变更。
   * 当前实现：不直接删除热词（因为 AsrHotwordManager 没有"反向操作"API），
   * 而是记录回滚，热词通过衰减机制自然淡出。
   * 未来可以扩展为反向操作。
   */
  private rollbackSnapshot(snapshotId: string): boolean {
    const snapshot = asrLogStore.getSnapshots().find((s) => s.id === snapshotId)
    if (!snapshot) return false

    log('INFO', 'asr_evolution_rollback', {
      snapshotId,
      changes: snapshot.appliedChanges,
      note: '热词将通过衰减机制自然淡出。如需立即清除，请手动调用 clearAllLearnedVocabulary()',
    })
    return true
  }

  /** 获取变更历史 */
  getChangeLog(): AsrChangeLog[] {
    return [...this.changeLog]
  }

  /** 获取最近变更 */
  getLastChange(): AsrChangeLog | null {
    return this.changeLog.length > 0 ? this.changeLog[this.changeLog.length - 1] : null
  }
}

// =============================================================================
// 单例
// =============================================================================

export const asrEvolutionManager = new AsrEvolutionManager()
