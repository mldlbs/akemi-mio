/**
 * WebSearchTools — 联网搜索能力（免费免配置，多后端回退）
 *
 * 提供两个工具：
 * - web_search：Bing → Baidu → DuckDuckGo 回退链，返回标题/链接/摘要
 * - web_fetch：抓取指定 URL 的正文纯文本
 *
 * 设计文档：docs/superpowers/specs/2026-08-12-web-search-capability-design.md
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

interface SearchProvider {
  name: string
  search(query: string, timeoutMs: number): Promise<WebSearchResult[]>
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 剥离标签 + 解码常见 HTML 实体 + 折叠空白 */
export function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 带 UA 与超时的 HTML 抓取 */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** 解码 Bing 跳转链接中 base64 编码的真实 URL（u= 参数） */
export function decodeBingRedirectUrl(href: string): string {
  try {
    const match = href.match(/[?&]u=([^&]+)/)
    if (match) {
      const decoded = Buffer.from(decodeURIComponent(match[1]), 'base64').toString('utf-8')
      if (/^https?:\/\//i.test(decoded)) return decoded
    }
  } catch {
    // 非标准 URL 原样返回
  }
  return href
}

/** 解码 DuckDuckGo 跳转链接（uddg= 参数） */
export function decodeDdgRedirectUrl(href: string): string {
  const raw = decodeEntities(href)
  if (!raw.includes('duckduckgo.com/l/')) return raw
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    const target = parsed.searchParams.get('uddg')
    if (target) return target
  } catch {
    // 解析失败时返回原始链接
  }
  return raw
}

export function parseBing(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/gi).slice(1)
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>\s*<\/h2>/is)
    if (!titleMatch) continue
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)<\/p>/is) ||
      block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>\s*<p[^>]*>(.*?)<\/p>/is)
    results.push({
      title: decodeEntities(titleMatch[2]),
      url: decodeBingRedirectUrl(titleMatch[1]),
      snippet: snippetMatch ? decodeEntities(snippetMatch[1]) : '',
    })
  }
  return results
}

export function parseBaidu(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/gi).slice(1)
  for (const block of blocks) {
    const titleMatch = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>\s*<\/h3>/is)
    if (!titleMatch) continue
    const snippetMatch =
      block.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>(.*?)<\/span>/is) ||
      block.match(/<span[^>]*class="[^"]*c-abstract[^"]*"[^>]*>(.*?)<\/span>/is) ||
      block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>(.*?)<\/div>/is)
    results.push({
      title: decodeEntities(titleMatch[2]),
      url: titleMatch[1],
      snippet: snippetMatch ? decodeEntities(snippetMatch[1]) : '',
    })
  }
  return results
}

export function parseDuckDuckGo(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/gi).slice(1)
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is)
    if (!linkMatch) continue
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/is)
    results.push({
      title: decodeEntities(linkMatch[2]),
      url: decodeDdgRedirectUrl(linkMatch[1]),
      snippet: snippetMatch ? decodeEntities(snippetMatch[1]) : '',
    })
  }
  return results
}

const PROVIDERS: SearchProvider[] = [
  {
    name: 'Bing',
    search: (query, timeoutMs) => fetchText(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, timeoutMs).then(parseBing),
  },
  {
    name: 'Baidu',
    search: (query, timeoutMs) => fetchText(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, timeoutMs).then(parseBaidu),
  },
  {
    name: 'DuckDuckGo',
    search: (query, timeoutMs) =>
      fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, timeoutMs).then(parseDuckDuckGo),
  },
]

export async function searchWeb(
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<{ engine: string; results: WebSearchResult[] }> {
  const errors: string[] = []
  for (const provider of PROVIDERS) {
    try {
      const results = (await provider.search(query, timeoutMs)).slice(0, maxResults)
      if (results.length > 0) return { engine: provider.name, results }
      errors.push(`${provider.name}: 无结果`)
    } catch (err) {
      errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`所有搜索后端均失败 — ${errors.join('; ')}`)
}

/** 校验 URL 必须是 http/https */
export function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** HTML → 可读纯文本：移除脚本/样式、块级换行、去标签、实体解码、折叠空白 */
export function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const webFetchTool = buildTool({
  name: 'web_fetch',
  isReadOnly: true,
  description: '抓取指定网页的正文纯文本，返回页面标题与正文（自动截断）。' + '仅支持 http/https 链接；配合 web_search 阅读搜索结果全文。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页 URL，仅支持 http/https，必填' },
      max_chars: { type: 'number', description: '返回正文最大字符数，默认 6000，范围 500-20000' },
      timeout_ms: { type: 'number', description: '请求超时（毫秒），默认 10000，范围 1000-30000' },
    },
    required: ['url'],
  },
  handler: async (args: { url?: string; max_chars?: number; timeout_ms?: number }) => {
    const url = (args.url ?? '').trim()
    if (!isValidHttpUrl(url)) return formatToolError('url 必须是 http/https 链接')
    const maxChars = Math.min(Math.max(Math.floor(args.max_chars ?? 6000), 500), 20000)
    const timeoutMs = Math.min(Math.max(Math.floor(args.timeout_ms ?? 10000), 1000), 30000)
    try {
      const html = await fetchText(url, timeoutMs)
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is)
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/is)
      const parts: string[] = []
      if (titleMatch) parts.push(`标题: ${decodeEntities(titleMatch[1])}`)
      if (descMatch) parts.push(`简介: ${decodeEntities(descMatch[1])}`)
      const body = stripToText(html)
      if (body) parts.push(body)
      const text = parts.join('\n\n')
      if (text.length <= maxChars) return formatToolResult(text)
      return formatToolResult(`${text.slice(0, maxChars)}\n…（已截断）`)
    } catch (err) {
      return formatToolError(err instanceof Error ? err.message : String(err))
    }
  },
})

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(value ?? fallback)
  if (Number.isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export const webSearchTool = buildTool({
  name: 'web_search',
  isReadOnly: true,
  description:
    '联网搜索：返回标题、链接与摘要。国内可用，Bing → Baidu → DuckDuckGo 自动回退。' +
    '适合查询最新信息、事实核查、查找网页来源等场景；需要阅读全文时配合 web_fetch。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，必填' },
      max_results: { type: 'number', description: '返回结果条数，默认 5，范围 1-10' },
      timeout_ms: { type: 'number', description: '单后端超时（毫秒），默认 8000，范围 1000-30000' },
    },
    required: ['query'],
  },
  handler: async (args: { query?: string; max_results?: number; timeout_ms?: number }) => {
    const query = (args.query ?? '').trim()
    if (!query) return formatToolError('query 不能为空')
    const envMax = Number(process.env.SEARCH_MAX_RESULTS)
    const envTimeout = Number(process.env.SEARCH_TIMEOUT_MS)
    const maxResults = clampInt(args.max_results ?? envMax, 5, 1, 10)
    const timeoutMs = clampInt(args.timeout_ms ?? envTimeout, 8000, 1000, 30000)
    try {
      const { engine, results } = await searchWeb(query, maxResults, timeoutMs)
      const lines = [`搜索完成（来源：${engine}）`]
      results.forEach((r, i) => {
        lines.push(`\n${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
      })
      return formatToolResult(lines.join('\n'))
    } catch (err) {
      return formatToolError(err instanceof Error ? err.message : String(err))
    }
  },
})

