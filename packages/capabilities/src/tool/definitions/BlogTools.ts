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

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { blogAgentService } from '@akemi-mio/intelligence/agent/blog/BlogAgentService'
import { blogSecurityReviewer } from '@akemi-mio/intelligence/agent/blog/BlogSecurityReviewer'
import { blogAnalyticsTracker } from '@akemi-mio/intelligence/agent/blog/BlogAnalyticsTracker'
import { BLOG_STAGE_LABELS, BLOG_STAGE_ORDER } from '@akemi-mio/intelligence/agent/blog/types'

// =============================================================================
// blog_start_session
// =============================================================================

export const blogStartSessionTool = buildTool({
  name: 'blog_start_session',
  description: '【BlogAgent】开始一个新的博客写作会话。用户有写作意图时调用此工具启动协作流程。返回会话ID和初始状态',
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
  description: '【BlogAgent】查看当前博客写作会话的状态和进度。返回当前阶段、已完成步骤、主题等信息',
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
        description:
          '用户的自然语言输入。支持：\n- 「继续/好/通过」→ 确认当前步骤\n- 「跳过」「跳过审核」→ 跳过某步骤\n- 「改成XXX」→ 修改方向\n- 「从XX重新开始」→ 回退\n- 「加个XX部分」→ 修改内容\n- 「进度」→ 查看状态',
      },
    },
    required: ['userInput'],
  },
  handler: async (args: { sessionId?: string; userInput: string }) => {
    try {
      // 获取会话
      const session = args.sessionId ? blogAgentService.getSession(args.sessionId) : (blogAgentService.listActiveSessions()[0] ?? null)

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
  description: '【BlogAgent】手动推进博客写作到下一阶段。当用户确认当前步骤完成、或 Agent 判断可以继续时调用',
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
  description: '【BlogAgent】获取用户的博客写作习惯分析。包括常用主题、平台偏好、写作时段、修订频率等。用于个性化优化写作流程',
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
  description: '【BlogAgent】获取针对当前用户习惯的博客写作优化建议。包括主题建议、发布时间建议、平台建议等',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const suggestions = blogAgentService.generateSuggestions()
      if (suggestions.length === 0) {
        return formatToolResult('目前还没有足够的写作数据来生成个性化建议。完成几篇博客后，我会根据你的习惯提供优化建议。')
      }
      return formatToolResult(`💡 博客写作优化建议:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_security_review
// =============================================================================

export const blogSecurityReviewTool = buildTool({
  name: 'blog_security_review',
  description:
    '【BlogAgent】对博客内容执行安全审查。检测 XSS 注入、敏感信息泄露（API Key/Token/密码）、外部链接风险、钓鱼内容、注入攻击模式等。返回审查报告含风险等级和修复建议',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '要审查的博客正文（Markdown 格式）',
      },
      sessionId: {
        type: 'string',
        description: '会话ID（可选）。如果提供，将使用该会话当前阶段的输出作为审查内容',
      },
      quick: {
        type: 'boolean',
        description: '是否仅检查关键/高风险问题（默认 false，检查全部）',
      },
      autoFix: {
        type: 'boolean',
        description: '是否自动修复可修复的问题（如内网IP替换），默认 false',
      },
    },
    required: [],
  },
  handler: async (args: { content?: string; sessionId?: string; quick?: boolean; autoFix?: boolean }) => {
    try {
      // 获取审查内容
      let content = args.content || ''

      if (!content && args.sessionId) {
        const session = blogAgentService.getSession(args.sessionId)
        if (session) {
          const stageOutput = session.stageOutputs[session.currentStage]
          if (stageOutput) content = stageOutput
        }
      }

      if (!content || content.trim().length < 10) {
        return formatToolError('审查内容不足。请提供博客正文或有效的会话ID')
      }

      // 执行安全审查
      const report = blogSecurityReviewer.review(content, {
        criticalOnly: args.quick ?? false,
        skipCodeBlocks: true,
      })

      // 自动修复（如果需要）
      let autoFixInfo = ''
      if (args.autoFix && !report.passed) {
        const { fixed, changes } = blogSecurityReviewer.autoFix(content)
        if (changes > 0) {
          autoFixInfo = `\n\n🔧 已自动修复 ${changes} 个问题（内网IP/路径替换）`
          if (report.overallRiskLevel !== 'info' && report.overallRiskLevel !== 'low') {
            autoFixInfo += '\n⚠️ 仍有需要手动处理的安全问题，请查看上方发现列表'
          }
          // 如果通过会话ID获取的内容，自动保存修复后的版本
          if (args.sessionId) {
            const session = blogAgentService.getSession(args.sessionId)
            if (session) {
              blogAgentService.updateStageOutput(args.sessionId, session.currentStage, fixed)
              autoFixInfo += '\n💾 修复后的内容已保存到会话'
            }
          }
        }
      }

      // 格式化输出
      const statusIcon = report.passed ? '✅' : report.overallRiskLevel === 'critical' ? '🚫' : '⚠️'
      const riskLabels: Record<string, string> = {
        info: '无风险',
        low: '低风险',
        medium: '中风险',
        high: '高风险',
        critical: '严重风险',
      }

      const lines: string[] = [
        `${statusIcon} 安全审查结果: ${riskLabels[report.overallRiskLevel]}`,
        `风险等级: ${report.overallRiskLevel.toUpperCase()}`,
        `发现总数: ${report.totalFindings}`,
        report.criticalHighCount > 0 ? `高风险及以上: ${report.criticalHighCount}` : '',
        report.passed ? '✅ 通过安全审查，可以发布' : `⛔ ${report.recommendedAction === 'block' ? '发布被阻止' : '修复后发布'}`,
        '',
      ]

      if (report.findings.length > 0) {
        lines.push('--- 安全发现 ---')
        for (const finding of report.findings) {
          const severityIcon =
            finding.riskLevel === 'critical' ? '🚫' : finding.riskLevel === 'high' ? '🔴' : finding.riskLevel === 'medium' ? '🟡' : '🟢'
          lines.push(
            `${severityIcon} [${finding.riskLevel.toUpperCase()}] ${finding.category}`,
            `  描述: ${finding.description.slice(0, 120)}`,
            `  位置: ${finding.location.snippet.slice(0, 100)}`,
            `  建议: ${finding.suggestion.slice(0, 120)}`,
            `  自动修复: ${finding.autoFixable ? '是' : '否'}`,
            '',
          )
        }
      }

      lines.push(`审查时间: ${new Date(report.timestamp).toLocaleString('zh-CN')}`)

      return formatToolResult(lines.filter(Boolean).join('\n') + autoFixInfo)
    } catch (err: any) {
      return formatToolError(`安全审查执行失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_record_performance — 登记文章发布后效果数据
// =============================================================================

export const blogRecordPerformanceTool = buildTool({
  name: 'blog_record_performance',
  description: '【BlogAgent】登记已发布博客文章的效果数据（阅读量、互动等）。用于后续分析文章表现和调整选题策略。支持单条或批量登记',
  inputJSONSchema: {
    type: 'object',
    properties: {
      postId: { type: 'string', description: '文章唯一标识' },
      title: { type: 'string', description: '文章标题' },
      platform: { type: 'string', description: '发布平台' },
      views: { type: 'number', description: '阅读量' },
      likes: { type: 'number', description: '点赞数（可选，默认0）' },
      comments: { type: 'number', description: '评论数（可选，默认0）' },
      shares: { type: 'number', description: '收藏/分享数（可选，默认0）' },
      publishedAt: { type: 'number', description: '发布时间戳（可选，默认当前时间）' },
      publishHour: { type: 'number', description: '发布小时（0-23，可选，自动从 publishedAt 提取）' },
      publishDay: { type: 'number', description: '发布星期几（0=周日，可选，自动从 publishedAt 提取）' },
      batch: {
        type: 'array',
        description: '批量登记数据（可选，提供此字段将覆盖上面的单条字段）',
        items: {
          type: 'object',
          properties: {
            postId: { type: 'string' },
            title: { type: 'string' },
            platform: { type: 'string' },
            views: { type: 'number' },
            likes: { type: 'number' },
            comments: { type: 'number' },
            shares: { type: 'number' },
            publishedAt: { type: 'number' },
          },
          required: ['postId', 'title', 'platform', 'views'],
        },
      },
    },
    required: [],
  },
  handler: async (args: {
    postId?: string
    title?: string
    platform?: string
    views?: number
    likes?: number
    comments?: number
    shares?: number
    publishedAt?: number
    publishHour?: number
    publishDay?: number
    batch?: Array<{
      postId: string
      title: string
      platform: string
      views: number
      likes?: number
      comments?: number
      shares?: number
      publishedAt?: number
    }>
  }) => {
    try {
      // 批量模式
      if (args.batch && args.batch.length > 0) {
        blogAnalyticsTracker.recordBatch(
          args.batch.map((b) => {
            const publishedAt = b.publishedAt || Date.now()
            const pubDate = new Date(publishedAt)
            return {
              postId: b.postId,
              title: b.title,
              platform: b.platform,
              views: b.views,
              likes: b.likes ?? 0,
              comments: b.comments ?? 0,
              shares: b.shares ?? 0,
              publishedAt,
              publishHour: pubDate.getHours(),
              publishDay: pubDate.getDay(),
            }
          }),
        )
        return formatToolResult(`✅ 已批量登记 ${args.batch.length} 篇文章的效果数据`)
      }

      // 单条模式
      if (!args.postId || !args.title || !args.platform || args.views === undefined) {
        return formatToolError('单条登记需要提供 postId、title、platform、views 字段，或使用 batch 批量登记')
      }

      const publishedAt = args.publishedAt || Date.now()
      const pubDate = new Date(publishedAt)

      blogAnalyticsTracker.recordPostPerformance({
        postId: args.postId,
        title: args.title,
        platform: args.platform,
        views: args.views,
        likes: args.likes ?? 0,
        comments: args.comments ?? 0,
        shares: args.shares ?? 0,
        publishedAt,
        publishHour: args.publishHour ?? pubDate.getHours(),
        publishDay: args.publishDay ?? pubDate.getDay(),
      })

      return formatToolResult(
        `✅ 已登记「${args.title}」在 ${args.platform} 的效果数据\n` +
          `阅读: ${args.views} | 点赞: ${args.likes ?? 0} | 评论: ${args.comments ?? 0} | 分享: ${args.shares ?? 0}`,
      )
    } catch (err: any) {
      return formatToolError(`登记效果数据失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_analytics_report — 生成效果分析报告
// =============================================================================

export const blogAnalyticsReportTool = buildTool({
  name: 'blog_analytics_report',
  description: '【BlogAgent】生成博客文章效果分析报告。基于已登记的效果数据，按类别、平台、发布时段汇总分析，提供数据洞察',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const report = blogAnalyticsTracker.generateReport()
      const posts = blogAnalyticsTracker.getAllPosts()

      if (posts.length === 0) {
        return formatToolResult('📭 暂无文章效果数据。发布文章后使用 blog_record_performance 登记效果数据')
      }

      const lines: string[] = [
        '📊 博客效果分析报告',
        `数据覆盖 ${report.totalPosts} 篇文章`,
        `覆盖平台: ${report.platforms.join('、') || '无'}`,
        `平均阅读: ${Math.round(report.overallAvgViews)}`,
        `平均互动率: ${(report.overallAvgEngagementRate * 100).toFixed(1)}%`,
        '',
      ]

      if (report.insights.length > 0) {
        lines.push('💡 洞察：')
        for (const insight of report.insights) {
          lines.push(`  • ${insight}`)
        }
        lines.push('')
      }

      if (report.categorySummary.length > 0) {
        lines.push('📂 按主题类别：')
        lines.push('  | 类别 | 文章数 | 平均阅读 | 互动率 | 评分 |')
        lines.push('  |------|--------|----------|--------|------|')
        for (const cat of report.categorySummary) {
          lines.push(
            `  | ${cat.category.padEnd(8)} | ${String(cat.postCount).padStart(4)}篇 | ${String(cat.avgViews).padStart(6)} | ${(cat.avgEngagementRate * 100).toFixed(1)}% | ${(cat.performanceScore * 100).toFixed(0)}分 |`,
          )
        }
        lines.push('')
      }

      if (report.platformPerformance.length > 0) {
        lines.push('🎯 按平台表现：')
        for (const pf of report.platformPerformance) {
          lines.push(`  • ${pf.platform}: ${pf.postCount}篇 | 均阅读 ${pf.avgViews} | 互动率 ${(pf.avgEngagementRate * 100).toFixed(1)}%`)
        }
        lines.push('')
      }

      if (report.bestTimeSlots.length > 0) {
        lines.push('⏰ 最佳发布时段 (Top 3)：')
        for (const slot of report.bestTimeSlots.slice(0, 3)) {
          const bar = '█'.repeat(Math.max(1, Math.round(slot.score * 10)))
          lines.push(
            `  • ${String(slot.hour).padStart(2)}:00 | ${bar} | 互动率 ${(slot.avgEngagementRate * 100).toFixed(1)}% (${slot.postCount}篇样本)`,
          )
        }
        lines.push('')
      }

      lines.push(`报告生成时间: ${new Date(report.generatedAt).toLocaleString('zh-CN')}`)
      lines.push(`数据充足: ${report.hasSufficientData ? '✅ 是' : '⚠️ 否（< 3篇文章）'}`)

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`生成分析报告失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_adjust_strategy — 基于效果数据调整选题策略
// =============================================================================

export const blogAdjustStrategyTool = buildTool({
  name: 'blog_adjust_strategy',
  description:
    '【BlogAgent】基于已登记的文章效果数据自动调整选题策略。分析哪些主题/平台/时段的文章表现更好，推荐下一步的选题方向。数据不足时返回通用推荐',
  inputJSONSchema: {
    type: 'object',
    properties: {
      plannedTopics: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，当前规划中的选题列表，用于在推荐中保留高潜力的选题',
      },
    },
    required: [],
  },
  handler: async (args: { plannedTopics?: string[] }) => {
    try {
      const strategy = blogAnalyticsTracker.adjustStrategy(args.plannedTopics)

      if (!strategy.dataDriven) {
        return formatToolResult(
          `📋 选题策略（默认推荐）\n\n` +
            `数据不足，无法进行数据驱动的策略调整。\n` +
            `至少需要 3 篇已登记效果数据的文章。\n\n` +
            `💡 默认推荐选题方向：\n${strategy.recommendedTopics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}\n\n` +
            `📝 建议：完成文章发布后使用 blog_record_performance 登记效果数据`,
        )
      }

      const lines: string[] = ['📋 选题策略调整（数据驱动）', strategy.summary, '']

      if (strategy.recommendedTopics.length > 0) {
        lines.push('✅ 推荐选题（按优先级）：')
        for (let i = 0; i < strategy.recommendedTopics.length; i++) {
          const adj = strategy.adjustments.find((a) => a.topic === strategy.recommendedTopics[i])
          if (adj) {
            const dirLabel = adj.direction === 'double_down' ? '📈 加大投入' : adj.direction === 'explore' ? '🔍 探索' : '🔄 调整'
            lines.push(`  ${i + 1}. ${strategy.recommendedTopics[i]} [${dirLabel}]`)
            lines.push(`     理由: ${adj.reason}`)
          } else {
            lines.push(`  ${i + 1}. ${strategy.recommendedTopics[i]}`)
          }
        }
        lines.push('')
      }

      if (strategy.avoidTopics.length > 0) {
        lines.push('❌ 建议避免的选题：')
        for (const t of strategy.avoidTopics) {
          lines.push(`  • ${t}`)
        }
        lines.push('')
      }

      if (strategy.adjustments.length > 0) {
        lines.push('📊 详细调整建议：')
        for (const adj of strategy.adjustments) {
          const dirLabel =
            adj.direction === 'double_down'
              ? '📈加大投入'
              : adj.direction === 'explore'
                ? '🔍探索'
                : adj.direction === 'shift'
                  ? '🔄调整方向'
                  : '📉减少'
          lines.push(`  [${dirLabel}] ${adj.topic}`)
          lines.push(`    ${adj.reason}`)
          lines.push(`    预期: ${adj.expectedOutcome}`)
          lines.push('')
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`调整策略失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

export const blogSetModeTool = buildTool({
  name: 'blog_set_mode',
  description:
    '【BlogAgent】设置博客写作的执行模式。MCP 模式适合简单/交互式写作，Plan:推理链模式适合复杂/自动化写作。切换时自动保存当前状态，保证无缝过渡',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话ID',
      },
      mode: {
        type: 'string',
        enum: ['mcp', 'plan_chain'],
        description: '目标模式：mcp（交互式，逐步骤确认）或 plan_chain（推理链，自动化流水线）',
      },
      reason: {
        type: 'string',
        description: '切换原因（可选，用于审计日志）',
      },
      force: {
        type: 'boolean',
        description: '是否强制切换，忽略冷却时间（可选，默认 false）',
      },
    },
    required: ['sessionId', 'mode'],
  },
  handler: async (args: { sessionId: string; mode: 'mcp' | 'plan_chain'; reason?: string; force?: boolean }) => {
    try {
      const { getBlogModeService } = await import('@akemi-mio/capabilities/tool/deps')
      const svc = getBlogModeService()
      if (!svc) return formatToolError('BlogModeService 未初始化')

      const result = await svc.switchMode({
        sessionId: args.sessionId,
        targetMode: args.mode,
        reason: args.reason || '用户主动切换',
        force: args.force ?? false,
      })

      if (result.success) {
        const lines: string[] = [
          `✅ 模式切换成功`,
          `从: ${args.mode === 'mcp' ? 'Plan:推理链' : 'MCP'} → 到: ${args.mode === 'mcp' ? 'MCP' : 'Plan:推理链'}`,
          result.snapshotId ? `快照ID: ${result.snapshotId}` : '',
          `耗时: ${result.durationMs}ms`,
        ]
        if (result.warnings.length > 0) {
          lines.push(``, '⚠️ 警告:')
          for (const w of result.warnings) lines.push(`  - ${w}`)
        }
        return formatToolResult(lines.filter(Boolean).join('\n'))
      }

      return formatToolError(`切换失败: ${result.error || '未知错误'}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_get_mode
// =============================================================================

export const blogGetModeTool = buildTool({
  name: 'blog_get_mode',
  description: '【BlogAgent】查看当前博客写作的执行模式状态，包括当前模式、模式推荐、切换历史等',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话ID（可选）。不传则查看全局模式配置',
      },
    },
    required: [],
  },
  handler: async (args: { sessionId?: string }) => {
    try {
      const { getBlogModeService } = await import('@akemi-mio/capabilities/tool/deps')
      const svc = getBlogModeService()
      if (!svc) return formatToolError('BlogModeService 未初始化')

      if (args.sessionId) {
        const report = svc.getModeReport(args.sessionId)
        const stats = svc.getStats()
        const lines: string[] = [
          `📋 博客模式状态报告`,
          ``,
          `当前会话模式: ${report.currentMode === 'mcp' ? 'MCP交互模式' : 'Plan推理链模式'}`,
          `全局默认模式: ${report.defaultMode === 'mcp' ? 'MCP交互模式' : 'Plan推理链模式'}`,
          `保存的快照数: ${report.snapshotCount}`,
          `全局 MCP 会话: ${stats.sessionsByMode.mcp ?? 0}`,
          `全局 Plan 会话: ${stats.sessionsByMode.plan_chain ?? 0}`,
          `历史切换次数: ${stats.totalSwitches}`,
        ]

        if (report.recentSwitches.length > 0) {
          lines.push(``, '🔄 最近切换:')
          for (const entry of report.recentSwitches.slice(-5)) {
            const time = new Date(entry.timestamp).toLocaleString('zh-CN')
            const from = entry.fromMode === 'mcp' ? 'MCP' : 'Plan:推理链'
            const to = entry.toMode === 'mcp' ? 'MCP' : 'Plan:推理链'
            lines.push(`  ${time}: ${from} → ${to} (${entry.success ? '成功' : '失败'})`)
          }
        }

        return formatToolResult(lines.join('\n'))
      }

      // 全局模式配置
      const stats = svc.getStats()
      const lines: string[] = [
        `📋 博客双模式系统状态`,
        ``,
        `全局默认模式: ${svc.getDefaultMode() === 'mcp' ? 'MCP交互模式' : 'Plan推理链模式'}`,
        `活跃会话分布:`,
        `  MCP模式: ${stats.sessionsByMode.mcp ?? 0} 个会话`,
        `  Plan推理链模式: ${stats.sessionsByMode.plan_chain ?? 0} 个会话`,
        `历史切换总次数: ${stats.totalSwitches}`,
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const blogListSessionsTool = buildTool({
  name: 'blog_list_sessions',
  description: '【BlogAgent】列出所有活跃的博客写作会话。查看当前有哪些进行中的写作任务',
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

