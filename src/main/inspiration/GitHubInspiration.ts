import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../logger/Logger'

/**
 * 搜索的领域 — 覆盖秋山澪相关的技术栈
 */
const SEARCH_QUERIES = [
  'voice assistant desktop',
  'electron wallpaper engine',
  'whisper realtime speech recognition',
  'ai personal assistant desktop',
  'TTS edge voice synthesis',
  'electron transparent overlay',
  'desktop widget AI chat',
  'self-evolving software architecture',
]

/** 缓存有效期（毫秒） 默认 12 小时 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** 每个 query 取前几个 repo */
const TOP_N_PER_QUERY = 3

/** 总 repo 数上限 */
const MAX_REPOS = 15

/** GitHub API 基础 URL */
const GITHUB_API = 'https://api.github.com'

/** 从 GitHub API 返回的原始仓库信息 */
export interface RawRepoInfo {
  owner: string
  repo: string
  url: string
  stars: number
  description: string
  topics: string[]
  language: string
}

/** 经过分析和缓存的灵感条目 */
export interface InspirationEntry {
  repo: RawRepoInfo
  fetchedAt: number
  readmePreview: string
  keyFeatures: string[]
  architectureHighlights: string[]
}

interface InspirationCache {
  entries: InspirationEntry[]
  lastFetched: number
}

/**
 * GitHubInspiration — 定期从 GitHub 搜索优秀项目，提取灵感和架构参考。
 *
 * 使用方式：
 * 1. 初始化时传入 cacheDir（推荐 evolution_workspace/inspiration/）
 * 2. 每次调用 getSources() 检查缓存是否过期，过期则刷新
 * 3. 返回 CreativitySource[]，注入到创造力引擎
 */
export class GitHubInspiration {
  private cachePath: string
  private cache: InspirationCache | null = null
  /** 可选 GitHub Token，提高 API 频率限制 */
  private token: string | null = null

  constructor(cacheDir: string, token?: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    this.cachePath = join(cacheDir, 'github-inspiration.json')
    this.token = token || null
  }

  /**
   * 获取灵感来源（缓存的或新抓取的）
   */
  getSources(): Array<{ name: string; content: string; type: 'knowledge'; weight: number }> {
    const cache = this.loadCache()

    // 缓存有效
    if (cache && Date.now() - cache.lastFetched < CACHE_TTL_MS) {
      log('INFO', 'inspiration_cache_hit', { entries: cache.entries.length })
      return this.entriesToSources(cache.entries)
    }

    // 异步刷新（不阻塞当前调用，返回旧缓存或空）
    this.refresh().catch((err) => log('ERROR', 'inspiration_refresh_failed', { error: String(err) }))

    if (cache && cache.entries.length > 0) {
      return this.entriesToSources(cache.entries)
    }
    return []
  }

