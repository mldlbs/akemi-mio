import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { inferWorkspace, safeWorkspacePath, wsLabel } from '@akemi-mio/capabilities/tool/utils/workspace'
import { isCustomProjectRootConfigured } from '@akemi-mio/core/workspace/project-root'

export const writeFileTool = buildTool({
  name: 'write_file',
  description:
    '写入文件到工作区。重要：必须使用子目录路径。正确: "my-server/src/index.ts"。错误: "index.ts"。workspace="project" 可直接写项目源码（用于 bug 修复），workspace="evolution" 写进化分析/实验代码，默认 workspace="mcp" 写 MCP 服务器沙箱。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对于目标 workspace 根目录。如 "my-server/src/index.ts"' },
      content: { type: 'string', description: '文件内容' },
      workspace: {
        type: 'string',
        description: '目标工作区，"mcp"（默认，沙箱）、"evolution"（进化工作区）、"project"（项目源码根目录）',
      },
    },
    required: ['path', 'content'],
  },
  handler: async (args: { path: string; content: string; workspace?: string }) => {
    try {
      if (!args.path) throw new Error('path 参数缺失')
      const ws = inferWorkspace(args.path, args.workspace)
      const p = safeWorkspacePath(args.path, ws)
      const label = wsLabel(ws)
      // 强制要求子目录：路径必须包含目录分隔符
      if (!args.path.includes('/') && !args.path.includes('\\')) {
        return formatToolError(`不能直接写入 ${label} 根目录。请在路径前加项目子目录名，如 "my-server/${args.path}"`)
      }
      // 硬阻断：project workspace 下禁止写入根级文件
      if (ws === 'project' && !isCustomProjectRootConfigured()) {
        const cleanPath = args.path.replace(/^[./\\]+/, '')
        if (!cleanPath.includes('/') && !cleanPath.includes('\\')) {
          return formatToolError(
            `禁止在项目源码根目录写文件「${args.path}」。代码写入 projects/ 下，临时文件写入 evolution_workspace/tmp/。`,
          )
        }
        // project 工作区禁止写 .txt/.json/.log 临时文件
        const ext = cleanPath.split('.').pop()?.toLowerCase()
        if (ext && ['txt', 'json', 'log', 'tmp', 'out'].includes(ext)) {
          return formatToolError(`禁止在 projects/ 目录写 .${ext} 临时文件「${args.path}」。请写入 evolution_workspace/tmp/。`)
        }
      }
      const dir = dirname(p)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, args.content, 'utf-8')
      return formatToolResult(`已写入 ${label}/${args.path}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})


