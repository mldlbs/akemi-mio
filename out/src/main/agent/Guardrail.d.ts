import type { ToolResult } from './ToolScheduler';
import type { ToolCallInfo } from '../llm/LlmService';
import type { Message } from './context';
import type { RunContext } from './runstate';
import type { PlanManagerLike } from '../evolution/types';
import type { ProceduralMemory } from './ProceduralMemory';
export interface GuardrailDeps {
    memoryService: {
        getFormattedContext(): string;
    } | null;
    skillManager: {
        getEnabledPromptModules(): string[];
    } | null;
    planManager: PlanManagerLike;
    proceduralMemory?: ProceduralMemory | null;
}
export interface GuardrailResult {
    injected: boolean;
}
export declare class Guardrail {
    private deps;
    private readOnlyTools;
    constructor(deps: GuardrailDeps, readOnlyTools?: Set<string>);
    /** 更新依赖（memoryService/skillManager 延迟注入） */
    updateDeps(partial: Partial<GuardrailDeps>): void;
    /**
     * 对一批工具执行结果执行所有 guardrail 检查。
     * 副作用：注入系统消息到 messages，更新 ctx 计数器。
     */
    apply(toolResults: ToolResult[], toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): GuardrailResult;
    /**
     * 连续只读检测 — 连续 2 轮以上全是只读操作则给出提示。
     * 含远程工具失败快速降级：检测到 centos_* 等远程工具失败时，1 轮即干预。
     * 累计 readonlyStuckCount >= 3 时强制提示输出中间结论，
     * >= 4 时直接中断 toolLoop 防止死循环。
     */
    private checkReadOnlyStuck;
    /**
     * list_files 路径兜底
     */
    private checkListFilesPathFallback;
    /**
     * plan 操作失败恢复
     */
    private checkPlanErrors;
    /**
     * 连续工具错误 → 诊断模式
     * 累计 >= 3 次注入诊断消息；>= 5 次直接中断 toolLoop
     */
    private checkConsecutiveToolErrors;
    /**
     * 只读错误 > 3 次 → 切换模式
     */
    private checkConsecutiveReadOnlyErrors;
    /**
     * writing 工具全部失败 → 注入切换提示，防止 LLM 在死循环中反复重试
     */
    private checkWritingToolFailure;
    /**
     * 流程记忆自动建议：当当前工具调用序列匹配到已保存流程时，给出提示。
     */
    private checkProcedureSuggestion;
}