  /**
   * 从 GitHub 刷新数据
   */
  async refresh(): Promise<void> {
    log('INFO', 'inspiration_refresh_start')

    const allRepos = new Map<string, RawRepoInfo>()

    // 并发搜索所有 query
    const results = await Promise.allSettled(
      SEARCH_QUERIES.map((q) => this.searchRepos(q)),
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const repo of result.value) {
          const key = `${repo.owner}/${repo.repo}`
          // 去重：保留 star 更高的
          if (!allRepos.has(key) || allRepos.get(key)!.stars < repo.stars) {
            allRepos.set(key, repo)
          }
        }
      }
    }

    // 按 star 排序取 top
    const repos = [...allRepos.values()]
      .sort((a, b) => b.stars - a.stars)
      .slice(0, MAX_REPOS)

    if (repos.length === 0) {
      log('WARN', 'inspiration_no_repos_found')
      return
    }

    log('INFO', 'inspiration_repos_found', { count: repos.length })

    // 抓取 README
    const entries: InspirationEntry[] = []
    for (const repo of repos) {
      try {
        const readme = await this.fetchReadme(repo.owner, repo.repo)
        if (!readme) continue

        const analysis = this.analyzeReadme(repo, readme)
        entries.push({
          repo,
          fetchedAt: Date.now(),
          readmePreview: readme.slice(0, 2000),
          keyFeatures: analysis.features,
          architectureHighlights: analysis.architecture,
        })
      } catch (err) {
        log('WARN', 'inspiration_readme_fetch_failed', {
          repo: `${repo.owner}/${repo.repo}`,
          error: String(err),
        })
      }
    }

    const cache: InspirationCache = {
      entries,
      lastFetched: Date.now(),
    }
    this.saveCache(cache)
    this.cache = cache

    log('INFO', 'inspiration_refresh_done', { entries: entries.length })
  }

  /**
   * 搜索 GitHub 仓库
   */
  private async searchRepos(query: string): Promise<RawRepoInfo[]> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'akemi-mio/1.0',
    }
    if (this.token) headers['Authorization'] = `token ${this.token}`

    const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${TOP_N_PER_QUERY}`

    const res = await fetch(url, { headers })
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        log('WARN', 'inspiration_rate_limited', { query })
        return []
      }
      log('WARN', 'inspiration_search_failed', { query, status: res.status })
      return []
    }

    const data = (await res.json()) as {
      items?: Array<{
        full_name: string
        html_url: string
        stargazers_count: number
        description: string | null
        topics?: string[]
        language: string | null
      }>
    }

    if (!data.items) return []

    return data.items.map((item) => {
      const [owner, repo] = item.full_name.split('/')
      return {
        owner,
        repo,
        url: item.html_url,
        stars: item.stargazers_count,
        description: item.description || '',
        topics: item.topics || [],
        language: item.language || 'unknown',
      }
    })
  }

  /**
   * 获取仓库 README
   */
  private async fetchReadme(owner: string, repo: string): Promise<string | null> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'akemi-mio/1.0',
    }
    if (this.token) headers['Authorization'] = `token ${this.token}`

    const url = `${GITHUB_API}/repos/${owner}/${repo}/readme`

    const res = await fetch(url, { headers })
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) return null
      return null
    }

    const text = await res.text()
    return text.slice(0, 5000) // 限制大小
  }

  /**
   * 从 README 提取关键信息
   */
  private analyzeReadme(
    repo: RawRepoInfo,
    readme: string,
  ): { features: string[]; architecture: string[] } {
    const features: string[] = []
    const architecture: string[] = []

    // 从描述中提取
    if (repo.description) {
      features.push(`项目方向: ${repo.description}`)
    }

    // 从 README 中提取关键信息
    const lines = readme.split('\n')
    let inFeatureSection = false
    let inArchSection = false

    for (const line of lines) {
      const lower = line.toLowerCase()

      // 特性章节
      if (
        /^##+\s*(features?|特性|功能|highlights?|特点)/i.test(line)
      ) {
        inFeatureSection = true
        inArchSection = false
        continue
      }

      // 架构章节
      if (
        /^##+\s*(architecture|arch|技术架构|架构|structure|design|tech stack|技术栈)/i.test(line)
      ) {
        inArchSection = false
        inArchSection = true
        continue
      }

      // 下一个章节
      if (/^##+\s/.test(line)) {
        inFeatureSection = false
        inArchSection = false
      }

      const trimmed = line.replace(/^[-*]\s*/, '').trim()
      if (!trimmed || trimmed.length < 10) continue

      if (inFeatureSection && features.length < 5) {
        features.push(trimmed)
      }
      if (inArchSection && architecture.length < 5) {
        architecture.push(trimmed)
      }
    }

    // 如果章节没找到，从其他部分提取
    if (features.length === 0) {
      for (const line of lines) {
        const l = line.toLowerCase()
        if (
          /built with|powered by|using|tech stack|runs on/i.test(l) ||
          /react|electron|typescript|python|whisper|tts|asr|llm|gpu|cuda/i.test(l)
        ) {
          features.push(line.trim())
          if (features.length >= 3) break
        }
      }
    }

    return {
      features: features.slice(0, 5),
      architecture: architecture.slice(0, 5),
    }
  }

  /**
   * 将缓存条目转为 CreativitySource 格式
   */
  private entriesToSources(
    entries: InspirationEntry[],
  ): Array<{ name: string; content: string; type: 'knowledge'; weight: number }> {
    const sources: Array<{ name: string; content: string; type: 'knowledge'; weight: number }> = []

    for (const entry of entries) {
      const starBadge = entry.repo.stars >= 10000 ? '🔥高星' : entry.repo.stars >= 1000 ? '⭐热门' : '📌'
      const contentLines: string[] = [
        `描述: ${entry.repo.description}`,
        `语言: ${entry.repo.language}`,
        `Star: ${entry.repo.stars}`,
        `主题: ${entry.repo.topics.join(', ')}`,
      ]

      if (entry.keyFeatures.length > 0) {
        contentLines.push(`特色功能: ${entry.keyFeatures.join(' | ')}`)
      }
      if (entry.architectureHighlights.length > 0) {
        contentLines.push(`架构亮点: ${entry.architectureHighlights.join(' | ')}`)
      }

      sources.push({
        name: `${starBadge} ${entry.repo.owner}/${entry.repo.repo}`,
        content: contentLines.join('\n'),
        type: 'knowledge',
        weight: Math.min(0.8, 0.3 + (entry.repo.stars / 50000) * 0.5),
      })
    }

    return sources
  }

  private loadCache(): InspirationCache | null {
    try {
      if (!existsSync(this.cachePath)) return null
      const raw = readFileSync(this.cachePath, 'utf-8')
      return JSON.parse(raw) as InspirationCache
    } catch {
      return null
    }
  }

  private saveCache(data: InspirationCache): void {
    try {
      const dir = dirname(this.cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'inspiration_cache_save_failed', { error: String(err) })
    }
  }

  /**
   * 强制立即刷新（用于手动触发）
   */
  async forceRefresh(): Promise<void> {
    this.cache = null
    await this.refresh()
  }
}
