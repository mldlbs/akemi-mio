import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'

export const githubTrendsTool = buildTool({
  name: 'search_github_trends',
  description: '搜索 GitHub 上与给定查询相关的热门项目。返回项目名称、描述和 Star 数',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，如 "voice assistant electron"' },
      limit: { type: 'number', description: '返回结果数，默认 10' },
    },
    required: ['query'],
  },
  handler: async (args: { query: string; limit?: number }) => {
    try {
      const token = process.env.GITHUB_TOKEN || ''
      const res = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(args.query)}&sort=stars&order=desc&per_page=${Math.min(args.limit ?? 10, 30)}`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            ...(token ? { Authorization: `token ${token}` } : {}),
            'User-Agent': 'akemi-mio',
          },
        },
      )
      if (!res.ok) return formatToolError(`GitHub API 错误: ${res.status}`)
      const data = await res.json()
      if (!data.items?.length) return formatToolResult('未找到匹配项目')

      const lines = data.items.map(
        (item: any, i: number) => `${i + 1}. ${item.full_name} ⭐${item.stargazers_count} | ${item.description?.slice(0, 100) || '无描述'}`,
      )
      return formatToolResult(`【GitHub 搜索结果 - ${args.query}】\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

