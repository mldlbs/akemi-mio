/**
 * PolishingMemoryTool — 章节润色记忆图谱工具
 *
 * 将 PolishingMemoryManager 暴露为 MCP 工具，供 LLM 在写作/润色流程中调用。
 *
 * 支持操作：
 * 1. store_decision  — 存储一段润色决策到 Memory
 * 2. query_history   — 查询某故事的润色历史
 * 3. get_context     — 获取润色上下文提示（用于注入 system prompt）
 * 4. extract_rules   — 从历史决策中提炼通用风格规则
 * 5. get_rules       — 查看当前持久规则库
 *
 * 配合 PolishingMemoryManager 使用。
 * 在 writing-prompt.ts 中可注入使用指引。
 */
import { buildTool, formatToolResult, formatToolError } from '../types'
import { PolishingMemoryManager } from '../../creativity/PolishingMemoryManager'
import type { PolishingDecision } from '../../creativity/PolishingMemoryManager'

export const polishingMemoryTool = buildTool({
  name: 'polishing_memory',
  description: `章节润色记忆图谱 — 管理各章节的润色决策记录，确保长篇创作风格一致性。

支持操作：
- store_decision: 存储当前段落的润色决策（写入 Memory）。参数：storyId, chapterTitle, paragraphIndex, modifications[]
- query_history: 查询某故事的润色历史决策。参数：storyId, chapterTitle(可选)
- get_context: 获取润色上下文提示，用于注入 LLM 的 system prompt（新章节前调用）。参数：storyId, chapterTitle(可选)
- extract_rules: 从历史决策中提炼通用风格规则。参数：storyId(可选，不传则全量分析)
- get_rules: 查看当前持久规则库。参数无

用法建议：
1. 每完成一段润色 → 调用 store_decision 记录决策
2. 开始新章节前 → 调用 get_context 获取历史上下文
3. 每完成一个章节 → 调用 extract_rules 提炼规则`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- store_decision: 存储润色决策\n' +
          '- query_history: 查询润色历史\n' +
          '- get_context: 获取润色上下文提示\n' +
          '- extract_rules: 提炼通用风格规则\n' +
          '- get_rules: 查看当前持久规则',
      },
      storyId: {
        type: 'string',
        description: '故事 ID 或名称。store_decision / query_history / get_context / extract_rules 需要。',
      },
      chapterTitle: {
        type: 'string',
        description: '章节标题（如 "第一章 初入江湖"）。store_decision 需要，query_history / get_context 可选过滤。',
      },
      paragraphIndex: {
        type: 'number',
        description: '段落索引，从 0 开始。store_decision 需要。',
      },
      modifications: {
        type: 'string',
        description:
          '修改列表的 JSON 字符串。store_decision 需要。格式：\n' +
          '[{"type":"修改类型","description":"修改描述","reason":"修改原因","rulesApplied":["规则1","规则2"]}]\n' +
          '修改类型可选值：style_unification(风格统一) | ai_depolish(去AI味) | rhythm_adjustment(节奏调整) | ' +
          'dialogue_naturalize(对话自然化) | detail_add(细节补充) | redundancy_remove(冗余删除) | ' +
          'perspective_fix(视角修正) | word_refine(用词精炼) | sentence_restructure(句式重组) | tense_or_mood_fix(时态/语气修正) | other(其他)',
      },
      styleRules: {
        type: 'string',
        description:
          '该段落应用的总体风格规则，JSON 字符串数组。store_decision 可选。如 ["show_dont_tell", "avoid_empty_adverbs"]',
      },
      originalExcerpt: {
        type: 'string',
        description: '原文片段（前 200 字符以内）。store_decision 可选，用于后续参考。',
      },
      polishedExcerpt: {
        type: 'string',
        description: '修改后片段（前 200 字符以内）。store_decision 可选。',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  handler: async (args) => {
    const {
      action,
      storyId,
      chapterTitle,
      paragraphIndex,
      modifications,
      styleRules,
      originalExcerpt,
      polishedExcerpt,
    } = args as {
      action: string
      storyId?: string
      chapterTitle?: string
      paragraphIndex?: number
      modifications?: string
      styleRules?: string
      originalExcerpt?: string
      polishedExcerpt?: string
    }

    const manager = new PolishingMemoryManager()

    try {
      switch (action) {
        // ─── 存储决策 ───
        case 'store_decision': {
          if (!storyId) return formatToolError('需要 storyId')
          if (!chapterTitle) return formatToolError('需要 chapterTitle')
          if (paragraphIndex === undefined || paragraphIndex === null) {
            return formatToolError('需要 paragraphIndex')
          }
          if (!modifications) return formatToolError('需要 modifications (JSON 数组字符串)')

          let parsedMods: PolishingDecision['modifications']
          try {
            parsedMods = JSON.parse(modifications)
          } catch {
            return formatToolError('modifications 格式错误，需要有效的 JSON 数组字符串')
          }

          if (!Array.isArray(parsedMods) || parsedMods.length === 0) {
            return formatToolError('modifications 需要是非空数组')
          }

          // 验证每个修改项的字段
          for (const m of parsedMods) {
            if (!m.type) return formatToolError('每个修改项需要 type 字段')
            if (!m.description) return formatToolError('每个修改项需要 description 字段')
            if (!m.reason) return formatToolError('每个修改项需要 reason 字段')
          }

          let parsedRules: string[] = []
          if (styleRules) {
            try {
              parsedRules = JSON.parse(styleRules)
            } catch {
              return formatToolError('styleRules 格式错误，需要有效的 JSON 数组字符串')
            }
          }

          const decision: PolishingDecision = {
            storyId,
            chapterTitle,
            paragraphIndex,
            originalExcerpt: originalExcerpt?.slice(0, 200),
            polishedExcerpt: polishedExcerpt?.slice(0, 200),
            modifications: parsedMods,
            styleRules: parsedRules,
            createdAt: Date.now(),
          }

          manager.storeDecision(decision)

          return formatToolResult(
            `✓ 已存储对《${storyId}》第 "${chapterTitle}" 段落#${paragraphIndex} 的润色决策。` +
              `共 ${parsedMods.length} 项修改：${parsedMods.map((m) => m.type).join(', ')}。`,
          )
        }

        // ─── 查询历史 ───
        case 'query_history': {
          if (!storyId) return formatToolError('需要 storyId')

          const decisions = manager.queryHistory(storyId, {
            chapterTitle,
            limit: 20,
          })

          if (decisions.length === 0) {
            return formatToolResult(
              `暂无关于《${storyId}》${chapterTitle ? `（${chapterTitle}）` : ''}的润色决策记录。`,
            )
          }

          const formatted = decisions.map((d, i) => {
            const modSummary = d.modifications
              .map((m) => `[${m.type}] ${m.description.slice(0, 50)}`)
              .join(' | ')
            return (
              `#${i + 1} [${d.chapterTitle} 段落#${d.paragraphIndex}] (${new Date(d.createdAt).toLocaleString('zh-CN')})\n` +
              `  修改: ${modSummary}\n` +
              `  原因: ${d.modifications.map((m) => m.reason.slice(0, 40)).join('; ')}`
            )
          })

          return formatToolResult(
            `《${storyId}》的润色历史（最近 ${decisions.length} 条）：\n\n` + formatted.join('\n\n'),
          )
        }

        // ─── 获取上下文提示 ───
        case 'get_context': {
          if (!storyId) return formatToolError('需要 storyId')

          const context = manager.buildPolishingContext(storyId, chapterTitle)

          if (context.isEmpty) {
            return formatToolResult(
              '暂无润色历史记录。可直接按当前风格进行润色，润色完成后使用 store_decision 记录决策。',
            )
          }

          return formatToolResult(
            `---\n【润色上下文参考】\n${context.summary}\n---\n` +
              `\n（共 ${context.decisionCount} 条历史决策，${context.ruleCount} 条通用规则）`,
          )
        }

        // ─── 提炼规则 ───
        case 'extract_rules': {
          const rules = await manager.extractRules(storyId)

          if (rules.length === 0) {
            return formatToolResult(
              '暂未提炼出新的风格规则。需要至少有 3 条润色决策记录才能进行规则提炼。',
            )
          }

          const formatted = rules.map(
            (r, i) =>
              `#${i + 1} [${r.category}] ${r.rule} (置信度: ${(r.confidence * 100).toFixed(0)}%)`,
          )

          return formatToolResult(
            `成功提炼 ${rules.length} 条风格规则：\n\n${formatted.join('\n')}`,
          )
        }

        // ─── 查看规则 ───
        case 'get_rules': {
          const rules = manager.getPersistentRules()

          if (rules.length === 0) {
            return formatToolResult('当前持久规则库为空。可使用 extract_rules 从历史决策中提炼规则。')
          }

          // 按置信度排序
          const sorted = [...rules].sort((a, b) => b.confidence - a.confidence)

          const formatted = sorted.map(
            (r, i) =>
              `#${i + 1} [${r.category}] ${r.rule}\n` +
              `   来源: ${r.source} | 置信度: ${(r.confidence * 100).toFixed(0)}%` +
              (r.exampleBefore ? `\n   修改前: ${r.exampleBefore.slice(0, 60)}` : '') +
              (r.exampleAfter ? `\n   修改后: ${r.exampleAfter.slice(0, 60)}` : ''),
          )

          return formatToolResult(
            `当前持久规则库共 ${rules.length} 条规则：\n\n${formatted.join('\n\n')}`,
          )
        }

        default:
          return formatToolError(
            `未知操作: ${action}。支持的操作：store_decision, query_history, get_context, extract_rules, get_rules。`,
          )
      }
    } catch (e: any) {
      return formatToolError(`润色记忆操作失败: ${e.message}`)
    }
  },
})
