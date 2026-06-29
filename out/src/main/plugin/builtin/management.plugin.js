import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { toolRegistry } from '../registry';
import { WORKSPACE_ROOT } from '../../config';
function getPluginsDir() {
    const dir = join(WORKSPACE_ROOT, 'plugins');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function sanitizePluginName(name) {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    if (!sanitized)
        throw new Error('插件名称无效，仅允许字母、数字、下划线和连字符');
    return sanitized;
}
function createPlugin(name, content) {
    const safeName = sanitizePluginName(name);
    const filename = `${safeName}.plugin.js`;
    const targetPath = join(getPluginsDir(), filename);
    if (existsSync(targetPath)) {
        throw new Error(`插件 ${filename} 已存在，如需更新请先删除旧文件`);
    }
    if (!content.includes('manifest') || !content.includes('handle')) {
        throw new Error('插件内容缺少 manifest 或 handle 字段，请提供完整的 Plugin 对象');
    }
    writeFileSync(targetPath, content, 'utf-8');
    return `插件已创建: ${filename}\n文件路径: ${targetPath}\n系统将自动加载此插件（等待文件监控检测）`;
}
function listPlugins() {
    const registrations = toolRegistry.getAllRegistrations();
    if (registrations.length === 0)
        return '暂无已注册的工具';
    const byPlugin = new Map();
    for (const reg of registrations) {
        if (!byPlugin.has(reg.pluginName))
            byPlugin.set(reg.pluginName, []);
        byPlugin.get(reg.pluginName).push(reg.name);
    }
    const lines = [];
    for (const [plugin, tools] of byPlugin) {
        lines.push(`📦 ${plugin}`);
        for (const tool of tools) {
            lines.push(`  ├ ${tool}`);
        }
    }
    return lines.join('\n');
}
const managementPlugin = {
    manifest: {
        name: '@builtin/management',
        version: '1.0.0',
        description: '插件管理工具（创建、列出插件）',
        permissions: ['system', 'file'],
    },
    tools: [
        {
            name: 'create_plugin',
            description: '创建一个插件文件并写入到插件目录，系统将自动热加载。插件必须默认导出 Plugin 接口对象。',
            parameters: {
                name: {
                    type: 'string',
                    description: '插件名称，用作文件名。仅允许字母、数字、下划线和连字符',
                },
                content: {
                    type: 'string',
                    description: '插件完整 JavaScript 代码。必须包含 manifest 和 handle 字段，默认导出 Plugin 对象',
                },
            },
            required: ['name', 'content'],
        },
        {
            name: 'list_plugins',
            description: '列出当前已加载的所有插件及其注册的工具',
            parameters: {},
            required: [],
        },
    ],
    handle(toolName, args) {
        switch (toolName) {
            case 'create_plugin':
                return createPlugin(args.name, args.content);
            case 'list_plugins':
                return listPlugins();
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    },
};
export default managementPlugin;
