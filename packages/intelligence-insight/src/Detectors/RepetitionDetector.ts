import type { RawDetection, DetectionContext } from '@akemi-mio/intelligence-insight/types'

const TOPIC_PATTERNS: { pattern: RegExp; topic: string }[] = [
  { pattern: /memory|记忆|上下文/i, topic: 'Memory/记忆系统' },
  { pattern: /重构|refactor|rewrite/i, topic: '重构/重写' },
  { pattern: /插件|plugin/i, topic: '插件系统' },
  { pattern: /进化|evolution|自改进/i, topic: '自进化' },
  { pattern: /性能|perf|慢|延迟/i, topic: '性能问题' },
  { pattern: /bug|错误|崩溃|crash|error/i, topic: 'Bug/错误' },
  { pattern: /测试|test|coverage/i, topic: '测试' },
  { pattern: /sqlite|数据库|持久化/i, topic: 'SQLite/持久化' },
  { pattern: /v3|3\..*版本|下一版/i, topic: 'v3 目标' },
  { pattern: /agent|智能体|代理/i, topic: 'Agent系统' },
  { pattern: /mcp|工具/i, topic: 'MCP/工具系统' },
  { pattern: /ui|界面|前端|renderer/i, topic: 'UI/前端' },
  { pattern: /tts|语音|说话|声音/i, topic: 'TTS/语音' },
  { pattern: /asr|语音识别|whisper/i, topic: 'ASR/语音识别' },
]

export class RepetitionDetector {
  detect(ctx: DetectionContext): RawDetection[] {
    const results: RawDetection[] = []

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const recentEntries = ctx.memoryEntries.filter((e) => e.createdAt > sevenDaysAgo)
    const recentSummaries = ctx.summaries
    const recentText = [...recentEntries.map((e) => e.content), ...recentSummaries].join('\n')

    const counts: { topic: string; count: number }[] = []

    for (const { pattern, topic } of TOPIC_PATTERNS) {
      const matches = recentText.match(pattern)
      if (matches) {
        counts.push({ topic, count: matches.length })
      }
    }

    counts.sort((a, b) => b.count - a.count)

    if (counts.length === 0) return results

    const top = counts[0]
    if (top.count < 3) return results

    const totalInteractions = Math.max(ctx.interactionCount, 1)
    const frequency = top.count / totalInteractions

    const novelty = Math.min(30 + top.count * 3, 70)
    const impact = Math.min(40 + top.count * 4, 90)
    const actionability = Math.min(30 + frequency * 200, 85)

    results.push({
      detector: 'RepetitionDetector',
      type: 'hot_topic',
      severity: top.count >= 10 ? 'high' : top.count >= 5 ? 'medium' : 'low',
      title: `「${top.topic}」成为反复讨论的话题`,
      description: `过去一周内「${top.topic}」被提到了 ${top.count} 次，占总体交互的 ${(frequency * 100).toFixed(0)}%。反复讨论通常是真瓶颈的信号。`,
      evidence: [`近7天出现 ${top.count} 次`, `共 ${totalInteractions} 次交互`],
      novelty,
      impact,
      actionability,
    })

    if (counts.length >= 2 && counts[1].count >= 5) {
      const second = counts[1]
      results.push({
        detector: 'RepetitionDetector',
        type: 'hot_topic',
        severity: 'medium',
        title: `「${second.topic}」值得关注`,
        description: `「${second.topic}」近期被提到 ${second.count} 次`,
        evidence: [`近7天出现 ${second.count} 次`],
        novelty: Math.min(20 + second.count * 2, 50),
        impact: Math.min(30 + second.count * 3, 60),
        actionability: 40,
      })
    }

    return results
  }
}
