/**
 * AsrBehaviorAdapter — POC 单元测试
 *
 * 覆盖：
 * 1. VoiceEmotion → BehaviorContextHint 映射
 * 2. AcousticEnvironment → BehaviorContextHint 映射
 * 3. Confidence → QualitySignal 映射
 * 4. 完整 adapt() 流程
 * 5. 边界情况：低置信度、空数据、POC 模式
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
}))

import { AsrBehaviorAdapter } from '@akemi-mio/evolution/user-behavior/asr-adapter/AsrBehaviorAdapter'
import type { AsrVoiceEmotionInput, AsrEnvironmentInput, AsrConfidenceInput } from '@akemi-mio/evolution/user-behavior/asr-adapter/AsrBehaviorTypes'

describe('AsrBehaviorAdapter', () => {
  let adapter: AsrBehaviorAdapter

  beforeEach(() => {
    adapter = new AsrBehaviorAdapter({ pocMode: false, debug: false })
  })

  // ── VoiceEmotion → BehaviorContextHint ──

  describe('voice emotion mapping', () => {
    const createEmotion = (label: AsrVoiceEmotionInput['label'], confidence: number): AsrVoiceEmotionInput => ({
      label,
      scores: { [label]: confidence },
      confidence,
      features: { energy: 0.5, pitchHz: 200, speechRate: 4, silenceRatio: 0.2 },
    })

    it('应将 calm 映射为低活跃度', () => {
      const result = adapter.adapt({ voiceEmotion: createEmotion('calm', 0.85) })
      expect(result.contextHint).not.toBeNull()
      expect(result.contextHint!.activityScore).toBe(0.3)
      expect(result.contextHint!.voiceEmotionSummary).toContain('平静')
      expect(result.success).toBe(true)
    })

    it('应将 angry 映射为高活跃度', () => {
      const result = adapter.adapt({ voiceEmotion: createEmotion('angry', 0.8) })
      expect(result.contextHint).not.toBeNull()
      expect(result.contextHint!.activityScore).toBe(0.9)
      expect(result.contextHint!.voiceEmotionSummary).toContain('激动')
    })

    it('应在置信度过低时跳过 Emotion 映射', () => {
      const result = adapter.adapt({ voiceEmotion: createEmotion('happy', 0.2) })
      // 无其他数据源时 contextHint 应为 null
      expect(result.contextHint).toBeNull()
    })
  })

  // ── AcousticEnvironment → BehaviorContextHint ──

  describe('environment mapping', () => {
    const createEnv = (env: AsrEnvironmentInput['environment'], confidence: number): AsrEnvironmentInput => ({
      environment: env,
      confidence,
      params: { noiseFilter: false, confidenceThresholdOffset: 0 },
    })

    it('应将 noisy 映射为嘈杂环境', () => {
      const result = adapter.adapt({ environment: createEnv('noisy', 0.8) })
      expect(result.contextHint).not.toBeNull()
      expect(result.contextHint!.isNoisy).toBe(true)
      expect(result.contextHint!.isQuiet).toBe(false)
    })

    it('应将 quiet 映射为安静环境', () => {
      const result = adapter.adapt({ environment: createEnv('quiet', 0.9) })
      expect(result.contextHint).not.toBeNull()
      expect(result.contextHint!.isQuiet).toBe(true)
      expect(result.contextHint!.isNoisy).toBe(false)
    })
  })

  // ── Confidence → QualitySignal ──

  describe('confidence mapping', () => {
    const createConfidence = (score: number, overrides?: Partial<AsrConfidenceInput>): AsrConfidenceInput => ({
      text: '测试文本',
      score,
      textScore: score,
      audioScore: 1.0,
      isLowConfidence: score < 0.7,
      ...overrides,
    })

    it('应在高置信度时只输出基础质量信号', () => {
      const result = adapter.adapt({ confidence: createConfidence(0.95) })
      expect(result.qualitySignals.length).toBeGreaterThanOrEqual(2)
      const confidenceSignal = result.qualitySignals.find((s) => s.name === 'asr_recognition_confidence')
      expect(confidenceSignal).toBeDefined()
      expect(confidenceSignal!.value).toBe(0.95)
    })

    it('应在低置信度时输出额外质量信号', () => {
      const result = adapter.adapt({ confidence: createConfidence(0.3, { isLowConfidence: true }) })
      const lowConfSignal = result.qualitySignals.find((s) => s.name === 'asr_low_confidence_detected')
      expect(lowConfSignal).toBeDefined()
    })

    it('应在检测到幻觉模式时标记', () => {
      const result = adapter.adapt({
        confidence: createConfidence(0.1, {
          isLowConfidence: true,
          hallucinationMatch: '谢谢大家',
        }),
      })
      const hallucinationSignal = result.qualitySignals.find((s) => s.name === 'asr_hallucination_detected')
      expect(hallucinationSignal).toBeDefined()
      expect(hallucinationSignal!.description).toContain('谢谢大家')
    })
  })

  // ── 完整适配流程 ──

  describe('full adapt flow', () => {
    it('应适配多数据源组合', () => {
      const result = adapter.adapt({
        voiceEmotion: {
          label: 'calm',
          scores: { calm: 0.9 },
          confidence: 0.9,
          features: { energy: 0.3, pitchHz: 180, speechRate: 3, silenceRatio: 0.3 },
        },
        environment: {
          environment: 'quiet',
          confidence: 0.85,
          params: { noiseFilter: false, confidenceThresholdOffset: 0 },
        },
        confidence: {
          text: '今天天气不错',
          score: 0.92,
          textScore: 0.95,
          audioScore: 0.9,
          isLowConfidence: false,
        },
      })

      expect(result.success).toBe(true)
      expect(result.contextHint).not.toBeNull()
      expect(result.contextHint!.isQuiet).toBe(true)
      expect(result.contextHint!.activityScore).toBe(0.3)
      expect(result.contextHint!.environmentLabel).toBe('安静环境')
      expect(result.qualitySignals.length).toBeGreaterThanOrEqual(2)
    })

    it('应在无任何输入时返回空但成功的输出', () => {
      const result = adapter.adapt({})
      expect(result.success).toBe(true)
      expect(result.contextHint).toBeNull()
      expect(result.qualitySignals).toEqual([])
    })
  })

  // ── POC 模式 ──

  describe('POC mode', () => {
    it('默认应启用 POC 模式', () => {
      const defaultAdapter = new AsrBehaviorAdapter()
      expect(defaultAdapter.getConfig().pocMode).toBe(true)
    })

    it('POC 模式下应有更少的消息输出', () => {
      const pocAdapter = new AsrBehaviorAdapter({ pocMode: true })
      const fullAdapter = new AsrBehaviorAdapter({ pocMode: false })

      const input = {
        voiceEmotion: {
          label: 'happy' as const,
          scores: { happy: 0.9 },
          confidence: 0.9,
          features: { energy: 0.7, pitchHz: 250, speechRate: 6, silenceRatio: 0.1 },
        },
      }

      const pocResult = pocAdapter.adapt(input)
      const fullResult = fullAdapter.adapt(input)

      // 两者 contextHint 应一致（核心转换结果不变）
      expect(pocResult.contextHint!.activityScore).toBe(fullResult.contextHint!.activityScore)
      // POC 模式有更少的消息
      expect(pocResult.messages.length).toBeLessThan(fullResult.messages.length)
    })
  })

  // ── 配置管理 ──

  describe('config management', () => {
    it('应支持运行时配置更新', () => {
      adapter.updateConfig({ enableVoiceEmotionMapping: false })
      const config = adapter.getConfig()
      expect(config.enableVoiceEmotionMapping).toBe(false)
    })

    it('禁用 VoiceEmotion 映射后应跳过 emotion 处理', () => {
      adapter.updateConfig({ enableVoiceEmotionMapping: false })
      const result = adapter.adapt({
        voiceEmotion: {
          label: 'calm',
          scores: { calm: 0.9 },
          confidence: 0.9,
          features: { energy: 0.3, pitchHz: 180, speechRate: 3, silenceRatio: 0.3 },
        },
      })
      expect(result.contextHint).toBeNull()
    })
  })

  // ── 适配器统计 ──

  describe('adapter state', () => {
    it('应记录适配次数', () => {
      expect(adapter.getState().totalAdaptations).toBe(0)
      adapter.adapt({})
      adapter.adapt({})
      expect(adapter.getState().totalAdaptations).toBe(2)
      expect(adapter.getState().successfulAdaptations).toBe(2)
    })
  })
})
