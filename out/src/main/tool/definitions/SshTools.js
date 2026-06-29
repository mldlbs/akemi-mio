import { buildTool, formatToolResult, formatToolError } from '../types';
import { sshExec, sshReadFile, sshWriteFile, sshGrep, sshSearchFiles } from '../utils/sshClient';
export const centosExecTool = buildTool({
    name: 'centos_exec',
    description: '通过 SSH 在远程 CentOS 服务器上执行 shell 命令。需要先在凭据中配置 centos_host、centos_user、centos_password 或 centos_ssh_key。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: '要执行的远程命令' },
            timeout: { type: 'number', description: '超时秒数，默认 60' },
        },
        required: ['command'],
    },
    handler: async (args) => {
        try {
            const result = await sshExec(undefined, args.command, (args.timeout ?? 60) * 1000);
            return formatToolResult(result || '命令执行完成（无输出）');
        }
        catch (err) {
            return formatToolError(`远程命令执行失败: ${err.message}`);
        }
    },
    isReadOnly: false,
});
export const centosReadFileTool = buildTool({
    name: 'centos_read_file',
    description: '通过 SSH 读取远程 CentOS 服务器上的文件内容。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '远程文件路径，如 /var/log/nginx/access.log' },
        },
        required: ['path'],
    },
    handler: async (args) => {
        try {
            const result = await sshReadFile(args.path);
            return formatToolResult(result);
        }
        catch (err) {
            return formatToolError(`远程读取文件失败: ${err.message}`);
        }
    },
    isReadOnly: true,
});
export const centosWriteFileTool = buildTool({
    name: 'centos_write_file',
    description: '通过 SFTP 向远程 CentOS 服务器写入或上传文件。会覆盖已存在的文件。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '远程文件路径，如 /etc/nginx/nginx.conf' },
            content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
    },
    handler: async (args) => {
        try {
            await sshWriteFile(args.path, args.content);
            return formatToolResult(`成功写入远程文件: ${args.path}`);
        }
        catch (err) {
            return formatToolError(`远程写入文件失败: ${err.message}`);
        }
    },
    isReadOnly: false,
});
export const centosGrepTool = buildTool({
    name: 'centos_grep',
    description: '在远程 CentOS 服务器上搜索文件内容（grep -rn）。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '搜索模式' },
            path: { type: 'string', description: '搜索路径（默认当前目录）' },
        },
        required: ['pattern'],
    },
    handler: async (args) => {
        try {
            const result = await sshGrep(args.pattern, args.path);
            return formatToolResult(result);
        }
        catch (err) {
            return formatToolError(`远程搜索失败: ${err.message}`);
        }
    },
    isReadOnly: true,
});
export const centosSearchFilesTool = buildTool({
    name: 'centos_search_files',
    description: '在远程 CentOS 服务器上搜索文件名（find -name glob）。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '文件名模式，如 "*.log"、"nginx*"' },
        },
        required: ['pattern'],
    },
    handler: async (args) => {
        try {
            const result = await sshSearchFiles(args.pattern);
            return formatToolResult(result);
        }
        catch (err) {
            return formatToolError(`远程文件搜索失败: ${err.message}`);
        }
    },
    isReadOnly: true,
});
