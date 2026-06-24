import type { CreativitySource } from './types'
import { resolveRandom, type RandomGenerator } from '../utils/random'

/**
 * SourceBuilder — 每轮创造力周期动态构建来源
 *
 * 相比旧版 AppRuntime 的静态字符串，这里注入：
 * 1. 来自各模块的实际运行数据（延迟、计数、错误率）
 * 2. 外部 Provocation 概念（跨领域刺激 + 反向约束）
 * 3. 已拒绝思路的重组片段
 */
export class SourceBuilder {
  private rng: RandomGenerator

  /** Provocation 池：外部领域概念 */
  private domainConcepts = [
    '生物进化：自然选择、突变、适应度景观',
    '博弈论：纳什均衡、囚徒困境、信号传递',
    '城市规划：多中心结构、道路分级、功能分区',
    '免疫系统：抗原识别、记忆细胞、自耐受',
    '音乐和声：对位法、主题变奏、动机发展',
    '神经可塑性：长时程增强、突触修剪、关键期',
    '软件供应链：依赖管理、SBOM、供应者信任',
    '分布式共识：Paxos、Raft、Gossip 协议',
    '经济学：边际效用、机会成本、市场设计',
    '军事指挥：OODA 循环、任务式指挥、侦察反馈',
  ]

  /** Provocation 池：反向约束 */
  private constraints = [
    '如果不能使用任何 LLM，纯规则引擎',
    '如果用户只能输入 3 个词（极简交互）',
    '如果 Mio 必须完全离线运行',
    '如果要支持 100 人同时使用',
    '如果每个决策必须对非技术用户可解释',
    '如果所有数据必须在 1 秒后自动销毁',
    '如果只有 64MB 内存可用',
    '如果用户是视障人士（纯语音界面）',
    '如果不允许写任何文件到磁盘',
    '如果每轮响应必须在 100ms 内完成',
  ]

  /** 已经用过的 provocation 索引 */
  private usedProvocations: number[] = []
  private usedConstraints: number[] = []

  constructor(seed?: number) {
    this.rng = resolveRandom(seed)
  }

