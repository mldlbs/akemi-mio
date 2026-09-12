/**
 * MemoryAsrArbitrator — ASR 与 Memory 结果的仲裁器
 *
 * 职责：
 * 当 ASR 路径和 Memory 路径的交叉验证结果不一致时，
 * 根据配置的策略和置信度进行仲裁决策：
 *
 * 策略：
 * 1. ASR 优先（默认）：当 ASR 置信度高于阈值时，即使与 Memory 假设不匹配也信任 ASR
 * 2. Memory 优先：当 Memory 假设置信度高于阈值且 ASR 置信度较低时，采纳 Memory 假设
 * 3. 加权融合：两者置信度均不高时，根据加权结果做决策
 * 4. LLM 深度仲裁（可选）：调用 LLM 对严重冲突进行语义层面的裁定
 *
 * 所有仲裁决策均有明确的 reason 字段说明依据。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryAsrHypothesis, CrossValidationResult, ArbitrationResult, HybridPipelineConfig } from './types'

/** LLM 接口定义（可选依赖，只在使用 LLM 仲裁时才需要） */
export interface LlmArbitrationProvider {
  chatText(
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ): Promise<{ reply?: string; error?: string }>
}

/** 默认混合流水线配置 */
export const DEFAULT_HYBRID_CONFIG: HybridPipelineConfig = {
  enabled: true,
  agreementThreshold: 0.4,
  asrMinConfidence: 0.6,
  memoryMinConfidence: 0.4,
  enableLlmArbitration: false,
}

export class MemoryAsrArbitrator {
  private llmProvider: LlmArbitrationProvider | null = null

  /** 当前配置 */
  private config: HybridPipelineConfig = { ...DEFAULT_HYBRID_CONFIG }

  /**
   * 注入可选的 LLM 仲裁提供者。
   * 仅在 enableLlmArbitration=true 且同一次仲裁中 agreementLevel 极低时使用。
   */
  setLlmProvider(provider: LlmArbitrationProvider): void {
    this.llmProvider = provider
  }

