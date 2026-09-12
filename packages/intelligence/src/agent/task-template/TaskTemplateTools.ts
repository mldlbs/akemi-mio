/**
 * TaskTemplateTools — 任务模板管理工具
 *
 * 提供给 Agent 使用的工具，用于查看、创建、编辑、删除和运行任务模板。
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { taskTemplateRegistry } from './TaskTemplateRegistry'
import { type TaskTemplate, type TemplateStep } from './types'

// =============================================================================
// 辅助
// =============================================================================

/** 格式化单个模板为可读文本 */
function formatTemplate(t: TaskTemplate): string {
  const keywordStr = t.triggerKeywords.length > 0 ? `触发关键词: ${t.triggerKeywords.join(', ')}` : '无触发关键词'

  const toolSteps = t.toolSequence.map((s, i) => `  ${i + 1}. ${s.toolName}${s.description ? ' - ' + s.description : ''}`).join('\n')

  const successRate = t.useCount > 0 ? ` (成功率: ${((t.successCount / t.useCount) * 100).toFixed(0)}%)` : ''

  const lastUsed = t.lastUsedAt ? `\n  最近使用: ${new Date(t.lastUsedAt).toLocaleString('zh-CN')}` : ''

  return (
    `📋 ${t.name} [${t.source === 'auto' ? '自动发现' : t.source === 'user' ? '用户创建' : '用户编辑'}]\n` +
    `  ID: ${t.id}\n` +
    `  描述: ${t.description}\n` +
    `  ${keywordStr}\n` +
    `  使用: ${t.useCount} 次${successRate}${lastUsed}\n` +
    `  工具序列:\n${toolSteps}`
  )
}

// =============================================================================
// 工具: list_task_templates
// =============================================================================

