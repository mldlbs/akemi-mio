/**
 * PlatformPublisher — 多平台发布适配器
 *
 * 实现 PlatformPublisherAdapter 接口，为各平台提供发布/回滚能力。
 *
 * 设计原则（与 BlogToolboxTools 的 PlatformFormatter 模式一致）：
 * - 每个平台一个适配器实例
 * - 通过 credentials 获取 API 密钥
 * - 发布结果标准化为 { postUrl, postId }
 * - 支持回滚（通过平台 API 删除文章）
 *
 * ## 凭证命名约定
 *
 * | 平台         | API Key 凭证名              | 额外凭证                    |
 * |-------------|---------------------------|---------------------------|
 * | WordPress   | wordpress_api_endpoint    | wordpress_username        |
 * |             | wordpress_api_password    | (Application Password)    |
 * | CSDN        | csdn_cookie               | csdn_article_id (可选)    |
 * | 知乎         | zhihu_cookie              | —                         |
 * | 掘金         | juejin_cookie             | —                         |
 * | GitHub Pages| github_token              | github_repo               |
 * | 微信公众号    | wechat_appid              | wechat_secret             |
 * | 通用 HTTP   | generic_http_url          | generic_http_token        |
 */

import { getCredentialsManager } from '../tool/deps'
import { execSync } from 'child_process'
import type { PublishConfig, PublishPlatform, PlatformPublisherAdapter } from './types'
import { PLATFORM_LABELS } from './types'

// =============================================================================
// WordPress 适配器（REST API）
// =============================================================================

class WordPressPublisher implements PlatformPublisherAdapter {
  readonly platform: PublishPlatform = 'wordpress'

  async initialize(): Promise<void> {
    // 无额外初始化
  }

  isConfigured(): boolean {
    const cm = getCredentialsManager()
    return !!(
      cm?.get('wordpress_api_endpoint') &&
      cm?.get('wordpress_api_password')
    )
  }

  async publish(config: PublishConfig): Promise<{ postUrl?: string; postId?: string }> {
    const cm = getCredentialsManager()
    const endpoint = cm!.get('wordpress_api_endpoint')!.replace(/\/+$/, '')
    const username = cm!.get('wordpress_username') || 'admin'
    const password = cm!.get('wordpress_api_password')!

    const auth = Buffer.from(`${username}:${password}`).toString('base64')

    const body: Record<string, any> = {
      title: config.title,
      content: config.content,
      status: config.asDraft ? 'draft' : 'publish',
    }
    if (config.summary) body.excerpt = config.summary
    if (config.tags?.length) body.tags = config.tags
    if (config.category) body.categories = [config.category]

    const response = await fetch(`${endpoint}/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`WordPress API ${response.status}: ${text.slice(0, 300)}`)
    }

    const result = await response.json()
    return {
      postUrl: result.link,
      postId: String(result.id),
    }
  }

  async delete(postId: string): Promise<void> {
    const cm = getCredentialsManager()
    const endpoint = cm!.get('wordpress_api_endpoint')!.replace(/\/+$/, '')
    const username = cm!.get('wordpress_username') || 'admin'
    const password = cm!.get('wordpress_api_password')!

    const auth = Buffer.from(`${username}:${password}`).toString('base64')

    const response = await fetch(`${endpoint}/wp/v2/posts/${postId}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`WordPress 删除失败 ${response.status}: ${text.slice(0, 200)}`)
    }
  }
}

// =============================================================================
// GitHub Pages 适配器（Git Push）
// =============================================================================

class GitHubPagesPublisher implements PlatformPublisherAdapter {
  readonly platform: PublishPlatform = 'github_pages'

  async initialize(): Promise<void> {
    // 无额外初始化
  }

  isConfigured(): boolean {
    const cm = getCredentialsManager()
    return !!(cm?.get('github_token') && cm?.get('github_repo'))
  }

  async publish(config: PublishConfig): Promise<{ postUrl?: string; postId?: string }> {
    const cm = getCredentialsManager()
    const token = cm!.get('github_token')!
    const repo = cm!.get('github_repo')!
    const branch = cm!.get('github_pages_branch') || 'main'
    const postsDir = cm!.get('github_pages_posts_dir') || '_posts'

    // 文件名：YYYY-MM-DD-title.md
    const dateStr = new Date().toISOString().slice(0, 10)
    const safeTitle = config.title
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '')
    const filename = `${dateStr}-${safeTitle}.md`

