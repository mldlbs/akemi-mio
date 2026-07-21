/**
 * ConfigSnapshotManager — 配置快照与回滚管理器
 *
 * 职责：
 * 1. 在每次配置修改前创建当前配置的快照
 * 2. 下一周期检测失败率变化，若上升则触发回滚
 * 3. 回滚到上一个快照的旧值
 *
 * 当前支持的配置类型：
 * - tool_description: 工具描述（通过 ToolStatsTracker / ToolRegistry）
 * - system_prompt: Agent system prompt 片段
 * - task_template: 任务模板
 *
 * 注意：当前实现以数据库记录为主，配个实际修改操作
 * 由 FailureLearningService 协调，本类专注于快照记录与回滚逻辑。
 */
import { log } from '../../logger/Logger'
import { failureDatabase } from './FailureDatabase'
import type { FailureRateSnapshot, ConfigSnapshotContext } from './types'

export class ConfigSnapshotManager {
  /**
   * 创建配置修改前的快照。
   * 由 FailureLearningService.applySuggestion() 在修改前调用。
   */
  async createBeforeModification(params: {
    snapshotType: string
    configKey: string
    oldValue: string
    newValue: string | null
    suggestionId?: string
    failureLogId?: string
  }): Promise<string> {
    const snapshotId = `snap_${params.snapshotType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // 获取当前失败率作为基线
    const currentRate = failureDatabase.computeCurrentFailureRate(50)

    failureDatabase.createSnapshot({
      id: snapshotId,
      snapshotType: params.snapshotType,
      configKey: params.configKey,
      oldValue: params.oldValue,
      newValue: params.newValue,
      suggestionId: params.suggestionId,
      failureLogId: params.failureLogId,
      preFailureRate: currentRate.failureRate,
    })

    log('INFO', 'config_snapshot_created', {
      snapshotId,
      type: params.snapshotType,
      key: params.configKey,
      preFailureRate: (currentRate.failureRate * 100).toFixed(1) + '%',
    })

    return snapshotId
  }

  /**
   * 评估是否需要回滚。
   * 检查最近应用的快照，比较 pre/post failure rate。
   * 如果 post > pre + threshold，则需要回滚。
   *
   * @returns 需要回滚的快照列表
   */
  async evaluateRollback(
    currentFailureRate: FailureRateSnapshot,
    rollbackThreshold: number,
  ): Promise<Array<{ snapshot: ConfigSnapshotContext; reason: string }>> {
    const toRollBack: Array<{ snapshot: ConfigSnapshotContext; reason: string }> = []

    // 获取上一个快照（最新未回滚且有 new_value 的）
    const latestSnapshot = failureDatabase.getLatestUnrolledBackSnapshot()
    if (!latestSnapshot) return toRollBack

    // 更新 post_failure_rate
    failureDatabase.updateSnapshotPostRate(latestSnapshot.snapshotId, currentFailureRate.failureRate)

    // 判断：如果当前失败率 > 基准失败率 + 阈值
    if (latestSnapshot.postFailureRate !== null && latestSnapshot.preFailureRate > 0) {
      // 已经有 post rate（第二次评估时）
      const delta = latestSnapshot.postFailureRate - latestSnapshot.preFailureRate
      if (delta > rollbackThreshold) {
        toRollBack.push({
          snapshot: latestSnapshot,
          reason: `失败率从 ${(latestSnapshot.preFailureRate * 100).toFixed(1)}% 升至 ${(latestSnapshot.postFailureRate * 100).toFixed(1)}%（变化 ${(delta * 100).toFixed(1)}%，阈值 ${(rollbackThreshold * 100).toFixed(1)}%）`,
        })
      }
    } else {
      // 第一次评估：还没 post rate，只记录当前 rate 作为 post rate
      // （下一个周期才会真正判定）
      log('INFO', 'rollback_eval_first_pass', {
        snapshotId: latestSnapshot.snapshotId,
        preRate: (latestSnapshot.preFailureRate * 100).toFixed(1) + '%',
        postRate: (currentFailureRate.failureRate * 100).toFixed(1) + '%',
      })
    }

    return toRollBack
  }

  /**
   * 执行回滚：将指定快照的 oldValue 还原到对应配置。
   *
   * @param snapshot 要回滚的快照
   * @returns 是否成功回滚
   */
  async rollback(snapshot: ConfigSnapshotContext): Promise<boolean> {
    try {
      log('INFO', 'config_rollback_started', {
        snapshotId: snapshot.snapshotId,
        type: snapshot.snapshotType,
        key: snapshot.configKey,
      })

      // 根据快照类型执行不同回滚策略
      switch (snapshot.snapshotType) {
        case 'tool_description':
          await this.rollbackToolDescription(snapshot)
          break
        case 'system_prompt':
          await this.rollbackSystemPrompt(snapshot)
          break
        case 'task_template':
          await this.rollbackTaskTemplate(snapshot)
          break
        case 'agent_config':
          await this.rollbackAgentConfig(snapshot)
          break
        default:
          log('WARN', 'config_rollback_unknown_type', { type: snapshot.snapshotType })
          return false
      }

      // 标记快照为已回滚
      failureDatabase.markSnapshotRolledBack(snapshot.snapshotId)

      // 标记关联的建议为 rollback_applied
      const pendingVerifications = failureDatabase.getSuggestionsPendingVerification()
      for (const s of pendingVerifications) {
        if (s.snapshotId === snapshot.snapshotId) {
          failureDatabase.updateSuggestionStatus(s.id, 'rollback_applied')
          break
        }
      }

      log('INFO', 'config_rollback_completed', {
        snapshotId: snapshot.snapshotId,
        type: snapshot.snapshotType,
      })
      return true
    } catch (err: any) {
      log('ERROR', 'config_rollback_failed', {
        snapshotId: snapshot.snapshotId,
        error: err.message,
      })
      return false
    }
  }

  // ══════════════════════════════════════════════
  // 私有：各类型配置的回滚实现
  // ══════════════════════════════════════════════

  private async rollbackToolDescription(snapshot: ConfigSnapshotContext): Promise<void> {
    const { toolStatsTracker } = await import('../../tool/ToolStatsTracker')
    // ToolStatsTracker 不支持直接修改工具描述，记录到日志并通知
    log('INFO', 'rollback_tool_description', {
      tool: snapshot.configKey,
      oldValue: snapshot.oldValue.slice(0, 200),
    })
    // TODO: 当 ToolRegistry 支持动态修改工具描述时接入
  }

  private async rollbackSystemPrompt(snapshot: ConfigSnapshotContext): Promise<void> {
    // System prompt 快照：当前仅记录，后续可通过 AgentService 的 system prompt 管理接入
    log('INFO', 'rollback_system_prompt', {
      target: snapshot.configKey,
      oldValue: snapshot.oldValue.slice(0, 200),
    })
    // TODO: 接入 SystemPromptManager 或 AgentService.updateSystemPrompt()
  }

  private async rollbackTaskTemplate(snapshot: ConfigSnapshotContext): Promise<void> {
    // 任务模板回滚：暂未实现模板管理
    log('INFO', 'rollback_task_template', {
      target: snapshot.configKey,
      oldValue: snapshot.oldValue.slice(0, 200),
    })
  }

  private async rollbackAgentConfig(snapshot: ConfigSnapshotContext): Promise<void> {
    log('INFO', 'rollback_agent_config', {
      key: snapshot.configKey,
      oldValue: snapshot.oldValue.slice(0, 200),
    })
  }
}

/** 全局单例 */
export const configSnapshotManager = new ConfigSnapshotManager()
