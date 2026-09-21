/**
 * check-form-registry 判据的直接测试。
 *
 * 为什么直接测判据而不是只跑脚本：门禁的失效方式不是「报错」而是「静默变绿」。
 * 如果三处源文件里的声明被重命名、解析器失配返回空集，那么所有「集合相等」
 * 判断都会在空集上空转成绿 —— 那时门禁仍然 exit 0，看起来一切正常。
 * 所以这里既测「不一致必须报出来」，也测「读不到东西必须报出来」。
 *
 * 另外用真实仓库数据跑一遍 collect()，保证解析器没有与实际文件脱节。
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const requireCjs = createRequire(import.meta.url)
const { collect, compare } = requireCjs('../../../../scripts/check-form-registry.cjs')

/** 一份三处自洽的最小夹具。改哪一处就把它改坏，用来验证判据会红。 */
function baseline() {
  const descriptor = (over: Record<string, unknown> = {}) => ({
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: false,
    fullscreen: false,
    acceptsMouseEvents: true,
    ...over,
  })
  const spec = (over: Record<string, unknown> = {}) => ({
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: false,
    fullscreen: false,
    ignoreMouseEvents: false,
    ...over,
  })
  return {
    formKindUnion: ['pet', 'chat', 'wallpaper'],
    formKinds: ['pet', 'chat', 'wallpaper'],
    registry: {
      pet: {
        ...descriptor(),
        htmlFile: 'pet.html',
        size: { width: 160, height: 200 },
        alwaysOnTop: true,
        skipTaskbar: true,
        alwaysOnTopLevel: 'floating',
      },
      chat: { ...descriptor(), htmlFile: 'chat.html', size: { width: 420, height: 560 } },
      wallpaper: {
        ...descriptor(),
        htmlFile: 'wallpaper.html',
        size: { width: 0, height: 0 },
        fullscreen: true,
        acceptsMouseEvents: false,
      },
    },
    specs: {
      pet: {
        ...spec(),
        htmlFile: 'pet.html',
        size: { width: 160, height: 200 },
        alwaysOnTop: true,
        skipTaskbar: true,
        alwaysOnTopLevel: 'floating',
      },
      chat: { ...spec(), htmlFile: 'chat.html', size: { width: 420, height: 560 } },
      wallpaper: { ...spec(), htmlFile: 'wallpaper.html', size: { width: 0, height: 0 }, fullscreen: true, ignoreMouseEvents: true },
    },
    viteInput: {
      index: 'index.html',
      agent: 'agent.html',
      pet: 'pet.html',
      chat: 'chat.html',
      wallpaper: 'wallpaper.html',
    },
  }
}

const joined = (problems: string[]) => problems.join('\n')

describe('check-form-registry 判据', () => {
  it('三处自洽时无问题（基线不是永远红的）', () => {
    expect(compare(baseline())).toEqual([])
  })

  it('解析失配（全空集）必须报错，不能在空集上空转成绿', () => {
    const empty = { formKindUnion: [], formKinds: [], registry: {}, specs: {}, viteInput: {} }
    const problems = compare(empty)
    expect(problems.length).toBeGreaterThan(0)
    expect(joined(problems)).toMatch(/未解析出/)
  })

  it('只有一处为空也必须报错（部分失配同样危险）', () => {
    const d = baseline()
    d.specs = {}
    expect(joined(compare(d))).toMatch(/Lifecycle\.ts 未解析出/)
  })

  it('形态集合漂移（Lifecycle 少了 chat）', () => {
    const d = baseline()
    delete d.specs.chat
    expect(joined(compare(d))).toMatch(/形态集合漂移/)
  })

  it('htmlFile 不一致', () => {
    const d = baseline()
    d.registry.pet.htmlFile = 'petty.html'
    expect(joined(compare(d))).toMatch(/htmlFile 不一致/)
  })

  it('vite 缺少形态入口', () => {
    const d = baseline()
    delete d.viteInput.pet
    expect(joined(compare(d))).toMatch(/缺少形态入口/)
  })

  it('vite 入口文件名与注册表不符', () => {
    const d = baseline()
    d.viteInput.chat = 'chatbox.html'
    expect(joined(compare(d))).toMatch(/与注册表 htmlFile/)
  })

  it('尺寸不一致', () => {
    const d = baseline()
    d.specs.chat.size = { width: 421, height: 560 }
    expect(joined(compare(d))).toMatch(/size 不一致/)
  })

  it('minSize 有无不一致', () => {
    const d = baseline()
    d.specs.chat.minSize = { width: 320, height: 360 }
    expect(joined(compare(d))).toMatch(/minSize 有无不一致/)
  })

  it('窗口标志不一致', () => {
    const d = baseline()
    d.specs.pet.transparent = false
    expect(joined(compare(d))).toMatch(/transparent 不一致/)
  })

  it('acceptsMouseEvents 与 ignoreMouseEvents 未互为取反', () => {
    const d = baseline()
    d.specs.wallpaper.ignoreMouseEvents = false
    expect(joined(compare(d))).toMatch(/互为取反/)
  })

  it('alwaysOnTopLevel 不一致', () => {
    const d = baseline()
    d.specs.pet.alwaysOnTopLevel = 'screen-saver'
    expect(joined(compare(d))).toMatch(/alwaysOnTopLevel 不一致/)
  })

  it('注册的 html 文件必须真实存在', () => {
    const d = baseline()
    d.registry.pet.htmlFile = 'nope.html'
    d.specs.pet.htmlFile = 'nope.html'
    d.viteInput.pet = 'nope.html'
    expect(joined(compare(d))).toMatch(/不存在/)
  })
})

describe('check-form-registry 与真实仓库', () => {
  it('collect() 能从三个真实文件里读出形态', () => {
    const data = collect()
    expect(data.formKinds).toEqual(['pet', 'chat', 'wallpaper'])
    for (const kind of data.formKinds) {
      expect(data.registry[kind], `registry 缺 ${kind}`).toBeTruthy()
      expect(data.specs[kind], `FORM_SPECS 缺 ${kind}`).toBeTruthy()
      expect(data.viteInput[kind], `vite input 缺 ${kind}`).toBeTruthy()
    }
  })

  it('当前仓库三处一致', () => {
    expect(compare(collect())).toEqual([])
  })
})
