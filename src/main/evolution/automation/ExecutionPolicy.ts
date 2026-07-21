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

/** 执行策略等级 */
export type ExecutionLevel = 'level_0_record' | 'level_1_propose' | 'level_2_execute'

/** 策略决定 */
export interface ExecutionVerdict {
  /** 裁定结果 */
  level: ExecutionLevel
  /** 决策原因 */
  reason: string
  /** 是否阻断执行（level_0 + level_1 = 阻断） */
  blocks: boolean
  /** 是否建议生成 ProposalRecord（仅 level_1） */
  shouldPropose: boolean
}

// =============================================================================
// 默认策略映射
// =============================================================================

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
  /**
   * 评估一个 Problem 的执行等级。
   *
   * 规则：
   *   1. evidence/memory/agent source 始终 Level 0（锁定记录）
   *   2. 其他 source 按 DEFAULT_LEVEL_BY_SOURCE 映射
   *   3. error severity 提升一级（不影响 Locked Level 0）
   *   4. info severity 降级到 Level 0
   *
   * @param problem 待评估的问题
   * @returns 执行裁定
   */
  evaluate(problem: Problem): ExecutionVerdict {
    // ── Rule 1: 锁定 Level 0 ──
    if (LOCKED_LEVEL_0.includes(problem.source as ProblemSource)) {
      return {
        level: 'level_0_record',
        reason: `source=${problem.source} 为锁定只记录来源`,
        blocks: true,
        shouldPropose: false,
      }
    }

    // ── Rule 2: 按 severity 降级 ──
    if (problem.severity === 'info') {
      return {
        level: 'level_0_record',
        reason: `severity=info 自动降级为只记录`,
        blocks: true,
        shouldPropose: false,
      }
    }

    // ── Rule 3: 按 source 获取基准等级 ──
    const baseLevel = DEFAULT_LEVEL_BY_SOURCE[problem.source] || 'level_1_propose'

    // ── Rule 4: error severity 提升一级（除非已达 level_2） ──
    const isError = problem.severity === 'error'
    const finalLevel: ExecutionLevel =
      isError && baseLevel === 'level_1_propose'
        ? 'level_2_execute'
        : baseLevel

    return {
      level: finalLevel,
      reason: `source=${problem.source}, severity=${problem.severity}, base=${baseLevel}, final=${finalLevel}`,
      blocks: finalLevel !== 'level_2_execute',
      shouldPropose: finalLevel === 'level_1_propose',
    }
  }
}
