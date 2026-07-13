/**
 * WritingDecisionTool — 写作决策记忆回溯与一致性检查 MCP 工具
 *
 * 提供五个操作：
 * 1. record_decision      — 手动记录一条写作决策到 Memory
 * 2. record_from_diff     — 通过新旧内容对比自动生成决策记录
 * 3. query_by_story       — 查询某故事的所有决策记录
 * 4. get_context          — 获取格式化决策上下文（用于写作前注入 prompt）
 * 5. check_consistency    — 对新章节内容运行一致性校验
 *
 * 配合 WritingDecisionMemory 服务使用。
 */
import { buildTool, formatToolResult, formatToolError } from '../types'
import { WritingDecisionService, type WritingDecisionType } from '../../creativity/WritingDecisionMemory'
import { getMemoryService } from '../deps'

const VALID_DECISION_TYPES: WritingDecisionType[] = [
  'character_change',
  'setting_change',
  'plot_change',
  'style_change',
  'timeline_change',
  'relationship_change',
  'dialogue_change',
  'worldbuilding_change',
  'other',
]

export const writingDecisionTool = buildTool({
  name: 'writing_decision_memory',
  description:
    '写作决策记忆回溯与一致性检查 — 记录/查询章节修改时的关键设定变更，' +
    '在新章节写作前回溯已变更项，在草稿完成后检查与历史决策的一致性。\n\n' +
    '操作类型:\n' +
    '- record_decision: 手动记录一条写作决策（提供实体、原/新内容、决策类型）\n' +
    '- record_from_diff: 通过对比新旧内容自动提取实体和变更，批量生成决策记录\n' +
    '- query_by_story: 查询某故事的所有历史决策记录\n' +
    '- query_by_entities: 按实体名（角色/地点等）查询相关决策记录\n' +
    '- get_context: 获取格式化决策回溯上下文（用于写作 prompt 注入）\n' +
    '- check_consistency: 对新章节内容运行一致性校验，检测与历史决策的矛盾\n\n' +
    '建议工作流：\n' +
    '  1. 续写新章节前 → 调用 get_context 获取历史决策，避免矛盾\n' +
    '  2. 修改已发布章节 → 调用 record_from_diff 记录变更（或在明确修改时调用 record_decision）\n' +
    '  3. 草稿完成后 → 调用 check_consistency 自动校验',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- record_decision: 手动记录写作决策。需 storyName, decisionType, entities, originalContent, modifiedContent, contextSummary\n' +
          '- record_from_diff: 通过 diff 自动生成决策。需 storyName, oldContent, newContent。可选 sceneId, sceneTitle, chapterNumber\n' +
          '- query_by_story: 查询故事所有决策。需 storyName\n' +
          '- query_by_entities: 按实体查询相关决策。需 storyName, entities（数组）\n' +
          '- get_context: 获取格式化上下文。需 storyName。可选 entities（数组，过滤实体）\n' +
          '- check_consistency: 一致性检查。需 storyName, newContent',
      },
      storyName: {
        type: 'string',
        description: '故事名称（如 "工业颂歌"）',
      },
      sceneId: {
        type: 'string',
        description: '场景/章节 ID（record_from_diff 可选）',
      },
      sceneTitle: {
        type: 'string',
        description: '场景标题（record_from_diff 可选）',
      },
      chapterNumber: {
        type: 'number',
        description: '章节编号（record_from_diff / check_consistency 可选）',
      },
      decisionType: {
        type: 'string',
        description:
          '决策类型（record_decision 时需要）：\n' +
          '- character_change: 角色变更（性格、外貌、背景等）\n' +
          '- setting_change: 场景/设定变更（地点、时代、气候等）\n' +
          '- plot_change: 情节变更（事件走向、悬念设置等）\n' +
          '- style_change: 文风变更（叙事视角、语言风格等）\n' +
          '- timeline_change: 时间线变更（顺序、间隔等）\n' +
          '- relationship_change: 关系变更（角色间互动）\n' +
          '- dialogue_change: 对话变更（台词、风格）\n' +
          '- worldbuilding_change: 世界观变更（规则、体系）\n' +
          '- other: 其他',
      },
      entities: {
        type: 'string',
        description:
          '实体列表（JSON 字符串数组）。record_decision 时填写涉及的实体名；' +
          'query_by_entities 时填写要查询的实体名；' +
          'get_context 时可选，用于过滤。格式：["林默","陈峰","钟楼市"]',
      },
      originalContent: {
        type: 'string',
        description: '原内容（record_decision 时需要，record_from_diff 时作为 oldContent）',
      },
      modifiedContent: {
        type: 'string',
        description: '修改后内容（record_decision 时需要，record_from_diff 时作为 newContent）',
      },
      contextSummary: {
        type: 'string',
        description: '上下文摘要（record_decision 时需要，100 字以内）',
      },
      oldContent: {
        type: 'string',
        description: '原场景完整内容（record_from_diff 时使用）',
      },
      newContent: {
        type: 'string',
        description: '新场景完整内容（record_from_diff / check_consistency 时使用）',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  handler: async (args) => {
    const {
      action,
      storyName,
      sceneId,
      sceneTitle,
      chapterNumber,
      decisionType,
      entities,
      originalContent,
      modifiedContent,
      contextSummary,
      oldContent,
      newContent,
    } = args as {
      action: string
      storyName?: string
      sceneId?: string
      sceneTitle?: string
      chapterNumber?: number
      decisionType?: string
      entities?: string
      originalContent?: string
      modifiedContent?: string
      contextSummary?: string
      oldContent?: string
      newContent?: string
    }

    // 验证 MemoryService 可用
    const ms = getMemoryService()
    if (!ms) {
      return formatToolError('记忆系统暂不可用，无法操作写作决策记忆。请确认 MemoryService 已初始化。')
    }

    const service = new WritingDecisionService()

    try {
      switch (action) {
        // ──── record_decision ────
        case 'record_decision': {
          if (!storyName) return formatToolError('record_decision 需要 storyName')
          if (!decisionType) return formatToolError('record_decision 需要 decisionType')
          if (!originalContent && !modifiedContent) {
            return formatToolError('record_decision 需要 originalContent 或 modifiedContent')
          }
          if (!contextSummary) return formatToolError('record_decision 需要 contextSummary')

          if (!VALID_DECISION_TYPES.includes(decisionType as WritingDecisionType)) {
            return formatToolError(
              `无效的决策类型: "${decisionType}"。有效值：${VALID_DECISION_TYPES.join(', ')}`,
            )
          }

          const parsedEntities: string[] = entities ? JSON.parse(entities) : []

          const entryId = service.recordDecision({
            storyName,
            sceneId,
            sceneTitle,
            chapterNumber,
            decisionType: decisionType as WritingDecisionType,
            entities: parsedEntities,
            originalContent: originalContent || '（未提供原内容）',
            modifiedContent: modifiedContent || '（未提供修改后内容）',
            contextSummary,
          })

          if (!entryId) {
            return formatToolError('保存决策记录失败，MemoryService 返回空 ID')
          }

          return formatToolResult(
            `✓ 已记录写作决策：${decisionType}\n` +
              `  故事：${storyName}\n` +
              `  实体：${parsedEntities.join(', ') || '无'}\n` +
              `  摘要：${contextSummary.slice(0, 80)}\n` +
              `  下次续写前可调用 get_context 回溯此决策。`,
          )
        }

        // ──── record_from_diff ────
        case 'record_from_diff': {
          if (!storyName) return formatToolError('record_from_diff 需要 storyName')
          if (!oldContent && !newContent) {
            return formatToolError('record_from_diff 需要 oldContent 和 newContent 至少提供一个')
          }
          if (oldContent === undefined) return formatToolError('record_from_diff 需要 oldContent（原内容）')
          if (newContent === undefined) return formatToolError('record_from_diff 需要 newContent（新内容）')

          const records = service.recordDecisionFromDiff({
            storyName,
            sceneId,
            sceneTitle,
            chapterNumber,
            oldContent,
            newContent,
          })

          if (records.length === 0) {
            return formatToolResult('未检测到内容差异，无需记录决策。')
          }

          const summary = records
            .map(
              (r, i) =>
                `${i + 1}. [${r.decisionType}] ${r.entities.join(', ') || '无实体'} — ${r.contextSummary.slice(0, 60)}`,
            )
            .join('\n')

          return formatToolResult(
            `✓ 通过 diff 自动生成 ${records.length} 条决策记录：\n${summary}\n\n` +
              `下次续写前可调用 get_context 回溯这些决策。`,
          )
        }

        // ──── query_by_story ────
        case 'query_by_story': {
          if (!storyName) return formatToolError('query_by_story 需要 storyName')

          const entries = service.queryByStory(storyName)
          if (entries.length === 0) {
            return formatToolResult(
              `暂无关于《${storyName}》的写作决策记录。修改章节后使用 record_from_diff 或 record_decision 记录。`,
            )
          }

          const formatted = entries.map(
            (e) =>
              `[${e.decisionType}] ${new Date(e.timestamp).toLocaleString('zh-CN')}\n` +
              `  实体：${e.entities.join(', ') || '无'}\n` +
              `  摘要：${e.contextSummary.slice(0, 100)}\n` +
              `  章节：${e.sceneTitle || '未知'}`,
          )

          return formatToolResult(
            `《${storyName}》共 ${entries.length} 条决策记录：\n\n${formatted.join('\n\n')}`,
          )
        }

        // ──── query_by_entities ────
        case 'query_by_entities': {
          if (!storyName) return formatToolError('query_by_entities 需要 storyName')
          if (!entities) return formatToolError('query_by_entities 需要 entities（JSON 字符串数组）')

          let parsedEntities: string[]
          try {
            parsedEntities = JSON.parse(entities)
            if (!Array.isArray(parsedEntities) || parsedEntities.length === 0) {
              return formatToolError('entities 应为非空 JSON 数组，如 ["林默","陈峰"]')
            }
          } catch {
            return formatToolError('entities 解析失败，请提供 JSON 字符串数组，如 ["林默","陈峰"]')
          }

          const matched = service.queryByEntities(storyName, parsedEntities)
          if (matched.length === 0) {
            return formatToolResult(
              `未找到与实体「${parsedEntities.join('、')}」相关的决策记录。`,
            )
          }

          const formatted = matched.map(
            (e) =>
              `[${e.decisionType}] ${new Date(e.timestamp).toLocaleString('zh-CN')}\n` +
              `  涉及实体：${e.entities.join(', ')}\n` +
              `  摘要：${e.contextSummary.slice(0, 100)}`,
          )

          return formatToolResult(
            `查询实体「${parsedEntities.join('、')}」找到 ${matched.length} 条相关决策：\n\n` +
              formatted.join('\n\n'),
          )
        }

        // ──── get_context ────
        case 'get_context': {
          if (!storyName) return formatToolError('get_context 需要 storyName')

          let entityFilter: string[] | undefined
          if (entities) {
            try {
              entityFilter = JSON.parse(entities)
              if (!Array.isArray(entityFilter)) entityFilter = undefined
            } catch {
              entityFilter = undefined
            }
          }

          const context = service.getFormattedContext(storyName, entityFilter)
          if (!context) {
            return formatToolResult(
              '暂无写作决策回溯信息。章节修改后可调用 record_from_diff 或 record_decision 来积累决策记忆。',
            )
          }

          return formatToolResult(context)
        }

        // ──── check_consistency ────
        case 'check_consistency': {
          if (!storyName) return formatToolError('check_consistency 需要 storyName')
          if (!newContent) return formatToolError('check_consistency 需要 newContent（新章节内容）')

          const issues = service.checkConsistency(storyName, newContent)

          if (issues.length === 0) {
            return formatToolResult(
              '✓ 一致性检查通过：新内容与所有历史决策记录无冲突。',
            )
          }

          const formatted = service.formatIssues(issues)
          const conflictCount = issues.filter((i) => i.severity === 'conflict').length
          const warningCount = issues.filter((i) => i.severity === 'warning').length

          return formatToolResult(
            `⚠️ 一致性检查发现 ${issues.length} 个问题` +
              `（${conflictCount} 个冲突，${warningCount} 个提示）：\n${formatted}`,
          )
        }

        default:
          return formatToolError(
            `未知操作: "${action}"。支持的操作：record_decision, record_from_diff, query_by_story, query_by_entities, get_context, check_consistency`,
          )
      }
    } catch (e: any) {
      return formatToolError(`写作决策记忆操作失败: ${e.message}`)
    }
  },
})
