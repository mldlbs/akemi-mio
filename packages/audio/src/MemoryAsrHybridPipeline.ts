/**
 * MemoryAsrHybridPipeline — Memory-ASR 混合流水线编排器
 *
 * 将 Memory 系统集成到 ASR 流程的核心编排点。
 *
 * 流水线结构：
 * ┌─────────────────────────────────────────────────────┐
 * │  MemoryAsrHybridPipeline                            │
 * │                                                     │
 * │  输入: AudioBuffer + ConversationContext             │
 * │                                                     │
 * │  ┌──────────────┐    ┌──────────────────────┐       │
 * │  │ Path A (ASR) │    │ Path B (Memory)      │       │
 * │  │ Audio → Text │    │ Context → Prediction │       │
 * │  │ (AsrService) │    │ (HypothesisGenerator)│       │
 * │  └──────┬───────┘    └─────────┬────────────┘       │
 * │         │                      │                    │
 * │         ▼                      ▼                    │
 * │  ┌──────────────────────────────────────┐           │
 * │  │  Confluence: CrossValidation          │           │
 * │  │  (MemoryAsrCrossValidator)            │           │
 * │  └──────────────────┬───────────────────┘           │
 * │                     ▼                               │
 * │  ┌──────────────────────────────────────┐           │
 * │  │  Arbitration (MemoryAsrArbitrator)   │           │
 * │  └──────────────────┬───────────────────┘           │
 * │                     ▼                               │
 * │  Final: AsrHybridResult                              │
 * └─────────────────────────────────────────────────────┘
 *
 * 关键设计：
 * - Path A 和 Path B 在并发上独立：Path B（Memory 预测）在音频
 *   转录前即可生成，实际与 Path A 并行执行
 * - 可降级：任一路径失败时透明降级到另一路径
 * - 可配置：通过 HybridPipelineConfig 控制行为和阈值
 * - 性能感知：默认不使用 LLM 仲裁（需显式开启）
 */

import { log, createRequestId } from '@akemi-mio/core/logger/Logger'
import type { AsrService } from './AsrService'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { AsrConversationContext, AsrHybridResult, VoiceEmotion, HybridPipelineConfig } from './types'
import { memoryAsrHypothesisGenerator } from './MemoryAsrHypothesisGenerator'
import { memoryAsrCrossValidator } from './MemoryAsrCrossValidator'
import { memoryAsrArbitrator, DEFAULT_HYBRID_CONFIG } from './MemoryAsrArbitrator'
import type { LlmArbitrationProvider } from './MemoryAsrArbitrator'
import { asrConfidenceScorer } from './AsrConfidenceScorer'
import type { AudioFeatures } from './types'

export class MemoryAsrHybridPipeline {
  private asrService: AsrService | null = null
  private memoryService: MemoryService | null = null
  private config: HybridPipelineConfig = { ...DEFAULT_HYBRID_CONFIG }

  /**
   * 注入 ASR 服务（Path A 的执行者）。
   */
  setAsrService(service: AsrService): void {
    this.asrService = service
  }

  /**
   * 注入 Memory 服务（Path B 的数据来源）。
   */
  setMemoryService(service: MemoryService): void {
    this.memoryService = service
    memoryAsrHypothesisGenerator.setMemoryService(service)
  }

  /**
   * 注入可选的 LLM 仲裁提供者。
   */
  setLlmProvider(provider: LlmArbitrationProvider): void {
    memoryAsrArbitrator.setLlmProvider(provider)
  }

  /**
   * 更新流水线配置。
   */
  updateConfig(partial: Partial<HybridPipelineConfig>): void {
    this.config = { ...this.config, ...partial }
    memoryAsrArbitrator.updateConfig(partial)
  }

  /**
   * 获取当前配置。
   */
  getConfig(): HybridPipelineConfig {
    return { ...this.config }
  }

  /**
   * 启用/禁用混合流水线。
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    memoryAsrArbitrator.updateConfig({ enabled })
  }

  /**
   * 判断混合流水线是否已就绪。
   */
  isReady(): boolean {
    return this.config.enabled && this.asrService !== null
  }

  // ══════════════════════════════════════════
  //  核心执行方法
  // ══════════════════════════════════════════

