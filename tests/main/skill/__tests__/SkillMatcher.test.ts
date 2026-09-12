import { describe, it, expect } from 'vitest'
import { SkillMatcher } from '@akemi-mio/intelligence/skill/SkillMatcher'
import type { SkillManifest } from '@akemi-mio/intelligence/skill/SkillTypes'

function makeSkill(overrides: Partial<SkillManifest> & { name: string }): SkillManifest {
  return {
    version: '1.0.0',
    description: '',
    triggers: [],
    ...overrides,
  }
}

describe('SkillMatcher', () => {
  const matcher = new SkillMatcher()

  // ── matchByKeyword ──
  describe('matchByKeyword', () => {
    it('返回 true 当输入包含 trigger 关键字', () => {
      expect(matcher.matchByKeyword('帮我做个ppt', ['ppt', 'pptx'])).toBe(true)
    })

    it('返回 true 当英文 trigger 匹配', () => {
      expect(matcher.matchByKeyword('create a presentation', ['presentation', 'deck'])).toBe(true)
    })

    it('返回 true 当中文 trigger 匹配', () => {
      expect(matcher.matchByKeyword('帮我写一份演示文稿', ['演示文稿', '幻灯片'])).toBe(true)
    })

    it('返回 false 当没有 trigger 匹配', () => {
      expect(matcher.matchByKeyword('今天天气怎么样', ['ppt', 'xlsx', 'pdf'])).toBe(false)
    })

    it('返回 false 当 triggers 为空', () => {
      expect(matcher.matchByKeyword('帮我做个ppt', [])).toBe(false)
    })

    it('多词组合需要全部命中', () => {
      expect(matcher.matchByKeyword('帮我把表格做成PPT', ['powerpoint 演示'])).toBe(false)
      expect(matcher.matchByKeyword('做powerpoint演示', ['powerpoint 演示'])).toBe(true)
    })

    it('大小写不敏感', () => {
      expect(matcher.matchByKeyword('EXCEL表格', ['excel'])).toBe(true)
    })
  })

  // ── matchByDescription ──
  describe('matchByDescription', () => {
    it('技能名包含输入关键字时匹配', () => {
      const skill = makeSkill({ name: 'pptx', description: '创建和编辑演示文稿' })
      expect(matcher.matchByDescription('ppt', skill)).toBe(true)
    })

    it('输入包含技能名时匹配', () => {
      const skill = makeSkill({ name: 'pptx', description: '创建和编辑演示文稿' })
      expect(matcher.matchByDescription('给我做个pptx', skill)).toBe(true)
    })

    it('描述中包含输入关键字时匹配', () => {
      const skill = makeSkill({ name: 'xlsx', description: 'Read, create, and manipulate Excel spreadsheets (.xlsx)' })
      expect(matcher.matchByDescription('create a spreadsheet', skill)).toBe(true)
    })

    it('不匹配不相关的描述', () => {
      const skill = makeSkill({ name: 'pptx', description: '演示文稿' })
      expect(matcher.matchByDescription('帮我统计一下数据', skill)).toBe(false)
    })
  })

  // ── match（综合入口） ──
  describe('match', () => {
    const skills = [
      makeSkill({ name: 'pptx', description: '演示文稿', triggers: ['ppt', '演示', 'slides'] }),
      makeSkill({ name: 'xlsx', description: '电子表格', triggers: ['excel', 'xlsx', 'spreadsheet', '表格'] }),
      makeSkill({ name: 'pdf', description: '文档处理', triggers: ['pdf'] }),
      makeSkill({ name: 'docx', description: 'Word 文档', triggers: ['word', 'docx'] }),
      makeSkill({ name: 'skill-creator', description: '创建和编辑技能', triggers: ['skill', '技能'] }),
      makeSkill({ name: 'mcp-builder', description: 'MCP server 开发', triggers: ['mcp server', 'fastmcp'] }),
    ]

    it('按关键词精确匹配 pptx', () => {
      const result = matcher.match('帮我做个PPT', skills)
      expect(result.map((r) => r.manifest.name)).toContain('pptx')
      expect(result.find((r) => r.manifest.name === 'pptx')?.matchType).toBe('keyword')
    })

    it('按关键词匹配 xlsx', () => {
      const result = matcher.match('帮我把这个表格整理一下', skills)
      expect(result.map((r) => r.manifest.name)).toContain('xlsx')
    })

    it('按描述匹配 docx', () => {
      const result = matcher.match('帮我写一个word文档', skills)
      expect(result.map((r) => r.manifest.name)).toContain('docx')
    })

    it('按描述匹配 pdf', () => {
      const result = matcher.match('做一个pdf文件', skills)
      expect(result.map((r) => r.manifest.name)).toContain('pdf')
    })

    it('不匹配无关输入', () => {
      const result = matcher.match('今天天气真好', skills)
      expect(result.length).toBe(0)
    })

    it('空输入返回空数组', () => {
      expect(matcher.match('', skills).length).toBe(0)
      expect(matcher.match('  ', skills).length).toBe(0)
    })

    it('空技能列表返回空数组', () => {
      expect(matcher.match('帮我做PPT', []).length).toBe(0)
    })

    it('多个技能可同时匹配', () => {
      const result = matcher.match('帮我整理表格做成PPT汇报', skills)
      expect(result.length).toBeGreaterThanOrEqual(2)
    })
  })
})
