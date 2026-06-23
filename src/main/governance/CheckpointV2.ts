import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { log } from '../logger/Logger'
import type { SessionRecoveryManager, CheckpointData } from '../agent/SessionRecoveryManager'
import type { SessionHealthScorer } from './SessionHealthScorer'
import type { CheckpointHealthVerification } from './SessionGovernorTypes'
import { eventBus } from '../core/EventBus'

/**
 * CheckpointV2 — 带健康验证的检查点系统。
 *
 * 在 SessionRecoveryManager 基础上增加：
 * 1. 保存前健康验证
 * 2. 恢复时选最近健康状态
 * 3. 坏状态拒绝保存
 */

export class CheckpointV2 {
  private baseDir: string
  private recoveryManager: SessionRecoveryManager
  private healthScorer: SessionHealthScorer | null = null

  constructor(baseDir: string, recoveryManager: SessionRecoveryManager) {
    this.baseDir = baseDir
    this.recoveryManager = recoveryManager
  }

  setHealthScorer(scorer: SessionHealthScorer): void {
    this.healthScorer = scorer
  }

  /**
   * 验证当前是否可保存 checkpoint。
   */
  verifyCheckpointHealth(): CheckpointHealthVerification {
    const score = this.healthScorer?.getScore() ?? 100
    const level = this.healthScorer?.getLevel() ?? 'HEALTHY'
    const consecutiveFailures = this.healthScorer?.getConsecutiveFailures() ?? 0

    if (level === 'CORRUPTED' || level === 'CRITICAL') {
      return {
        passed: false,
        score,
        toolSuccessRate: 0,
        contextIntegrity: 0,
        hasPendingToolCalls: true,
        messageStructureValid: false,
        reason: `Health score ${score} (${level}) below save threshold`,
      }
    }

    if (consecutiveFailures >= 10) {
      return {
        passed: false,
        score,
        toolSuccessRate: 0,
        contextIntegrity: 0,
        hasPendingToolCalls: true,
        messageStructureValid: false,
        reason: `Too many consecutive failures: ${consecutiveFailures}`,
      }
    }

    return {
      passed: true,
      score,
      toolSuccessRate: 1,
      contextIntegrity: 1,
      hasPendingToolCalls: false,
      messageStructureValid: true,
    }
  }

  /**
   * 查找健康分最高的 checkpoint（而非最新的）。
   */
  findHealthyCheckpoint(): { checkpoint: CheckpointData | null; score: number; path: string } | null {
    try {
      const ckDir = join(this.baseDir, 'checkpoints')
      const files = readdirSync(ckDir)
        .filter((f) => f.startsWith('chk_') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 10)

      const scored: Array<{ data: CheckpointData; path: string; metaScore: number }> = []

      for (const file of files) {
        try {
          const path = join(ckDir, file)
          const raw = readFileSync(path, 'utf-8')
          const data = JSON.parse(raw) as CheckpointData
          scored.push({ data, path, metaScore: this.scoreCheckpoint(data) })
        } catch {
          continue
        }
      }

      if (scored.length === 0) return null
      scored.sort((a, b) => b.metaScore - a.metaScore)
      const best = scored[0]

      log('INFO', 'checkpoint_v2.healthy_found', {
        score: best.metaScore,
        path: best.path,
        candidates: scored.length,
      })

      return { checkpoint: best.data, score: best.metaScore, path: best.path }
    } catch (err: any) {
      log('WARN', 'checkpoint_v2.find_healthy_failed', { error: String(err) })
      return null
    }
  }

  private scoreCheckpoint(data: CheckpointData): number {
    let score = 100
    if (data.runContext.interruptFlag) score -= 20
    if (data.runContext.consecutiveTimeouts > 0) score -= data.runContext.consecutiveTimeouts * 10
    if (data.runContext.consecutiveToolErrors > 0) score -= data.runContext.consecutiveToolErrors * 10
    if (data.runContext.forceContinueStagnation > 0) score -= data.runContext.forceContinueStagnation * 15
    if (data.meta.trigger === 'error') score -= 15
    if (data.meta.trigger === 'interrupt') score -= 10
    if (data.conversationStats.totalMessages < 3) score -= 20
    return Math.max(0, Math.min(100, score))
  }
}
