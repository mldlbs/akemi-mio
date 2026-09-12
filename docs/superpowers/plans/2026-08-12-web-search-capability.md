# Web Search Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **执行说明：** 本会话约定不自动执行 `git commit`（除非用户明确要求），计划中的 Commit 步骤执行时跳过并口头说明即可。

**Goal:** 为 mio 增加免费免配置的联网搜索能力：`web_search`（Bing → Baidu → DuckDuckGo 回退）与 `web_fetch`（抓取网页正文）。

**Architecture:** 在 `src/main/tool/definitions/WebSearchTools.ts` 实现两个只读工具，经 `getAllTools()` 注册后通过 `LocalProviderAdapter` → `ServerManager` 暴露给 LLM。capability-first 模式下 `search.retrieval` 的 defaultTool 是 `grep`、schema 无工具选择字段，走不到 web 搜索，因此**新增独立 capability**：在 `AppRuntime.ts` 注册 `web-search`（`web.search`）与 `web-fetch`（`web.fetch`）两个 manifest，并用 `searchAdapter`（已有 `web_search` / `web_fetch` 映射）注册 adapter。同时保留 search-engine manifest 的 `search.retrieval → web_search / web_fetch` 依赖（对 `call_raw_tool` / dual 路由无害）。解析采用轻量正则/字符串，不引入 DOM 解析依赖。

**Tech Stack:** TypeScript / Node fetch（Electron 主进程）/ Vitest（mock `globalThis.fetch`）。

---

## 前置命令速查

```bash
# 单文件测试
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
# 注册回归
npx vitest run src/main/tool/__tests__/index.test.ts src/main/__tests__/tools.test.ts
# 类型检查
npm run typecheck
```

---

## Task 1: WebSearchTools 解析与回退链

**Files:**
- Create: `src/main/tool/definitions/WebSearchTools.ts`
- Test: `src/main/tool/__tests__/WebSearchTools.test.ts`

- [ ] **Step 1: 编写解析与回退链测试（先红）**

创建 `src/main/tool/__tests__/WebSearchTools.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseBing,
  parseBaidu,
  parseDuckDuckGo,
  decodeBingRedirectUrl,
  searchWeb,
} from '../definitions/WebSearchTools'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOnce(html: string, ok = true, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    text: async () => html,
  } as any)
}

function bingHref(target: string): string {
  return `https://cn.bing.com/ck/a?u=${encodeURIComponent(Buffer.from(target).toString('base64'))}`
}

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="${bingHref('https://example.com/')}">Example Domain</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">This domain is for use in illustrative examples.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="${bingHref('https://example.org/')}">Example Org &amp; Friends</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">Second snippet here.</p></div>
  </li>
</ol>`

const BAIDU_HTML = `
<div class="result c-container " id="1">
  <h3 class="t"><a href="https://www.baidu.com/link?url=abc123">百度测试结果</a></h3>
  <span class="content-right_8Zs40">这是百度的摘要内容。</span>
</div>`

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2F&rut=1">DDG Result</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2F&rut=1">DDG 摘要文本</a>
</div>`

describe('解析函数', () => {
  it('parseBing 提取标题/解码 URL/摘要', () => {
    const results = parseBing(BING_HTML)
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Example Domain')
    expect(results[0].url).toBe('https://example.com/')
    expect(results[0].snippet).toContain('illustrative examples')
    expect(results[1].title).toBe('Example Org & Friends')
  })

  it('parseBaidu 提取标题/链接/摘要', () => {
    const results = parseBaidu(BAIDU_HTML)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('百度测试结果')
    expect(results[0].url).toBe('https://www.baidu.com/link?url=abc123')
    expect(results[0].snippet).toContain('百度的摘要内容')
  })

  it('parseDuckDuckGo 提取标题/解码 uddg URL/摘要', () => {
    const results = parseDuckDuckGo(DDG_HTML)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://ddg.example/')
    expect(results[0].snippet).toContain('DDG 摘要文本')
  })

  it('decodeBingRedirectUrl 解码 base64 真实 URL', () => {
    expect(decodeBingRedirectUrl(bingHref('https://example.com/path?a=1'))).toBe('https://example.com/path?a=1')
    expect(decodeBingRedirectUrl('https://plain.example/')).toBe('https://plain.example/')
  })
})

