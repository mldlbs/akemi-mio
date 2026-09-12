import { describe, it, expect } from 'vitest'
import { webSearchTool, webFetchTool } from '@akemi-mio/capabilities/tool/definitions/WebSearchTools'

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