export const listTaskTemplatesTool = buildTool({
  name: 'list_task_templates',
  description: '列出所有已保存的任务模板。支持按名称/关键词搜索。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '可选的搜索关键词，按名称/描述/触发关键词过滤',
      },
      status: {
        type: 'string',
        enum: ['active', 'disabled', 'archived'],
        description: '按状态筛选，默认全部',
      },
      includeAutoDiscovery: {
        type: 'boolean',
        description: '是否包含自动发现的模板（默认 true）',
      },
    },
    required: [],
  },
  handler: async (args: { query?: string; status?: string; includeAutoDiscovery?: boolean }) => {
    try {
      let templates: TaskTemplate[]

      if (args.query) {
        templates = taskTemplateRegistry.searchTemplates(args.query)
      } else if (args.status) {
        templates = taskTemplateRegistry.getAllTemplates(args.status as any)
      } else {
        templates = taskTemplateRegistry.getAllTemplates()
      }

      // 过滤
      if (args.includeAutoDiscovery === false) {
        templates = templates.filter((t) => t.source !== 'auto')
      }

      if (templates.length === 0) {
        return formatToolResult('暂无已保存的任务模板。')
      }

      const lines = [`找到 ${templates.length} 个任务模板:\n`, ...templates.map((t, i) => `${i + 1}. ${formatTemplate(t)}`)]

      return formatToolResult(lines.join('\n\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具: create_task_template
// =============================================================================

export const createTaskTemplateTool = buildTool({
  name: 'create_task_template',
  description: '创建新的任务模板。手动定义模板名称、触发关键词和工具序列。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '模板名称（简短描述性，如"代码调试-读改搜"）',
      },
      description: {
        type: 'string',
        description: '模板详细描述',
      },
      triggerKeywords: {
        type: 'array',
        items: { type: 'string' },
        description: '触发关键词列表（用户消息包含任意关键词即可能匹配）',
      },
      toolSequence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: '工具名称' },
            argsTemplate: { type: 'string', description: '可选参数模板' },
            description: { type: 'string', description: '可选步骤描述' },
          },
          required: ['toolName'],
        },
        description: '工具调用序列（有序）',
      },
    },
    required: ['name', 'toolSequence'],
  },
  handler: async (args: {
    name: string
    description?: string
    triggerKeywords?: string[]
    toolSequence: Array<{ toolName: string; argsTemplate?: string; description?: string }>
  }) => {
    try {
      if (!args.name || args.name.trim().length === 0) {
        return formatToolError('模板名称不能为空')
      }

      const tmpl = taskTemplateRegistry.createTemplate({
        name: args.name.trim(),
        description: args.description || `用户创建的模板: ${args.name}`,
        triggerKeywords: args.triggerKeywords || [],
        toolSequence: args.toolSequence as TemplateStep[],
        source: 'user',
        status: 'active',
        useCount: 0,
        successCount: 0,
        lastUsedAt: null,
      })

      return formatToolResult(`任务模板已创建:\n${formatTemplate(tmpl)}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具: edit_task_template
// =============================================================================

export const editTaskTemplateTool = buildTool({
  name: 'edit_task_template',
  description: '编辑已有任务模板。可更新名称、描述、触发关键词、工具序列或状态。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '模板 ID',
      },
      name: {
        type: 'string',
        description: '新的模板名称',
      },
      description: {
        type: 'string',
        description: '新的模板描述',
      },
      triggerKeywords: {
        type: 'array',
        items: { type: 'string' },
        description: '新的触发关键词列表',
      },
      toolSequence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            toolName: { type: 'string' },
            argsTemplate: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['toolName'],
        },
        description: '新的工具调用序列',
      },
      status: {
        type: 'string',
        enum: ['active', 'disabled', 'archived'],
        description: '新的状态',
      },
    },
    required: ['id'],
  },
  handler: async (args: {
    id: string
    name?: string
    description?: string
    triggerKeywords?: string[]
    toolSequence?: Array<{ toolName: string; argsTemplate?: string; description?: string }>
    status?: 'active' | 'disabled' | 'archived'
  }) => {
    try {
      const updates: Partial<Omit<TaskTemplate, 'id' | 'createdAt'>> = {}

      if (args.name !== undefined) updates.name = args.name.trim()
      if (args.description !== undefined) updates.description = args.description
      if (args.triggerKeywords !== undefined) updates.triggerKeywords = args.triggerKeywords
      if (args.toolSequence !== undefined) updates.toolSequence = args.toolSequence as TemplateStep[]
      if (args.status !== undefined) updates.status = args.status

      // 用户编辑自动生成的模板 → 标记为 edited
      const existing = taskTemplateRegistry.getTemplate(args.id)
      if (existing && existing.source === 'auto') {
        updates.source = 'edited'
      }

      const updated = taskTemplateRegistry.updateTemplate(args.id, updates)
      if (!updated) {
        return formatToolError(`模板 ${args.id} 不存在`)
      }

      return formatToolResult(`模板已更新:\n${formatTemplate(updated)}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具: delete_task_template
// =============================================================================

export const deleteTaskTemplateTool = buildTool({
  name: 'delete_task_template',
  description: '删除指定任务模板。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '模板 ID',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string }) => {
    try {
      const deleted = taskTemplateRegistry.deleteTemplate(args.id)
      if (!deleted) {
        return formatToolError(`模板 ${args.id} 不存在`)
      }
      return formatToolResult(`模板已删除 (ID: ${args.id})`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具: run_task_template
// =============================================================================

export const runTaskTemplateTool = buildTool({
  name: 'run_task_template',
  description: '执行指定任务模板。Agent 将按照模板定义的工具序列依次执行任务。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '模板 ID',
      },
      modifyPrompt: {
        type: 'string',
        description: '可选的自定义提示，说明如何调整模板执行（如修改某个步骤的参数）',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string; modifyPrompt?: string }) => {
    try {
      const tmpl = taskTemplateRegistry.getTemplate(args.id)
      if (!tmpl) {
        return formatToolError(`模板 ${args.id} 不存在`)
      }

      // 构建执行指令给 Agent
      const toolSteps = tmpl.toolSequence
        .map((s, i) => `${i + 1}. 调用 \`${s.toolName}\`${s.description ? ' - ' + s.description : ''}`)
        .join('\n')

      const modifyNote = args.modifyPrompt ? `\n\n用户修改说明: ${args.modifyPrompt}` : ''

      // 记录使用
      taskTemplateRegistry.recordUse(tmpl.id, true)

      return formatToolResult(
        `正在执行模板「${tmpl.name}」...\n\n` +
          `执行计划:\n${toolSteps}` +
          modifyNote +
          `\n\n请按照模板定义的工具序列依次执行。完成后请告知执行结果。`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
