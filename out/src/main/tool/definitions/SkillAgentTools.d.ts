import { SubAgentPool } from '../../agent/SubAgentPool';
/**
 * spawn_skill_agent — 派发一个受控子 Agent 来执行 executor 技能
 */
export declare const spawnSkillAgentTool: import("..").Tool<{
    skill: string;
    params?: Record<string, any>;
}, import("../../mcp").MCPToolResult>;
export declare function setSubAgentPool(pool: SubAgentPool | null): void;
export declare function getSubAgentPool(): SubAgentPool | null;
