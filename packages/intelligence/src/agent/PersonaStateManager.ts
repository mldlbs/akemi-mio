/**
 * PersonaStateManager — 人格仲裁状态管理
 *
 * 独立于 ChatExecutor，管理人格等级检测、过渡、prompt 注入。
 * 可测试、可复用，TaskExecutor 将来也能接入。
 *
 * Persona 等级：
 * - core:   无写作偏置（默认）
 * - hybrid: 轻量表达偏置（中置信度写作意图）
 * - writer: 完整作家偏置（高置信度写作意图）
 *
 * 过渡规则（状态惯性优先，当前状态是强先验）：
 *   writer(惯性) → score ≤ 0.35 → hybrid → score ≤ 0.2 → core
 *   hybrid(惯性) → score ≥ 0.6 → writer | score ≤ 0.25 → core
 *   core(基线)    → score ≥ 0.75 → writer | score ≥ 0.4 → hybrid
 *
 * 人格漂移防护：降级时返回 transition signal，由调用方注入对话上下文，
 * 显式打断历史回复的残留偏置。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { PROMPT_WRITER_IDENTITY, PROMPT_WRITER_STYLE, detectWritingIntent, resolvePersona, type PersonaLevel } from './writing-prompt'

export type { PersonaLevel }

export interface PersonaUpdateResult {
  /** 需要注入的 prompt modules（由 getExtraModules 读取） */
  changed: boolean
  /** 降级信号 — 放入 scratchpad 以注入消息层面，打断历史偏置 */
  transitionSignal: string | null
}

const TRANSITION_SIGNALS: Record<string, string> = {
  'writer→core': '写作模式已退出，请恢复自然对话风格，不要再使用文学化表达。',
  'writer→hybrid': '写作模式已降级为混合模式，保留轻度表达偏置，但不再使用完整文学风格。',
  'hybrid→core': '表达偏置已解除，请恢复自然对话风格。',
}

export class PersonaStateManager {
  private level: PersonaLevel = 'core'

  /** 对输入进行意图评分并更新人格等级（带滞后） */
  update(text: string): PersonaUpdateResult {
    const score = detectWritingIntent(text)
    const resolved = resolvePersona(score, this.level)
    if (resolved === this.level) return { changed: false, transitionSignal: null }

    const from = this.level
    this.level = resolved
    log('INFO', 'persona_transition', { from, to: resolved, score })

    // 只有降级才需要过渡信号（升级场景不存在历史偏置污染）
    const signal = this.grade(from) > this.grade(resolved) ? TRANSITION_SIGNALS[`${from}→${resolved}`] || null : null
    return { changed: true, transitionSignal: signal }
  }

  /** 返回当前人格等级 */
  getCurrentLevel(): PersonaLevel {
    return this.level
  }

  /** 是否处于写作相关状态（hybrid 或 writer） */
  isActive(): boolean {
    return this.level === 'hybrid' || this.level === 'writer'
  }

  /** 根据当前人格返回需要注入的 extra prompt module(s) */
  getExtraModules(): string[] {
    if (this.level === 'writer') return [PROMPT_WRITER_IDENTITY]
    if (this.level === 'hybrid') return [PROMPT_WRITER_STYLE]
    return []
  }

  /** 重置到 core（跨会话/测试清理） */
  reset(): void {
    if (this.level !== 'core') {
      log('INFO', 'persona_reset', { from: this.level })
      this.level = 'core'
    }
  }

  private grade(level: PersonaLevel): number {
    return level === 'core' ? 0 : level === 'hybrid' ? 1 : 2
  }
}
