/**
 * ADR-008 Frozen Contract.
 *
 * ToolPromptAssembler — 将 ToolDecision 翻译为 LLM Prompt。
 *
 * 职责：
 *  - 将 ToolDecision.preference 映射为 LLM 可理解的自然语言指令
 *  - 仅在 non-auto 时注入 Prompt（auto 时不需要提示）
 *
 * 不负责：
 *  - 决策策略（见 ToolPolicyPlanner）
 *  - 工具过滤器（见 SafetyFilter）
 *
 * I-5: auto 不注入 — 当 preference === 'auto' 时，assemble() 返回 null
 */

import { type ToolDecision, ToolDecisionReason } from './types'

/**
 * ADR-008 Frozen Contract.
 *
 * ToolPromptAssembler 的公开接口。
 */
export interface IToolPromptAssembler {
  assemble(decision: ToolDecision): string | null
}

/**
 * ADR-008 默认实现。
 *
 * 映射规则：
 *  - proactive: 鼓励主动使用工具
 *  - auto: 不注入（null）
 *  - avoid: 仅在用户明确要求时使用工具
 *  - forbidden: 禁止使用工具（安全限制）
 */
export class ToolPromptAssembler implements IToolPromptAssembler {
  assemble(decision: ToolDecision): string | null {
    // I-5: auto → 不注入
    if (decision.preference === 'auto') return null

    // forbidden: 安全限制
    if (decision.preference === 'forbidden') {
      return `【工具使用】检测到安全限制，当前不应使用任何工具。`
    }

    // avoid: 仅在必要时使用
    if (decision.preference === 'avoid') {
      return `【工具使用】检测到当前为快速问答或聊天场景，只在用户明确要求时使用工具，否则直接回答。`
    }

    // proactive: 鼓励主动
    if (decision.preference === 'proactive') {
      return `【工具使用】检测到当前为技术或任务执行场景，优先使用工具获取信息或执行操作。`
    }

    return null
  }
}
