import { buildTool, formatToolResult, formatToolError } from '../types';
import { getCredentialsManager } from '../deps';
export const getCredentialTool = buildTool({
    name: 'get_credential',
    description: '读取已保存的 API 密钥或凭据。如果返回未配置，请告知用户需要注册什么服务',
    inputJSONSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '凭据名称，如 netease_api_key, qq_music_appid' },
        },
        required: ['name'],
    },
    handler: async (args) => {
        try {
            const cm = getCredentialsManager();
            if (!cm)
                return formatToolError('凭据管理器尚未就绪');
            const value = cm.get(args.name);
            if (value === null) {
                return formatToolResult(`凭据 "${args.name}" 未配置。请在回复中告知用户需要注册什么服务并提供指引。`);
            }
            return formatToolResult(value);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
export const setCredentialTool = buildTool({
    name: 'set_credential',
    description: '保存用户提供的 API 密钥或凭据。仅当用户明确告诉你密钥内容时才调用',
    inputJSONSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '凭据名称' },
            value: { type: 'string', description: '凭据值' },
        },
        required: ['name', 'value'],
    },
    handler: async (args) => {
        try {
            const cm = getCredentialsManager();
            if (!cm)
                return formatToolError('凭据管理器尚未就绪');
            cm.set(args.name, String(args.value));
            return formatToolResult(`凭据 "${args.name}" 已保存`);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: false,
});
export const listCredentialsTool = buildTool({
    name: 'list_credentials',
    description: '列出所有已配置的凭据名称（不显示值）',
    inputJSONSchema: {
        type: 'object',
        properties: {},
        required: [],
    },
    handler: async () => {
        try {
            const cm = getCredentialsManager();
            if (!cm)
                return formatToolError('凭据管理器尚未就绪');
            const keys = cm.list();
            if (keys.length === 0)
                return formatToolResult('暂无已配置的凭据');
            return formatToolResult(keys.join('\n'));
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
