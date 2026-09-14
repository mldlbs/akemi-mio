import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 形态窗口的布局底座护栏。
 *
 * 这里测的不是字符串，而是两条**只有真跑起来才看得见、但能在源码层锁死**的
 * 不变量。它们对应的真实故障：shared.css 曾写着 `html.form-root { height:100% }`，
 * 而 form-root 只挂在 <body> 上、<html> 从来没有这个类 —— 死规则。
 * 后果是整条百分比高度链失去确定高度而塌成 0：壁纸形态 2560x1440 的窗口里
 * 根容器高度是 0（整块全透明，只剩一个时钟浮着），对话框 420x560 的窗口里
 * 卡片只有 220 高。这类问题 jsdom 测不出来（不做布局），所以在此断言源码。
 */
const SHARED_CSS = join(__dirname, '..', 'shared.css')

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 找出所有声明了 `height: 100%` 的规则块，返回其选择器列表。 */
function rulesWithFullHeight(css: string): { selector: string; selectors: string[] }[] {
  const out: { selector: string; selectors: string[] }[] = []
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/height\s*:\s*100%/.test(m[2])) continue
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    out.push({ selector: m[1].trim(), selectors })
  }
  return out
}

describe('形态窗口布局底座 shared.css', () => {
  it('百分比高度链的根必须能匹配 <html>', () => {
    const css = readFileSync(SHARED_CSS, 'utf8')
    const hits = rulesWithFullHeight(css)

    // 必须存在一条规则：既给 html 定高，又带 height:100%。
    // 裸 `html` 才算数 —— `html.form-root` 是死规则，<html> 上没那个类。
    const rooted = hits.filter((r) => r.selectors.includes('html'))
    expect(rooted.length).toBeGreaterThan(0)

    // 反向佐证：任何形态入口的 <html> 都不带 form-root 类，
    // 否则上面那条断言可以被"给 html 加个类"绕过而实际 DOM 又没变。
    for (const file of ['pet.html', 'chat.html', 'wallpaper.html']) {
      const html = readFileSync(join(__dirname, '..', '..', '..', file), 'utf8')
      const openTag = /<html[^>]*>/.exec(html)?.[0] ?? ''
      expect(openTag, `${file} 的 <html> 不应依赖 form-root 类`).not.toMatch(/form-root/)
    }
  })

  it('形态窗口自带 border-box reset（主窗口的 base.css 不会被导入）', () => {
    const css = readFileSync(SHARED_CSS, 'utf8')
    const blocks = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /box-sizing\s*:\s*border-box/.test(m[2]))
      .map((m) => m[1].trim())

    expect(blocks.length).toBeGreaterThan(0)
    // 必须覆盖到形态根容器内部的元素，而不只是根本身
    expect(blocks.some((s) => s.includes('body.form-root'))).toBe(true)
  })
})
