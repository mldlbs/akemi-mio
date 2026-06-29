import { existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { buildTool, formatToolResult, formatToolError } from '../types';
import { resolveWorkspace, stripWorkspaceLabelPrefix } from '../utils/workspace';
export const listFilesTool = buildTool({
    name: 'list_files',
    description: '列出目录中的文件。不传 workspace 则浏览项目根目录。指定 workspace 可在工作区内浏览。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '目录路径，相对于对应 workspace 根目录。浏览进化工作区请传如 "sandbox" 并指定 workspace="evolution"',
            },
            workspace: {
                type: 'string',
                description: '目标工作区，"mcp"（沙箱）、"evolution"（进化工作区）、"project"（默认，项目根目录）',
            },
        },
        required: ['path'],
    },
    handler: async (args) => {
        try {
            if (typeof args.path !== 'string')
                throw new Error('path 参数必须为字符串');
            const base = resolveWorkspace(args.workspace || 'project');
            const cleanPath = args.workspace ? stripWorkspaceLabelPrefix(args.path, args.workspace) : args.path;
            const fullPath = resolve(base, cleanPath);
            if (!fullPath.startsWith(base))
                throw new Error(`路径 ${args.path} 超出工作区目录`);
            // Auto-create workspace root if it doesn't exist (so "list_files ." works on fresh workspaces)
            if (cleanPath === '.' && !existsSync(fullPath)) {
                mkdirSync(fullPath, { recursive: true });
            }
            if (!existsSync(fullPath))
                throw new Error(`目录不存在: ${args.path}`);
            const entries = readdirSync(fullPath, { withFileTypes: true });
            const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name + '/');
            const files = entries.filter((e) => e.isFile()).map((e) => e.name);
            const result = [...dirs, ...files].join('\n');
            return formatToolResult(result);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
