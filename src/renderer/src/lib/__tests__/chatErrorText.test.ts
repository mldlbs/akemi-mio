import { describe, expect, it } from 'vitest'
import { chatErrorText } from '../chatErrorText'

describe('chatErrorText', () => {
  it('无错误时返回 null，调用方据此跳过展示', () => {
    expect(chatErrorText(undefined)).toBeNull()
    expect(chatErrorText(null)).toBeNull()
    expect(chatErrorText('')).toBeNull()
  })

  it('熔断给出「会自动恢复」的说明，而不是把内部码甩给用户', () => {
    const text = chatErrorText('CIRCUIT_OPEN')
    expect(text).toBeTruthy()
    expect(text).not.toContain('CIRCUIT_OPEN')
    expect(text).toContain('自动恢复')
  })

  it('覆盖主进程会返回的各个错误码，且都不暴露内部码', () => {
    const codes = ['PAUSED', 'NO_REPLY', 'INTERNAL', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'NO_KEY', 'INVALID_KEY']
    for (const code of codes) {
      const text = chatErrorText(code)
      expect(text, code).toBeTruthy()
      expect(text, code).not.toContain(code)
    }
  })

  it('未知错误码回退到带原始码的通用文案（不丢排查信息）', () => {
    expect(chatErrorText('API_ERROR:503')).toContain('API_ERROR:503')
  })
})
