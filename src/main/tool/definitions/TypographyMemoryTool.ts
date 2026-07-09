/**
 * TypographyMemoryTool — 排版规则自适应记忆工具
 *
 * 将 TypographyMemoryManager 暴露为 MCP 工具，供 LLM 在排版流程中调用。
 *
 * 支持操作：
 * 1. load_preferences  — 排版前调用：查询存储在 Memory 中的历史排版偏好
 * 2. save_preferences  — 排版后调用：将本次使用的排版参数及用户确认保存到 Memory
 * 3. analyze_trends    — 分析跨章节排版参数变化趋势
 *
 * 配合 TypographyMemoryManager 使用。
 * 在 writing-prompt.ts 中可注入使用指引。
 */
import { buildTool, formatToolResult, formatToolError } from '../types'
import { TypographyMemoryManager } from '../../creativity/TypographyMemoryManager'
import type { TypographyRecord } from '../../creativity/TypographyMemoryManager'

export const typographyMemoryTool = buildTool({
  name: 'typography_memory',
  description: `排版规则自适应记忆 — 管理公众号等平台的排版偏好，使排版风格随章节处理自动优化。

支持操作：
- load_preferences: 排版前调用，查询该故事/平台的历史排版偏好（返回参数摘要和上下文提示）。
  参数：storyId, platformTag(如"公众号"), chapterNumber(可选)
- save_preferences: 排版后调用，将本次排版参数及用户确认保存到 Memory。
  参数：storyId, platformTag, chapterNumber, chapterTitle, parameters(JSON),
        userCorrections(可选), confirmedExcerpt(可选), source(可选)
- analyze_trends: 分析跨章节排版参数变化趋势。
  参数：storyId(可选，不传则全量分析), platformTag(可选)

用法建议：
1. 开始新章节排版前 → 调用 load_preferences 获取历史偏好
2. 排版完成用户确认后 → 调用 save_preferences 保存本次参数
3. 每完成一个故事/系列 → 调用 analyze_trends 查看趋势`,
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- load_preferences: 排版前加载历史偏好\n' +
          '- save_preferences: 排版后保存本次参数\n' +
          '- analyze_trends: 分析跨章节排版趋势',
      },
      storyId: {
        type: 'string',
        description: '故事/文章 ID。load_preferences / save_preferences 需要，analyze_trends 可选过滤。',
      },
      platformTag: {
        type: 'string',
        description: '平台标签，如 "公众号"、"知乎"、"小红书"。load_preferences / save_preferences 需要，analyze_trends 可选过滤。',
      },
      chapterNumber: {
        type: 'number',
        description: '章节序号（从 1 开始）。load_preferences(可选，用于定位) / save_preferences(需要)',
      },
      chapterTitle: {
        type: 'string',
        description: '章节标题。save_preferences 需要。',
      },
      parameters: {
        type: 'string',
        description:
          '排版参数 JSON 字符串。save_preferences 需要。\n' +
          '可选字段：\n' +
          '- sentenceDensity: 断句密度("dense"密集|"normal"适中|"sparse"稀疏)\n' +
          '- citationStyle: 引用样式("blockquote"引用块|"indent"缩进|"inline_quote"行内引用|"none"无)\n' +
          '- introLength: 导语长度("none"无|"short"短|"medium"中|"long"长)\n' +
          '- paragraphSpacing: 段落间距("compact"紧凑|"normal"适中|"wide"宽松)\n' +
          '- emphasisStyle: 重点强调("bold"加粗|"color_mark"彩色|"bg_mark"背景高亮|"none"无)\n' +
          '- listStyle: 列表样式("bullet"圆点|"number"数字|"icon"图标)\n' +
          '- sectionDivider: 章节分隔("line"分割线|"spacing"留白|"emoji"Emoji)\n' +
          '- imageCaption: 图片说明("below_center"居中|"below_left"左对齐|"none"无)\n' +
          '也可自定义扩展字段。',
      },
      userCorrections: {
        type: 'string',
        description: '用户本次的修正描述（如 "引用样式改为缩进"）。save_preferences 可选。',
      },
      confirmedExcerpt: {
        type: 'string',
        description: '用户最终确认的版本片段（前 300 字以内）。save_preferences 可选，用于后续参考。',
      },
      source: {
        type: 'string',
        description: '记录来源："auto"(自动) | "user_correction"(用户修正) | "evolution"(进化分析)，默认 "auto"。save_preferences 可选。',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  handler: async (args) => {
    const {
      action,
      storyId,
      platformTag,
      chapterNumber,
      chapterTitle,
      parameters,
      userCorrections,
      confirmedExcerpt,
      source,
    } = args as {
      action: string
      storyId?: string
      platformTag?: string
      chapterNumber?: number
      chapterTitle?: string
      parameters?: string
      userCorrections?: string
      confirmedExcerpt?: string
      source?: string
    }

    const manager = new TypographyMemoryManager()

    try {
      switch (action) {
        // ─── 加载偏好 ───
        case 'load_preferences': {
          if (!storyId) return formatToolError('需要 storyId')
          if (!platformTag) return formatToolError('需要 platformTag')

          const context = manager.buildTypographyContext(storyId, platformTag, chapterNumber)

          if (context.isEmpty) {
            return formatToolResult(
              `暂无《${storyId}》在「${platformTag}」的历史排版记录。可直接使用默认排版参数，排版后调用 save_preferences 保存本次参数供后续章节参考。`,
            )
          }

          return formatToolResult(context.contextPrompt)
        }

        // ─── 保存偏好 ───
        case 'save_preferences': {
          if (!storyId) return formatToolError('需要 storyId')
          if (!platformTag) return formatToolError('需要 platformTag')
          if (chapterNumber === undefined || chapterNumber === null) {
            return formatToolError('需要 chapterNumber')
          }
          if (!chapterTitle) return formatToolError('需要 chapterTitle')
          if (!parameters) return formatToolError('需要 parameters (JSON 字符串)')

          let parsedParams: Record<string, any>
          try {
            parsedParams = JSON.parse(parameters)
          } catch {
            return formatToolError('parameters 格式错误，需要有效的 JSON 对象字符串')
          }

          if (typeof parsedParams !== 'object' || Object.keys(parsedParams).length === 0) {
            return formatToolError('parameters 需要是非空 JSON 对象')
          }

          const validSource = source === 'user_correction' || source === 'evolution' ? source : 'auto'

          const record: TypographyRecord = {
            storyId,
            platformTag,
            chapterNumber,
            chapterTitle,
            parameters: parsedParams as any,
            userCorrections: userCorrections?.slice(0, 500),
            confirmedExcerpt: confirmedExcerpt?.slice(0, 300),
            source: validSource,
            createdAt: Date.now(),
          }

          manager.saveRecord(record)

          // 构建参数摘要
          const paramSummary = Object.entries(parsedParams)
            .map(([k, v]) => `${k}:${String(v).slice(0, 20)}`)
            .join(', ')

          return formatToolResult(
            `✓ 已保存《${storyId}》第 ${chapterNumber} 章「${chapterTitle}」在「${platformTag}」的排版参数。` +
              `来源: ${validSource} | 参数: ${paramSummary.slice(0, 200)}` +
              (userCorrections ? ` | 用户修正: ${userCorrections.slice(0, 100)}` : ''),
          )
        }

        // ─── 分析趋势 ───
        case 'analyze_trends': {
          if (storyId && platformTag) {
            const report = manager.analyzeTrends(storyId, platformTag)
            if (!report) {
              return formatToolResult(
                `《${storyId}》在「${platformTag}」的记录不足 2 条，无法进行趋势分析。` +
                  `建议先排版几章后再分析。`,
              )
            }
            return formatToolResult(formatTrendReport(report))
          }

          // 全量分析：遍历所有记录
          const allRecords = manager.getAllRecords(200)
          if (allRecords.length < 2) {
            return formatToolResult('排版记录不足 2 条，无法进行趋势分析。建议先排版几章后再分析。')
          }

          // 按 storyId + platformTag 分组
          const groups = new Map<string, TypographyRecord[]>()
          for (const r of allRecords) {
            const key = `${r.storyId}::${r.platformTag}`
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(r)
          }

          const lines: string[] = [
            `排版趋势分析报告（共 ${allRecords.length} 条记录，${groups.size} 个故事/平台组合）：`,
            '',
          ]
          for (const [key, groupRecords] of groups) {
            const [sid, tag] = key.split('::')
            const report = manager.analyzeTrends(sid, tag)
            if (report) {
              lines.push(`--- 《${sid}》@${tag}（${groupRecords.length} 章）---`)
              lines.push(formatTrendReport(report))
            }
          }

          return formatToolResult(lines.join('\n'))
        }

        default:
          return formatToolError(
            `未知操作: ${action}。支持的操作：load_preferences, save_preferences, analyze_trends。`,
          )
      }
    } catch (e: any) {
      return formatToolError(`排版记忆操作失败: ${e.message}`)
    }
  },
})

