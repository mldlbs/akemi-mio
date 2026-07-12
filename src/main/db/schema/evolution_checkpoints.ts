import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

/**
 * evolution_checkpoints — 自进化系统检查点表
 *
 * 记录每次进化周期的关键阶段快照，支持中断恢复与回滚。
 * 每个 checkpoint 对应一次 git stash/snapshot + 元数据记录。
 */
export const evolutionCheckpoints = sqliteTable('evolution_checkpoints', {
  /** 检查点唯一标识 (格式: chk_{cycleId}_{phase}_{timestamp}) */
  id: text('id').primaryKey(),

  /** 所属进化周期 ID (格式: cycle_{timestamp}) */
  cycleId: text('cycle_id').notNull(),

  /**
   * 阶段名称：
   *   pre_cycle      — 周期开始前的快照
   *   pre_pipeline   — 管道执行前的快照
   *   in_collect     — 问题采集阶段中
   *   pre_execute    — 执行修复前的快照
   *   post_execute   — 执行完成后的确认快照
   *   pre_commit     — git 提交前的快照
   */
  phase: text('phase').notNull(),

  /**
   * 状态：
   *   pending        — 已创建但尚未开始
   *   in_progress    — 正在执行中
   *   completed      — 成功完成
   *   failed         — 执行失败
   *   rolled_back    — 已回滚到该检查点
   *   interrupted    — 被中断（如进程退出）
   */
  status: text('status').notNull().default('pending'),

  /** git snapshot branch name (由 EvolutionGitOps.createSnapshot 创建) */
  gitSnapshotBranch: text('git_snapshot_branch'),

  /** git stash message (如果使用了 stash 而非 branch) */
  stashMessage: text('stash_message'),

  /** 受影响的文件列表 (JSON string array) */
  targetFiles: text('target_files'),

  /** 当前 git commit hash (snapshot 时的 HEAD) */
  gitHeadHash: text('git_head_hash'),

  /** 步骤元数据 (JSON blob, 如 plan_id, step_index, problem_ids 等) */
  stepData: text('step_data'),

  /** 创建时间戳 */
  createdAt: integer('created_at').notNull(),

  /** 完成/失败时间戳 */
  completedAt: integer('completed_at'),

  /** 错误信息 */
  error: text('error'),
})

export type EvolutionCheckpointRow = typeof evolutionCheckpoints.$inferSelect
export type EvolutionCheckpointPhase =
  | 'pre_cycle'
  | 'pre_pipeline'
  | 'in_collect'
  | 'pre_execute'
  | 'post_execute'
  | 'pre_commit'

export type EvolutionCheckpointStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'interrupted'
