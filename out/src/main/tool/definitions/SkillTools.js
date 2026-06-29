import { buildTool, formatToolResult, formatToolError } from '../types';
import { getSkillManager } from '../deps';
export const listSkillsTool = buildTool({
    name: 'list_skills',
    description: '列出所有已安装的技能及其启用/禁用状态',
    inputJSONSchema: {
        type: 'object',
        properties: {},
        required: [],
    },
    handler: async () => {
        try {
            const sm = getSkillManager();
            if (!sm)
                return formatToolError('技能管理器尚未就绪');
            const skills = sm.getAllSkills();
            if (skills.length === 0)
                return formatToolResult('尚未安装任何技能。将技能目录放到 AppData 下即可自动加载');
            const lines = skills.map((s) => `${s.enabled ? '[启用]' : '[禁用]'} ${s.manifest.name} — ${s.manifest.description}${s.toolsLoaded ? ' (含工具)' : ''}`);
            return formatToolResult(`已安装 ${skills.length} 个技能:\n${lines.join('\n')}`);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
export const enableSkillTool = buildTool({
    name: 'enable_skill',
    description: '启用一个已安装但被禁用的技能，恢复其提示模块注入和工具注册',
    inputJSONSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '技能名称' },
        },
        required: ['name'],
    },
    handler: async (args) => {
        try {
            const sm = getSkillManager();
            if (!sm)
                return formatToolError('技能管理器尚未就绪');
            const msg = await sm.enableSkill(args.name);
            return formatToolResult(msg);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: false,
});
export const disableSkillTool = buildTool({
    name: 'disable_skill',
    description: '禁用一个已启用的技能（不从磁盘删除），暂时移除其提示模块和工具',
    inputJSONSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '技能名称' },
        },
        required: ['name'],
    },
    handler: async (args) => {
        try {
            const sm = getSkillManager();
            if (!sm)
                return formatToolError('技能管理器尚未就绪');
            const msg = await sm.disableSkill(args.name);
            return formatToolResult(msg);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: false,
});
