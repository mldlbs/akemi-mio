import { existsSync, readFileSync, statSync } from 'fs';
import { buildTool, formatToolResult, formatToolError } from '../types';
import { inferWorkspace, safeWorkspacePath, wsLabel } from '../utils/workspace';
export const readFileTool = buildTool({
    name: 'read_file',
    description: '读取项目文件内容',
    inputJSONSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径，相对于项目根目录' },
        },
        required: ['path'],
    },
    handler: async (args) => {
        try {
            if (!args.path)
                throw new Error('path 参数缺失');
            const ws = inferWorkspace(args.path);
            const p = safeWorkspacePath(args.path, ws);
            if (!existsSync(p))
                throw new Error(`路径不存在: ${wsLabel(ws)}/${args.path}`);
            if (statSync(p).isDirectory())
                throw new Error(`路径是目录，不是文件: ${wsLabel(ws)}/${args.path}`);
            const result = readFileSync(p, 'utf-8');
            return formatToolResult(result);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
