import { log } from '@akemi-mio/core/logger/Logger'
import type { ObserverLlmService } from './ObserverLlmService'
import type { ObserverStore } from './ObserverStore'
import type { TopicCandidate, ResearchResult, BrainOutput, InsightOutput, InsightSection, WritingMode, BrainContributions } from './types'
import { INSIGHT_SECTION_TITLES, WRITING_MODE_LABELS } from './types'

/**
 * InsightComposer — 五段式结构化输出
 *
 * 将研究结果 + 四脑输出转化为 5 段 markdown 文章。
 * 3 种写作模式 (neutral/analytical/creative) 控制语气。
 *
 * 写入格式 = YAML frontmatter + markdown（兼容 essays/published/）
 */
export class InsightComposer {
  private llm: ObserverLlmService
  private store: ObserverStore

  constructor(llm: ObserverLlmService, store: ObserverStore) {
    this.llm = llm
    this.store = store
  }

  async compose(topic: TopicCandidate, research: ResearchResult, brainOutputs: BrainOutput[], mode: WritingMode): Promise<InsightOutput> {
    const startedAt = Date.now()
    const id = `obs_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const writerContent = brainOutputs.find((b) => b.brain === 'writer')?.content ?? ''
    const analystContent = brainOutputs.find((b) => b.brain === 'analyst')?.content ?? ''
    const curiosityContent = brainOutputs.find((b) => b.brain === 'curiosity')?.content ?? ''

    const sections: InsightSection[] = []
    const missingSections: string[] = []

    // Section 1: 发生了什么 — 从结构化数据组装
    const s1 = this.assembleSection1(research)
    if (s1) sections.push({ title: INSIGHT_SECTION_TITLES[1], content: s1 })
    else missingSections.push(INSIGHT_SECTION_TITLES[1])

    const SECTION_SYSTEM =
      '用中文回答。禁止使用：然而、不仅、而且、因此、总之、显而易见、不可忽视、值得关注、引人深思、从某种意义上说、由此可见、综上所述。直接写内容，不要自我评价。'
    const sectionGens: { index: number; title: string; prompt: string; system: string; temperature: number }[] = [
      {
        index: 2,
        title: INSIGHT_SECTION_TITLES[2],
        prompt: `主题：「${topic.topic}」\n分析材料：${analystContent.slice(0, 2000)}\n只写一个核心结构：是什么力量在驱动这件事？用一句话开头然后 2-3 句解释。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.4,
      },
      {
        index: 3,
        title: INSIGHT_SECTION_TITLES[3],
        prompt: `主题：「${topic.topic}」\n事实：${research.facts.slice(0, 5).join('；')}\n${curiosityContent.slice(0, 800)}\n列出 2-3 个不同立场，每行用「一方认为」开头。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.5,
      },
      {
        index: 4,
        title: INSIGHT_SECTION_TITLES[4],
        prompt: `主题：「${topic.topic}」\n素材：${writerContent.slice(0, 2000)}\n用第一人称「我」写一段个人看法，像在和朋友聊天。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.7,
      },
      {
        index: 5,
        title: INSIGHT_SECTION_TITLES[5],
        prompt: `主题：「${topic.topic}」\n因果：${research.causalLinks
          .slice(0, 5)
          .map((c) => `${c.cause}→${c.effect}`)
          .join('；')}\n冲突：${research.conflicts
          .slice(0, 3)
          .map((c) => `${c.partyA} vs ${c.partyB}`)
          .join('；')}\n写一件事半年后会怎样，只写一种走向，不说另一方面。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.4,
      },
    ]

    for (const gen of sectionGens) {
      const result = await this.llm.generate(gen.prompt, { system: gen.system, temperature: gen.temperature, maxTokens: 2048 })
      if (result.data && result.data.length > 20) {
        sections.push({ title: gen.title, content: result.data })
      } else {
        missingSections.push(gen.title)
        log('WARN', 'insight_section_empty', { section: gen.title, error: result.error })
      }
    }

    const contributions = this.calcContributions(brainOutputs)
    const content = this.formatInsightMarkdown(topic, sections, mode, missingSections)
    this.store.saveEssay(content, 'published')

    const insight: InsightOutput = {
      id,
      topic: topic.topic,
      mode,
      generatedAt: new Date().toISOString(),
      sections,
      ...(missingSections.length > 0 ? { missingSections } : {}),
      metadata: {
        wordCount: content.split(/\s+/).length,
        confidence: sections.length / 5,
        brainContributions: contributions,
        llmCalls: sectionGens.length + 1,
        durationMs: Date.now() - startedAt,
      },
    }

    this.store.saveInsight(insight)
    log('INFO', 'insight_composed', { id, topic: topic.topic, mode, sections: `${sections.length}/5` })
    return insight
  }

  // ── private ──────────────────────────────────────────────

  private assembleSection1(research: ResearchResult): string {
    const lines: string[] = []
    if (research.facts.length > 0) lines.push(...research.facts.slice(0, 8).map((f) => `- ${f}`))
    if (research.timeline.length > 0) {
      lines.push('', '时间线：')
      lines.push(...research.timeline.slice(0, 8).map((t) => `- **${t.time}**: ${t.event}`))
    }
    return lines.length > 0 ? lines.join('\n') : ''
  }

  private calcContributions(brainOutputs: BrainOutput[]): BrainContributions {
    const get = (name: string) => brainOutputs.find((b) => b.brain === name)?.content.length ?? 1
    const p = get('perception'),
      c = get('curiosity'),
      a = get('analyst'),
      w = get('writer')
    const sum = p + c + a + w
    return {
      perception: parseFloat((p / sum).toFixed(2)),
      curiosity: parseFloat((c / sum).toFixed(2)),
      analyst: parseFloat((a / sum).toFixed(2)),
      writer: parseFloat((w / sum).toFixed(2)),
    }
  }

  private formatInsightMarkdown(topic: TopicCandidate, sections: InsightSection[], mode: WritingMode, missingSections: string[]): string {
    const fm = [
      '---',
      `mode: ${mode}`,
      `topic: ${topic.topic}`,
      `probability: ${topic.probability}`,
      `sections: ${sections.length}/5`,
      ...(missingSections.length > 0 ? [`missing: ${missingSections.join(', ')}`] : []),
      '---',
      '',
      `# ${topic.topic}`,
      '',
    ].join('\n')
    return fm + sections.map((s) => `## ${s.title}\n\n${s.content.trim()}\n`).join('\n')
  }
}
