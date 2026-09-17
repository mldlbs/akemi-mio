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
    const codes = [
      'PAUSED',
      'NO_REPLY',
      'EMPTY_RESPONSE',
      'INTERNAL',
      'TIMEOUT',
      'NETWORK',
      'RATE_LIMITED',
      'RATE_LIMITED_EXHAUSTED',
      'NO_KEY',
      'INVALID_KEY',
      'INVALID_REQUEST',
      'NO_TOOLS_AVAILABLE',
    ]
    for (const code of codes) {
      const text = chatErrorText(code)
      expect(text, code).toBeTruthy()
      expect(text, code).not.toContain(code)
    }
  })

  it('模型返回空内容：EMPTY_RESPONSE 与 NO_REPLY 给同一套说辞', () => {
    expect(chatErrorText('EMPTY_RESPONSE')).toBe(chatErrorText('NO_REPLY'))
  })

  it('超时不再被伪装成「模型没有返回内容」', () => {
    // 回归护栏：ChatExecutor 曾把「超时重试耗尽」也报成 NO_REPLY，
    // 于是用户看到「模型没有返回内容」—— 与真实原因（超时）不符。
    const text = chatErrorText('TIMEOUT')
    expect(text).toContain('超时')
    expect(text).not.toBe(chatErrorText('NO_REPLY'))
  })

  it('用户主动打断不弹错误（取消是用户的意图，不是故障）', () => {
    expect(chatErrorText('INTERRUPTED')).toBeNull()
    // ABORTED 只由 RunContext.interrupt() 触发，语义与 INTERRUPTED 相同
    expect(chatErrorText('ABORTED')).toBeNull()
  })

  it('API_ERROR:<status> 说清是服务端返回错误，而不是把状态码当内部码甩出去', () => {
    const text = chatErrorText('API_ERROR:503')
    expect(text).toContain('503')
    expect(text).not.toContain('API_ERROR')
  })

  it('未知错误码回退到带原始码的通用文案（不丢排查信息）', () => {
    expect(chatErrorText('WEIRD_CODE')).toContain('WEIRD_CODE')
  })

  it('原始异常报文不糊到界面上（error 字段的类型只是 string，可能夹带堆栈）', () => {
    // LlmService.ts:647 在网络异常分支把 String(err) 直接当错误码返回，
    // 所以这个字段可能是「TypeError: fetch failed」这种含空格的技术文本。
    const text = chatErrorText('TypeError: fetch failed')!
    expect(text).not.toContain('TypeError')
    expect(text).not.toContain('fetch')
    expect(text).toContain('暂时不可用')
  })

  it('超长的疑似报文也不展示原文', () => {
    const text = chatErrorText('X'.repeat(500))!
    expect(text).not.toContain('XXXX')
    expect(text).toContain('暂时不可用')
  })
})