/**
 * 格式化趋势报告为可读文本。
 */
function formatTrendReport(report: any): string {
  if (!report) return ''
  const lines: string[] = [
    `📊 排版趋势分析 — 《${report.storyId}》@${report.platformTag}`,
    `   分析章节数: ${report.chapterCount}`,
    `   分析时间: ${new Date(report.analyzedAt).toLocaleString('zh-CN')}`,
    ``,
    `参数变化：`,
  ]

  for (const [param, trend] of Object.entries(report.parameterTrends) as Array<[string, any]>) {
    const label = (PARAM_LABELS as Record<string, string>)[param] || param
    const currentVal = (PARAM_VALUE_LABELS as Record<string, Record<string, string>>)[param]?.[String(trend.current)] || String(trend.current)
    const directionIcon =
      trend.direction === 'stable' ? '✅' :
      trend.direction === 'changed' ? '🔄' :
      trend.direction === 'increasing' ? '📈' : '📉'
    lines.push(`  ${directionIcon} ${label}: ${currentVal}（${trend.changeCount} 次变化）`)
  }

  if (report.topCorrectedParams && report.topCorrectedParams.length > 0) {
    lines.push(``)
    lines.push(`用户修正最多的参数：`)
    for (const cp of report.topCorrectedParams) {
      const label = (PARAM_LABELS as Record<string, string>)[cp.param] || cp.param
      lines.push(`  ✏️ ${label}: ${cp.count} 次`)
    }
  }

  if (report.suggestedDefaults) {
    lines.push(``)
    lines.push(`建议默认参数：`)
    for (const [key, value] of Object.entries(report.suggestedDefaults) as Array<[string, any]>) {
      const label = (PARAM_LABELS as Record<string, string>)[key] || key
      const val = (PARAM_VALUE_LABELS as Record<string, Record<string, string>>)[key]?.[String(value)] || String(value)
      lines.push(`  - ${label}: ${val}`)
    }
  }

  return lines.join('\n')
}

