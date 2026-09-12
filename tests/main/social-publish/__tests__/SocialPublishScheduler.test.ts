import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SocialPublishScheduler } from '@akemi-mio/capabilities/social-publish/SocialPublishScheduler'
import type { ICapabilityService, CapabilityBinding } from '@akemi-mio/capabilities/capability/types'

const FIXED_NOW = new Date('2026-08-13T12:00:00+08:00').getTime()
const DRAFT_REL = 'drafts/2026-08-13-x/douyin/x.md'

class FakeCapabilityService implements ICapabilityService {
  public calls: Array<{ binding: CapabilityBinding; input: unknown }> = []
  constructor(private readonly respond: (input: any) => unknown) {}
  async resolve(_capability: string): Promise<CapabilityBinding | undefined> {
    return { capability: 'publishing', provider: { type: 'mcp', id: 'social-publish' }, tool: 'social_publish' }
  }
  async invoke(binding: CapabilityBinding, input: unknown): Promise<unknown> {
    this.calls.push({ binding, input })
    return JSON.stringify(this.respond(input))
  }
  listCapabilities(): string[] {
    return ['publishing']
  }
}

const CALENDAR = (body: string): string => `# 内容排程索引
# draft: drafts/<platform>/<file>.md 查看完整内容

scheduled:
${body}
published:
`

function item(overrides: Record<string, unknown> = {}): string {
  const scheduledAt = overrides.scheduledAt ?? '2026-08-13 11:00'
  const platform = overrides.platform ?? 'telegram'
  const status = overrides.status ?? 'scheduled'
  return [
    `  - scheduledAt: "${scheduledAt}"`,
    `    draft: "${DRAFT_REL}"`,
    `    platform: "${platform}"`,
    '    title: "测试标题"',
    '    topics: ["a"]',
    `    status: ${status}`,
  ].join('\n')
}

const DRAFT_CONTENT = ['# 测试标题', '', '## 文案', '正文内容', ''].join('\n')

describe('SocialPublishScheduler', () => {
  let dir: string
  let svc: FakeCapabilityService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'social-scheduler-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    mkdirSync(join(dir, 'drafts', '2026-08-13-x', 'douyin'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'config.yaml'),
      ['mode: assisted', 'platforms:', '  telegram:', '    enabled: true', '  x:', '    enabled: false'].join('\n'),
      'utf-8',
    )
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function scheduler(respond: (input: any) => unknown): SocialPublishScheduler {
    svc = new FakeCapabilityService(respond)
    return new SocialPublishScheduler(svc, { socialDir: dir, now: () => FIXED_NOW })
  }

  function writeDraft(content = DRAFT_CONTENT): void {
    writeFileSync(join(dir, DRAFT_REL), content, 'utf-8')
  }

  it('无日历文件时返回全 0', async () => {
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result).toEqual({ posted: 0, skipped: 0, errors: 0, cancelled: 0, details: [] })
  })

  it('到期项发布成功：回写 published + postId，从 scheduled 移除', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    const s = scheduler(() => ({ status: 'published', postId: 'p123', url: 'https://t.me/x/p123' }))
    const result = await s.runOnce()
    expect(result.posted).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: published')
    expect(raw).toContain('postId: p123')
    const scheduledSection = raw.slice(raw.indexOf('scheduled:') + 'scheduled:'.length, raw.indexOf('published:'))
    expect(scheduledSection).not.toContain('scheduledAt')
    expect(svc.calls).toHaveLength(1)
    expect((svc.calls[0].input as any).platform).toBe('telegram')
    expect((svc.calls[0].input as any).content).toBe('正文内容')
    expect((svc.calls[0].input as any).title).toBe('测试标题')
  })

  it('未到期项保留在 scheduled', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item({ scheduledAt: '2026-08-14 09:00' })), 'utf-8')
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result.posted).toBe(0)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('2026-08-14 09:00')
    expect(raw).toContain('status: scheduled')
  })

  it('平台 disabled 时跳过并保持 scheduled', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item({ platform: 'x' })), 'utf-8')
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result.skipped).toBe(1)
    expect(svc.calls).toHaveLength(0)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('platform: "x"')
    expect(raw).toContain('status: scheduled')
  })

  it('mode safe 时跳过并保持 scheduled', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: safe\nplatforms:\n  telegram:\n    enabled: true\n', 'utf-8')
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result.skipped).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: scheduled')
  })

  it('未知平台记为 failed', async () => {
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item({ platform: 'myspace' })), 'utf-8')
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result.errors).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: failed')
  })

  it('requires_review 记为 cancelled', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    const s = scheduler(() => ({ status: 'requires_review', reasons: ['微信'] }))
    const result = await s.runOnce()
    expect(result.cancelled).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: cancelled')
  })

  it('invoke 抛错时记为 failed', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    svc = new FakeCapabilityService(() => {
      throw new Error('boom')
    })
    const s = new SocialPublishScheduler(svc, { socialDir: dir, now: () => FIXED_NOW })
    const result = await s.runOnce()
    expect(result.errors).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: failed')
  })

  it('空内容跳过并保持 scheduled', async () => {
    writeDraft('')
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    const s = scheduler(() => ({ status: 'published' }))
    const result = await s.runOnce()
    expect(result.skipped).toBe(1)
    const raw = readFileSync(join(dir, 'config', 'content_calendar.yaml'), 'utf-8')
    expect(raw).toContain('status: scheduled')
  })

  it('tick() 包装为 TaskExecutionResult', async () => {
    writeDraft()
    writeFileSync(join(dir, 'config', 'content_calendar.yaml'), CALENDAR(item()), 'utf-8')
    const s = scheduler(() => ({ status: 'published', postId: 'p1' }))
    const result = await s.tick()
    expect(result.success).toBe(true)
    expect(result.summary).toContain('"posted":1')
  })
})