    // 构建 Markdown 内容（含 frontmatter）
    const frontmatter: string[] = [
      '---',
      `title: "${config.title}"`,
      `date: ${dateStr}`,
    ]
    if (config.tags?.length) {
      frontmatter.push(`tags: [${config.tags.map((t) => `"${t}"`).join(', ')}]`)
    }
    if (config.category) {
      frontmatter.push(`categories: [${config.category}]`)
    }
    frontmatter.push('---')
    frontmatter.push('')

    const content = frontmatter.join('\n') + config.content

    // 使用 GitHub API 创建/更新文件
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${postsDir}/${filename}`
    const body = {
      message: `publish: ${config.title}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
    }

    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`)
    }

    const result = await response.json()

    // 判断 Pages 部署 URL
    const repoParts = repo.split('/')
    const owner = repoParts[0]
    const repoName = repoParts[1]
    const pagesUrl = `https://${owner}.github.io/${repoName}/${postsDir}/${filename.replace(/\.md$/, '/')}`

    return {
      postUrl: pagesUrl,
      postId: result.content?.sha || filename,
    }
  }

  async delete(postId: string): Promise<void> {
    const cm = getCredentialsManager()
    const token = cm!.get('github_token')!
    const repo = cm!.get('github_repo')!
    const branch = cm!.get('github_pages_branch') || 'main'
    const postsDir = cm!.get('github_pages_posts_dir') || '_posts'

    // 先获取文件的 SHA
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${postsDir}/${postId}`
    const getResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!getResponse.ok) {
      // 文件不存在则忽略
      if (getResponse.status === 404) return
      const text = await getResponse.text()
      throw new Error(`GitHub 获取文件失败 ${getResponse.status}: ${text.slice(0, 200)}`)
    }

    const fileInfo = await getResponse.json()

    // 删除文件
    const deleteResponse = await fetch(apiUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        message: `rollback: remove ${postId}`,
        sha: fileInfo.sha,
        branch,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!deleteResponse.ok) {
      const text = await deleteResponse.text()
      throw new Error(`GitHub 删除失败 ${deleteResponse.status}: ${text.slice(0, 200)}`)
    }
  }
}

// =============================================================================
// 通用 HTTP API 适配器
// =============================================================================

class GenericHttpPublisher implements PlatformPublisherAdapter {
  readonly platform: PublishPlatform = 'generic_http'

  async initialize(): Promise<void> {
    // 无额外初始化
  }

  isConfigured(): boolean {
    const cm = getCredentialsManager()
    return !!(cm?.get('generic_http_url') && cm?.get('generic_http_token'))
  }

  async publish(config: PublishConfig): Promise<{ postUrl?: string; postId?: string }> {
    const cm = getCredentialsManager()
    const url = cm!.get('generic_http_url')!
    const token = cm!.get('generic_http_token')!

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: config.title,
        content: config.content,
        summary: config.summary,
        tags: config.tags,
        category: config.category,
        cover_image: config.coverImage,
        as_draft: config.asDraft,
        ...config.customFields,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP API ${response.status}: ${text.slice(0, 300)}`)
    }

    const result = await response.json()
    return {
      postUrl: result.url || result.link || undefined,
      postId: String(result.id || result.postId || result.post_id || ''),
    }
  }

  async delete(postId: string): Promise<void> {
    const cm = getCredentialsManager()
    const url = cm!.get('generic_http_url')!
    const token = cm!.get('generic_http_token')!

    const response = await fetch(`${url}/${postId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok && response.status !== 404) {
      const text = await response.text()
      throw new Error(`HTTP API 删除失败 ${response.status}: ${text.slice(0, 200)}`)
    }
  }
}

// =============================================================================
// PlatformPublisherRegistry — 发布适配器注册表
// =============================================================================

export class PlatformPublisherRegistry {
  private adapters = new Map<PublishPlatform, PlatformPublisherAdapter>()

  constructor() {
    this.register(new WordPressPublisher())
    this.register(new GitHubPagesPublisher())
    this.register(new GenericHttpPublisher())
  }

  register(adapter: PlatformPublisherAdapter): void {
    this.adapters.set(adapter.platform, adapter)
  }

  get(platform: PublishPlatform): PlatformPublisherAdapter | undefined {
    return this.adapters.get(platform)
  }

  getAllConfigured(): PlatformPublisherAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => a.isConfigured())
  }

  getSupportedPlatforms(): PublishPlatform[] {
    return Array.from(this.adapters.keys())
  }

  isConfigured(platform: PublishPlatform): boolean {
    return this.adapters.get(platform)?.isConfigured() ?? false
  }
}

/** 全局单例 */
export const platformPublisherRegistry = new PlatformPublisherRegistry()
