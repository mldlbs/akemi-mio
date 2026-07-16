/**
 * RadarTools — 雷达功能 MCP 工具
 *
 * 将 Observer 采集器和分析引擎封装为 MCP 工具：
 * - radar_scan:    按源列表+关键词进行按需采集
 * - radar_analyze: 对原始数据进行结构化分析
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getObserverService } from '../deps'
import { log } from '../../logger/Logger'

// =============================================================================
// radar_scan — 按需采集
// =============================================================================

export const radarScanTool = buildTool({
  name: 'radar_scan',
  description:
    '按需采集指定信息源的网络情报。支持 hackernews、weibo-hot、github-trending、bilibili、douyin、rss 等源，' +
    '可用关键词过滤结果。返回每条内容附带来源标签。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: { type: 'string' },
        description:
          '采集源名称列表。可选值: hackernews, weibo-hot, github-trending, bilibili, douyin, rss。传入 ["all"] 采集所有源',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '可选关键词过滤（OR 匹配），只返回包含任意关键词的结果',
      },
      limit: {
        type: 'number',
        description: '每个源最大返回条数，默认 20',
      },
    },
    required: ['sources'],
  },
  handler: async (args: { sources: string[]; keywords?: string[]; limit?: number }) => {
    try {
      const os = getObserverService()
      if (!os) return formatToolError('Observer 服务暂不可用')

      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
      const collected = await os.collectBySource(args.sources, args.keywords, limit)

      const sourceCount = Object.keys(collected).length
      if (sourceCount === 0) {
        return formatToolResult('⚠️ 未采集到任何数据。可能的原因：采集器未匹配到指定源、所有源返回为空、或网络请求超时')
      }

      // 构建格式化输出
      const lines: string[] = [`📡 雷达扫描完成 — 覆盖 ${sourceCount} 个源\n`]
      let totalItems = 0

      for (const [sourceName, observations] of Object.entries(collected)) {
        const label = SOURCE_LABELS[sourceName] ?? sourceName
        lines.push(`── ${label}（${observations.length} 条）`)
        for (const obs of observations) {
          totalItems++
          lines.push(`  [${sourceName}] ${obs.content.slice(0, 300)}`)
        }
        lines.push('')
      }

      lines.push(`✅ 共 ${totalItems} 条结果`)
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      log('ERROR', 'radar_scan_failed', { error: err.message })
      return formatToolError(`雷达扫描失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// radar_analyze — 结构化分析
// =============================================================================

const ANALYZE_MODE_DESCRIPTIONS: Record<string, string> = {
  summary: '总结：概括数据的主要内容、核心主题和关键发现',
  trend: '趋势：识别数据中的模式、反复出现的主题和变化方向',
  sentiment: '情感：分析文本的情感倾向（正面/负面/中性）及情感强度',
  entities: '实体：提取文中关键实体（人物、组织、概念、技术）及其关系',
}

export const radarAnalyzeTool = buildTool({
  name: 'radar_analyze',
  description:
    '对采集到的雷达数据或其他原始文本进行结构化分析。支持摘要、趋势识别、情感分析和实体提取四种模式。' +
    '数据可以来自 radar_scan 的输出，也可以粘贴任意文本。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: '待分析的原始文本数据（可以是 radar_scan 的采集结果，或任意文本内容）',
      },
      mode: {
        type: 'string',
        enum: ['summary', 'trend', 'sentiment', 'entities'],
        description: '分析模式：summary=总结, trend=趋势识别, sentiment=情感分析, entities=实体提取',
      },
    },
    required: ['data'],
  },
  handler: async (args: { data: string; mode?: string }) => {
    try {
      const os = getObserverService()
      if (!os) return formatToolError('Observer 服务暂不可用')

      const mode = args.mode ?? 'summary'
      const validModes = ['summary', 'trend', 'sentiment', 'entities']
      if (!validModes.includes(mode)) {
        return formatToolError(`不支持的分析模式: ${mode}。可选: ${validModes.join(', ')}`)
      }

      const data = args.data.trim()
      if (data.length < 10) {
        return formatToolError('输入数据过短，至少需要 10 个字符')
      }
      if (data.length > 50000) {
        return formatToolError('输入数据过长，请限制在 50000 字符以内')
      }

      const llm = os.getLlm()
      const modeDesc = ANALYZE_MODE_DESCRIPTIONS[mode] ?? '总结分析'

      if (!llm.isLoaded) {
        await llm.initialize()
      }

      if (!llm.isLoaded) {
        // LLM 不可用时降级为基于规则的分析
        return formatToolResult(formatFallbackAnalysis(data, mode))
      }

      const systemPrompt = `你是一个专业的信息分析助手。请对用户提供的数据进行 "${modeDesc}" 分析。

分析要求：
- 输出简洁、结构化，使用中文
- 基于数据本身的客观分析，不推测不存在的信息
- 输出格式为 Markdown`

      const prompt = `请对以下数据进行 ${mode} 模式分析：

${data.slice(0, 30000)}`

      const startTime = Date.now()
      const result = await llm.generate(prompt, {
        system: systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
      })
      const durationMs = Date.now() - startTime

      if (result.error) {
        log('WARN', 'radar_analyze_llm_fallback', { error: result.error })
        return formatToolResult(formatFallbackAnalysis(data, mode))
      }

      const content = result.data ?? '分析未产生输出'
      const charCount = data.length
      const outputLines = [
        `📊 雷达分析报告 — 模式: ${mode}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `输入: ${charCount} 字符 | 耗时: ${(durationMs / 1000).toFixed(1)}s`,
        '',
        content,
      ]

      log('INFO', 'radar_analyze_done', { mode, charCount, durationMs })
      return formatToolResult(outputLines.join('\n'))
    } catch (err: any) {
      log('ERROR', 'radar_analyze_failed', { error: err.message })
      return formatToolError(`雷达分析失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 辅助
// =============================================================================

/** 源名称 → 友好标签映射 */
const SOURCE_LABELS: Record<string, string> = {
  hackernews: 'HackerNews 技术趋势',
  'weibo-hot': '微博热搜',
  'github-trending': 'GitHub Trending',
  bilibili: 'Bilibili 热门',
  douyin: '抖音热点',
  rss: 'RSS 订阅',
}

