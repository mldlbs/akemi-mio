import { describe, it, expect } from 'vitest'
import { cleanTTS } from '../tts/TtsService'

describe('tts', () => {
  describe('cleanTTS', () => {
    it('strips *text* tone indicators', () => {
      const result = cleanTTS('你好 *微笑* 世界')
      expect(result).toBe('你好 微笑 世界')
    })

    it('strips **text** tone indicators', () => {
      const result = cleanTTS('**开心地说** 今天天气真好')
      expect(result).toBe('开心地说 今天天气真好')
    })

    it('strips (text) tone indicators', () => {
      const result = cleanTTS('（轻声）你好（微笑）')
      expect(result).toBe('你好')
    })

    it('removes emoji', () => {
      const result = cleanTTS('你好 😊 世界 🌍')
      expect(result).toBe('你好 世界')
    })

    it('strips markdown headers ###', () => {
      const result = cleanTTS('### 动态消耗公式验收标准')
      expect(result).toBe('动态消耗公式验收标准')
    })

    it('strips inline code backticks', () => {
      const result = cleanTTS('使用 `基础值×效果强度` 公式')
      expect(result).toBe('使用 基础值×效果强度 公式')
    })

    it('strips markdown links', () => {
      const result = cleanTTS('查看[文档](https://example.com)')
      expect(result).toBe('查看文档')
    })

    it('strips list markers', () => {
      const result = cleanTTS('- 第一项\n- 第二项')
      expect(result).toBe('第一项\n第二项')
    })

    it('strips numbered list markers', () => {
      const result = cleanTTS('1. 首先\n2. 其次')
      expect(result).toBe('首先\n其次')
    })

    it('strips table pipes', () => {
      const result = cleanTTS('| 强度 | 消耗 |')
      expect(result).toBe('强度 消耗')
    })

    it('strips blockquote markers', () => {
      const result = cleanTTS('> 引用内容')
      expect(result).toBe('引用内容')
    })

    it('strips code fences', () => {
      const result = cleanTTS('代码：```\nconst x = 1\n```')
      expect(result).toBe('代码：')
    })

    it('preserves normal Chinese text', () => {
      const result = cleanTTS('今天天气真好我们去散步吧')
      expect(result).toBe('今天天气真好我们去散步吧')
    })

    it('preserves normal text with punctuation', () => {
      const result = cleanTTS('你好，世界！今天真不错。')
      expect(result).toBe('你好，世界！今天真不错。')
    })

    it('strips lone UTF-16 surrogates', () => {
      const result = cleanTTS('啊\uDC8A你好')
      expect(result).toBe('啊你好')
    })

    it('strips surrogate pairs (emoji)', () => {
      const result = cleanTTS('啊😊你好')
      expect(result).toBe('啊你好')
    })

    it('handles the all-filtered case', () => {
      const result = cleanTTS('*测试*（括号）😊')
      expect(result).toBe('测试')
    })

    it('returns fallback for emoji-only input', () => {
      const result = cleanTTS('🌸')
      expect(result).toBe('嗯')
    })

    it('returns fallback for kaomoji-only input', () => {
      const result = cleanTTS('(◠‿◠)')
      expect(result).toBe('嗯')
    })
  })
})

describe('cleanTTS with markdown from logs', () => {
  it('strips real log-style markdown output', () => {
    const input = '### **动态消耗公式验收标准**\n\n- ✅ 用户可输入`基础值×效果强度`\n| 强度 | 消耗 |'
    const result = cleanTTS(input)
    expect(result).not.toMatch(/[#*`|]/)
    expect(result).toContain('用户可输入')
    expect(result).toContain('强度')
  })

  it('strips bold code references', () => {
    const input = '**魔法来源**：血脉传承'
    const result = cleanTTS(input)
    expect(result).not.toContain('**')
    expect(result).toContain('魔法来源')
    expect(result).toContain('血脉传承')
  })
})
