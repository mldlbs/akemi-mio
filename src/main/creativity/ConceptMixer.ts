import type { CreativitySource, ConceptCombo } from './types'
import { resolveRandom, type RandomGenerator } from '../utils/random'

/**
 * ConceptMixer — 创造力核心：旧概念随机重组产生新想法
 *
 * 人类创造力 ≈ 已有概念的重新组合
 * 输入来源越多、越多样，组合越新颖
 */
export class ConceptMixer {
  private rng: RandomGenerator

  constructor(seed?: number) {
    this.rng = resolveRandom(seed)
  }
  /**
   * 将所有来源两两配对并打分，返回前 N 个最有潜力的组合
   */
  mix(sources: CreativitySource[], maxCombos = 10): { combo: ConceptCombo; score: number }[] {
    if (sources.length < 2) return []

    const combos = this.generatePairs(sources)
    const scored = combos.map(([a, b]) => this.scorePair(a, b, sources))
    const sorted = scored.sort((a, b) => b.score - a.score)
    return sorted.slice(0, maxCombos)
  }

  private generatePairs(sources: CreativitySource[]): [CreativitySource, CreativitySource][] {
    const pairs: [CreativitySource, CreativitySource][] = []
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        pairs.push([sources[i], sources[j]])
      }
    }
    return pairs
  }

  private scorePair(a: CreativitySource, b: CreativitySource, allSources: CreativitySource[]): { combo: ConceptCombo; score: number } {
    // 同类型组合分数降低（重复视角），不同类型组合分数提高
    const typeBonus = a.type === b.type ? 10 : 40
    const weightProduct = a.weight * b.weight * 0.3
    const noveltyBonus = this.calculateNoveltyBonus(a.name, b.name, allSources)

    // 随机扰动：让组合有不可预测性
    const perturbation = this.rng() * 20

    const score = Math.round(typeBonus + weightProduct + noveltyBonus + perturbation)

    const description = this.describeCombo(a.name, b.name, a.type, b.type)

    const combo: ConceptCombo = {
      id: `combo_${Date.now()}_${this.rng().toString(36).slice(2, 6)}`,
      sources: [a.name, b.name],
      description,
      createdAt: Date.now()
    }

    return { combo, score }
  }

  private calculateNoveltyBonus(nameA: string, nameB: string, allSources: CreativitySource[]): number {
    // 跨类型组合本身就比同类型新颖
    return 10
  }

  private describeCombo(nameA: string, nameB: string, typeA: string, typeB: string): string {
    const comboType = `${typeA} × ${typeB}`
    const combos: Record<string, string> = {
      'knowledge × knowledge': `将「${nameA}」与「${nameB}」两种知识领域融合，形成跨领域新概念`,
      'knowledge × behavior': `将「${nameA}」的知识与「${nameB}」的行为模式结合`,
      'knowledge × insight': `用「${nameA}」的知识重新解读「${nameB}」的洞察`,
      'knowledge × failure': `从「${nameB}」的失败中寻找「${nameA}」的未被发现的价值`,
      'knowledge × random': `让「${nameA}」受到「${nameB}」的随机扰动产生变异`,
      'behavior × behavior': `合并「${nameA}」与「${nameB}」两种行为模式`,
      'behavior × insight': `用「${nameB}」的洞察解释「${nameA}」的行为`,
      'behavior × failure': `「${nameA}」的行为方式能否避免「${nameB}」的失败`,
      'behavior × random': `将「${nameA}」的行为方式与随机元素「${nameB}」杂交`,
      'insight × insight': `将两个洞察「${nameA}」与「${nameB}」放在一起，产生更深层的推论`,
      'insight × failure': `「${nameB}」的失败是否源于「${nameA}」所揭示的问题`,
      'insight × random': `用随机元素「${nameB}」扰动既有洞察「${nameA}」`,
      'failure × failure': `将「${nameA}」和「${nameB}」两种失败模式组合，避免重蹈覆辙`,
      'failure × random': `「${nameA}」的失败 + 「${nameB}」的随机扰动 = 全新方向`,
    }
    return combos[comboType] || `概念重组: ${nameA} × ${nameB}`
  }

  /**
   * 随机抽取一组来源（温度越高，越可能选中低权重来源）
   */
  pickRandomSources(sources: CreativitySource[], temperature: number, minCount = 3): CreativitySource[] {
    const weighted = sources.map(s => ({
      source: s,
      weight: s.weight * (0.5 + this.rng() * temperature)
    }))
    const sorted = weighted.sort((a, b) => b.weight - a.weight)
    const count = Math.min(sorted.length, Math.max(minCount, Math.floor(sorted.length * (0.3 + this.rng() * 0.5))))
    return sorted.slice(0, count).map(w => w.source)
  }
}
