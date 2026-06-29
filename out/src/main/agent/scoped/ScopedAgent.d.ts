import { ServerManager } from '../../mcp/ServerManager';
import type { SkillAgentDef } from '../../skill/SkillAgentRegistry';
import type { SubAgentResult, SubAgentStatus } from '../SubAgentPool';
/**
 * ScopedAgent — 受控子 Agent
 *
 * 与 SubAgentInstance 的区别：
 * - 有固定的 system prompt（来自技能 SKILL.md）
 * - 只能调用白名单内的工具
 * - 强制结构化 JSON 输出
 * - 不自主决策，仅按参数执行
 */
export declare class ScopedAgent {
    readonly id: string;
    readonly skillName: string;
    status: SubAgentStatus;
    summary: string;
    error?: string;
    readonly startedAt: number;
    completedAt?: number;
    private llm;
    private context;
    private abortController;
    private mcpManager;
    private agentDef;
    private params;
    constructor(id: string, skillName: string, agentDef: SkillAgentDef, params: Record<string, any>, mcpManager: ServerManager, chatKey: string, codeKey: string);
    run(): Promise<void>;
    interrupt(): void;
    private toolLoop;
    private processToolCalls;
    private tryExtractJson;
    toResult(): SubAgentResult;
}