  /** 更新配置 */
  updateConfig(partial: Partial<HybridPipelineConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** 获取当前配置 */
  getConfig(): HybridPipelineConfig {
    return { ...this.config }
  }

  /**
   * 执行仲裁决策。
   *
   * @param asrText           ASR 引擎输出的原始文本
   * @param asrConfidence      ASR 引擎的原始置信度（由 AsrConfidenceScorer 评估）
   * @param hypothesis         Memory 路径生成的假设
   * @param crossValidation    交叉验证结果
   * @param llmContext         可选的上下文信息（用于 LLM 仲裁的附加信息）
   * @returns                  仲裁结果
   */
  async arbitrate(
    asrText: string,
    asrConfidence: number,
    hypothesis: MemoryAsrHypothesis | null,
    crossValidation: CrossValidationResult,
    llmContext?: { requestId?: string; topicContext?: string },
  ): Promise<ArbitrationResult> {
    const { agreementThreshold, asrMinConfidence, memoryMinConfidence, enableLlmArbitration } = this.config
    const agreementLevel = crossValidation.agreementLevel

    // ── 情况 1：高度一致 → 信任 ASR ──
    if (agreementLevel >= agreementThreshold) {
      return {
        finalText: asrText,
        finalConfidence: Math.min(1, asrConfidence + crossValidation.confidenceAdjustment),
        source: 'asr_primary',
        arbitrationTriggered: false,
        reason: `交叉验证一致度 ${agreementLevel.toFixed(2)} ≥ 阈值 ${agreementThreshold}，信任 ASR 结果`,
      }
    }

    // ── 情况 2：不一致 → 触发仲裁 ──
    log('INFO', 'asr_arbitration_triggered', {
      agreement: agreementLevel.toFixed(2),
      asrText: asrText.slice(0, 50),
      asrConfidence: asrConfidence.toFixed(2),
      hasHypothesis: !!hypothesis,
    })

    // 情况 2a：ASR 置信度足够高 → 信任 ASR
    if (asrConfidence >= asrMinConfidence) {
      return {
        finalText: asrText,
        finalConfidence: Math.max(0, asrConfidence + crossValidation.confidenceAdjustment),
        source: 'asr_primary',
        arbitrationTriggered: true,
        reason: `仲裁: ASR 置信度 ${asrConfidence.toFixed(2)} ≥ 阈值 ${asrMinConfidence}，维持 ASR 结果（一致度 ${agreementLevel.toFixed(2)}）`,
      }
    }

    // 情况 2b：Memory 假设置信度足够高 → 采纳 Memory 假设
    if (hypothesis && hypothesis.confidence >= memoryMinConfidence && hypothesis.predictedText) {
      return {
        finalText: hypothesis.predictedText,
        finalConfidence: hypothesis.confidence,
        source: 'memory_primary',
        arbitrationTriggered: true,
        reason: `仲裁: ASR 置信度 ${asrConfidence.toFixed(2)} 过低，采纳 Memory 假设（置信度 ${hypothesis.confidence.toFixed(2)}）`,
      }
    }

    // 情况 2c：启用 LLM 深度仲裁 → 尝试 LLM 裁决
    if (enableLlmArbitration && this.llmProvider) {
      try {
        const llmResult = await this.performLlmArbitration(asrText, hypothesis, crossValidation, llmContext)
        return llmResult
      } catch (err) {
        log('WARN', 'asr_llm_arbitration_failed', {
          error: String(err),
        })
        // LLM 失败降级到情况 2d
      }
    }

    // 情况 2d：均不确定 → 返回 ASR 结果并标记低置信
    return {
      finalText: asrText,
      finalConfidence: Math.max(0, asrConfidence + crossValidation.confidenceAdjustment),
      source: 'asr_primary',
      arbitrationTriggered: true,
      reason: `仲裁: 两者均不可靠，降级返回 ASR 结果（一致度 ${agreementLevel.toFixed(2)}，ASR 置信度 ${asrConfidence.toFixed(2)}）`,
    }
  }

  /**
   * LLM 深度仲裁：调用 LLM 对不一致的 ASR 和 Memory 结果进行语义裁决。
   * 只在 enableLlmArbitration=true 且交叉验证严重不一致时调用。
   */
  private async performLlmArbitration(
    asrText: string,
    hypothesis: MemoryAsrHypothesis | null,
    crossValidation: CrossValidationResult,
    llmContext?: { requestId?: string; topicContext?: string },
  ): Promise<ArbitrationResult> {
    if (!this.llmProvider) {
      throw new Error('LLM provider not available for arbitration')
    }

    const system = `你是一个 ASR 纠错与裁决助手。你的任务是：
1. 阅读 ASR 识别出的文本和基于对话上下文的预测
2. 判断 ASR 文本在语义上是否合理（与当前对话上下文一致）
3. 如果不合理，尝试从上下文预测中推断更可能的正确文本
4. 以 JSON 格式输出裁决结果

注意：不要无意义地修改 ASR 结果，只在有明显问题时才进行修正。`

    const hypothesisInfo = hypothesis
      ? `\nMemory 预测（基于对话上下文）：
- 预测文本: ${hypothesis.predictedText}
- 预期关键词: ${hypothesis.expectedKeywords.slice(0, 10).join(', ')}
- 预测置信度: ${hypothesis.confidence.toFixed(2)}`
      : '\nMemory 预测: 无'

    const topicContext = llmContext?.topicContext || ''

    const userPrompt = `ASR 识别文本: "${asrText}"
ASR 置信度: 低${hypothesisInfo}
${topicContext ? `对话上下文摘要: ${topicContext}` : ''}
未命中的 Memory 关键词: ${crossValidation.unmatchedKeywords.slice(0, 10).join(', ')}

请判断：
1. ASR 结果是否合理？（是/否）
2. 如果不合理，请给出修正后的文本（如果你认为 ASR 正确则保留原文）
3. 你认为修正后的置信度是多少？（0-1）

以 JSON 格式返回：{"reasonable": boolean, "correctedText": string, "confidence": number}`

    const result = await this.llmProvider.chatText(userPrompt, {
      system,
      temperature: 0.2,
      timeoutMs: 10000,
      requestId: llmContext?.requestId,
    })

    if (result.error || !result.reply) {
      throw new Error(result.error || 'Empty LLM response')
    }

    // 尝试解析 LLM 返回
    try {
      const jsonMatch = result.reply.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        const reasonable = parsed.reasonable !== false
        const correctedText = parsed.correctedText || asrText
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5

        return {
          finalText: correctedText,
          finalConfidence: confidence,
          source: reasonable ? 'asr_primary' : 'fused',
          arbitrationTriggered: true,
          reason: `LLM 仲裁: ${reasonable ? '确认 ASR 结果合理' : '修正 ASR 结果'}`,
        }
      }
    } catch {
      // JSON 解析失败，降级
    }

    // LLM 响应解析失败，降级到 ASR 优先
    throw new Error('Failed to parse LLM arbitration result')
  }
}

// ===== 单例（使用默认配置） =====
export const memoryAsrArbitrator = new MemoryAsrArbitrator()
