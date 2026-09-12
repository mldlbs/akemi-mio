import { spawn } from 'child_process'
import { join } from 'path'
import { WORKSPACE } from '@akemi-mio/core/config'
import { log } from '@akemi-mio/core/logger/Logger'
import type { CredentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { SOCIAL_CREDS_KEY_MIGRATION } from '@akemi-mio/core/credentials/socialCredsMigration'
import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import { loadSocialConfig } from './socialConfig'
import { assessRisk, modeAllowsPublish } from './socialPolicy'

/**
 * SocialPublishService — 社交平台发布能力（publishing · social-publish provider）
 *
 * 阶段一：后端调用 evolution workspace 的 social CLI（7 平台适配器），
 * 后续阶段将适配器迁入 in-app TS，并把门禁（平台开关 / mode / 风险词 / 凭据）
 * 上移到能力边界。
 */

export const SOCIAL_PLATFORMS = ['x', 'telegram', 'weibo', 'zhihu', 'douyin', 'xiaohongshu', 'wechat_mp'] as const

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export interface SocialPublishInput {
  platform: string
  content: string
  title?: string
  replyToId?: string
  dryRun?: boolean
}

export type SocialPublishStatus = 'dry_run' | 'published' | 'requires_review' | 'blocked' | 'error'

export interface SocialPublishResult {
  platform: string
  status: SocialPublishStatus
  postId?: string
  url?: string
  requiresHumanPublish?: boolean
  reasons?: string[]
  mode?: string
  action?: string
  error?: string
  raw?: unknown
}

export interface SocialAdapterHealth {
  platform: string
  healthy: boolean
  capabilities: Record<string, boolean>
}

/** CLI runner：args 数组 + cwd + env，返回 stdout/stderr（可注入用于测试） */
export type CliRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>

async function defaultRunner(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || `social CLI 退出码 ${code}`))
    })
  })
}

export type CredentialProvider = Pick<CredentialsManager, 'get'>

/** 凭据注入所需的小写键集合（对齐设计 4.4 迁移映射） */
export const SOCIAL_CREDENTIAL_KEYS: string[] = Object.values(SOCIAL_CREDS_KEY_MIGRATION)

export interface SocialPublishServiceOptions {
  /** 覆盖 social 工作区目录（测试用） */
  socialDir?: string
  /** 覆盖凭据读取源（测试用；默认走 deps 注入的 CredentialsManager） */
  credentials?: CredentialProvider
}

export class SocialPublishService {
  private readonly socialDir: string
  private readonly cliPath: string
  private readonly credentials?: CredentialProvider

  constructor(
    private readonly runner: CliRunner = defaultRunner,
    options: SocialPublishServiceOptions = {},
  ) {
    this.socialDir = options.socialDir ?? join(WORKSPACE.evolution, 'social')
    this.cliPath = join(this.socialDir, 'workflows', 'cli.mjs')
    this.credentials = options.credentials
  }

  /** 平台分发：canonical input → social CLI post → 结构化结果 */
  async post(input: SocialPublishInput): Promise<SocialPublishResult> {
    const platform = (input?.platform ?? '').trim()
    const content = (input?.content ?? '').trim()

    if (!SOCIAL_PLATFORMS.includes(platform as SocialPlatform)) {
      return { platform, status: 'error', error: `未知平台: ${platform}（可用: ${SOCIAL_PLATFORMS.join(', ')}）` }
    }
    if (!content) {
      return { platform, status: 'error', error: 'content 不能为空' }
    }

    // dryRun 短路：只做平台 / 内容校验，不产生真实发布（门禁前放行，便于演练校验）
    if (input.dryRun) {
      log('INFO', 'social_publish.dry_run', {
        platform,
        contentLength: content.length,
        title: input.title,
        replyToId: input.replyToId,
      })
      return { platform, status: 'dry_run', requiresHumanPublish: false }
    }

    // 门禁（能力边界，设计 4.5）：平台开关 → mode 策略 → 风险词
    const config = loadSocialConfig(this.socialDir)

    const platformCfg = config.platforms[platform]
    if (platformCfg && platformCfg.enabled === false) {
      log('WARN', 'social_publish.blocked', { platform, reason: 'platform_disabled', mode: config.mode })
      return { platform, status: 'blocked', mode: config.mode, action: 'publish', reasons: ['platform_disabled'] }
    }

    const allowance = modeAllowsPublish(config.mode, input.replyToId)
    if (!allowance.allowed) {
      log('WARN', 'social_publish.blocked', { platform, reason: 'mode_not_allowed', mode: config.mode, action: allowance.action })
      return { platform, status: 'blocked', mode: config.mode, action: allowance.action, reasons: ['mode_not_allowed'] }
    }

    const risk = assessRisk(content, config.mode)
    if (risk.requiresReview) {
      log('WARN', 'social_publish.requires_review', { platform, reasons: risk.reasons })
      return { platform, status: 'requires_review', reasons: risk.reasons }
    }

    const args = [this.cliPath, 'post', platform, content]
    if (input.title) args.push('--title', input.title)
    if (input.replyToId) args.push('--replyToId', input.replyToId)

    try {
      const { stdout } = await this.runner(args, this.socialDir, this.buildSocialEnv())
      return this.parsePostResult(platform, stdout)
    } catch (err: any) {
      log('WARN', 'social_publish.post_failed', { platform, error: err.message })
      return { platform, status: 'error', error: err.message || String(err) }
    }
  }

  /** 只读健康检查（Gate G2）：7 平台适配器 healthCheck */
  async health(): Promise<SocialAdapterHealth[]> {
    try {
      const { stdout } = await this.runner([this.cliPath, 'adapters'], this.socialDir, this.buildSocialEnv())
      const parsed = JSON.parse(stdout)
      return Array.isArray(parsed?.adapters) ? (parsed.adapters as SocialAdapterHealth[]) : []
    } catch (err: any) {
      log('WARN', 'social_publish.health_failed', { error: err.message })
      return []
    }
  }

  /**
   * 凭据注入（设计 4.4）：从 CredentialsManager 批量读取小写键，
   * 以大写 env 键注入子进程（social/adapters/*.mjs 仍读大写环境变量）。
   */
  private buildSocialEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const cm = this.credentials ?? getCredentialsManager()
    const env: NodeJS.ProcessEnv = { ...base }
    if (!cm) return env
    for (const key of SOCIAL_CREDENTIAL_KEYS) {
      const value = cm.get(key)
      if (value) env[key.toUpperCase()] = value
    }
    return env
  }

  private parsePostResult(platform: string, stdout: string): SocialPublishResult {
    try {
      const data = JSON.parse(stdout.trim()) as Record<string, any>
      if (data.status === 'requires_review') {
        return { platform, status: 'requires_review', reasons: Array.isArray(data.reasons) ? data.reasons : [] }
      }
      if (data.status === 'blocked') {
        return { platform, status: 'blocked', mode: data.mode, action: data.action }
      }
      if (data.status === 'error') {
        return { platform, status: 'error', error: data.error ?? 'social CLI 返回错误' }
      }
      // 适配器直接返回发布结果（无 status 字段）
      return {
        platform,
        status: 'published',
        postId: data.postId,
        url: data.url,
        requiresHumanPublish: data.requiresHumanPublish,
        raw: data,
      }
    } catch {
      return { platform, status: 'error', error: `无法解析 social CLI 输出: ${stdout.trim().slice(0, 200)}` }
    }
  }
}

export const socialPublishService = new SocialPublishService()