describe('searchWeb 回退链', () => {
  it('首个后端有结果时返回该后端', async () => {
    mockFetchOnce(BING_HTML)
    const result = await searchWeb('test', 5, 8000)
    expect(result.engine).toBe('Bing')
    expect(result.results).toHaveLength(2)
  })

  it('首个后端无结果时切换到下一个', async () => {
    mockFetchOnce('<ol id="b_results"></ol>')
    mockFetchOnce(BAIDU_HTML)
    const result = await searchWeb('test', 5, 8000)
    expect(result.engine).toBe('Baidu')
    expect(result.results).toHaveLength(1)
  })

  it('全部后端失败时抛出聚合错误', async () => {
    mockFetchOnce('', false, 503)
    mockFetchOnce('', false, 403)
    mockFetchOnce('', false, 500)
    await expect(searchWeb('test', 5, 8000)).rejects.toThrow('所有搜索后端均失败')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败（模块不存在）**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: FAIL，报错 `Cannot find module '../definitions/WebSearchTools'`。

- [ ] **Step 3: 实现解析与回退链**

创建 `src/main/tool/definitions/WebSearchTools.ts`，写入以下内容（后续 Task 2/3 会继续追加）：

```ts
/**
 * WebSearchTools — 联网搜索能力（免费免配置，多后端回退）
 *
 * 提供两个工具：
 * - web_search：Bing → Baidu → DuckDuckGo 回退链，返回标题/链接/摘要
 * - web_fetch：抓取指定 URL 的正文纯文本
 *
 * 设计文档：docs/superpowers/specs/2026-08-12-web-search-capability-design.md
 */

import { buildTool, formatToolResult, formatToolError } from '../types'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

interface SearchProvider {
  name: string
  search(query: string, timeoutMs: number): Promise<WebSearchResult[]>
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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
    search: (query, timeoutMs) =>
      fetchText(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, timeoutMs).then(parseBing),
  },
  {
    name: 'Baidu',
    search: (query, timeoutMs) =>
      fetchText(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, timeoutMs).then(parseBaidu),
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
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: 7 个测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/tool/definitions/WebSearchTools.ts src/main/tool/__tests__/WebSearchTools.test.ts
git commit -m "feat(search): add web search parser + provider fallback chain"
```

---

## Task 2: web_fetch 工具

**Files:**
- Modify: `src/main/tool/definitions/WebSearchTools.ts`（追加）
- Test: `src/main/tool/__tests__/WebSearchTools.test.ts`（追加）

- [ ] **Step 1: 追加 web_fetch 测试（先红）**

把 `src/main/tool/__tests__/WebSearchTools.test.ts` 顶部 import 改为（追加 `webFetchTool, stripToText`）：

```ts
import {
  parseBing,
  parseBaidu,
  parseDuckDuckGo,
  decodeBingRedirectUrl,
  searchWeb,
  webFetchTool,
  stripToText,
} from '../definitions/WebSearchTools'
```

在文件末尾追加：

```ts
describe('web_fetch 工具', () => {
  const PAGE_HTML = `
<!DOCTYPE html><html><head>
<title>测试页面</title>
<meta name="description" content="页面简介">
<script>var x = 1;</script>
<style>body { color: red }</style>
</head><body>
<h1>标题一</h1>
<p>第一段文本 <b>加粗</b> 内容&amp;更多。</p>
<div>第二段内容</div>
</body></html>`

  it('提取标题与正文纯文本', async () => {
    mockFetchOnce(PAGE_HTML)
    const result = await webFetchTool.handler({ url: 'https://example.com/page' })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('标题: 测试页面')
    expect(result.content[0].text).toContain('简介: 页面简介')
    expect(result.content[0].text).toContain('第一段文本 加粗 内容&更多。')
    expect(result.content[0].text).not.toContain('var x')
  })

  it('按 max_chars 截断并标注', async () => {
    mockFetchOnce(PAGE_HTML)
    const result = await webFetchTool.handler({ url: 'https://example.com/page', max_chars: 120 })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('（已截断）')
    expect(result.content[0].text.length).toBeLessThanOrEqual(130)
  })

  it('拒绝非 http/https URL', async () => {
    const result = await webFetchTool.handler({ url: 'ftp://example.com/file' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('http/https')
  })

  it('stripToText 清理脚本样式并保留块级换行', () => {
    const text = stripToText(PAGE_HTML)
    expect(text).toContain('标题一')
    expect(text).not.toContain('color: red')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: FAIL，报错 `webFetchTool` / `stripToText` 未导出。

- [ ] **Step 3: 追加 web_fetch 实现**

在 `src/main/tool/definitions/WebSearchTools.ts` 末尾（`searchWeb` 之后）追加：

```ts
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
  description:
    '抓取指定网页的正文纯文本，返回页面标题与正文（自动截断）。' +
    '仅支持 http/https 链接；配合 web_search 阅读搜索结果全文。',
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
```

注意：`webFetchTool` 需要 `isReadOnly: true`，但 `buildTool` 默认 `isReadOnly: false`；该标记在 Task 4 Step 2 注册接入时统一补上。

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: 全部 PASS（含新增 4 个 web_fetch 测试）。

- [ ] **Step 5: Commit**

```bash
git add src/main/tool/definitions/WebSearchTools.ts src/main/tool/__tests__/WebSearchTools.test.ts
git commit -m "feat(search): add web_fetch tool with readable text extraction"
```

---

## Task 3: web_search 工具 handler

**Files:**
- Modify: `src/main/tool/definitions/WebSearchTools.ts`（追加）
- Test: `src/main/tool/__tests__/WebSearchTools.test.ts`（追加）

- [ ] **Step 1: 追加 web_search 工具测试（先红）**

把 `src/main/tool/__tests__/WebSearchTools.test.ts` 顶部 import 改为（追加 `webSearchTool`）：

```ts
import {
  parseBing,
  parseBaidu,
  parseDuckDuckGo,
  decodeBingRedirectUrl,
  searchWeb,
  webFetchTool,
  stripToText,
  webSearchTool,
} from '../definitions/WebSearchTools'
```

在文件末尾追加：

```ts
describe('web_search 工具', () => {
  it('query 为空时返回错误', async () => {
    const result = await webSearchTool.handler({ query: '  ' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('query 不能为空')
  })

  it('返回格式化结果并遵守 max_results', async () => {
    mockFetchOnce(BING_HTML)
    const result = await webSearchTool.handler({ query: 'test', max_results: 1 })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('来源：Bing')
    expect(result.content[0].text).toContain('Example Domain')
    expect(result.content[0].text).not.toContain('Example Org')
  })

  it('max_results 超界时 clamp 到 1-10', async () => {
    const many = `<ol id="b_results">${Array.from(
      { length: 12 },
      (_, i) =>
        `\n  <li class="b_algo"><h2><a href="${bingHref(`https://example.com/${i}`)}">Result ${i}</a></h2></li>`,
    ).join('')}\n</ol>`
    mockFetchOnce(many)
    const result = await webSearchTool.handler({ query: 'test', max_results: 999 })
    expect(result.isError).toBe(false)
    const numbered = (result.content[0].text.match(/^\d+\./gm) ?? []).length
    expect(numbered).toBe(10)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: FAIL，报错 `webSearchTool` 未导出。

- [ ] **Step 3: 追加 web_search 工具实现**

在 `src/main/tool/definitions/WebSearchTools.ts` 末尾追加：

```ts
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(value ?? fallback)
  if (Number.isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export const webSearchTool = buildTool({
  name: 'web_search',
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
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/tool/definitions/WebSearchTools.ts src/main/tool/__tests__/WebSearchTools.test.ts
git commit -m "feat(search): add web_search tool with params validation and clamping"
```

---

## Task 4: 注册接入

**Files:**
- Modify: `src/main/tool/getAllTools.ts`
- Modify: `src/main/bootstrap/AppRuntime.ts`（search-engine manifest + 新增 web-search / web-fetch manifest 与 adapter 注册）
- Modify: `src/main/tool/definitions/WebSearchTools.ts`（补 `isReadOnly: true`）
- Modify: `src/main/tool/__tests__/index.test.ts`（READONLY_TOOLS）
- Create: `src/main/capability/__tests__/WebSearchCapability.test.ts`（capability 解析回归）
- Modify: `.env.template`

- [ ] **Step 1: 在 getAllTools 注册两个工具**

`src/main/tool/getAllTools.ts`：

1. 在 import 区（`BrowserAgentTools` import 之后）追加：

```ts
import { webSearchTool, webFetchTool } from './definitions/WebSearchTools'
```

2. 在工具数组里（`browserAgentExecuteTool as Tool,` 之后）追加：

```ts
    // === 联网搜索（Web Search）===
    webSearchTool as Tool,
    webFetchTool as Tool,
```

- [ ] **Step 2: 给两个工具补 isReadOnly: true**

`src/main/tool/definitions/WebSearchTools.ts`：在 `webSearchTool` 的 `buildTool({` 对象中 `name: 'web_search',` 之后加一行 `isReadOnly: true,`；`webFetchTool` 同理加 `isReadOnly: true,`。

- [ ] **Step 3: AppRuntime search-engine manifest 增加依赖**

`src/main/bootstrap/AppRuntime.ts`，在 search-engine manifest 的 `dependencies` 数组末尾（`query_asr_vocabulary` 那一行之后）追加：

```ts
        // 2026-08-12: web search（联网搜索）
        { capability: 'search.retrieval', tool: 'web_search' },
        { capability: 'search.retrieval', tool: 'web_fetch' },
```

- [ ] **Step 3.5: AppRuntime 新增 web-search / web-fetch capability manifest 与 adapter**

> 2026-08-12 架构决策（用户反馈）：capability-first 下 `search.retrieval` 默认走 `grep`，到不了 `web_search`。保留 Step 3 的依赖，同时新增独立 capability。

`src/main/bootstrap/AppRuntime.ts`：

1. search-engine manifest 之后新增两个 manifest：
   - `web-search`：capabilities `['web.search']`，capabilitySchemas `{query, max_results, timeout_ms}`，dependencies `[{ capability: 'web.search', tool: 'web_search' }]`，permissions `['network.http']`
   - `web-fetch`：capabilities `['web.fetch']`，capabilitySchemas `{url, max_chars, timeout_ms}`，dependencies `[{ capability: 'web.fetch', tool: 'web_fetch' }]`，permissions `['network.http']`

2. setAdapter 区块追加：

```ts
capabilityService.setAdapter('web-search', 'web_search', searchAdapter)
capabilityService.setAdapter('web-fetch', 'web_fetch', searchAdapter)
```

3. 新增 `src/main/capability/__tests__/WebSearchCapability.test.ts`：断言 `CapabilityCatalog` + `CapabilityResolver` 将 `web.search` → `web_search`、`web.fetch` → `web_fetch`。

```bash
npx vitest run src/main/capability/__tests__/WebSearchCapability.test.ts
```

- [ ] **Step 4: 更新 index.test.ts 的 READONLY_TOOLS**

`src/main/tool/__tests__/index.test.ts`，在 READONLY_TOOLS Set 中追加两项：

```ts
  'web_search',
  'web_fetch',
```

- [ ] **Step 5: 更新 .env.template**

`.env.template` 末尾追加：

```
# ============================================================
# 联网搜索（Web Search）— 免费免配置，无需 API Key
# ============================================================
# SEARCH_TIMEOUT_MS=8000
# SEARCH_MAX_RESULTS=5
```

- [ ] **Step 6: 运行注册回归测试**

```bash
npx vitest run src/main/tool/__tests__/index.test.ts src/main/__tests__/tools.test.ts
```

Expected: 全部 PASS（`index.test.ts` 中 `>= 50` 断言、无重名断言、只读分类断言均保持通过）。

- [ ] **Step 7: Commit**

```bash
git add src/main/tool/getAllTools.ts src/main/bootstrap/AppRuntime.ts src/main/tool/definitions/WebSearchTools.ts src/main/tool/__tests__/index.test.ts .env.template
git commit -m "feat(search): register web_search/web_fetch into tool surface and search.retrieval capability"
```

---

## Task 5: 全量验证与真实网络冒烟

**Files:**
- Create: `src/main/tool/__tests__/WebSearchTools.live.test.ts`（默认 skip，仅 LIVE_SEARCH=1 时运行）

- [ ] **Step 1: 添加受环境变量保护的冒烟测试**

创建 `src/main/tool/__tests__/WebSearchTools.live.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { webSearchTool, webFetchTool } from '../definitions/WebSearchTools'

const live = process.env.LIVE_SEARCH === '1'

describe.skipIf(!live)('live web search smoke（LIVE_SEARCH=1 时运行）', () => {
  it('web_search 真实抓取并解析出结果', async () => {
    const result = await webSearchTool.handler({ query: 'OpenAI', max_results: 3, timeout_ms: 8000 })
    console.log(result.content[0].text.slice(0, 600))
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('搜索完成')
  })

  it('web_fetch 真实抓取页面标题', async () => {
    const result = await webFetchTool.handler({ url: 'https://example.com', max_chars: 1000, timeout_ms: 10000 })
    console.log(result.content[0].text.slice(0, 300))
    expect(result.isError).toBe(false)
  })
})
```

- [ ] **Step 2: 类型检查**

```bash
npm run typecheck
```

Expected: 退出码 0，无类型错误。

- [ ] **Step 3: 运行相关单元测试**

```bash
npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts src/main/tool/__tests__/index.test.ts src/main/__tests__/tools.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 4: 真实网络冒烟（手动，网络可达时执行）**

```powershell
$env:LIVE_SEARCH = '1'
npx vitest run src/main/tool/__tests__/WebSearchTools.live.test.ts
Remove-Item Env:\LIVE_SEARCH
```

Expected: 两个测试 PASS，控制台输出实际搜索返回的标题/链接/摘要片段（Bing 或 Baidu 至少一个可用）。

- [ ] **Step 5: Commit（如用户允许）**

```bash
git add src/main/tool/__tests__/WebSearchTools.live.test.ts
git commit -m "test(search): add env-guarded live smoke test"
```

---

## Self-Review

- **Spec 覆盖：** `web_search` / `web_fetch` schema（Task 3/2）、三后端回退链（Task 1）、Bing URL 解码与 DDG uddg 解码（Task 1）、正文提取与截断（Task 2）、`isReadOnly`（Task 4 Step 2）、`getAllTools` 注册（Task 4 Step 1）、`search.retrieval` manifest 依赖（Task 4 Step 3）、`web-search` / `web-fetch` manifest 与 adapter（Task 4 Step 3.5）、capability 解析测试（Task 4 Step 3.5）、READONLY_TOOLS 回归（Task 4 Step 4）、`.env.template`（Task 4 Step 5）、单测 + 冒烟 + typecheck（Task 5）——与设计文档 §3–§6 一一对应。
- **占位符扫描：** 无 TBD/TODO；每个改代码步骤都附完整代码。
- **类型/命名一致性：** `webSearchTool` / `webFetchTool` / `searchWeb` / `parseBing` / `parseBaidu` / `parseDuckDuckGo` / `decodeBingRedirectUrl` / `decodeDdgRedirectUrl` / `stripToText` / `isValidHttpUrl` / `clampInt` 在实现、测试、注册三处命名一致。
