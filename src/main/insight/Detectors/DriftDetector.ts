import type { RawDetection, DetectionContext } from '../types'

const TOPIC_KEYWORDS: { pattern: RegExp; topic: string }[] = [
  { pattern: /memory|记忆|上下文/i, topic: 'Memory' },
  { pattern: /重构|refactor|rewrite/i, topic: '重构' },
  { pattern: /插件|plugin/i, topic: '插件系统' },
  { pattern: /进化|evolution/i, topic: '自进化' },
  { pattern: /性能|perf/i, topic: '性能' },
  { pattern: /sqlite|持久化/i, topic: 'SQLite' },
  { pattern: /v3|3\.0/i, topic: 'v3 目标' },
  { pattern: /agent|智能体/i, topic: 'Agent' },
  { pattern: /mcp|工具系统/i, topic: 'MCP' },
  { pattern: /ui|界面|前端/i, topic: 'UI' },
  { pattern: /tts|语音/i, topic: 'TTS' },
  { pattern: /asr|语音识别|whisper/i, topic: 'ASR' },
  { pattern: /陪伴|桌面|desktop|companion/i, topic: '桌面陪伴' },
]

function extractTopics(text: string): Map<string, number> {
  const topics = new Map<string, number>()
  for (const { pattern, topic } of TOPIC_KEYWORDS) {
    const matches = text.match(pattern)
    if (matches) {
      topics.set(topic, (topics.get(topic) || 0) + matches.length)
    }
  }
  return topics
}

function dominantTopic(topics: Map<string, number>): string | null {
  let max = 0
  let dominant: string | null = null
  for (const [topic, count] of topics) {
    if (count > max) {
      max = count
      dominant = topic
    }
  }
  return max > 0 ? dominant : null
}

export class DriftDetector {
  detect(ctx: DetectionContext): RawDetection[] {
    const results: RawDetection[] = []
    const entries = ctx.memoryEntries
    if (entries.length < 6) return results

    const half = Math.floor(entries.length / 2)
    const earlyEntries = entries.slice(0, half)
    const recentEntries = entries.slice(-half)

    const earlyText = earlyEntries.map(e => e.content).join('\n')
    const recentText = recentEntries.map(e => e.content).join('\n')

    const earlyTopics = extractTopics(earlyText)
    const recentTopics = extractTopics(recentText)

    const earlyDominant = dominantTopic(earlyTopics)
    const recentDominant = dominantTopic(recentTopics)

    if (earlyDominant && recentDominant && earlyDominant !== recentDominant) {
      const earlyCount = earlyTopics.get(earlyDominant) || 0
      const recentCount = recentTopics.get(recentDominant) || 0

      if (earlyCount >= 2 && recentCount >= 2) {
        const earlyPct = ((earlyCount / Math.max([...earlyTopics.values()].reduce((a, b) => a + b, 0), 1)) * 100).toFixed(0)
        const recentPct = ((recentCount / Math.max([...recentTopics.values()].reduce((a, b) => a + b, 0), 1)) * 100).toFixed(0)

        results.push({
          detector: 'DriftDetector',
          type: 'drift',
          severity: recentCount >= 5 && earlyCount >= 3 ? 'high' : 'medium',
          title: '关注点发生了漂移',
          description: `早期的关注重心是「${earlyDominant}」（${earlyPct}%），近期已转向「${recentDominant}」（${recentPct}%）。这种漂移可能意味着项目方向在变化。`,
          evidence: [
            `早期核心: ${earlyDominant}（${earlyCount} 次）`,
            `近期核心: ${recentDominant}（${recentCount} 次）`
          ],
          novelty: 75,
          impact: 70,
          actionability: 60
        })
      }
    }

    const allEarlyTopics = new Set(earlyTopics.keys())
    const allRecentTopics = new Set(recentTopics.keys())
    const dropped = [...allEarlyTopics].filter(t => !allRecentTopics.has(t) && (earlyTopics.get(t) || 0) >= 3)

    if (dropped.length > 0) {
      results.push({
        detector: 'DriftDetector',
        type: 'drift',
        severity: 'low',
        title: '部分早期关注点已被搁置',
        description: `以下话题早期频繁讨论但近期已不再出现：${dropped.join('、')}`,
        evidence: dropped.map(t => `${t}（早期 ${earlyTopics.get(t)} 次 → 近期 0 次）`),
        novelty: 40,
        impact: 45,
        actionability: 50
      })
    }

    return results
  }
}
