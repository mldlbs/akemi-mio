/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner — 工具策略决策层。
 *
 * 职责：基于 Scene + 用户消息 + 上下文信号，输出结构化策略契约。
 *
 * 当前实现 (P1)：纯 Scene→ToolDecision 映射，无信号检测。
 * 后续版本 (P4) 将加入信号加权检测和 adaptive policy。
 *
 * 不负责：
 *  - 生成 Prompt 文案（见 ToolPromptAssembler）
 *  - 设置 allowedToolNames（见 SafetyFilter）
 *  - 调用任何工具
 *
 * I-1: 确定性 — 相同输入必然产生完全相同的 ToolDecision
 * I-2: 无副作用 — 不修改任何外部状态
 * I-3: 无 LLM 调用 — 纯本地同步逻辑
 * I-7: ToolDecision 不可变 — 输出后不可修改
 */

import type { SceneLabel } from '../UserBehaviorAnalyzer'
import { ToolDecision, ToolDecisionReason } from './types'

export class ToolPolicyPlanner {
  /**
   * 基于 Scene 标签输出结构化策略契约。
   *
   * 当前为 Scene→Preference 直映射（P1 阶段）。
   * 所有决策原因均为 DEFAULT（无强信号命中）。
   */
  decide(scene: SceneLabel, _userText: string, _context?: { hasRecentToolCalls?: boolean }): ToolDecision {
    const preference = this._mapSceneToPreference(scene)
    return {
      preference,
      confidence: 0.5,
      reason: ToolDecisionReason.DEFAULT,
    }
  }

  /**
   * Scene → ToolPreference 映射。
   *
   * 当前映射语义：
   *  - proactive: 预期高频使用工具的场景
   *  - auto: 工具使用由 LLM 自行判断（无倾向）
   *  - avoid: 预期少用或不用工具的场景
   *  - forbidden: 禁止使用工具（当前无映射）
   */
  private _mapSceneToPreference(scene: SceneLabel): ToolDecision['preference'] {
    switch (scene) {
      case 'code_debugging':
        return 'proactive'
      case 'system_evolution':
        return 'proactive'
      case 'task_execution':
        return 'proactive'
      case 'quick_qa':
        return 'avoid'
      case 'casual_chat':
        return 'avoid'
      case 'creative_writing':
        return 'avoid'
      case 'deep_discussion':
        return 'auto'
      case 'unknown':
      default:
        return 'auto'
    }
  }

  /**
   * 获取最近工具调用统计（委托 UserBehaviorAnalyzer）。
   * 供信号检测使用，当前为桩。
   */
  getRecentToolCalls(): number {
    // P4: 接入 UserBehaviorAnalyzer 的 tool call 统计
    return 0
  }
}
