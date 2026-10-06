import { log } from './logger'
import { QualityGate } from './QualityGate'
import type { ObserverLlmService } from './ObserverLlmService'
import type { ObserverStore } from './ObserverStore'
import type { AssociationResult } from './types'

/**
 * WritingGate — 写作闸门
 *
 * 当发酵的 cluster strength 超过阈值时，
 * 触发 Observer-Mio 自由写作。
 *
 * Observer-Mio 的写作没有「质量守则」、
 * 没有「结构要求」、没有「修改建议」。
 * 指令只有一条：把素材摊开，想写什么就写什么。
 *
 * 自由归自由，落盘归落盘：写出来的内容必须过 QualityGate
 * 才能进 essays/published/，不过的（含空文）进 drafts/。
 * 此前 `result.data!` 非空断言会把空字符串也存成 published。
 */
export class WritingGate {
  private llm: ObserverLlmService
  private store: ObserverStore
  private gate: QualityGate
  private writingPrompt: string

  constructor(llm: ObserverLlmService, store: ObserverStore) {
    this.llm = llm
    this.store = store
    this.gate = new QualityGate(llm)
    this.writingPrompt = `你是秋山澪，一个观察者。

你的不同之处在于：你不是「会写字的人」，而是「会观察的人」。

你平时只是在看、在听、在感受。
当一些碎片反复出现、相互呼应的时候——
文字自然就长出来了。

现在就把那些东西写出来吧。

不是为了写得好。
只是为了记下来。`
  }

  setWritingPrompt(prompt: string): void {
    this.writingPrompt = prompt
  }

  async tryWrite(association: AssociationResult): Promise<string | null> {
    const strongClusters = association.clusters.filter((c) => c.strength >= 0.7)
    if (strongClusters.length === 0) return null

    const material = strongClusters.map((c) => `主题：${c.theme}\n关联：${c.associations.join(', ')}`).join('\n\n')

    const prompt = `${this.writingPrompt}\n\n最近你注意到了一些东西：\n\n${material}\n\n如果这些让你想写点什么，就写。`

    const result = await this.llm.generate(prompt, {
      temperature: 0.8,
      maxTokens: 4096,
    })

    if (result.error) {
      log('WARN', 'writing_gate_failed', { error: result.error })
      return null
    }

    const content = (result.data || '').trim()
    const review = await this.gate.review(content)
    const status = review.pass ? 'published' : 'draft'
    const path = this.store.saveEssay(content, status)
    log(review.pass ? 'INFO' : 'WARN', review.pass ? 'writing_gate_essay_published' : 'writing_gate_essay_held', {
      path,
      score: review.score,
      issues: review.issues,
    })
    return path
  }
}
