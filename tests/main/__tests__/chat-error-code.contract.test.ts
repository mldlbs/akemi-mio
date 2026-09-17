import { describe, it, expect } from 'vitest'
import { CHAT_ERROR_CODES } from '@akemi-mio/intelligence/llm/types'
import {
  CHAT_ERROR_TEXT,
  SILENT_CODES,
  UNMAPPED_BY_DESIGN,
  chatErrorText,
} from '../../../src/renderer/src/lib/chatErrorText'

/**
 * 契约测试：主进程 `ChatResult.error` 的值域 ↔ renderer 的用户文案表。
 *
 * **为什么要这条测试**：这两张表分处两个进程、两个 tsconfig，且 renderer 刻意不 import
 * 主进程包（`src/renderer` 里零 `@akemi-mio/*`，是架构边界），所以**类型约束到不了这里**。
 * 后果就是「主进程加了新错误码、忘了加文案」—— 用户看到「请求失败（RATE_LIMITED_EXHAUSTED）」
 * 这种内部码。这个漏洞靠人工 grep 核对已经漏过三次（最近一次见 2026-09-18 日志），
 * 所以改成让测试来管：新增码而不补文案 → 这里直接红。
 *
 * 判据：`CHAT_ERROR_CODES` ⊆ `CHAT_ERROR_TEXT` 的键 ∪ `SILENT_CODES` ∪ `UNMAPPED_BY_DESIGN`。
 */
describe('错误码契约：ChatResult.error ↔ chatErrorText 文案', () => {
  it('每个错误码都有归属：专属文案 / 静默 / 明确登记为「有意不映射」', () => {
    const missing = CHAT_ERROR_CODES.filter(
      (code) => !(code in CHAT_ERROR_TEXT) && !SILENT_CODES.has(code) && !(code in UNMAPPED_BY_DESIGN),
    )
    expect(
      missing,
      '以下错误码既没有用户文案，也没登记为静默或「有意不映射」。二选一：\n' +
        '  ① 在 src/renderer/src/lib/chatErrorText.ts 的 CHAT_ERROR_TEXT 里补文案；\n' +
        '  ② 若确实不该展示文案（例如不是故障），加进 SILENT_CODES 或 UNMAPPED_BY_DESIGN 并写明理由。',
    ).toEqual([])
  })

  it('CHAT_ERROR_TEXT 里没有主进程已不再产出的码（防止码表单边膨胀）', () => {
    const known = new Set<string>(CHAT_ERROR_CODES)
    const stale = Object.keys(CHAT_ERROR_TEXT).filter((code) => !known.has(code))
    expect(stale, 'CHAT_ERROR_TEXT 里有已不在 CHAT_ERROR_CODES 中的码，请同步删除').toEqual([])
  })

  it('非静默码都能被翻译成专属文案，不会落到「请求失败（码）」兜底', () => {
    for (const code of CHAT_ERROR_CODES) {
      if (SILENT_CODES.has(code)) {
        expect(chatErrorText(code), `${code} 应静默（返回 null，不打扰用户）`).toBeNull()
        continue
      }
      if (code in UNMAPPED_BY_DESIGN) continue
      expect(chatErrorText(code), `${code} 没有专属文案，用户会看到内部码`).toBe(CHAT_ERROR_TEXT[code])
    }
  })

  it('UNMAPPED_BY_DESIGN 的每个键都必须是已知码，且写清了理由', () => {
    const known = new Set<string>(CHAT_ERROR_CODES)
    for (const [code, reason] of Object.entries(UNMAPPED_BY_DESIGN)) {
      expect(known.has(code), `${code} 不在 CHAT_ERROR_CODES 里（码可能已删除，请一并清掉）`).toBe(true)
      expect(reason.trim().length, `${code} 的理由太短，写清「为什么可以不映射文案」`).toBeGreaterThan(10)
    }
  })

  it('CHAT_ERROR_CODES 自身没有重复项', () => {
    expect(new Set(CHAT_ERROR_CODES).size).toBe(CHAT_ERROR_CODES.length)
  })
})
