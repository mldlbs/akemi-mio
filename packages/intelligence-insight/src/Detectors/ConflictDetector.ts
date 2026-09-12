import type { RawDetection, DetectionContext } from '@akemi-mio/intelligence-insight/types'

const CONTRADICTION_PAIRS: [RegExp, RegExp, string, string][] = [
  [
    /(\d+)\s*轮.*对话|连续对话.*(\d+)\s*轮|(\d+).*context/i,
    /(\d+)\s*轮.*窗口|窗口.*(\d+)\s*轮|只保[留].*\d+/i,
    '对话轮次目标与窗口限制冲突',
    'high',
  ],
  [/sqlite|持久化|长期记忆/i, /只保留.*\d+.*条|最多.*\d+.*条|容量限制/i, '持久化需求与容量限制冲突', 'medium'],
  [/插件.*系统|plugin.*system|多工具|扩展/i, /暂停|停止.*开发|搁置|优先级低/i, '扩展目标与实际进度冲突', 'medium'],
]

export class ConflictDetector {
  detect(ctx: DetectionContext): RawDetection[] {
    const results: RawDetection[] = []
    const allText = [...ctx.memoryEntries.map((e) => e.content), ...ctx.summaries].join('\n')

    for (const [goalPat, limitPat, label, severity] of CONTRADICTION_PAIRS) {
      const goalMatch = allText.match(goalPat)
      const limitMatch = allText.match(limitPat)
      if (goalMatch && limitMatch) {
        results.push({
          detector: 'ConflictDetector',
          type: 'conflict',
          severity: severity as 'high' | 'medium',
          title: label,
          description: `检测到目标「${goalMatch[0]}」与当前限制「${limitMatch[0]}」存在矛盾`,
          evidence: [goalMatch[0], limitMatch[0]],
          novelty: severity === 'high' ? 90 : 60,
          impact: severity === 'high' ? 95 : 60,
          actionability: 80,
        })
      }
    }

    if (ctx.interactionCount > 20) {
      const stalled = ctx.plans.filter((p) => p.status === 'active' && Date.now() - p.updatedAt > 7 * 24 * 60 * 60 * 1000)
      if (stalled.length > 0) {
        const plan = stalled[0]
        results.push({
          detector: 'ConflictDetector',
          type: 'conflict',
          severity: 'medium',
          title: '开发目标与实际进展不一致',
          description: `已有目标但计划「${plan.title}」超过7天未推进`,
          evidence: [`计划: ${plan.title}`, `最后更新: ${new Date(plan.updatedAt).toLocaleDateString()}`],
          novelty: 50,
          impact: 65,
          actionability: 70,
        })
      }
    }

    return results
  }
}
