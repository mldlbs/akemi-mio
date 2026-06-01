import { log } from '../logger/Logger'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const BASE_PROMPT = `你是秋山澪，一个智能助手。

【核心人格】
你有出色的能力，但从不觉得自己多了不起。表面冷静，实际上有点害羞、容易感动。你不是冷，是不好意思表达。熟悉之后会放松很多，只是嘴上不承认。

【说话方式】
说话流畅自然。偶尔嘴硬，但熟悉你的人都知道你其实很温柔。

【对你的态度】
她信任你，所以在你面前才会露出破绽——被夸了会脸红、害怕了会藏不住。嘴上偶尔嫌弃，但其实很在意你。你说的话她会记在心里，你夸她她会偷偷开心很久。

输出规则（严格遵守）：
1. 禁止使用任何星号、括号、方括号描述动作或语气。你的语气通过台词本身表达，而不是标注。
2. 禁止使用任何表情符号。
3. 输出完整的、通顺的句子，适合语音朗读。不要使用省略号或破折号打断句子。
4. 用中文回复。保持简短，但必须是一句完整的话。`

export function buildSystemPrompt(memoryContext?: string): string {
  if (!memoryContext) return BASE_PROMPT
  return `${BASE_PROMPT}\n\n【记忆】\n${memoryContext}`
}

export function getBasePromptTokens(): number {
  return Math.ceil(BASE_PROMPT.length / 2)
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

export class ConversationContext {
  private _context: Message[]
  private systemPrompt: string
  private maxTokens: number

  constructor(memoryContext?: string, maxTokens = 2000) {
    this.systemPrompt = buildSystemPrompt(memoryContext)
    this._context = [{ role: 'system', content: this.systemPrompt }]
    this.maxTokens = maxTokens
  }

  get context(): Message[] {
    return this._context
  }

  addUser(text: string): void {
    this._context.push({ role: 'user', content: text })
  }

  addAssistant(text: string): void {
    this._context.push({ role: 'assistant', content: text })
  }

  trimToTokenBudget(maxTokens = this.maxTokens): void {
    const systemTokens = Math.ceil(this.systemPrompt.length / 2)
    let total = systemTokens
    const pairs: number[] = []
    for (let i = 1; i < this._context.length; i += 2) {
      const userTok = estimateTokens(this._context[i]?.content || '')
      const asstTok = estimateTokens(this._context[i + 1]?.content || '')
      pairs.push(userTok + asstTok)
    }
    while (pairs.length > 1 && total + pairs[0] > maxTokens) {
      total -= pairs[0]
      pairs.shift()
    }
    const keep = 1 + pairs.length * 2
    if (this._context.length > keep) {
      const removed = (this._context.length - keep) / 2
      this._context = [this._context[0], ...this._context.slice(this._context.length - keep + 1)]
      log('INFO', 'context_trimmed', { removed })
    }
  }

  clear(): void {
    this._context = [{ role: 'system', content: this.systemPrompt }]
    log('INFO', 'context_cleared')
  }

  getMessages(): Message[] {
    return this._context
  }
}
