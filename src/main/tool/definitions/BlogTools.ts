/**
 * BlogTools — BlogAgent 的 MCP 工具集
 *
 * 这些工具作为 AI 与 BlogAgentService 之间的桥梁，
 * 让 LLM 可以通过 MCP 协议管理博客写作会话。
 *
 * 工具列表：
 * - blog_start_session — 开始新的博客写作会话
 * - blog_session_status — 查看当前会话状态和进度
 * - blog_handle_input — 处理用户输入（自然语言指令）
 * - blog_advance_stage — 手动推进到下一阶段
 * - blog_get_habits — 获取用户写作习惯分析
 * - blog_get_suggestions — 获取写作优化建议
 * - blog_list_sessions — 列出所有活跃会话
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { blogAgentService } from '../../agent/blog/BlogAgentService'
import { BLOG_STAGE_LABELS, BLOG_STAGE_ORDER } from '../../agent/blog/types'

// =============================================================================
// blog_start_session
// =============================================================================

export const blogStartSessionTool = buildTool({
  name: 'blog_start_session',
  description:
    '【BlogAgent】开始一个新的博客写作会话。用户有写作意图时调用此工具启动协作流程。返回会话ID和初始状态',
  inputJSONSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '博客主题或标题，如实描述用户想要写的内容',
      },
      platform: {
        type: 'string',
        description: '目标平台（可选），如：博客园、CSDN、知乎、掘金、公众号、个人博客等',
      },
    },
    required: ['topic'],
  },
  handler: async (args: { topic: string; platform?: string }) => {
    try {
      const session = blogAgentService.startSession(args.topic, args.platform)

      // 获取习惯建议
      const suggestions = blogAgentService.generateSuggestions()

      // 获取写作习惯
      const habits = blogAgentService.getHabitProfile()

      const lines: string[] = [
        `✅ 博客写作会话已创建！`,
        ``,
        `📝 会话ID: ${session.sessionId}`,
        `📌 主题: ${session.topic}`,
        session.targetPlatform ? `🎯 目标平台: ${session.targetPlatform}` : '',
        ``,
        `📋 当前阶段: ${BLOG_STAGE_LABELS[session.currentStage]}`,
        `工作流包含 ${BLOG_STAGE_ORDER.length} 个阶段，我会在每个决策点停下来询问你的意见。`,
      ]

      // 如果有写作习惯建议，附加上
      if (suggestions.length > 0) {
        lines.push(``, `💡 写作建议:`)
        for (const s of suggestions) {
          lines.push(`  - ${s}`)
        }
      }

      // 首次写作提示
      if (habits.totalSessions === 0) {
        lines.push(
          ``,
          `📖 第一次使用 BlogAgent！你可以：`,
          `  - 自然交流，我会自动推进流程`,
          `  - 说「跳过这个」跳过某阶段`,
          `  - 说「改成XXX」修改方向`,
          `  - 说「进度」查看当前状态`,
        )
      }

      // 显示自动检索的历史经验参考
      if (session.experienceReferences && session.experienceReferences.length > 0) {
        const categoryLabels: Record<string, string> = {
          analysis: '代码分析',
          design_decision: '设计决策',
          test_result: '测试结果',
          refactoring: '重构记录',
          bug_fix: 'Bug修复',
          performance: '性能优化',
          architecture: '架构决定',
          other: '其他',
        }

        lines.push(``, `📚 找到 ${session.experienceReferences.length} 条相关历史经验：`)
        for (const ref of session.experienceReferences.slice(0, 3)) {
          const label = categoryLabels[ref.category] || ref.category
          const similarity = (ref.score * 100).toFixed(0)
          lines.push(`  - [${label}] (${similarity}% 相关) ${ref.content.slice(0, 120)}`)
        }
        if (session.experienceReferences.length > 3) {
          lines.push(`  ... 还有 ${session.experienceReferences.length - 3} 条，可用 blog_memory_search 查看全部`)
        }
      }

      return formatToolResult(lines.filter(Boolean).join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_session_status
// =============================================================================

export const blogSessionStatusTool = buildTool({
  name: 'blog_session_status',
  description:
    '【BlogAgent】查看当前博客写作会话的状态和进度。返回当前阶段、已完成步骤、主题等信息',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话ID（可选）。不传则返回最近一个活跃会话的状态',
      },
    },
    required: [],
  },
  handler: async (args: { sessionId?: string }) => {
    try {
      let status: string

      if (args.sessionId) {
        const session = blogAgentService.getSession(args.sessionId)
        if (!session) return formatToolResult('未找到该会话ID。它可能已过期或不存在。')
        status = blogAgentService.getStatusText(session)
      } else {
        const active = blogAgentService.listActiveSessions()
        if (active.length === 0) return formatToolResult('当前没有活跃的博客写作会话。如需开始新的写作，请告知主题。')

        if (active.length === 1) {
          status = blogAgentService.getStatusText(active[0])
        } else {
          const lines = [`有 ${active.length} 个活跃的博客写作会话:`, ``]
          for (const s of active) {
            lines.push(`  - [${s.sessionId}] ${s.topic} → ${BLOG_STAGE_LABELS[s.currentStage]}`)
          }
          lines.push(``, '使用 sessionId 查看具体会话详情。')
          status = lines.join('\n')
        }
      }

      return formatToolResult(status)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_handle_input
// =============================================================================

export const blogHandleInputTool = buildTool({
  name: 'blog_handle_input',
  description:
    '【BlogAgent】处理用户对博客写作的自然语言指令。当用户对当前写作步骤有意见（跳过、修改、回退等），或有新指示时调用此工具。自动解析意图并执行',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话ID。如果不传，会自动匹配最近的活跃会话',
      },
      userInput: {
        type: 'string',
        description: '用户的自然语言输入。支持：\n- 「继续/好/通过」→ 确认当前步骤\n- 「跳过」「跳过审核」→ 跳过某步骤\n- 「改成XXX」→ 修改方向\n- 「从XX重新开始」→ 回退\n- 「加个XX部分」→ 修改内容\n- 「进度」→ 查看状态',
      },
    },
    required: ['userInput'],
  },
  handler: async (args: { sessionId?: string; userInput: string }) => {
    try {
      // 获取会话
      let session = args.sessionId
        ? blogAgentService.getSession(args.sessionId)
        : blogAgentService.listActiveSessions()[0] ?? null

      if (!session) {
        // 没有活跃会话，检查是否是开始写作的意图
        if (/写(博客|文章|文)|开始|创作/.test(args.userInput)) {
          return formatToolResult('没有找到活跃的写作会话。请先用 blog_start_session 开始新的写作。')
        }
        return formatToolResult('当前没有活跃的博客写作会话。如需开始新的写作，请告知主题。')
      }

      const sid = session.sessionId

      // 解析指令
      const command = blogAgentService.parseCommand(args.userInput)

      // 如果是 approve 且有下一个阶段，自动推进
      if (command.type === 'approve') {
        const result = blogAgentService.executeCommand(sid, command)
        const updated = blogAgentService.advanceStage(sid)
        if (updated) {
          const nextLabel = updated.completed
            ? '🎉 文章已完成！如需发布规划，请告知。'
            : `📋 已进入下一阶段: ${BLOG_STAGE_LABELS[updated.currentStage]}`
          return formatToolResult(`${result}\n\n${nextLabel}`)
        }
        return formatToolResult(result)
      }

      // 如果是 status 指令，直接返回状态
      if (command.type === 'status') {
        return formatToolResult(blogAgentService.getStatusText(session))
      }

      // 其他指令执行
      const result = blogAgentService.executeCommand(sid, command)
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_advance_stage
// =============================================================================

export const blogAdvanceStageTool = buildTool({
  name: 'blog_advance_stage',
  description:
    '【BlogAgent】手动推进博客写作到下一阶段。当用户确认当前步骤完成、或 Agent 判断可以继续时调用',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话ID',
      },
      stageOutput: {
        type: 'string',
        description: '当前阶段的输出内容（可选），如分析结果、生成的文本等',
      },
    },
    required: ['sessionId'],
  },
  handler: async (args: { sessionId: string; stageOutput?: string }) => {
    try {
      const session = blogAgentService.getSession(args.sessionId)
      if (!session) return formatToolError('未找到该会话ID。')

      // 如果有输出，先更新
      if (args.stageOutput) {
        blogAgentService.updateStageOutput(args.sessionId, session.currentStage, args.stageOutput)
      }

      // 推进到下一阶段
      const updated = blogAgentService.advanceStage(args.sessionId)
      if (!updated) return formatToolError('无法推进阶段。')

      if (updated.completed) {
        return formatToolResult(
          `🎉 博客「${updated.topic}」已完成所有写作阶段！\n\n你可以：\n- 查看/保存最终版本\n- 进行发布规划\n- 开始新的博客`,
        )
      }

      return formatToolResult(
        `✅ 已推进到下一阶段: ${BLOG_STAGE_LABELS[updated.currentStage]}\n\n${updated.skippedStages.length > 0 ? `已跳过: ${updated.skippedStages.map((st) => BLOG_STAGE_LABELS[st]).join('、')}\n\n` : ''}是否需要我继续执行当前阶段？`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_get_habits
// =============================================================================

export const blogGetHabitsTool = buildTool({
  name: 'blog_get_habits',
  description:
    '【BlogAgent】获取用户的博客写作习惯分析。包括常用主题、平台偏好、写作时段、修订频率等。用于个性化优化写作流程',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const habits = blogAgentService.getHabitProfile()
      const suggestions = blogAgentService.generateSuggestions()

      const lines: string[] = [
        '📊 写作习惯分析',
        `总写作次数: ${habits.totalSessions}`,
        `常用主题: ${habits.commonTopics.length > 0 ? habits.commonTopics.slice(0, 5).join('、') : '暂无数据'}`,
        `常用平台: ${habits.commonPlatforms.length > 0 ? habits.commonPlatforms.join('、') : '暂无数据'}`,
        `风格偏好: ${habits.stylePreferences.length > 0 ? habits.stylePreferences.join('、') : '暂无数据'}`,
        `平均修订轮次: ${habits.avgRevisionRounds}`,
        `偏好大纲: ${habits.prefersOutline ? '是' : '否'}`,
        `固定发布日: ${habits.preferredPublishDay ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][habits.preferredPublishDay - 1] : '未设定'}`,
      ]

      if (suggestions.length > 0) {
        lines.push(``, '💡 个性化建议:')
        for (const s of suggestions) {
          lines.push(`  - ${s}`)
        }
      }

      if (habits.totalSessions === 0) {
        lines.push(``, '📝 尚无充足写作数据。完成几篇博客后我会学习你的习惯。')
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_get_suggestions
// =============================================================================

export const blogGetSuggestionsTool = buildTool({
  name: 'blog_get_suggestions',
  description:
    '【BlogAgent】获取针对当前用户习惯的博客写作优化建议。包括主题建议、发布时间建议、平台建议等',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const suggestions = blogAgentService.generateSuggestions()
      if (suggestions.length === 0) {
        return formatToolResult(
          '目前还没有足够的写作数据来生成个性化建议。完成几篇博客后，我会根据你的习惯提供优化建议。',
        )
      }
      return formatToolResult(`💡 博客写作优化建议:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_list_sessions
// =============================================================================

export const blogListSessionsTool = buildTool({
  name: 'blog_list_sessions',
  description:
    '【BlogAgent】列出所有活跃的博客写作会话。查看当前有哪些进行中的写作任务',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const sessions = blogAgentService.listActiveSessions()
      if (sessions.length === 0) return formatToolResult('当前没有活跃的博客写作会话。')

      const lines = sessions.map((s, i) => {
        const completedCount = BLOG_STAGE_ORDER.filter((st) => s.stageStatuses[st] === 'completed').length
        const totalCount = BLOG_STAGE_ORDER.length - s.skippedStages.length
        return (
          `  ${i + 1}. [${s.sessionId.slice(0, 16)}…] ${s.topic}` +
          `\n     阶段: ${BLOG_STAGE_LABELS[s.currentStage]} (${completedCount}/${totalCount})` +
          `\n     创建: ${new Date(s.createdAt).toLocaleString('zh-CN')}`
        )
      })

      return formatToolResult(`📝 活跃的博客写作会话 (${sessions.length}):\n\n${lines.join('\n\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
