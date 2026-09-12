import type { RawDetection, DetectionContext } from '@akemi-mio/intelligence-insight/types'

const REWORK_PATTERNS = /重构|refactor|rewrite|重写|重做|重来|redesign/i
const MODULE_REF = /(memory|记忆|agent|mcp|evo|进化|tts|asr|ui|插件|plugin|sqlite)/i

export class FrictionDetector {
  detect(ctx: DetectionContext): RawDetection[] {
    const results: RawDetection[] = []
    const allText = [...ctx.memoryEntries.map((e) => e.content), ...ctx.summaries].join('\n')

    const reworkMentions = allText.match(REWORK_PATTERNS)
    if (!reworkMentions || reworkMentions.length < 3) return results

    const content = ctx.memoryEntries.map((e) => e.content).join(' ')
    const tokens = content.split(/[，。！？、\n]+/)
    const reworkTokens = tokens.filter((t) => REWORK_PATTERNS.test(t))

    if (reworkTokens.length < 2) {
      results.push({
        detector: 'FrictionDetector',
        type: 'friction',
        severity: 'low',
        title: '存在频繁重构倾向',
        description: `近期共有 ${reworkMentions.length} 次提到重构/重写`,
        evidence: [`重构提及 ${reworkMentions.length} 次`],
        novelty: 40,
        impact: 45,
        actionability: 55,
      })
      return results
    }

    const modules = reworkTokens
      .map((t) => {
        const m = t.match(MODULE_REF)
        return m ? m[1] : 'unknown'
      })
      .filter(Boolean)

    let sequence = ''
    for (let i = 0; i < modules.length; i++) {
      sequence += modules[i]
      if (i < modules.length - 1) sequence += '→'
    }

    const hasThrashing = modules.length >= 3 && (modules[0] === modules[2] || new Set(modules.slice(0, 4)).size <= 2)

    if (hasThrashing) {
      results.push({
        detector: 'FrictionDetector',
        type: 'friction',
        severity: 'high',
        title: '检测到架构震荡（Architecture Thrashing）',
        description: `同一模块被反复重构：${sequence}。这通常说明当前架构设计存在根本性问题，建议暂停重构，重新审视设计方向。`,
        evidence: [`重构序列: ${sequence}`, `共 ${reworkMentions.length} 次重构提及`],
        novelty: 85,
        impact: 90,
        actionability: 85,
      })
    } else {
      results.push({
        detector: 'FrictionDetector',
        type: 'friction',
        severity: 'medium',
        title: '存在频繁重构倾向',
        description: `近期 ${reworkMentions.length} 次提到重构。频繁重构可能是架构不稳定的信号。涉及模块: ${sequence}`,
        evidence: [`重构提及 ${reworkMentions.length} 次`, `涉及模块: ${sequence}`],
        novelty: 50,
        impact: 55,
        actionability: 60,
      })
    }

    return results
  }
}
