import { BrowserWindow } from 'electron';
import { LlmService } from '../llm/LlmService';
import { AsrService } from '../asr/AsrService';
import { TtsService } from '../tts/TtsService';
import { ConversationContext } from './context';
import { MemoryService } from '../memory/MemoryService';
import { ChatResult } from '../llm/types';
import { IntentHandler } from './intent/types';
import { ServerManager } from '../mcp/ServerManager';
import { EventBus } from '../core/EventBus';
import type { PlanManagerLike } from '../evolution/types';
import { ReflectLoop } from './ReflectLoop';
import { FailureAnalyzer } from './FailureAnalyzer';
import { GoalGuardrail } from '../governance/GoalGuardrail';
import { CircuitBreaker } from '../core/CircuitBreaker';
import { ResourceBudget } from '../core/ResourceBudget';
import { type TokenAccount } from '../cognitive/TokenEconomy';
import { SleepCycle } from './SleepCycle';
import { SkillManager } from '../skill';
import { SessionRecoveryManager } from './SessionRecoveryManager';
import { ProceduralMemory } from './ProceduralMemory';
export declare class AgentService {
    private llmService;
    private asrService;
    private ttsService;
    private memoryService;
    private context;
    private mainWindow;
    private intentHandlers;
    private eventBus;
    private mcpManager;
    private planManager;
    private inSelfTask;
    /** 本次会话中由 LLM 创建的活跃计划 ID，force_continue 仅作用于它们 */
    private sessionPlanIds;
    /** 运行状态机上下文 */
    private runContext;
    /** 并发工具调度器 */
    private toolScheduler;
    /** Guardrail — 工具循环安全护栏 */
    private guardrail;
    /** 自任务超时中止控制器 — 用于取消 timed-out 的进化分析任务 */
    private selfTaskAbortController;
    /** 自任务开始时间戳，用于检测挂起超时任务 */
    private selfTaskStartTime;
    private subAgentPool;
    readonly reflectLoop: ReflectLoop;
    readonly proceduralMemory: ProceduralMemory;
    readonly failureAnalyzer: FailureAnalyzer;
    readonly sleepCycle: SleepCycle;
    readonly resourceBudget: ResourceBudget;
    /** Token 经济账户 — 长期 Token 余额管理 */
    tokenAccount: TokenAccount | null;
    /** 技能管理器 — 管理外部技能的安装与注入 */
    private skillManager;
    /** 目标守卫 — 工具调用前拦截，防宪法违规 & 目标漂移 */
    readonly goalGuardrail: GoalGuardrail;
    /** 熔断器 — 防止 LLM/工具调用级联失败 */
    readonly circuitBreaker: CircuitBreaker;
    /** 会话恢复管理器 */
    private recoveryManager;
    /** 错误分类器 */
    private errorClassifier;
    /** 上次创建检查点的 toolLoop step */
    private lastCheckpointStep;
    /** 上次创建检查点的时间戳 */
    private lastCheckpointTime;
    /** 连续可重试错误计数 */
    private consecutiveRetryableErrors;
    /** 暂停状态 */
    private _paused;
    /** 身份上下文缓存（由 CognitiveService.identity 提供） */
    private identityContext;
    /** ChatExecutor — Chat 运行时（独立 context + toolLoop） */
    private chatExecutor;
    /** TaskExecutor — Evolution 循环执行引擎 */
    private taskExecutor;
    constructor(llmService: LlmService, asrService: AsrService, ttsService: TtsService, bus?: EventBus, mcpManager?: ServerManager, planManager?: PlanManagerLike);
    getMcpManager(): ServerManager;
    registerIntentHandler(handler: IntentHandler): void;
    private registerDefaultHandlers;
    private classifyIntent;
    /** 同步 ChatExecutor 中的 DI 依赖（延时注入后调用） */
    private updateRuntimeDeps;
    setMemoryService(memoryService: MemoryService): void;
    /** 刷新 ConversationContext 中的静态记忆片段，确保 remember_fact 写入后立即可见 */
    private refreshMemoryInContext;
    setSkillManager(sm: SkillManager): void;
    getSkillManager(): SkillManager | null;
    setMainWindow(win: BrowserWindow | null): void;
    getContext(): ConversationContext;
    clearContext(): void;
    getLlmService(): LlmService;
    getAsrService(): AsrService;
    getTtsService(): TtsService;
    getMemoryService(): MemoryService | null;
    private executeIntentCommand;
    processTextInput(text: string, requestId?: string, source?: 'electron' | 'telegram', extra?: {
        telegramChatId?: number;
        telegramUserId?: number;
        telegramFrom?: string;
        telegramMessageId?: number;
    }, sessionId?: string, noTts?: boolean): Promise<ChatResult>;
    stopConversation(): Promise<void>;
    isBusy(): boolean;
    /** 暂停 Chat 处理（暂停 ASR/TTS/LLM 调用，保留上下文） */
    pause(): void;
    /** 恢复 Chat 处理 */
    resume(): void;
    /** 是否处于暂停状态 */
    isPaused(): boolean;
    /** 设置/清除强制续行抑制。在 tryRun 前设为 true，防止 toolLoop 注入"停止读取"等干扰提示 */
    setSuppressForceContinue(val: boolean): void;
    /** 取消正在运行的自任务（由 SelfEvolutionService 在超时时调用） */
    abortSelfTask(): void;
    /** 获取自任务运行时长（毫秒），无自任务时返回 0 */
    getSelfTaskAge(): number;
    /** 获取子 agent 状态 */
    getSubAgentStatus(): {
        running: {
            id: string;
            goal: string;
            elapsed: number;
        }[];
    };
    /** 设置会话恢复管理器 */
    setRecoveryManager(rm: SessionRecoveryManager): void;
    /** 保存恢复快照（检查点） */
    saveRecoverySnapshot(trigger: 'milestone' | 'error' | 'interrupt' | 'shutdown', error?: string): Promise<void>;
    /** 尝试恢复中断的会话。返回 true 表示已恢复 */
    private tryRestoreSession;
    runSelfTask(task: string, systemPrompt?: string): Promise<{
        success: boolean;
        summary: string;
    }>;
}
