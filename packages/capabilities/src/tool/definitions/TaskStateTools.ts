import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'

// ===== save_task_state — 保存当前任务状态 =====

export const saveTaskStateTool = buildTool({
  name: 'save_task_state',
  description: '保存当前任务进度，以便下次对话恢复。当执行多步骤任务时，每完成一步或暂停时调用。系统会自动追踪任务ID、步骤进度和中间结果',
  inputJSONSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '唯一任务ID，同一任务多次调用会覆盖更新' },
      title: { type: 'string', description: '简短任务标题，如"修复TypeScript编译错误"' },
      description: { type: 'string', description: '任务详细描述，单句话说明目标' },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'abandoned'],
        description: '任务当前状态',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: '步骤描述' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: '步骤状态' },
            result: { type: 'string', description: '步骤结果摘要（可选）' },
          },
          required: ['description', 'status'],
        },
        description: '步骤列表，至少包含一个步骤',
      },
      lastStepIndex: { type: 'number', description: '当前进行到的步骤索引（0-based）' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表，如["bug", "typescript", "refactor"]',
      },
    },
    required: ['taskId', 'title', 'description', 'status', 'steps', 'lastStepIndex'],
  },
  handler: async (args: {
    taskId: string
    title: string
    description: string
    status: 'active' | 'paused' | 'completed' | 'abandoned'
    steps: Array<{ description: string; status: string; result?: string }>
    lastStepIndex: number
    tags?: string[]
  }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const steps = (args.steps || []).map((s) => ({
        description: String(s.description),
        status: (s.status as 'pending' | 'in_progress' | 'completed' | 'failed') || 'pending',
        result: s.result ? String(s.result) : undefined,
        completedAt: s.status === 'completed' ? Date.now() : undefined,
      }))

      const data = {
        taskId: String(args.taskId),
        title: String(args.title),
        description: String(args.description),
        status: args.status,
        steps,
        lastStepIndex: Number(args.lastStepIndex),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionIds: [],
        tags: (args.tags || []).map(String),
      }

      if (data.status === 'completed') {
        ms.markTaskComplete(data.taskId)
        return formatToolResult(`任务「${data.title}」已标记完成`)
      }

      if (data.status === 'abandoned') {
        ms.markTaskAbandoned(data.taskId)
        return formatToolResult(`任务「${data.title}」已放弃`)
      }

      ms.saveTaskState(data)

      const stepStats = steps.filter((s) => s.status === 'completed').length
      return formatToolResult(
        `已保存任务「${data.title}」(${data.status === 'paused' ? '已暂停' : '进行中'}, ${stepStats}/${steps.length} 步已完成)`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ===== query_tasks — 查询未完成任务 =====

export const queryTasksTool = buildTool({
  name: 'query_tasks',
  description: '查询未完成的任务列表，用于对话开始时恢复上次的工作。返回任务ID、标题、进度、上次更新时间等信息',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const unfinished = ms.getUnfinishedTasks()
      if (unfinished.length === 0) {
        return formatToolResult('当前没有未完成的任务。')
      }

      const lines = unfinished.map((t) => {
        const completedSteps = t.steps.filter((s) => s.status === 'completed').length
        const totalSteps = t.steps.length
        const nextStep = t.steps.find((s) => s.status === 'pending' || s.status === 'in_progress')
        let line = `- [${t.taskId}] ${t.title} (${t.status === 'paused' ? '已暂停' : '进行中'}, ${completedSteps}/${totalSteps} 步)`
        if (nextStep) line += `\n  下一步: ${nextStep.description.slice(0, 80)}`
        line += `\n  上次更新: ${new Date(t.updatedAt).toLocaleString('zh-CN')}`
        if (t.tags.length > 0) line += `\n  标签: ${t.tags.join(', ')}`
        return line
      })

      return formatToolResult(`未完成的任务（共 ${unfinished.length} 个）：\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ===== save_user_preference — 保存用户偏好 =====

export const saveUserPreferenceTool = buildTool({
  name: 'save_user_preference',
  description: '保存用户的个人偏好到记忆系统。当用户透露了风格、语言、详略度等偏好时主动调用，用于跨对话保持一致的交互体验',
  inputJSONSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '偏好标识，如"response_style"、"language_level"、"detail_preference"' },
      value: { type: 'string', description: '偏好内容，如"简洁直接"、"中文为主"、"详细解释每一步"' },
      category: {
        type: 'string',
        enum: ['style', 'detail', 'language', 'preference', 'identity', 'other'],
        description: '偏好分类：style=风格, detail=详略, language=语言, preference=偏好, identity=身份, other=其他',
      },
      confidence: { type: 'number', description: '确信度 0-1，默认 0.8' },
      source: { type: 'string', description: '来源描述，如"用户明确要求"、"对话推断"、"历史记录"' },
    },
    required: ['key', 'value', 'category'],
  },
  handler: async (args: {
    key: string
    value: string
    category: 'style' | 'detail' | 'language' | 'preference' | 'identity' | 'other'
    confidence?: number
    source?: string
  }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      ms.saveUserPreference({
        key: String(args.key),
        value: String(args.value),
        confidence: typeof args.confidence === 'number' ? args.confidence : 0.8,
        category: args.category || 'other',
        source: String(args.source || '对话记录'),
        updatedAt: Date.now(),
      })

      return formatToolResult(`已记住用户偏好: ${args.key} = ${args.value.slice(0, 60)}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ===== get_user_preferences — 获取用户画像 =====

export const getUserPreferencesTool = buildTool({
  name: 'get_user_preferences',
  description: '获取已保存的用户画像和偏好信息。在对话开始时自动调用，帮助了解用户习惯和偏好',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const prefs = ms.getUserPreferences()
      if (prefs.length === 0) {
        return formatToolResult('尚未记录任何用户偏好。')
      }

      const byCat: Record<string, string[]> = {}
      for (const p of prefs) {
        if (!byCat[p.category]) byCat[p.category] = []
        byCat[p.category].push(`${p.key}: ${p.value} (置信度${p.confidence.toFixed(1)})`)
      }

      const labels: Record<string, string> = {
        style: '风格',
        detail: '详略',
        language: '语言',
        preference: '偏好',
        identity: '身份',
        other: '其他',
      }

      const lines = [`用户画像（共 ${prefs.length} 条）：`]
      for (const [cat, items] of Object.entries(byCat)) {
        lines.push(`- ${labels[cat] || cat}: ${items.join('; ')}`)
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

