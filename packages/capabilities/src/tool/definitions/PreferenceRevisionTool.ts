/**
 * PreferenceRevisionTool — 偏好记忆写作助手 MCP 工具
 *
 * 提供六个操作：
 * 1. record_preference       — 记录用户对 Agent 修订建议的接受/拒绝反馈
 * 2. record_batch            — 批量记录多条偏好
 * 3. get_preferences         — 查询某故事的所有偏好记录
 * 4. get_hints               — 获取从历史偏好中提炼的偏好提示
 * 5. get_context             — 获取格式化偏好上下文（用于注入下一章节的生成提示）
 * 6. get_revision_progress   — 获取修订进度统计
 *
 * 配合 PreferenceRevisionMemory 服务使用。
 * 工作流建议：
 *   1. 每次 Agent 给出修订建议后 → record_preference 记录用户反馈
 *   2. 每个章节修订完成后 → record_revised_chapter 记录修订摘要
 *   3. 开始新一轮修订前 → get_context 获取偏好提示注入 prompt
 */
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getPreferenceRevisionMemory } from '@akemi-mio/creativity/PreferenceRevisionMemory'

export const preferenceRevisionTool = buildTool({
  name: 'preference_revision',
  description:
    '偏好记忆写作助手 — 在修订过程中利用 Memory 记录用户对每次生成内容的反馈和偏好，' +
    '动态调整输出风格。支持记录接受/拒绝反馈、查询偏好历史、获取偏好提示、跟踪修订进度。\n\n' +
    '操作类型:\n' +
    '- record_preference: 记录用户对 Agent 修订建议的反馈（接受/拒绝）。需 storyName, chapterId, suggestion, feedbackType\n' +
    '- record_batch: 批量记录多条偏好。需 storyName, entries（JSON 数组）\n' +
    '- record_revised_chapter: 记录某章节已完成修订。需 storyName, chapterId, summary\n' +
    '- get_preferences: 查询某故事的所有偏好记录。需 storyName\n' +
    '- get_hints: 获取从历史偏好中提炼的偏好提示。需 storyName，可选 minConfidence\n' +
    '- get_context: 获取格式化偏好上下文（用于注入下一章节的生成提示）。需 storyName\n' +
    '- get_revision_progress: 获取修订进度统计。需 storyName\n' +
    '- clear_story: 清空某故事的所有偏好和修订记录。需 storyName\n' +
    '- get_stats: 获取偏好记忆系统全局统计。无需参数',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- record_preference: 记录接受/拒绝反馈。需 storyName, chapterId, suggestion, feedbackType\n' +
          '- record_batch: 批量记录。需 storyName, entries\n' +
          '- record_revised_chapter: 记录已修订章节。需 storyName, chapterId, summary\n' +
          '- get_preferences: 查询偏好记录。需 storyName\n' +
          '- get_hints: 获取偏好提示。需 storyName，可选 minConfidence\n' +
          '- get_context: 获取格式化上下文。需 storyName\n' +
          '- get_revision_progress: 修订进度统计。需 storyName\n' +
          '- clear_story: 清除故事数据。需 storyName\n' +
          '- get_stats: 全局统计',
      },
      storyName: {
        type: 'string',
        description:
          '故事/作品名称（如 "工业颂歌"）。record_preference / record_batch / record_revised_chapter / ' +
          'get_preferences / get_hints / get_context / get_revision_progress / clear_story 均需要。',
      },
      chapterId: {
        type: 'string',
        description: '章节标识（如 "ch19" 或 "第19章"）。record_preference / record_revised_chapter 需要。',
      },
      suggestion: {
        type: 'string',
        description: 'Agent 给出的修订建议摘要（300 字以内）。record_preference 需要。',
      },
      feedbackType: {
        type: 'string',
        enum: ['accept', 'reject'] as any,
        description: '用户反馈类型。record_preference 需要。\n' + '- accept: 用户接受了该建议\n' + '- reject: 用户拒绝了该建议',
      },
      userComment: {
        type: 'string',
        description: '用户可选评论文本，可用于后续偏好分析（500 字以内）。record_preference 可选。',
      },
      category: {
        type: 'string',
        enum: ['style', 'detail', 'plot', 'dialogue', 'character', 'other'] as any,
        description:
          '反馈分类。record_preference 可选，默认 other。\n' +
          '- style: 文风（描写风格、叙事视角、语言风格）\n' +
          '- detail: 详略（细节密度、抽象程度）\n' +
          '- plot: 情节（剧情走向、冲突设计）\n' +
          '- dialogue: 对话（对话自然度、口语化程度）\n' +
          '- character: 角色（角色塑造、心理描写）\n' +
          '- other: 其他',
      },
      entries: {
        type: 'string',
        description:
          '批量记录时的条目列表（JSON 字符串数组）。record_batch 需要。\n' +
          '格式：[{"chapterId":"ch19","suggestion":"简化描写","feedbackType":"accept","category":"style","userComment":"不错"}]\n' +
          '每条必填：chapterId, suggestion, feedbackType。可选：userComment, category。',
      },
      summary: {
        type: 'string',
        description: '修订内容摘要（500 字以内）。record_revised_chapter 需要。',
      },
      minConfidence: {
        type: 'number',
        description: '偏好提示的最低置信度过滤（0-1，默认 0）。值越高返回越可靠的提示但数量越少。get_hints 可选。',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  handler: async (args) => {
    const { action, storyName, chapterId, suggestion, feedbackType, userComment, category, entries, summary, minConfidence } = args as {
      action: string
      storyName?: string
      chapterId?: string
      suggestion?: string
      feedbackType?: string
      userComment?: string
      category?: string
      entries?: string
      summary?: string
      minConfidence?: number
    }

    const service = getPreferenceRevisionMemory()

    try {
      switch (action) {
        // ──── record_preference ────
        case 'record_preference': {
          if (!storyName) return formatToolError('record_preference 需要 storyName')
          if (!chapterId) return formatToolError('record_preference 需要 chapterId')
          if (!suggestion) return formatToolError('record_preference 需要 suggestion')
          if (!feedbackType || (feedbackType !== 'accept' && feedbackType !== 'reject')) {
            return formatToolError('feedbackType 必须是 "accept" 或 "reject"')
          }

          const validCategories = ['style', 'detail', 'plot', 'dialogue', 'character', 'other']
          const cat = category && validCategories.includes(category) ? category : 'other'

          service.recordPreference(storyName, chapterId, suggestion, feedbackType as 'accept' | 'reject', userComment || '', cat)

          const totalPrefs = service.getStoryPreferences(storyName).length

          return formatToolResult(
            `✓ 已记录修订偏好：${feedbackType === 'accept' ? '接受' : '拒绝'}\n` +
              `  故事：${storyName}\n` +
              `  章节：${chapterId}\n` +
              `  分类：${cat}\n` +
              `  建议：${suggestion.slice(0, 80)}${suggestion.length > 80 ? '…' : ''}\n` +
              `  该故事累计 ${totalPrefs} 条偏好记录。\n\n` +
              `💡 提示：使用 get_context 获取偏好上下文用于后续章节 prompt 注入。`,
          )
        }

        // ──── record_batch ────
        case 'record_batch': {
          if (!storyName) return formatToolError('record_batch 需要 storyName')
          if (!entries) return formatToolError('record_batch 需要 entries (JSON 字符串数组)')

          let parsedEntries: Array<{
            chapterId: string
            suggestion: string
            feedbackType: string
            userComment?: string
            category?: string
          }>
          try {
            parsedEntries = JSON.parse(entries)
            if (!Array.isArray(parsedEntries) || parsedEntries.length === 0) {
              return formatToolError('entries 应为非空 JSON 数组')
            }
          } catch {
            return formatToolError('entries 格式错误，需要有效的 JSON 数组字符串')
          }

          const validCategories = ['style', 'detail', 'plot', 'dialogue', 'character', 'other']
          let successCount = 0
          const errors: string[] = []

          for (let i = 0; i < parsedEntries.length; i++) {
            const e = parsedEntries[i]
            if (!e.chapterId || !e.suggestion || !e.feedbackType) {
              errors.push(`第 ${i + 1} 条缺少必要字段 (chapterId, suggestion, feedbackType)`)
              continue
            }
            if (e.feedbackType !== 'accept' && e.feedbackType !== 'reject') {
              errors.push(`第 ${i + 1} 条 feedbackType 无效: ${e.feedbackType}`)
              continue
            }

            service.recordPreference(
              storyName,
              e.chapterId,
              e.suggestion,
              e.feedbackType as 'accept' | 'reject',
              e.userComment || '',
              e.category && validCategories.includes(e.category) ? e.category : 'other',
            )
            successCount++
          }

          const result = `✓ 已批量记录 ${successCount} 条修订偏好`
          const errorSuffix = errors.length > 0 ? `\n⚠️ ${errors.length} 条记录失败：${errors.slice(0, 3).join('; ')}` : ''

          return formatToolResult(result + errorSuffix)
        }

        // ──── record_revised_chapter ────
        case 'record_revised_chapter': {
          if (!storyName) return formatToolError('record_revised_chapter 需要 storyName')
          if (!chapterId) return formatToolError('record_revised_chapter 需要 chapterId')
          if (!summary) return formatToolError('record_revised_chapter 需要 summary')

          const alreadyRevised = service.isChapterRevised(storyName, chapterId)
          service.recordRevisedChapter(storyName, chapterId, summary)

          const revised = service.getRevisedChapters(storyName)
          const progress = service.getRevisionProgress(storyName)

          return formatToolResult(
            `${alreadyRevised ? '🔄 已更新' : '✓ 已记录'}章节修订：${chapterId}\n` +
              `  故事：${storyName}\n` +
              `  摘要：${summary.slice(0, 80)}${summary.length > 80 ? '…' : ''}\n` +
              `  已修订章节：${revised.length} 章\n` +
              `  接受率：${Math.round(progress.acceptRate * 100)}%\n\n` +
              `💡 提示：使用 get_context 查看偏好参考。`,
          )
        }

        // ──── get_preferences ────
        case 'get_preferences': {
          if (!storyName) return formatToolError('get_preferences 需要 storyName')

          const preferences = service.getStoryPreferences(storyName)

          if (preferences.length === 0) {
            return formatToolResult(
              `暂无关于《${storyName}》的修订偏好记录。` + '\n在 Agent 给出修订建议后使用 record_preference 开始积累。',
            )
          }

          const grouped: Record<string, { accept: number; reject: number }> = {}
          const formatted = preferences.slice(0, 20).map((p) => {
            const catLabel: Record<string, string> = {
              style: '文风',
              detail: '详略',
              plot: '情节',
              dialogue: '对话',
              character: '角色',
              other: '其他',
            }
            const icon = p.feedbackType === 'accept' ? '✓' : '✗'
            const cat = catLabel[p.category] || p.category
            const date = new Date(p.timestamp).toLocaleString('zh-CN')
            const comment = p.userComment ? `（用户说：${p.userComment.slice(0, 40)}）` : ''

            if (!grouped[p.category]) grouped[p.category] = { accept: 0, reject: 0 }
            grouped[p.category][p.feedbackType]++

            return `${icon} [${cat}] ${p.suggestion.slice(0, 60)} ${comment}\n   ${p.chapterId} | ${date}`
          })

          const summary = Object.entries(grouped)
            .map(([cat, counts]) => {
              const catLabel: Record<string, string> = {
                style: '文风',
                detail: '详略',
                plot: '情节',
                dialogue: '对话',
                character: '角色',
                other: '其他',
              }
              return `${catLabel[cat] || cat}: 接受${counts.accept}次/拒绝${counts.reject}次`
            })
            .join('、')

          return formatToolResult(
            `《${storyName}》共 ${preferences.length} 条修订偏好记录：\n` +
              `汇总：${summary}\n\n` +
              formatted.join('\n\n') +
              (preferences.length > 20 ? `\n\n…及另外 ${preferences.length - 20} 条` : '') +
              '\n\n💡 使用 get_hints 获取提炼后的偏好提示，或 get_context 获取格式化上下文。',
          )
        }

        // ──── get_hints ────
        case 'get_hints': {
          if (!storyName) return formatToolError('get_hints 需要 storyName')

          const minConf = typeof minConfidence === 'number' ? Math.max(0, Math.min(1, minConfidence)) : 0
          const hints = service.getPreferenceHints(storyName, minConf)

          if (hints.length === 0) {
            if (minConf > 0) {
              return formatToolResult(
                '暂无满足置信度要求的偏好提示。可降低 minConfidence 值或继续积累更多反馈。' + '\n当前最低需要 2 条同类反馈才能提炼提示。',
              )
            }
            return formatToolResult(
              '暂无足够的偏好记录用于提炼提示。当前最低需要 2 条同类反馈。' + '\n在 Agent 给出修订建议后使用 record_preference 记录反馈。',
            )
          }

          const catLabel: Record<string, string> = {
            style: '文风',
            detail: '详略',
            plot: '情节',
            dialogue: '对话',
            character: '角色',
            other: '其他',
          }

          const formatted = hints.map(
            (h, i) =>
              `#${i + 1} [${catLabel[h.category] || h.category}] ${h.hint}` +
              `（置信度 ${Math.round(h.confidence * 100)}%，${h.sampleCount} 条样本）`,
          )

          const preferences = service.getStoryPreferences(storyName)
          return formatToolResult(
            `📊 《${storyName}》的修订偏好提示（基于 ${preferences.length} 条历史反馈）：\n\n` +
              formatted.join('\n\n') +
              '\n\n💡 使用 get_context 获取带格式的上下文文本用于 prompt 注入。',
          )
        }

        // ──── get_context ────
        case 'get_context': {
          if (!storyName) return formatToolError('get_context 需要 storyName')

          const context = service.getPreferenceContext(storyName)

          if (!context) {
            return formatToolResult(
              '暂无修订偏好与修订记录。开始修订后使用 record_preference 和 record_revised_chapter 积累数据。' +
                '\n当积累到 2 条以上同类反馈后，系统将自动生成偏好提示。',
            )
          }

          return formatToolResult(context)
        }

        // ──── get_revision_progress ────
        case 'get_revision_progress': {
          if (!storyName) return formatToolError('get_revision_progress 需要 storyName')

          const progress = service.getRevisionProgress(storyName)

          if (progress.totalPreferences === 0 && progress.revisedCount === 0) {
            return formatToolResult(
              `《${storyName}》暂无修订活动。可使用 record_preference 记录修订反馈，` + 'record_revised_chapter 记录已修订章节。',
            )
          }

          const catLabel: Record<string, string> = {
            style: '文风',
            detail: '详略',
            plot: '情节',
            dialogue: '对话',
            character: '角色',
            other: '其他',
          }

          const preferences = service.getStoryPreferences(storyName)
          const categoryBreakdown: Record<string, number> = {}
          for (const p of preferences) {
            categoryBreakdown[p.category] = (categoryBreakdown[p.category] || 0) + 1
          }
          const breakdownStr = Object.entries(categoryBreakdown)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `${catLabel[cat] || cat}(${count}条)`)
            .join('、')

          return formatToolResult(
            `📊 《${storyName}》修订进度\n` +
              `━━━━━━━━━━━━━━━━\n` +
              `📚 已修订章节：${progress.revisedCount} 章\n` +
              `📝 总偏好记录：${progress.totalPreferences} 条\n` +
              `  ${breakdownStr}\n` +
              `✓ 接受率：${Math.round(progress.acceptRate * 100)}%\n` +
              `✗ 拒绝率：${Math.round(progress.rejectRate * 100)}%\n` +
              (progress.revisedChapters.length > 0 ? `📖 已修订章节：${progress.revisedChapters.join('、')}\n` : '') +
              (progress.totalPreferences > 0 ? '\n💡 使用 get_hints 获取偏好提示，或 get_context 获取格式化上下文。' : ''),
          )
        }

        // ──── clear_story ────
        case 'clear_story': {
          if (!storyName) return formatToolError('clear_story 需要 storyName')

          const removed = service.clearStoryData(storyName)

          return formatToolResult(`✓ 已清空《${storyName}》的 ${removed} 条偏好与修订记录。`)
        }

        // ──── get_stats ────
        case 'get_stats': {
          const stats = service.getStats()

          return formatToolResult(
            `📊 偏好记忆写作助手 — 全局统计\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📝 总偏好记录：${stats.totalPreferences} 条\n` +
              `📚 已修订章节记录：${stats.totalRevisedChapters} 条\n` +
              `📖 涉及故事数：${stats.storiesCount} 个\n` +
              `💾 JSON 文件大小：${stats.storeFileSize}\n` +
              `📂 存储路径：${service.getStoreFilePath()}`,
          )
        }

        default:
          return formatToolError(
            `未知操作: "${action}"。支持的操作：` +
              'record_preference, record_batch, record_revised_chapter, ' +
              'get_preferences, get_hints, get_context, get_revision_progress, ' +
              'clear_story, get_stats',
          )
      }
    } catch (e: any) {
      return formatToolError(`偏好记忆操作失败: ${e.message}`)
    }
  },
})