/**
 * LLM 不可用时的规则分析降级。
 * 基于简单的统计规则生成基础分析报告。
 */
function formatFallbackAnalysis(data: string, mode: string): string {
  const lines = data.split('\n').filter(Boolean)
  const items = lines.filter((l) => l.startsWith('  ['))
  const sources = new Set<string>()
  for (const l of items) {
    const m = l.match(/\[(\w+-?\w*)\]/)
    if (m) sources.add(m[1])
  }

  const header = `[降级分析] LLM 暂不可用，已切换为基于规则的基础分析。\n如需深度分析，请确保 Ollama 服务已启动。\n`

  switch (mode) {
    case 'summary': {
      return (
        header +
        `\n## 基础总结\n` +
        `- 数据行数: ${lines.length}\n` +
        `- 条目数: ${items.length}\n` +
        `- 来源数: ${sources.size}（${[...sources].join(', ')}）\n` +
        `- 文本长度: ${data.length} 字符\n`
      )
    }
    case 'trend': {
      // 简单的词频统计
      const wordFreq = new Map<string, number>()
      const stopWords = new Set(['的', '了', '是', '在', '和', '与', '有', '对', '为', '及', '等', '一个', '这个', '那个', '我们', '他们', '可以', '没有', '不是', '进行', '通过', '使用', '以及', '其中'])
      const words = data.split(/[\s,，。！？、；：""''《》（）\n\[\]]+/)
      for (const w of words) {
        const t = w.trim()
        if (t.length < 2 || stopWords.has(t)) continue
        wordFreq.set(t, (wordFreq.get(t) ?? 0) + 1)
      }
      const topWords = [...wordFreq.entries()]
        .filter(([_, c]) => c > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)

      return (
        header +
        `\n## 高频词统计（简易趋势）\n` +
        topWords.map(([w, c]) => `- ${w}: ${c} 次`).join('\n')
      )
    }
    case 'sentiment': {
      // 简单的情感词匹配
      const positive = ['赞', '好', '高', '增长', '突破', '成功', '领先', '创新', '优秀', '新']
      const negative = ['问题', '下降', '失败', '危机', '风险', '违规', '起诉', '争议']
      let posCount = 0
      let negCount = 0
      for (const w of positive) {
        posCount += (data.match(new RegExp(w, 'g')) ?? []).length
      }
      for (const w of negative) {
        negCount += (data.match(new RegExp(w, 'g')) ?? []).length
      }
      const total = posCount + negCount
      const ratio = total > 0 ? (posCount / total * 100).toFixed(0) : 'N/A'

      return (
        header +
        `\n## 基础情感分析\n` +
        `- 正面信号: ${posCount}\n` +
        `- 负面信号: ${negCount}\n` +
        `- 正面占比: ${ratio}%\n` +
        `- 样本量: ${items.length} 条\n`
      )
    }
    case 'entities': {
      // 简单实体提取（大写/英文词 + 数字指标）
      const entities = new Set<string>()
      const entityPattern = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g
      let m: RegExpExecArray | null
      while ((m = entityPattern.exec(data)) !== null) {
        if (m[0].length > 2 && m[0].length < 50) entities.add(m[0])
      }
      return (
        header +
        `\n## 基础实体提取\n` +
        [...entities].slice(0, 30).map((e) => `- ${e}`).join('\n')
      )
    }
    default:
      return header + '暂不支持该分析模式'
  }
}

// =============================================================================
// 导出所有工具
// =============================================================================

export const radarTools = [radarScanTool, radarAnalyzeTool] as const
