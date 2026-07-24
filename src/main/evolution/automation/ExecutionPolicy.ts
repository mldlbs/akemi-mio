/**
 * ExecutionPolicy — 执行策略门（Phase 3A）
 *
 * 全局治理门：任何 ProblemSource 在进入 tryFix() 前必须经过 ExecutionPolicy。
 *
 * 职责：
 *   输入: Problem（任意 source）
 *   输出: ExecutionVerdict — 阻断 / 记录 / 执行
 *
 * 不依赖：
 *   - 不 import SelfEvolutionService
 *   - 不 import EvidenceBridge / EvidenceCollector
 *   - 不直接修改 ProblemQueue
 *
 * 设计约束：
 *   - evaluate() 是纯函数，不修改输入
 *   - 不访问文件系统
 *   - 不调用外部服务
 *   - 不产生副作用
 */
import type { Problem, ProblemSource, Severity } from './types'

// =============================================================================
// 类型定义
// =============================================================================

/** 执行策略等级（保留兼容，执行路径使用 action） */
export type ExecutionLevel = 'level_0_record' | 'level_1_propose' | 'level_2_execute'

/** 执行模式（Phase 3C+）
 *
 * disabled → evaluate + emit + always execute（兼容旧行为，用于部署验证）
 * shadow   → evaluate + emit + always execute + 不修改 queue 状态（观测）
 * enforce  → evaluate + emit + action 生效（治理）
 */
export type ExecutionMode = 'disabled' | 'shadow' | 'enforce'

/** 执行动作（Phase 3C: 执行路径唯一依据）
 *
 * skip    → 治理跳过（level_0_record），不进 executor
 * block   → 治理阻断（level_1_propose），不进 executor
 * execute → 放行至 tryFix()（level_2_execute 仅兼容保留，legacy source fall-through）
 */
export type VerdictAction = 'execute' | 'skip' | 'block'

/** 策略决定 */
export interface ExecutionVerdict {
  /** 裁定结果（保留兼容） */
  level: ExecutionLevel
  /** 执行动作（Phase 3C: 消费方只看此字段） */
  action: VerdictAction
  /** 决策原因 */
  reason: string
  /** 是否阻断执行（level_0 + level_1 = 阻断） */
  blocks: boolean
  /** 是否建议生成 ProposalRecord（仅 level_1） */
  shouldPropose: boolean
}

/** Phase 3C+: policy.decision 事件固定 schema */
export interface PolicyDecisionEvent {
  problemId: string
  source: string
  action: VerdictAction
  /** 决策时的执行模式 */
  mode: ExecutionMode
  /** shadow/disabled 模式下是否实际执行了 tryFix() */
  executed: boolean
  reason: string
  policyVersion: string
  timestamp: number
}

// =============================================================================
// 默认策略映射
// =============================================================================

/**
 * Policy v1.1.0 Strategy by Source:
 *
 * ── Protected Block ──
 * cicd:   tsc compilation errors are high-certainty failures.
 *         block → level_2_execute (deepseek/agent-sdk) serves as fallback.
 *         Not changed to execute: no value in running executor before tsc error is resolved.
 *
 * ── Record-Only (skip) ──
 * evidence:   external observation, no auto-fix target.
 * memory:     system state, auto-execution high risk.
 * agent:      agent behavior observations, manual review required.
 *
 * ── Candidate Execute (level_1_propose pending calibration) ──
 * feature:   code/UI/behavior changes — potential execute candidate.
 *            Shadow data shows all observed severity=info (auto-skip).
 *            Re-evaluate when feature:error samples exist.
 * behavior:  same as feature.
 * tool:      configuration/analytics — low-risk, future execute candidate.
 * tts:       voice preference tuning — low-risk, future execute candidate.
 * blog:      content generation — supervised execution path.
 *
 * ── Execute ──
 * tsc/test/lint/log/git/runtime: established auto-fix paths.
 */

/**
 * 按 source 分级的默认策略。
 * 每个 source 在没有被规则覆盖时使用此默认值。
 */
const DEFAULT_LEVEL_BY_SOURCE: Record<string, ExecutionLevel> = {
  'evidence': 'level_0_record',
  'memory': 'level_0_record',
  'agent': 'level_0_record',
  'behavior': 'level_1_propose',
  'feature': 'level_1_propose',
  'tool': 'level_1_propose',
  'tts': 'level_1_propose',
  'file_organizer': 'level_1_propose',
  'runtime': 'level_2_execute',
  'tsc': 'level_2_execute',
  'test': 'level_2_execute',
  'lint': 'level_2_execute',
  'log': 'level_2_execute',
  'git': 'level_2_execute',
  'cicd': 'level_1_propose',
  'blog': 'level_1_propose',
}

/**
 * severity 覆盖：当 severity 为 error 时提升一级。
 * 但 evidence 和 memory 不受此规则影响（始终 level_0）。
 */
const LOCKED_LEVEL_0: ProblemSource[] = ['evidence', 'memory', 'agent']

// =============================================================================
// ExecutionPolicy
// =============================================================================

export class ExecutionPolicy {
  readonly policyVersion: string
  readonly mode: ExecutionMode

  constructor(options?: { mode?: ExecutionMode; policyVersion?: string }) {
    this.mode = options?.mode ?? 'disabled'
    this.policyVersion = options?.policyVersion ?? '1.0.0'
  }

  /**
   * 评估一个 Problem 的执行等级。
   *
   * Phase 3C 规则：
   *   1. evidence/memory/agent source 始终 Level 0（锁定记录）
   *   2. 其他 source 按 DEFAULT_LEVEL_BY_SOURCE 映射
   *   3. info severity 降级到 Level 0
   *   4. Level 2 路径关闭（仅作兼容保留，执行路径使用 action）
   *
   * action 映射：
   *   level_0_record  → skip
   *   level_1_propose → block
   *   level_2_execute → execute（仅 legacy source fall-through）
   *
   * @param problem 待评估的问题
   * @returns 执行裁定
   */
  evaluate(problem: Problem): ExecutionVerdict {
    // ── Rule 1: 锁定 Level 0 ──
    if (LOCKED_LEVEL_0.includes(problem.source as ProblemSource)) {
      return {
        level: 'level_0_record',
        action: 'skip',
        reason: `source=${problem.source} 为锁定只记录来源`,
        blocks: true,
        shouldPropose: false,
      }
    }

    // ── Rule 2: 按 severity 降级 ──
    if (problem.severity === 'info') {
      return {
        level: 'level_0_record',
        action: 'skip',
        reason: `severity=info 自动降级为只记录`,
        blocks: true,
        shouldPropose: false,
      }
    }

    // ── Rule 3: 按 source 获取基准等级 ──
    const baseLevel = DEFAULT_LEVEL_BY_SOURCE[problem.source] || 'level_1_propose'

    // Phase 3C: Level 2 仅作兼容保留（legacy source fall-through）
    const action = baseLevel === 'level_2_execute' ? 'execute' as const : baseLevel === 'level_1_propose' ? 'block' as const : 'skip' as const

    return {
      level: baseLevel,
      action,
      reason: `source=${problem.source}, severity=${problem.severity}, level=${baseLevel}`,
      blocks: action !== 'execute',
      shouldPropose: action === 'block',
    }
  }
}
