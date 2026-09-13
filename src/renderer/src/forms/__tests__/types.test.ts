/**
 * forms/types 的契约测试。
 *
 * 这些断言的作用是"上锁"：形态注册表是三处必须同步的配置之一
 * （另外两处是 Lifecycle 的 FORM_SPECS 与 electron.vite.config.ts 的 rollup input），
 * 一旦有人改了 htmlFile 或漏了形态，这里会先报错，
 * 而不是等到运行期窗口空白才发现。
 */

import { describe, it, expect } from 'vitest'
import { FORM_KINDS, FORM_REGISTRY, PET_MOODS, isFormKind } from '../types'

describe('FORM_REGISTRY 契约', () => {
  it('每个 FORM_KINDS 都有对应的 registry 条目', () => {
    for (const kind of FORM_KINDS) {
      expect(FORM_REGISTRY[kind], `缺少 ${kind} 的元数据`).toBeDefined()
    }
  })

  it('registry 的 kind 字段与键名一致（防止复制粘贴改漏）', () => {
    for (const kind of FORM_KINDS) {
      expect(FORM_REGISTRY[kind].kind).toBe(kind)
    }
  })

  it('htmlFile 与 kind 对应，且带 .html 后缀', () => {
    for (const kind of FORM_KINDS) {
      const { htmlFile } = FORM_REGISTRY[kind]
      expect(htmlFile).toBe(`${kind}.html`)
    }
  })

  it('htmlFile 互不重复', () => {
    const files = FORM_KINDS.map((k) => FORM_REGISTRY[k].htmlFile)
    expect(new Set(files).size).toBe(files.length)
  })

  it('每个形态都有非空的中文标签与说明', () => {
    for (const kind of FORM_KINDS) {
      const d = FORM_REGISTRY[kind]
      expect(d.label.length).toBeGreaterThan(0)
      expect(d.description.length).toBeGreaterThan(0)
    }
  })

  it('透明形态一律无边框（有边框的透明窗口会出现系统标题栏）', () => {
    for (const kind of FORM_KINDS) {
      const d = FORM_REGISTRY[kind]
      if (d.transparent) expect(d.frame).toBe(false)
    }
  })

  it('壁纸形态必须置底、不可点击、铺满全屏', () => {
    const wp = FORM_REGISTRY.wallpaper
    expect(wp.alwaysOnTop).toBe(false)
    expect(wp.fullscreen).toBe(true)
    expect(wp.acceptsMouseEvents).toBe(false)
  })

  it('宠物形态必须置顶且不进任务栏', () => {
    const pet = FORM_REGISTRY.pet
    expect(pet.alwaysOnTop).toBe(true)
    expect(pet.skipTaskbar).toBe(true)
  })

  it('置顶形态必须声明 level（否则默认层级可能被全屏应用盖住）', () => {
    for (const kind of FORM_KINDS) {
      const d = FORM_REGISTRY[kind]
      if (d.alwaysOnTop) expect(d.alwaysOnTopLevel).toBeDefined()
    }
  })

  it('声明了 minSize 的形态，min 不得大于默认尺寸', () => {
    for (const kind of FORM_KINDS) {
      const d = FORM_REGISTRY[kind]
      if (!d.minSize) continue
      expect(d.minSize.width).toBeLessThanOrEqual(d.size.width)
      expect(d.minSize.height).toBeLessThanOrEqual(d.size.height)
    }
  })
})

describe('isFormKind', () => {
  it('识别合法形态', () => {
    for (const kind of FORM_KINDS) expect(isFormKind(kind)).toBe(true)
  })

  it('拒绝非法值', () => {
    expect(isFormKind('bogus')).toBe(false)
    expect(isFormKind('')).toBe(false)
    expect(isFormKind(null)).toBe(false)
    expect(isFormKind(undefined)).toBe(false)
    expect(isFormKind(42)).toBe(false)
    expect(isFormKind({})).toBe(false)
  })

  it('大小写敏感（防止 "Pet" 这类误传）', () => {
    expect(isFormKind('Pet')).toBe(false)
  })
})

describe('PET_MOODS', () => {
  it('包含 idle 作为基准情绪', () => {
    expect(PET_MOODS).toContain('idle')
  })

  it('无重复项', () => {
    expect(new Set(PET_MOODS).size).toBe(PET_MOODS.length)
  })
})
