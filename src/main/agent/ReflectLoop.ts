import { log } from '../logger/Logger'
import { LlmService } from '../llm/LlmService'
import { EngineeringMemory } from '../memory/EngineeringMemory'
import type { ResourceBudget } from '../core/ResourceBudget'

export interface ReflectionResult {
  summary: string
  patterns: string[]
  improvements: string[]
  confidence: number
}

const REFLECTION_PROMPT = `你刚刚完成了一次与用户的交互。请快速反思（1-2秒思考）：

1. 这次交互顺利吗？有没有哪个工具调用失败或超时？
2. 用户是否重复了之前的指令（可能意味着第一次没做好）？
3. 有没有什么模式值得记住？

输出 JSON，不要多余文字：
{
  "summary": "一句话总结",
  "patterns": ["值得记住的模式，最多2条"],
  "improvements": ["下次可以做得更好的地方，最多2条"],
  "confidence": 0.0-1.0
}`

/**
 * Lightweight reflect loop — runs after each agent interaction.
 * Non-blocking: fire-and-forget, stores findings in EngineeringMemory.
 */
export class ReflectLoop {
  private llmService: LlmService | null = null
  private engineering: EngineeringMemory | null = null
  private resourceBudget: ResourceBudget | null = null
  private recentReflections: Array<{ summary: string; timestamp: number }> = []
  private consecutiveReflectionFailures = 0

  setDeps(llmService: LlmService, engineering: EngineeringMemory): void {
    this.llmService = llmService
    this.engineering = engineering
  }

  setResourceBudget(budget: ResourceBudget): void {
    this.resourceBudget = budget
  }

  /** 触发一次反射（异步，fire-and-forget） */
  trigger(context: {
    requestId: string
    userMessage: string
    toolCalls?: Array<{ name: string; error?: string }>
    planActive?: boolean
    replyLength: number
    durationMs: number
  }): void {
    if (!this.llmService || !this.engineering) return

    if (this.consecutiveReflectionFailures >= 3) {
      if (this.consecutiveReflectionFailures === 3) {
        log('WARN', 'reflect_loop_suppressed', { reason: '3 consecutive failures' })
        this.consecutiveReflectionFailures++
      }
      return
    }

    if (context.replyLength < 10 && context.toolCalls?.length === 0) return

    setTimeout(async () => {
      try {
        await this.runReflection(context)
        this.consecutiveReflectionFailures = 0
      } catch (err) {
        this.consecutiveReflectionFailures++
        log('WARN', 'reflect_loop_failed', { error: String(err) })
      }
    }, 0)
  }

  private async runReflection(context: {
    requestId: string
    userMessage: string
    toolCalls?: Array<{ name: string; error?: string }>
    planActive?: boolean
    replyLength: number
    durationMs: number
  }): Promise<void> {
    const toolSummary = context.toolCalls?.length
      ? `工具调用: ${context.toolCalls.map((t) => `${t.name}${t.error ? ` (ERR:${t.error.slice(0, 40)})` : ''}`).join(', ')}`
      : '无工具调用'

    const prompt = `${REFLECTION_PROMPT}

交互详情：
- 用户消息: ${context.userMessage.slice(0, 100)}
- ${toolSummary}
- 响应长度: ${context.replyLength} chars
- 耗时: ${context.durationMs}ms
- 有活跃计划: ${context.planActive}`

    // 消耗 background budget
    try {
      this.resourceBudget?.consumeLlmCall('background')
    } catch {
      log('WARN', 'reflect_loop_budget_exhausted')
      return
    }

    const result = await this.llmService!.chatJson(prompt, {
      system: '你是一个轻量级反思引擎。简短、精确、JSON only。',
      temperature: 0.2,
      timeoutMs: 8000,
      requestId: `reflect_${context.requestId}`,
    })

    if (result.error || !result.data) {
      log('WARN', 'reflect_llm_failed', { requestId: context.requestId, error: result.error })
      return
    }

    const reflection: ReflectionResult = typeof result.data === 'string' ? JSON.parse(result.data) : (result.data as ReflectionResult)

    if (reflection.confidence < 0.4) return

    const content = [
      `【反思】${reflection.summary}`,
      reflection.patterns.length ? `模式: ${reflection.patterns.join('; ')}` : '',
      reflection.improvements.length ? `改进: ${reflection.improvements.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    this.engineering!.store({
      type: 'failure_pattern',
      content,
      source: 'reflect_loop',
      confidence: reflection.confidence,
      relatedFiles: [],
      tags: [...reflection.patterns.map((p) => p.slice(0, 20)), ...reflection.improvements.map((i) => i.slice(0, 20))],
    })

    this.recentReflections.push({ summary: reflection.summary, timestamp: Date.now() })
    if (this.recentReflections.length > 20) {
      this.recentReflections = this.recentReflections.slice(-20)
    }
  }

  /** 格式化反思上下文，注入 system prompt */
  getFormattedContext(): string {
    if (this.recentReflections.length === 0) return ''

    const recent = this.recentReflections.slice(-3)
    const parts = ['---', '【近期自我反思】']
    for (const r of recent) {
      parts.push(`- ${r.summary}`)
    }
    parts.push('---')
    return parts.join('\n')
  }
}
