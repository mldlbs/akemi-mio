import { buildTool, formatToolResult, formatToolError } from '../types';
import { getSkillManager } from '../deps';
import { skillAgentRegistry } from '../../skill/SkillAgentRegistry';
/**
 * spawn_skill_agent — 派发一个受控子 Agent 来执行 executor 技能
 */
export const spawnSkillAgentTool = buildTool({
    name: 'spawn_skill_agent',
    description: '派发一个技能子 Agent 来执行特定任务（仅限 executor 类型的技能）。子 Agent 会在后台执行，完成后通过 collect_completed 获取结果。',
    inputJSONSchema: {
        type: 'object',
        properties: {
            skill: { type: 'string', description: '要执行的技能名称（必须是 executor 类型）' },
            params: { type: 'object', description: '传给技能子 Agent 的执行参数' },
        },
        required: ['skill'],
    },
    handler: async (args) => {
        try {
            const sm = getSkillManager();
            if (!sm)
                return formatToolError('技能管理器尚未就绪');
            const agentDef = skillAgentRegistry.get(args.skill);
            if (!agentDef) {
                return formatToolError(`技能「${args.skill}」不是 executor 类型或未注册。` +
                    '请先用 list_skills 确认技能状态，knowledge 类型的技能会自动注入无需手动调用。');
            }
            const pool = getSubAgentPool();
            if (!pool)
                return formatToolError('子 Agent 池尚未就绪，无法派发技能任务');
            const agentId = pool.spawnSkillAgent(args.skill, agentDef, args.params || {});
            return formatToolResult(`技能「${args.skill}」子 Agent 已派发（ID: ${agentId}）。` + `执行完成后会通过后台任务汇报通知你结果，届时请注意查看。`);
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: false,
});
let _subAgentPool = null;
export function setSubAgentPool(pool) {
    _subAgentPool = pool;
}
export function getSubAgentPool() {
    return _subAgentPool;
}
