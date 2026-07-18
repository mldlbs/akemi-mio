import { existsSync, readFileSync, statSync } from 'fs'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { inferWorkspace, safeWorkspacePath, wsLabel } from '../utils/workspace'

export const readFileTool = buildTool({
  name: 'read_file',
  description: '读取项目文件内容',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对于工作区根目录' },
      workspace: {
        type: 'string',
        enum: ['project', 'evolution'],
        description: '工作区：project=项目源码, evolution=进化工作区（默认根据路径自动推断）',
      },
    },
    required: ['path'],
  },
  handler: async (args: { path: string; workspace?: string }) => {
    try {
      if (!args.path) throw new Error('path 参数缺失')
      const ws = args.workspace || inferWorkspace(args.path)
      const p = safeWorkspacePath(args.path, ws)
      if (!existsSync(p)) throw new Error(`路径不存在: ${wsLabel(ws)}/${args.path}`)
      if (statSync(p).isDirectory()) throw new Error(`路径是目录，不是文件: ${wsLabel(ws)}/${args.path}`)
      const result = readFileSync(p, 'utf-8')
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