// 共享给 handler 使用的标签映射（与 TypographyMemoryManager 保持一致）
const PARAM_LABELS: Record<string, string> = {
  sentenceDensity: '断句密度',
  citationStyle: '引用样式',
  introLength: '导语长度',
  paragraphSpacing: '段落间距',
  emphasisStyle: '重点强调',
  listStyle: '列表样式',
  sectionDivider: '章节分隔',
  imageCaption: '图片说明',
}

const PARAM_VALUE_LABELS: Record<string, Record<string, string>> = {
  sentenceDensity: { dense: '密集', normal: '适中', sparse: '稀疏' },
  citationStyle: { blockquote: '引用块', indent: '缩进', inline_quote: '行内引用', none: '无引用' },
  introLength: { none: '无导语', short: '短导语', medium: '中等', long: '长导语' },
  paragraphSpacing: { compact: '紧凑', normal: '适中', wide: '宽松' },
  emphasisStyle: { bold: '加粗', color_mark: '彩色标注', bg_mark: '背景高亮', none: '无' },
  listStyle: { bullet: '圆点列表', number: '数字列表', icon: '图标列表' },
  sectionDivider: { line: '分割线', spacing: '留白', emoji: 'Emoji分隔' },
  imageCaption: { below_center: '居中说明', below_left: '左对齐说明', none: '无说明' },
}
