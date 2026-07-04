import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCognitiveService } from '../deps'

export const createGoalTool = buildTool({
  name: 'create_goal',
  description: '创建一个新目标。category: mission(使命)/long_term(长期)/short_term(短期)/initiative(行动项)',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '目标标题' },
      description: { type: 'string', description: '目标描述' },
      priority: { type: 'number', description: '优先级 0-10，越高越优先' },
      category: {
        type: 'string',
        enum: ['mission', 'long_term', 'short_term', 'initiative'],
        description: '目标类别',
      },
      status: {
        type: 'string',
        enum: ['active', 'paused'],
        description: '初始状态，默认 active',
      },
    },
    required: ['title', 'category'],
  },
  handler: async (args: {
    title: string
    description?: string
    priority?: number
    category: 'mission' | 'long_term' | 'short_term' | 'initiative'
    status?: 'active' | 'paused'
  }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      const goal = cs.goals.create({
        title: args.title,
        description: args.description || '',
        priority: args.priority ?? 5,
        category: args.category,
        status: args.status || 'active',
        parentGoalId: null,
      })
      return formatToolResult(`目标已创建: [${goal.category}] ${goal.title} (ID: ${goal.id})`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listGoalsTool = buildTool({
  name: 'list_goals',
  description: '列出目标，可按状态和类别筛选',
  inputJSONSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'abandoned'],
        description: '按状态筛选',
      },
      category: {
        type: 'string',
        enum: ['mission', 'long_term', 'short_term', 'initiative'],
        description: '按类别筛选',
      },
    },
    required: [],
  },
  handler: async (args: { status?: string; category?: string }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')

      const db = (await import('../../db/connection')).getRawDb()
      const conditions: string[] = []
      const params: any[] = []
      if (args.status) {
        conditions.push('status = ?')
        params.push(args.status)
      }
      if (args.category) {
        conditions.push('category = ?')
        params.push(args.category)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = db.exec(`SELECT * FROM goals ${where} ORDER BY priority DESC, created_at DESC`)[0]
      if (!rows || !rows.values.length) return formatToolResult('暂无目标')

      const lines = rows.values.map((v: any[]) => {
        const cols = rows.columns
        const idx = (n: string) => cols.indexOf(n)
        const bar = '█'.repeat(Math.floor(Number(v[idx('progress')]) / 10)) + '░'.repeat(10 - Math.floor(Number(v[idx('progress')]) / 10))
        return `[${v[idx('category')]}] ${v[idx('title')]} | ${v[idx('status')]} | ${v[idx('progress')]}% ${bar} | 优先级:${v[idx('priority')]}`
      })
      return formatToolResult(`【目标列表】\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const updateGoalTool = buildTool({
  name: 'update_goal',
  description: '更新目标进度或状态',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '目标 ID' },
      progress: { type: 'number', description: '进度增量 0-100（累加）' },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'abandoned'],
        description: '新状态',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string; progress?: number; status?: string }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      if (typeof args.progress === 'number') {
        cs.goals.updateProgress(args.id, args.progress)
      }
      if (args.status) {
        cs.goals.setStatus(args.id, args.status as any)
      }
      return formatToolResult(`目标 ${args.id} 已更新`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