  /**
   * 执行 Memory-ASR 混合流水线。
   *
   * 流程：
   * 1. 生成 Memory 假设（Path B 准备，基于对话上下文）
   * 2. 执行 ASR 转录（Path A）
   * 3. 交叉验证（Confluence）
   * 4. 仲裁（如果需要）
   * 5. 返回 AsrHybridResult
   *
   * @param audioBuffer     PCM 音频数据 (16kHz Int16 ArrayBuffer)
   * @param context         对话上下文（由 AsrContextBuilder 从 Memory 提取）
   * @param audioFeatures   音频特征（可选，已在外部提取时可复用）
   * @param requestId       请求 ID（可选）
   * @returns               AsrHybridResult
   */
  async run(
    audioBuffer: ArrayBuffer,
    context: AsrConversationContext | null,
    audioFeatures?: AudioFeatures,
    requestId?: string,
  ): Promise<AsrHybridResult> {
    const rid = requestId || createRequestId()
    const t0 = Date.now()

    // 如果未启用或 ASR 服务不可用，降级到标准 ASR
    if (!this.config.enabled || !this.asrService) {
      if (this.asrService) {
        const result = await this.asrService.transcribe(audioBuffer, rid)
        return this.toHybridResult(result, rid)
      }
      // ASR 服务完全不可用，返回空结果
      log('WARN', 'asr_hybrid_pipeline_asr_unavailable', { request_id: rid })
      return {
        text: '',
        requestId: rid,
        source: 'asr_only',
        agreementLevel: 0,
        arbitrationTriggered: false,
        asrText: '',
        memoryHypothesis: null,
        confidence: 0,
      }
    }

    // ── Path B: Memory 假设生成（快于 ASR，可在转录前完成）──
    const hypothesis = memoryAsrHypothesisGenerator.generate(context)

    // ── Path A: ASR 转录 ──
    const asrResult = await this.asrService.transcribe(audioBuffer, rid)

    // 如果 ASR 返回空文本或无上下文，直接返回
    if (!asrResult.text || !context) {
      return {
        ...this.toHybridResult(asrResult, rid),
        memoryHypothesis: hypothesis.expectedKeywords.length > 0 ? hypothesis : null,
        agreementLevel: 0.5,
        arbitrationTriggered: false,
        source: 'asr_only',
      }
    }

    // ── 汇合点: 交叉验证 ──
    const crossValidation = memoryAsrCrossValidator.validate(asrResult.text, hypothesis)

    // ── 仲裁 ──
    const asrConfidence = asrConfidenceScorer.score(asrResult.text, audioFeatures)
    const arbitration = await memoryAsrArbitrator.arbitrate(asrResult.text, asrConfidence, hypothesis, crossValidation, { requestId: rid })

    const elapsed = Date.now() - t0

    log('INFO', 'asr_hybrid_pipeline_completed', {
      request_id: rid,
      asr_text: asrResult.text.slice(0, 50),
      final_text: arbitration.finalText.slice(0, 50),
      agreement: crossValidation.agreementLevel.toFixed(2),
      matched: crossValidation.matchedKeywords.length,
      total_kw: crossValidation.matchedKeywords.length + crossValidation.unmatchedKeywords.length,
      arb_triggered: arbitration.arbitrationTriggered,
      source: arbitration.source,
      final_confidence: arbitration.finalConfidence.toFixed(2),
      duration_ms: elapsed,
    })

    return {
      text: arbitration.finalText,
      requestId: rid,
      source: arbitration.arbitrationTriggered ? arbitration.source : 'asr_primary',
      agreementLevel: crossValidation.agreementLevel,
      arbitrationTriggered: arbitration.arbitrationTriggered,
      asrText: asrResult.text,
      memoryHypothesis: hypothesis,
      confidence: arbitration.finalConfidence,
      voiceEmotion: asrResult.voiceEmotion,
    }
  }

  /** 将标准 AsrService.transcribe() 返回转换为 AsrHybridResult */
  private toHybridResult(
    result: { text: string; request_id: string; error?: string; voiceEmotion?: VoiceEmotion },
    requestId: string,
  ): AsrHybridResult {
    return {
      text: result.text,
      requestId,
      source: 'asr_only',
      agreementLevel: 0.5,
      arbitrationTriggered: false,
      asrText: result.text,
      memoryHypothesis: null,
      confidence: result.text ? 0.5 : 0,
      voiceEmotion: result.voiceEmotion,
    }
  }
}

// ===== 单例 =====
export const memoryAsrHybridPipeline = new MemoryAsrHybridPipeline()
