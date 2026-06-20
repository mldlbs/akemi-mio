import { existsSync, readFileSync, writeFileSync } from 'fs'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { inferWorkspace, safeWorkspacePath, wsLabel } from '../utils/workspace'

export const editFileTool = buildTool({
  name: 'edit_file',
  description: '在 workspace 内的文件中替换文本。workspace="project" 可修改项目源码。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对于目标 workspace 根目录' },
      old_string: { type: 'string', description: '被替换的文本' },
      new_string: { type: 'string', description: '替换后的新文本' },
      workspace: { type: 'string', description: '目标工作区，"mcp"（默认）、"evolution"、"project"' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  handler: async (args: { path: string; old_string: string; new_string: string; workspace?: string }) => {
    try {
      if (!args.path) throw new Error('path 参数缺失')
      const ws = inferWorkspace(args.path, args.workspace)
      const p = safeWorkspacePath(args.path, ws)
      const label = wsLabel(ws)
      // 硬阻断：禁止编辑项目根目录的根级文件
      if (ws === 'project') {
        const cleanPath = args.path.replace(/^[.\/\\]+/, '')
        if (!cleanPath.includes('/') && !cleanPath.includes('\\')) {
          throw new Error(`禁止编辑项目根目录文件「${args.path}」。`)
        }
      }
      if (!existsSync(p)) throw new Error(`路径不存在: ${label}/${args.path}`)
      const content = readFileSync(p, 'utf-8')
      if (!content.includes(args.old_string)) throw new Error(`未在 ${label}/${args.path} 中找到匹配的文本`)
      writeFileSync(p, content.replace(args.old_string, args.new_string), 'utf-8')
      return formatToolResult(`已更新 ${label}/${args.path}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
