import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContentEnhancer } from '@akemi-mio/creativity/ContentEnhancer'
import type { CreativitySource } from '@akemi-mio/creativity/types'

describe('ContentEnhancer', () => {
  let enhancer: ContentEnhancer

  beforeEach(() => {
    enhancer = new ContentEnhancer({ fetchTimeoutMs: 2000 })
  })

  describe('enhance()', () => {
    it('应该为简单来源生成摘要和关键词', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Memory',
          content: '对话记忆系统：150 条记录，最近话题: 语音识别、壁纸引擎、自进化',
          type: 'knowledge',
          weight: 0.9,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Memory')
      expect(result[0].summary).toBeDefined()
      expect(result[0].summary!.length).toBeGreaterThan(0)
      expect(result[0].keywords).toBeDefined()
      expect(result[0].qualityScore).toBeGreaterThanOrEqual(0)
      expect(result[0].qualityScore).toBeLessThanOrEqual(100)
    })

    it('应该保留原始来源的基本字段', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'ASR',
          content: '语音识别：平均延迟 200ms，错误率 5.2%',
          type: 'knowledge',
          weight: 0.7,
          fullContent: '详细内容：语音识别系统基于 Whisper 模型，支持中英文混合识别，平均延迟 200ms，错误率 5.2%',
          sourceDepth: 'medium',
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].type).toBe('knowledge')
      expect(result[0].weight).toBe(0.7)
      expect(result[0].fullContent).toContain('Whisper')
      expect(['medium', 'full']).toContain(result[0].sourceDepth)
    })

    it('应该处理空内容', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Empty',
          content: '',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result).toHaveLength(1)
      expect(result[0].summary).toBe('')
      expect(result[0].keywords).toEqual([])
      expect(result[0].qualityScore).toBe(0)
    })

    it('应该处理多个来源', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Memory',
          content: '对话记忆系统',
          type: 'knowledge',
          weight: 0.9,
        },
        {
          name: 'UserBehavior',
          content: '最近交互 50 次',
          type: 'behavior',
          weight: 0.7,
        },
        {
          name: '失败思路',
          content: '之前尝试过但不可行的方向',
          type: 'failure',
          weight: 0.6,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result).toHaveLength(3)
      expect(result.map((r) => r.type)).toEqual(['knowledge', 'behavior', 'failure'])
    })
  })

  describe('摘要提取', () => {
    it('应该从长文本中提取关键句子', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'LongContent',
          content:
            '语音识别系统是 Mio 的核心模块之一。它负责将用户的语音输入转换为文本。系统基于 Whisper 模型，支持中英文混合识别。平均延迟为 200 毫秒。错误率控制在 5% 以内。该模块还支持实时流式识别。',
          type: 'knowledge',
          weight: 0.8,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].summary).toBeDefined()
      expect(result[0].summary!.length).toBeGreaterThan(10)
      // 摘要应该不超过 300 字符
      expect(result[0].summary!.length).toBeLessThanOrEqual(300)
    })

    it('短文本应该直接作为摘要', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Short',
          content: '这是一个简短的描述',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].summary).toBeDefined()
      expect(result[0].summary!.length).toBeGreaterThan(0)
    })
  })

  describe('关键词提取', () => {
    it('应该提取中英文关键词', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Mixed',
          content: '语音识别 speech recognition 系统基于 Whisper 模型，支持 TTS 文字转语音功能',
          type: 'knowledge',
          weight: 0.8,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].keywords).toBeDefined()
      expect(result[0].keywords!.length).toBeGreaterThan(0)
      expect(result[0].keywords!.length).toBeLessThanOrEqual(8)
    })

    it('应该过滤停用词', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Stopwords',
          content: '的 是 在 了 我 有 和 这个 那个 什么 怎么 可以',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      const result = await enhancer.enhance(sources)

      // 停用词应该被过滤掉
      expect(result[0].keywords!.every((k) => k.length >= 2)).toBe(true)
    })
  })

  describe('内容质量评估', () => {
    it('有结构的内容应该有较高质量分', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Quality',
          content:
            '## 语音识别模块\n\n该模块负责将用户的语音输入转换为文本。系统基于 Whisper 模型，支持中英文混合识别。\n\n### 技术细节\n\n- 平均延迟：200ms\n- 错误率：5.2%\n- 支持语言：中文、英文',
          type: 'knowledge',
          weight: 0.8,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].qualityScore).toBeGreaterThan(30)
      expect(result[0].structuralComplexity).toBeGreaterThan(0)
    })

    it('空内容应该质量分为 0', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Empty',
          content: '',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].qualityScore).toBe(0)
    })
  })

  describe('深度分类', () => {
    it('短内容应该是 shallow', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Shallow',
          content: '简短描述',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].sourceDepth).toBe('shallow')
    })

    it('有结构的长内容应该是 full 或 medium', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Deep',
          content:
            '语音识别系统是 Mio 的核心模块之一。它负责将用户的语音输入转换为文本。系统基于 Whisper 模型，支持中英文混合识别。平均延迟为 200 毫秒。错误率控制在 5% 以内。该模块还支持实时流式识别，可以在用户说话的同时进行转写。系统使用了最新的 Whisper large-v3 模型，在中文识别准确率上达到了 95% 以上。',
          type: 'knowledge',
          weight: 0.8,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(['medium', 'full']).toContain(result[0].sourceDepth)
    })
  })

  describe('语义密度', () => {
    it('应该计算语义密度', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Density',
          content:
            '语音识别系统基于深度学习模型，支持多语言实时转写。该系统在中文场景下表现优异，准确率超过 95%。同时支持英文、日文等语言的混合识别。',
          type: 'knowledge',
          weight: 0.8,
        },
      ]

      const result = await enhancer.enhance(sources)

      expect(result[0].semanticDensity).toBeGreaterThanOrEqual(0)
      expect(result[0].semanticDensity).toBeLessThanOrEqual(1)
    })
  })

  describe('错误处理', () => {
    it('应该优雅处理单个来源的错误', async () => {
      const sources: CreativitySource[] = [
        {
          name: 'Normal',
          content: '正常内容',
          type: 'knowledge',
          weight: 0.5,
        },
        {
          name: 'WithUrl',
          content: '访问 https://example.com 了解详情',
          type: 'knowledge',
          weight: 0.5,
        },
      ]

      // fetch 会失败，但应该降级处理
      const result = await enhancer.enhance(sources)

      expect(result).toHaveLength(2)
      expect(result[0].summary).toBeDefined()
      expect(result[1].summary).toBeDefined()
    })
  })
})
