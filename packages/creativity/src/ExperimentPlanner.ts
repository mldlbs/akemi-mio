import type { Hypothesis, ExperimentPlan } from './types'
import { resolveRandom, type RandomGenerator, randomPick } from '@akemi-mio/core/utils/random'

/**
 * ExperimentPlanner — 将假设转化为可验证的实验方案
 *
 * 创造力最大的敌人是"幻想"。
 * 每个想法必须有办法验证它是否可行。
 */
export class ExperimentPlanner {
  private rng: RandomGenerator

  constructor(seed?: number) {
    this.rng = resolveRandom(seed)
  }
  plan(hypothesis: Hypothesis): ExperimentPlan | null {
    if (hypothesis.novelty >= 90 && hypothesis.feasibility < 30) {
      // 极高新颖性但当前不可行的假设 → 只生成研究步骤而非实验
      return this.researchPlan(hypothesis)
    }

    return this.concretePlan(hypothesis)
  }

  private concretePlan(hypothesis: Hypothesis): ExperimentPlan {
    const steps = [
      `定义「${hypothesis.title}」的 MVP 范围`,
      `实现核心抽象层：${hypothesis.idea.slice(0, 40)}...`,
      `编写 A/B 测试比较新旧方案`,
      `收集运行数据和用户反馈`,
      `评估是否达到预期收益：${hypothesis.expectedBenefit}`,
    ]

    const criteria = [`功能完整性 >= 80%`, `性能不低于当前基线`, `用户无感知迁移`, `收益指标明确可量化`]

    const durations = ['3-5 天', '1-2 周', '2-3 周', '1 个月']
    const duration = randomPick(this.rng, durations)

    return {
      hypothesisId: hypothesis.id,
      title: `实验: ${hypothesis.title}`,
      steps,
      successCriteria: criteria,
      estimatedDuration: duration,
      createdAt: Date.now(),
    }
  }

  private researchPlan(hypothesis: Hypothesis): ExperimentPlan {
    return {
      hypothesisId: hypothesis.id,
      title: `研究: ${hypothesis.title}`,
      steps: [
        `调研同类系统中的实现方案`,
        `设计可行性原型（不开发完整功能）`,
        `使用 10% 的真实数据模拟验证`,
        `输出可行性评估报告`,
        `决定是否进入开发阶段`,
      ],
      successCriteria: [`可行性 >= 60%`, `落地成本可接受`, `与现有架构不冲突`],
      estimatedDuration: '1-2 天研究',
      createdAt: Date.now(),
    }
  }
}


