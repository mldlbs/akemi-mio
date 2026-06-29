import { ServerManager } from '../mcp/ServerManager';
import { EventBus } from '../core/EventBus';
import type { SkillAgentDef } from '../skill/SkillAgentRegistry';
export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface SubAgentResult {
    id: string;
    goal: string;
    status: SubAgentStatus;
    summary: string;
    error?: string;
    startedAt: number;
    completedAt?: number;
}
export declare class SubAgentPool {
    private agents;
    private scopedAgents;
    /** 已完成但尚未被主 agent 消费的结果 */
    private completedQueue;
    private mcpManager;
    private eventBus;
    private counter;
    private watchdogTimer;
    private chatKey;
    private codeKey;
    constructor(mcpManager: ServerManager, bus?: EventBus, chatKey?: string, codeKey?: string);
    /** 派发一个子任务，立即返回 id */
    spawn(goal: string, parentGoal?: string): string;
    /** 派发多个并行任务 */
    spawnBatch(tasks: {
        goal: string;
    }[], parentGoal?: string): string[];
    /**
     * 派发一个技能子 Agent（受控执行）
     * 返回 agentId，执行完成后结果会进入 completedQueue
     */
    spawnSkillAgent(skillName: string, agentDef: SkillAgentDef, params: Record<string, any>): string;
    /** 打断一个子任务 */
    interrupt(id: string): boolean;
    /** 打断全部运行中的子任务 */
    interruptAll(): number;
    /** 收集所有已完成但尚未被消费的结果 */
    collectCompleted(): SubAgentResult[];
    /** 当前运行中的任务列表 */
    listRunning(): {
        id: string;
        goal: string;
        elapsed: number;
    }[];
    private onAgentDone;
    private ensureWatchdog;
    /** 销毁池子（清理定时器） */
    dispose(): void;
}
