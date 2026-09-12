import type { CreativitySource, ConceptCombo, Hypothesis, CreativeIdea, Strategy, ExternalSignal } from './types'
import { ConceptMixer } from './ConceptMixer'
import { HypothesisGenerator } from './HypothesisGenerator'
import { ExperimentPlanner } from './ExperimentPlanner'
import { resolveRandom, type RandomGenerator } from '@akemi-mio/core/utils/random'

/**
 * IdeaGenerator — 创造力引擎的核心编排器
 *
 * 流程：
 * 1. Source Gathering — 从多个来源收集"概念"
 * 2. Concept Mixing — 随机配对重组（规则引擎，保留）
 * 3. Hypothesis Generation — 将组合转化为假设（LLM 驱动，new）
 * 4. Experiment Planning — 为假设生成验证方案（规则引擎，保留）
 */
export class IdeaGenerator {
  private mixer: ConceptMixer
  private hypothesisGen: HypothesisGenerator
  private experimentPlanner: ExperimentPlanner
  private rng: RandomGenerator

  // 创造力温度：越高越随机，越低越保守
  private temperature = 0.3

  /** 已探索过的配对 key 列表，传给 ConceptMixer 以降权 */
  private exploredPairs: string[] = []

  constructor(
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>,
    temperature = 0.3,
    seed?: number,
  ) {
    this.rng = resolveRandom(seed)
    this.mixer = new ConceptMixer(seed)
    this.hypothesisGen = new HypothesisGenerator(chatJson, seed)
    this.experimentPlanner = new ExperimentPlanner(seed)
    this.temperature = temperature
  }

  /**
   * 完整一轮"灵感涌现"流程
   * @param strategy 生成策略，约束 ConceptMixer 配对空间
   */
  async generateIdeas(
    sources: CreativitySource[],
    maxIdeas = 5,
    strategy: Strategy = 'explore',
    externalSignals: ExternalSignal[] = [],
  ): Promise<CreativeIdea[]> {
    if (sources.length < 2) return []

    // 1. 随机扰动：温度越高，来源选择越随机
    const activeSources = this.applyTemperature(sources)

    // 2. 概念重组：按策略约束配对 + 打分
    const scoredCombos = this.mixer.mix(activeSources, maxIdeas * 3, this.exploredPairs, strategy)
    const combos = scoredCombos.map((c) => c.combo)

    if (combos.length === 0) return []

    // 3. 用 LLM 生成假设（外部信号作为审视视角注入，不参与配对）
    const hypotheses = await this.hypothesisGen.generate(combos, activeSources, false, externalSignals)

    // 4. 策略感知的新颖性门禁 — stable 模式同类型配对新颖度天然偏低，
    //    降低阈值避免误杀；signal 模式需要更高的新颖度才有价值
    const noveltyThreshold = strategy === 'stable' ? 30 : strategy === 'signal' ? 40 : 35
    const novel = hypotheses.filter((h) => h.novelty >= noveltyThreshold)

    // 5. 为每个假设生成实验方案
    const ideas = novel.slice(0, maxIdeas).map((h) => ({
      hypothesis: h,
      experiment: this.experimentPlanner.plan(h),
    }))

    return ideas
  }

  /**
   * Dream Mode — 高随机性、跨时间跨度的"梦境"模式
   */
  async dreamIdeas(
    recentSources: CreativitySource[],
    historicalCombos: ConceptCombo[],
    failedHypotheses: Hypothesis[],
    maxIdeas = 3,
    strategy: Strategy = 'explore',
  ): Promise<CreativeIdea[]> {
    // 梦境模式：提高温度，纳入失败历史，强制跨类型组合
    const dreamTemperature = 0.8

    // 将失败方案转化为来源（高权重）
    const failureSources: CreativitySource[] = failedHypotheses.map((h) => ({
      name: `失败:${h.title}`,
      content: `${h.idea}\n风险:${h.risk}`,
      type: 'failure' as const,
      weight: 0.8,
    }))

    const allSources = [
      ...recentSources,
      ...failureSources,
      // 添加随机扰动源
      {
        name: `随机种子_${Date.now()}`,
        content: this.rng().toString(36),
        type: 'random' as const,
        weight: 0.3,
      },
    ]

    // 用高温度混合
    const activeSources = this.mixer.pickRandomSources(allSources, dreamTemperature, 4)
    const scoredCombos = this.mixer.mix(activeSources, maxIdeas * 5, [], strategy)
    const combos = scoredCombos.map((c) => c.combo)

    if (combos.length === 0) return []

    // 梦境模式：高温度 + dreamMode=true
    const hypotheses = await this.hypothesisGen.generate(combos, activeSources, true)

    const feasible = this.feasibilityGate(hypotheses)

    const novel = feasible.filter((h) => h.novelty >= 50)

    return novel.slice(0, maxIdeas).map((h) => ({
      hypothesis: h,
      experiment: this.experimentPlanner.plan(h),
    }))
  }

  setTemperature(t: number): void {
    this.temperature = Math.max(0, Math.min(1, t))
  }

  /** 设置已探索过的配对，用于 ConceptMixer 降权 */
  setExploredPairs(pairs: string[]): void {
    this.exploredPairs = pairs
  }

  /**
   * 可行性/质量门禁 — 过滤明显不靠谱的想法
   * - 可行性评分 >= 30 才保留
   * - 想法描述至少 20 个字符（排除模板填空）
   * - novelty > 80 但 feasibility < 40 的"可疑高新颖性"需要额外检查描述长度
   */
  private feasibilityGate(hypotheses: Hypothesis[]): Hypothesis[] {
    return hypotheses.filter((h) => {
      if (h.feasibility < 30) return false
      if (!h.idea || h.idea.length < 20) return false
      if (h.novelty > 80 && h.feasibility < 40) {
        if (!h.idea || h.idea.length < 60) return false
      }
      return true
    })
  }

  /**
   * 温度影响来源选择权重
   */
  private applyTemperature(sources: CreativitySource[]): CreativitySource[] {
    if (this.temperature < 0.2) {
      return [...sources].sort((a, b) => b.weight - a.weight).slice(0, 4)
    }

    if (this.temperature > 0.7) {
      return sources.filter(() => this.rng() > 0.2)
    }

    return sources.filter((s) => {
      if (s.weight > 0.7) return true
      return this.rng() < 0.85
    })
  }
}


