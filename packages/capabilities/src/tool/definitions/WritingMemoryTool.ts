/**
 * WritingMemoryTool — 创作记忆管理工具
 *
 * 提供三个操作：
 * 1. search_feedback — 查询 Memory 中与某故事相关的读者反馈
 * 2. get_summary    — 生成「读者期望摘要」（300 字以内）
 * 3. store_feedback — 将用户对续写内容的反馈存入 Memory
 *
 * 配合 WritingMemoryContinuation 服务使用。
 * 在 writing-prompt.ts 中注入使用指引。
 */
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { WritingMemoryContinuation } from '@akemi-mio/creativity/WritingMemoryContinuation'

export const writingMemoryTool = buildTool({
  name: 'writing_memory',
  description:
    '创作记忆管理 — 查询读者对小说章节的历史反馈记忆；生成「读者期望摘要」（压缩为300字内）；存储新的读者反馈。' +
    '在续写新章节前应先调用 get_summary 获取读者期望摘要附加到 prompt 底部。',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- search_feedback: 查询历史反馈（返回原始记忆条目列表）\n' +
          '- get_summary: 生成读者期望摘要（压缩为 300 字以内，含分类汇总）\n' +
          '- store_feedback: 存储新的用户反馈',
      },
      storyName: {
        type: 'string',
        description: '故事名称（如 "工业颂歌"）。search_feedback / get_summary / store_feedback 均需要。',
      },
      feedback: {
        type: 'string',
        description: '用户反馈内容。store_feedback 时需要。',
      },
      category: {
        type: 'string',
        description:
          '反馈分类（store_feedback 时需要，search_feedback/get_summary 可选过滤）：\n' +
          '- emotion_preference: 情绪偏好（如 "喜欢悲壮感""轻松日常"）\n' +
          '- setting_disagreement: 背景设定分歧（如 "工业背景不够具体"）\n' +
          '- style_feedback: 文风反馈（如 "描写过于冗长"）\n' +
          '- plot_suggestion: 情节建议（如 "建议加入角色回忆线"）\n' +
          '- general: 一般反馈',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  handler: async (args) => {
    const { action, storyName, feedback, category } = args as {
      action: string
      storyName?: string
      feedback?: string
      category?: string
    }

    const service = new WritingMemoryContinuation()

    try {
      switch (action) {
        case 'search_feedback': {
          if (!storyName) return formatToolError('需要 storyName')
          const entries = service.queryStoryFeedback(storyName)
          if (entries.length === 0) {
            return formatToolResult('暂无关于《' + storyName + '》的反馈记忆。')
          }
          const formatted = entries.map(
            (e) => `[${e.category}] (${new Date(e.timestamp).toLocaleString('zh-CN')}) ${e.feedback.slice(0, 200)}`,
          )
          return formatToolResult(`关于《${storyName}》的 ${entries.length} 条反馈：\n` + formatted.join('\n'))
        }

        case 'get_summary': {
          if (!storyName) return formatToolError('需要 storyName')
          const context = service.getReaderExpectationContext(storyName)
          if (!context) {
            return formatToolResult('暂无关于《' + storyName + '》的读者反馈。直接按原始方向续写即可。')
          }
          return formatToolResult(context)
        }

        case 'store_feedback': {
          if (!storyName) return formatToolError('需要 storyName')
          if (!feedback) return formatToolError('需要 feedback')
          const validCategories = ['emotion_preference', 'setting_disagreement', 'style_feedback', 'plot_suggestion', 'general']
          const cat = category && validCategories.includes(category) ? category : 'general'
          service.storeFeedback(storyName, feedback, cat as any)
          return formatToolResult(`✓ 已保存对《${storyName}》的反馈（分类：${cat}）。下次续写时将参考此反馈。`)
        }

        default:
          return formatToolError(`未知操作: ${action}。支持的操作为：search_feedback, get_summary, store_feedback。`)
      }
    } catch (e: any) {
      return formatToolError(`创作记忆操作失败: ${e.message}`)
    }
  },
})

