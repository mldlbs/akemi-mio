/**
 * MemoryAsrHypothesisGenerator — Memory 路径的语音假设生成器
 *
 * 职责：
 * 在 ASR 转录的同时，利用 Memory 系统的多方面信息（话题转移预测、
 * 行为加权兴趣画像、对话摘要、用户画像）生成一个关于用户可能发言
 * 内容的预测假设（Hypothesis），用于后续与 ASR 结果交叉验证。
 *
 * 输入：
 * - AsrConversationContext（当前对话上下文）
 * - MemoryService 引用（可选，提供更多预测信号）
 *
 * 输出：
 * - MemoryAsrHypothesis（预测文本、关键词、置信度）
 *
 * 设计原则：
 * - 轻量：不使用 LLM，仅基于已有 Memory 数据的聚合和规则
 * - 快速：在 ASR 转录期间即可生成，不增加关键路径延迟
 * - 可降级：Memory 数据不足时返回低置信度假设，不影响主流程
 */

import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { AsrConversationContext, MemoryAsrHypothesis } from './types'
import { log } from '@akemi-mio/core/logger/Logger'

export class MemoryAsrHypothesisGenerator {
  private memoryService: MemoryService | null = null

  /**
   * 注入 MemoryService 引用（可选，用于获取话题转移预测和兴趣画像）。
   * 不注入时，假设生成器仅基于 AsrConversationContext 工作。
   */
  setMemoryService(service: MemoryService): void {
    this.memoryService = service
  }

  /**
   * 基于对话上下文和 Memory 数据生成语音假设。
   *
   * @param context 当前对话上下文（由 AsrContextBuilder 从 Memory 摘要中提取）
   * @returns MemoryAsrHypothesis
   */
  generate(context: AsrConversationContext | null): MemoryAsrHypothesis {
    const now = Date.now()

    // 无上下文时返回空的假设
    if (!context || (!context.topics.length && !context.keyEntities.length)) {
      return this.createEmptyHypothesis(now)
    }

    // 1. 从对话摘要提取话题和实体
    const topicKeywords = context.topics.slice(0, 15)
    const entityKeywords = context.keyEntities.slice(0, 15)

    // 2. 从 Memory 获取话题转移预测（若有 MemoryService）
    let predictedTopics: string[] = []
    let interestKeywords: string[] = []

    if (this.memoryService) {
      try {
        // 话题转移预测：基于当前话题预测下一话题
        if (context.topics.length > 0) {
          try {
            const predictions = this.memoryService.topicTransitionPredictor.predictNextTopics(context.topics.slice(0, 3), 5)
            predictedTopics = predictions.map((p: any) => (typeof p === 'string' ? p : p.topic || '')).filter(Boolean)
          } catch {
            // 预测失败不阻塞
          }
        }

        // 兴趣画像关键词
        try {
          const profile = this.memoryService.getCurrentInterestProfile()
          if (profile && profile.topicWeights.size > 0) {
            interestKeywords = this.memoryService.behaviorWeighting.getTopInterests(profile, 8)
          }
        } catch {
          // 画像获取失败不阻塞
        }
      } catch (err) {
        log('WARN', 'memory_hypothesis_memory_fetch_failed', {
          error: String(err),
        })
      }
    }

    // 3. 合并所有关键词（去重）
    const allKeywords = [...new Set([...topicKeywords, ...entityKeywords, ...predictedTopics, ...interestKeywords])]

    // 4. 构建预测文本
    const predictedText = this.buildPredictedText(allKeywords, context)

    // 5. 计算预测置信度
    const confidence = this.calculateConfidence(allKeywords, context, predictedTopics, interestKeywords)

    return {
      predictedText,
      confidence,
      expectedKeywords: allKeywords.slice(0, 25),
      sources: {
        topics: topicKeywords,
        entities: entityKeywords,
        predictedTopics,
        interestProfile: interestKeywords,
      },
      timestamp: now,
    }
  }

  /** 生成空的假设（当上下文不足时） */
  private createEmptyHypothesis(timestamp: number): MemoryAsrHypothesis {
    return {
      predictedText: '',
      confidence: 0,
      expectedKeywords: [],
      sources: { topics: [], entities: [], predictedTopics: [], interestProfile: [] },
      timestamp,
    }
  }

  /**
   * 将关键词集合组合为自然语言描述形式的预测文本。
   * 格式如："根据对话上下文，用户可能正在讨论：编程、TypeScript、React 等相关话题。"
   */
  private buildPredictedText(keywords: string[], context: AsrConversationContext): string {
    if (keywords.length === 0) return ''

    const parts: string[] = ['根据对话上下文，用户可能正在讨论：']

    // 取前 10 个关键词作为预测文本
    const display = keywords.slice(0, 10)
    parts.push(display.join('、'))

    if (context.recentUserText) {
      parts.push('。最近提到：')
      const snippet = context.recentUserText.length > 40 ? context.recentUserText.slice(0, 40) + '…' : context.recentUserText
      parts.push(snippet)
    }

    parts.push('等相关内容。')
    return parts.join('')
  }

  /**
   * 根据上下文丰富度计算假设置信度。
   * - 高丰富度（≥10 关键词、有话题转移预测、有兴趣画像）→ 0.6–0.8
   * - 中等丰富度（3–9 关键词）→ 0.3–0.6
   * - 低丰富度（<3 关键词）→ 0–0.3
   */
  private calculateConfidence(
    keywords: string[],
    context: AsrConversationContext,
    predictedTopics: string[],
    interestKeywords: string[],
  ): number {
    if (keywords.length === 0) return 0

    let confidence = 0.2 // 基础分

    // 关键词数量贡献
    confidence += Math.min(0.3, keywords.length * 0.03)

    // 有话题转移预测的额外加分
    if (predictedTopics.length > 0) {
      confidence += 0.1
    }

    // 有兴趣画像的额外加分
    if (interestKeywords.length > 0) {
      confidence += 0.1
    }

    // 有 recentUserText 的额外加分
    if (context.recentUserText) {
      confidence += 0.1
    }

    // 有实体的额外加分（实体比一般关键词更有预测价值）
    if (context.keyEntities.length >= 3) {
      confidence += 0.1
    }

    return Math.min(1, confidence)
  }
}

// ===== 单例 =====
export const memoryAsrHypothesisGenerator = new MemoryAsrHypothesisGenerator()
