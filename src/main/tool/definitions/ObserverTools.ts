import { buildTool, formatToolResult, formatToolError } from '../types'
import { getObserverService } from '../deps'

export const triggerCollectTool = buildTool({
  name: 'trigger_collect',
  description: '手动触发 Observer 收集器抓取外部信息（RSS/B站/微博/GitHub Trending/HackerNews/抖音）',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const os = getObserverService()
      if (!os) return formatToolError('Observer 服务暂不可用')
      await os.forceCollect()
      return formatToolResult('收集器已触发')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const triggerFermentTool = buildTool({
  name: 'trigger_ferment',
  description: '手动触发发酵引擎，将观测数据连接为主题簇',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const os = getObserverService()
      if (!os) return formatToolError('Observer 服务暂不可用')
      await os.forceFerment()
      return formatToolResult('发酵引擎已触发')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const triggerDeepResearchTool = buildTool({
  name: 'trigger_deep_research',
  description: '手动触发 Observer 深度研究管线（扩展→结构建模→冲突分析）',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const os = getObserverService()
      if (!os) return formatToolError('Observer 服务暂不可用')
      const result = await os.forcePipeline()
      return formatToolResult(result ? `深度研究完成\n${JSON.stringify(result, null, 2).slice(0, 1000)}` : '深度研究未产生输出')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
