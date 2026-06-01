import { describe, it, expect } from 'vitest'
import { cleanTTS } from '../tts/TtsService'

describe('tts', () => {
  describe('cleanTTS', () => {
    it('strips *text* tone indicators', () => {
      const result = cleanTTS('你好 *微笑* 世界')
      expect(result).toBe('你好 世界')
    })

    it('strips **text** tone indicators', () => {
      const result = cleanTTS('**开心地说** 今天天气真好')
      expect(result).toBe('今天天气真好')
    })

    it('strips (text) tone indicators', () => {
      const result = cleanTTS('（轻声）你好（微笑）')
      expect(result).toBe('你好')
    })

    it('removes emoji', () => {
      const result = cleanTTS('你好 😊 世界 🌍')
      expect(result).toBe('你好 世界')
    })

    it('preserves normal Chinese text', () => {
      const result = cleanTTS('今天天气真好我们去散步吧')
      expect(result).toBe('今天天气真好我们去散步吧')
    })

    it('handles the all-filtered case', () => {
      const result = cleanTTS('*测试*（括号）😊')
      expect(result).toBe('')
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
      const result = cleanTTS('啊\uD83D\uDE0A你好')
      expect(result).toBe('啊你好')
    })
  })
})
