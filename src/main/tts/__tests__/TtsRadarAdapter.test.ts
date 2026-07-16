import { describe, it, expect } from 'vitest'
import { ttsRadarAdapter, TtsRadarAdapter } from '../TtsRadarAdapter'

describe('TtsRadarAdapter', () => {
  const adapter = new TtsRadarAdapter()

  // ═══════════════════════════════════════════════
  // 1. cleanSignalTitle — 适配自 cleanTTS
  // ═══════════════════════════════════════════════

  describe('cleanSignalTitle', () => {
    it('strips markdown bold from signal title', () => {
      expect(adapter.cleanSignalTitle('**Show HN:** 基于 AI 的代码审查助手')).toBe('Show HN: 基于 AI 的代码审查助手')
    })

    it('strips emoji from signal title', () => {
      expect(adapter.cleanSignalTitle('Cursor IDE 获 6000 万美元 B 轮融资 🚀')).toBe('Cursor IDE 获 6000 万美元 B 轮融资')
    })

    it('strips markdown inline code from title', () => {
      expect(adapter.cleanSignalTitle('使用 `n8n` 的开源工作流')).toBe('使用 n8n 的开源工作流')
    })

    it('strips markdown links from title', () => {
      expect(adapter.cleanSignalTitle('查看[文档](https://example.com)了解详情')).toBe('查看文档了解详情')
    })

    it('strips tone indicators in parentheses', () => {
      expect(adapter.cleanSignalTitle('（更新）AI SaaS 市场报告')).toBe('AI SaaS 市场报告')
    })

    it('strips list markers from title', () => {
      expect(adapter.cleanSignalTitle('- 第一项')).toBe('第一项')
    })

    it('strips numbered list markers', () => {
      expect(adapter.cleanSignalTitle('1. 首先')).toBe('首先')
    })

    it('returns fallback for empty title after cleaning', () => {
      const result = adapter.cleanSignalTitle('** **')
      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(0)
    })

    it('returns empty string for null/empty input', () => {
      expect(adapter.cleanSignalTitle('')).toBe('')
    })

    it('preserves normal Chinese text', () => {
      expect(adapter.cleanSignalTitle('2025 年 Q2 SaaS 市场融资报告')).toBe('2025 年 Q2 SaaS 市场融资报告')
    })

    it('strips blockquote markers', () => {
      expect(adapter.cleanSignalTitle('> 引用内容')).toBe('引用内容')
    })
  })

  // ═══════════════════════════════════════════════
  // 2. cleanSignalSummary — 带长度控制的摘要清理
  // ═══════════════════════════════════════════════

  describe('cleanSignalSummary', () => {
    it('strips markdown from summary', () => {
      const input = '一个使用大语言模型**自动审查** Pull Request 的开源工具'
      expect(adapter.cleanSignalSummary(input)).toBe('一个使用大语言模型自动审查 Pull Request 的开源工具')
    })

    it('strips source tag prefix', () => {
      const input = '[hackernews] AI 编程助手完成 B 轮融资'
      expect(adapter.cleanSignalSummary(input)).toBe('AI 编程助手完成 B 轮融资')
    })

    it('truncates long summaries with ellipsis', () => {
      const longSummary = 'A'.repeat(300)
      const result = adapter.cleanSignalSummary(longSummary, { summaryMaxLength: 50 })
      expect(result.length).toBeLessThanOrEqual(51) // 50 + '…'
      expect(result.endsWith('…')).toBe(true)
    })

    it('returns empty for empty input', () => {
      expect(adapter.cleanSignalSummary('')).toBe('')
    })

    it('handles summaries with emoji', () => {
      expect(adapter.cleanSignalSummary('AI 工具 2000+ star 😊')).toBe('AI 工具 2000+ star')
    })

    it('preserves useful punctuation in summaries', () => {
      const input = 'n8n 本周 GitHub Star 突破 5 万，企业级工作流自动化领域开源替代 Zapier 的最佳选择'
      expect(adapter.cleanSignalSummary(input)).toBe(input)
    })
  })

  // ═══════════════════════════════════════════════
  // 3. cleanSignal — 完整信号清理
  // ═══════════════════════════════════════════════

  describe('cleanSignal', () => {
    it('cleans both title and summary', () => {
      const signal = {
        title: '**Show HN:** AI 工具开源发布 🚀',
        summary: '[hackernews] 使用大语言模型**自动审查** PR',
      }
      const result = adapter.cleanSignal(signal)
      expect(result.title).toBe('Show HN: AI 工具开源发布')
      expect(result.summary).toBe('使用大语言模型自动审查 PR')
    })

    it('respects options to skip title cleaning', () => {
      const signal = { title: '**粗体标题**', summary: '普通摘要' }
      const result = adapter.cleanSignal(signal, { cleanTitle: false })
      expect(result.title).toBe('**粗体标题**')
      expect(result.summary).toBe('普通摘要')
    })

    it('respects options to skip summary cleaning', () => {
      const signal = { title: '普通标题', summary: '**粗体摘要**' }
      const result = adapter.cleanSignal(signal, { cleanSummary: false })
      expect(result.title).toBe('普通标题')
      expect(result.summary).toBe('**粗体摘要**')
    })
  })

  // ═══════════════════════════════════════════════
  // 4. orientPushCadence — 适配自 TtsRouter 决策模式
  // ═══════════════════════════════════════════════

  describe('orientPushCadence', () => {
    it('returns immediate for hot urgency with high score', () => {
      expect(adapter.orientPushCadence('hot', 0.85)).toBe('immediate')
    })

    it('returns batch for hot urgency with low score', () => {
      expect(adapter.orientPushCadence('hot', 0.3)).toBe('batch')
    })

    it('returns batch for warm urgency with high score', () => {
      expect(adapter.orientPushCadence('warm', 0.7)).toBe('batch')
    })

    it('returns defer for warm urgency with low score', () => {
      expect(adapter.orientPushCadence('warm', 0.3)).toBe('defer')
    })

    it('returns defer for cold urgency regardless of score', () => {
      expect(adapter.orientPushCadence('cold', 0.9)).toBe('defer')
      expect(adapter.orientPushCadence('cold', 0.1)).toBe('defer')
    })
  })

  // ═══════════════════════════════════════════════
  // 5. getPushStyle — TTS 风格推送配置
  // ═══════════════════════════════════════════════

  describe('getPushStyle', () => {
    it('returns hot style with fire emoji and immediate cadence', () => {
      const style = adapter.getPushStyle('hot')
      expect(style.urgencyPrefix).toBe('🔥')
      expect(style.pushCadence).toBe('immediate')
      expect(style.compact).toBe(false)
      expect(style.showScore).toBe(true)
    })

    it('returns warm style with batch cadence', () => {
      const style = adapter.getPushStyle('warm')
      expect(style.urgencyPrefix).toBe('⚡')
      expect(style.pushCadence).toBe('batch')
    })

    it('returns cold style with defer cadence', () => {
      const style = adapter.getPushStyle('cold')
      expect(style.urgencyPrefix).toBe('💤')
      expect(style.pushCadence).toBe('defer')
      expect(style.compact).toBe(true)
      expect(style.showScore).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════
  // 6. prepareForTelegram — POC 集成点
  // ═══════════════════════════════════════════════

  describe('prepareForTelegram', () => {
    it('returns cleaned signal fields ready for Telegram', () => {
      const signal = { title: '**重要信号** 🚀', summary: '[test] 这是一个**重要**的摘要' }
      const result = adapter.prepareForTelegram(signal)
      expect(result.title).toBe('重要信号')
      expect(result.summary).toBe('这是一个重要的摘要')
    })
  })

  describe('prepareBatchForTelegram', () => {
    it('cleans multiple signals', () => {
      const signals = [
        { title: '**信号一**', summary: '[src] 摘要一' },
        { title: '**信号二**', summary: '[src] 摘要二' },
      ]
      const results = adapter.prepareBatchForTelegram(signals)
      expect(results).toHaveLength(2)
      expect(results[0].title).toBe('信号一')
      expect(results[1].title).toBe('信号二')
    })

    it('returns empty array for empty input', () => {
      expect(adapter.prepareBatchForTelegram([])).toEqual([])
    })
  })

  // ═══════════════════════════════════════════════
  // 7. 单例可用性
  // ═══════════════════════════════════════════════

  describe('singleton', () => {
    it('provides a global singleton instance', () => {
      expect(ttsRadarAdapter).toBeInstanceOf(TtsRadarAdapter)
      expect(ttsRadarAdapter.cleanSignalTitle('**测试**')).toBe('测试')
    })
  })
})
