import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SocialPublishService, SOCIAL_PLATFORMS, type CliRunner, type CredentialProvider } from '@akemi-mio/capabilities/social-publish/SocialPublishService'

type ImplResult = { stdout: string; stderr?: string } | Error

function makeRunner(impl: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => ImplResult): CliRunner {
  return vi.fn(async (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => {
    const r = impl(args, cwd, env)
    if (r instanceof Error) throw r
    return { stdout: r.stdout, stderr: r.stderr ?? '' }
  })
}

function credsOf(map: Record<string, string>): CredentialProvider {
  return { get: vi.fn((k: string) => map[k] ?? null) }
}

const CONFIG_DEFAULT = ['mode: assisted', 'platforms:', '  x:', '    enabled: true', '  telegram:', '    enabled: true'].join('\n')

describe('SocialPublishService', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'social-svc-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'config.yaml'), CONFIG_DEFAULT, 'utf-8')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function svc(runner: CliRunner, options: { credentials?: CredentialProvider } = {}): SocialPublishService {
    return new SocialPublishService(runner, { socialDir: dir, ...options })
  }

  it('拒绝未知平台', async () => {
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'myspace', content: 'hi' })
    expect(result.status).toBe('error')
    expect(result.error).toContain('未知平台')
  })

  it('拒绝空 content', async () => {
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: '   ' })
    expect(result.status).toBe('error')
    expect(result.error).toContain('content 不能为空')
  })

  it('dryRun 短路，不调用 CLI', async () => {
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: 'hi', dryRun: true })
    expect(result.status).toBe('dry_run')
    expect(runner).not.toHaveBeenCalled()
  })

  it('post 组装 CLI 参数并解析发布结果', async () => {
    const runner = makeRunner((args) => {
      expect(args[1]).toBe('post')
      expect(args[2]).toBe('telegram')
      expect(args[3]).toBe('hello 世界')
      return { stdout: JSON.stringify({ postId: '123', url: 'https://t.me/x/123' }) }
    })
    const result = await svc(runner).post({ platform: 'telegram', content: 'hello 世界', title: '标题' })
    expect(result.status).toBe('published')
    expect(result.postId).toBe('123')
    expect(result.url).toBe('https://t.me/x/123')
  })

  it('透传 title / replyToId 参数', async () => {
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: autopilot\nplatforms:\n  x:\n    enabled: true\n', 'utf-8')
    const runner = makeRunner((args) => {
      expect(args).toContain('--title')
      expect(args).toContain('--replyToId')
      return { stdout: JSON.stringify({ postId: 'r9' }) }
    })
    const result = await svc(runner).post({ platform: 'x', content: 'c', title: 't', replyToId: 'r9' })
    expect(result.status).toBe('published')
    expect(result.postId).toBe('r9')
  })

  it('映射 requires_review / blocked / CLI 异常', async () => {
    const s1 = svc(makeRunner(() => ({ stdout: JSON.stringify({ status: 'requires_review', reasons: ['微信'] }) })))
    const r1 = await s1.post({ platform: 'telegram', content: '带微信链接' })
    expect(r1.status).toBe('requires_review')
    expect(r1.reasons).toEqual(['微信'])

    const s2 = svc(makeRunner(() => ({ stdout: JSON.stringify({ status: 'blocked', mode: 'safe', action: 'draft' }) })))
    const r2 = await s2.post({ platform: 'telegram', content: 'hi' })
    expect(r2.status).toBe('blocked')
    expect(r2.mode).toBe('safe')

    const s3 = svc(makeRunner(() => new Error('boom')))
    const r3 = await s3.post({ platform: 'telegram', content: 'hi' })
    expect(r3.status).toBe('error')
    expect(r3.error).toBe('boom')
  })

  it('health 解析适配器健康矩阵', async () => {
    const runner = makeRunner((args) => {
      expect(args[1]).toBe('adapters')
      return { stdout: JSON.stringify({ adapters: [{ platform: 'telegram', healthy: true, capabilities: { post: true } }] }) }
    })
    const health = await svc(runner).health()
    expect(health).toHaveLength(1)
    expect(health[0].platform).toBe('telegram')
    expect(health[0].healthy).toBe(true)
  })

  it('暴露 7 平台常量', () => {
    expect(SOCIAL_PLATFORMS).toEqual(['x', 'telegram', 'weibo', 'zhihu', 'douyin', 'xiaohongshu', 'wechat_mp'])
  })

  it('凭据从 CredentialsManager 以小写键读取并注入子进程 env（设计 4.4）', async () => {
    const creds = credsOf({ telegram_bot_token: 'BOT123', telegram_chat_id: 'CID', social_proxy: 'http://proxy:8080' })
    const runner = makeRunner((_args, _cwd, env) => {
      expect(env?.TELEGRAM_BOT_TOKEN).toBe('BOT123')
      expect(env?.TELEGRAM_CHAT_ID).toBe('CID')
      expect(env?.SOCIAL_PROXY).toBe('http://proxy:8080')
      expect(env?.WEIBO_COOKIE).toBeUndefined()
      return { stdout: JSON.stringify({ postId: '1' }) }
    })
    const result = await svc(runner, { credentials: creds }).post({ platform: 'telegram', content: 'hi' })
    expect(result.status).toBe('published')
  })

  it('health 同样注入凭据 env', async () => {
    const creds = credsOf({ telegram_bot_token: 'BOT' })
    const runner = makeRunner((_args, _cwd, env) => {
      expect(env?.TELEGRAM_BOT_TOKEN).toBe('BOT')
      return { stdout: JSON.stringify({ adapters: [] }) }
    })
    await svc(runner, { credentials: creds }).health()
    expect(runner).toHaveBeenCalled()
  })

  it('平台 disabled 时在能力边界拒绝（platform_disabled）', async () => {
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: assisted\nplatforms:\n  telegram:\n    enabled: false\n', 'utf-8')
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: 'hi' })
    expect(result.status).toBe('blocked')
    expect(result.reasons).toEqual(['platform_disabled'])
    expect(runner).not.toHaveBeenCalled()
  })

  it('mode safe 时拒绝自动发布（mode_not_allowed）', async () => {
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: safe\nplatforms:\n  telegram:\n    enabled: true\n', 'utf-8')
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: 'hi' })
    expect(result.status).toBe('blocked')
    expect(result.mode).toBe('safe')
    expect(result.reasons).toEqual(['mode_not_allowed'])
    expect(runner).not.toHaveBeenCalled()
  })

  it('assisted 模式拒绝自动回复（reply_auto）', async () => {
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: 'hi', replyToId: 'r1' })
    expect(result.status).toBe('blocked')
    expect(result.action).toBe('reply_auto')
    expect(runner).not.toHaveBeenCalled()
  })

  it('autopilot 模式放行发布与自动回复', async () => {
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: autopilot\nplatforms:\n  telegram:\n    enabled: true\n', 'utf-8')
    const runner = makeRunner(() => ({ stdout: JSON.stringify({ postId: 'p1' }) }))
    const service = svc(runner)
    const r1 = await service.post({ platform: 'telegram', content: 'hi' })
    const r2 = await service.post({ platform: 'telegram', content: 'hi', replyToId: 'r1' })
    expect(r1.status).toBe('published')
    expect(r2.status).toBe('published')
  })

  it('风险词命中时返回 requires_review 且不调用 CLI（设计 4.5）', async () => {
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: '包含政治和宗教相关内容' })
    expect(result.status).toBe('requires_review')
    expect(result.reasons).toContain('政治')
    expect(runner).not.toHaveBeenCalled()
  })

  it('dryRun 在门禁前放行（演练校验不受平台开关影响）', async () => {
    writeFileSync(join(dir, 'config', 'config.yaml'), 'mode: safe\nplatforms:\n  telegram:\n    enabled: false\n', 'utf-8')
    const runner = makeRunner(() => new Error('should not run'))
    const result = await svc(runner).post({ platform: 'telegram', content: 'hi', dryRun: true })
    expect(result.status).toBe('dry_run')
    expect(runner).not.toHaveBeenCalled()
  })
})