  /**
   * 构建一轮创造力来源
   * @param moduleData 各模块运行时数据
   * @param rejectedIdeas 最近被拒绝的假设片段
   */
  build(
    moduleData: {
      memory?: { entryCount: number; recentTopics: string[]; lastAddedAt: number }
      userBehavior?: { interactionCount: number; recentLabels: string[]; peakHours: string }
      asr?: { avgLatencyMs: number; errorRate: number; domainTerms: string[] }
      tts?: { charsSynthesized: number; queueLength: number }
      agent?: { toolCalls: number; successRate: number; topTools: string[] }
      evolution?: { generation: number; strategyCount: number; recentEvents: string[] }
      observer?: { trends: string[]; insights: string[] }
    },
    rejectedIdeas: string[] = [],
    worldTrends?: string[],
  ): CreativitySource[] {
    const sources: CreativitySource[] = []

    // 1. Memory
    const memInfo = moduleData.memory
    sources.push({
      name: 'Memory',
      content: memInfo
        ? `对话记忆系统：${memInfo.entryCount} 条记录，最近话题: ${memInfo.recentTopics.slice(0, 3).join('、') || '无'}`
        : '对话记忆系统',
      type: 'knowledge',
      weight: 0.9,
    })

    // 2. MCP
    sources.push({
      name: 'MCP',
      content: `工具调用框架：${moduleData.agent ? `${moduleData.agent.topTools.slice(0, 3).join(', ')} 等 ${moduleData.agent.toolCalls} 次调用` : '多工具集成'}`,
      type: 'knowledge',
      weight: 0.8,
    })

    // 3. ASR
    const asrInfo = moduleData.asr
    sources.push({
      name: 'ASR',
      content: asrInfo
        ? `语音识别：平均延迟 ${asrInfo.avgLatencyMs}ms，错误率 ${(asrInfo.errorRate * 100).toFixed(1)}%，识别领域: ${asrInfo.domainTerms.slice(0, 3).join('、') || '通用'}`
        : '语音识别',
      type: 'knowledge',
      weight: 0.7,
    })

    // 4. TTS
    const ttsInfo = moduleData.tts
    sources.push({
      name: 'TTS',
      content: ttsInfo ? `语音合成：本小时合成 ${ttsInfo.charsSynthesized} 字符，队列深度 ${ttsInfo.queueLength}` : '语音合成',
      type: 'knowledge',
      weight: 0.7,
    })

    // 5. Agent
    const agentInfo = moduleData.agent
    sources.push({
      name: 'Agent',
      content: agentInfo
        ? `Agent 服务：${agentInfo.toolCalls} 次工具调用，成功率 ${(agentInfo.successRate * 100).toFixed(0)}%，最常用 ${agentInfo.topTools.slice(0, 3).join(', ')}`
        : 'Agent 服务',
      type: 'knowledge',
      weight: 0.9,
    })

    // 6. Evolution
    const evoInfo = moduleData.evolution
    sources.push({
      name: 'Evolution',
      content: evoInfo
        ? `自进化系统：第 ${evoInfo.generation} 代，${evoInfo.strategyCount} 个策略，最近事件: ${evoInfo.recentEvents.slice(0, 3).join(' | ') || '无'}`
        : '自进化系统',
      type: 'knowledge',
      weight: 0.8,
    })

    // 7. Wallpaper
    sources.push({
      name: 'Wallpaper',
      content: '桌面壁纸集成：Overlay 渲染、透明窗口、系统托盘',
      type: 'knowledge',
      weight: 0.5,
    })

    // 8. PiperTTS
    sources.push({
      name: 'PiperTTS',
      content: '本地 TTS：离线语音合成、低延迟、多语音模型',
      type: 'knowledge',
      weight: 0.5,
    })

    // 9. UserBehavior
    const ubInfo = moduleData.userBehavior
    sources.push({
      name: 'UserBehavior',
      content: ubInfo
        ? `最近交互 ${ubInfo.interactionCount} 次，活跃话题: ${ubInfo.recentLabels.slice(0, 3).join('、') || '无'}，高峰时段: ${ubInfo.peakHours}`
        : `最近交互 ${ubInfo?.interactionCount || 0} 次`,
      type: 'behavior',
      weight: 0.7,
    })

    // 10. 世界趋势 — 来自 Observer 的真实世界信息
    if (worldTrends && worldTrends.length > 0) {
      // 最多取 3 条趋势作为 provocation 来源
      const picked = worldTrends.slice(0, 3)
      for (const trend of picked) {
        sources.push({
          name: `趋势:${trend.slice(0, 12)}`,
          content: trend,
          type: 'provocation',
          weight: 0.85,
        })
      }
    } else {
      // fallback: 无世界数据时用硬编码领域概念
      const domainConcept = this.pickProvocation()
      if (domainConcept) {
        sources.push({
          name: `刺激:${domainConcept.split('：')[0]}`,
          content: domainConcept,
          type: 'provocation',
          weight: 0.85,
        })
      }
    }

    // 11. 反向约束
    const constraint = this.pickConstraint()
    if (constraint) {
      sources.push({
        name: `约束:${constraint.slice(0, 16)}`,
        content: constraint,
        type: 'provocation',
        weight: 0.8,
      })
    }

    // 12. 世界洞察 — 来自 Observer 的 insight 摘要
    if (moduleData.observer?.insights && moduleData.observer.insights.length > 0) {
      for (const insight of moduleData.observer.insights.slice(0, 2)) {
        sources.push({
          name: `洞察:${insight.slice(0, 16)}`,
          content: insight,
          type: 'insight',
          weight: 0.75,
        })
      }
    }

    // 13. 已拒绝假设片段（随机取一条）
    if (rejectedIdeas.length > 0) {
      const picked = rejectedIdeas[Math.floor(this.rng() * rejectedIdeas.length)]
      sources.push({
        name: '已拒绝思路',
        content: `之前尝试过但不可行的方向: ${picked}`,
        type: 'failure',
        weight: 0.6,
      })
    }

    return sources
  }

  /**
   * 从 domain 概念池中选一个未用过的
   */
  private pickProvocation(): string | null {
    const available = this.domainConcepts.filter((_, i) => !this.usedProvocations.includes(i))
    if (available.length === 0) {
      this.usedProvocations = [] // 全部用过了，重置
      return this.domainConcepts[Math.floor(this.rng() * this.domainConcepts.length)]
    }
    const idx = Math.floor(this.rng() * available.length)
    const originalIdx = this.domainConcepts.indexOf(available[idx])
    this.usedProvocations.push(originalIdx)
    return available[idx]
  }

  /**
   * 从约束池中选一个未用过的
   */
  private pickConstraint(): string | null {
    const available = this.constraints.filter((_, i) => !this.usedConstraints.includes(i))
    if (available.length === 0) {
      this.usedConstraints = [] // 全部用过了，重置
      return this.constraints[Math.floor(this.rng() * this.constraints.length)]
    }
    const idx = Math.floor(this.rng() * available.length)
    const originalIdx = this.constraints.indexOf(available[idx])
    this.usedConstraints.push(originalIdx)
    return available[idx]
  }

  /** 重置 provocation 使用记录（新梦周期触发） */
  resetProvocations(): void {
    this.usedProvocations = []
    this.usedConstraints = []
  }
}
