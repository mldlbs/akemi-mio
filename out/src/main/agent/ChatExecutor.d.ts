/**
 * ChatExecutor — Chat Runtime 独立执行器
 *
 * 拥有自己的 ConversationContext、自己的 toolLoop。
 * 不与其他 Runtime 共享执行上下文。
 * P0 优先级，不受 Budget 限流（但有安全兜底 300 轮）。
 */
import { BrowserWindow } from 'electron';
import type { LlmService } from '../llm/LlmService';
import type { TtsService } from '../tts/TtsService';
import { ConversationContext } from './context';
import type { MemoryService } from '../memory/MemoryService';
import { ChatResult } from '../llm/types';
import type { PlanManagerLike } from '../evolution/types';
import { SubAgentPool } from './SubAgentPool';
import { ReflectLoop } from './ReflectLoop';
import { Guardrail } from './Guardrail';
import { GoalGuardrail } from '../governance/GoalGuardrail';
import { ToolScheduler } from './ToolScheduler';
import type { TokenAccount } from '../cognitive/TokenEconomy';
import { SkillManager } from '../skill';
import { SessionRecoveryManager } from './SessionRecoveryManager';
import { ResourceBudget } from '../core/ResourceBudget';
import type { ProceduralMemory } from './ProceduralMemory';
import type { FailureAnalyzer } from './FailureAnalyzer';
export declare class ChatExecutor {
    private llmService;
    private ttsService;
    private mainWindow;
    private workingMemory;
    private toolScheduler;
    private guardrail;
    private planManager;
    private resourceBudget;
    private memoryService;
    private skillManager;
    private recoveryManager;
    private tokenAccount;
    private subAgentPool;
    private reflectLoop;
    private goalGuardrail;
    private sessionPlanIds;
    private errorClassifier;
    private consecutiveRetryableErrors;
    private consecutiveInvalidRequest;
    private lastCheckpointStep;
    private lastCheckpointTime;
    private identityContext;
    private runContext;
    private proceduralMemory;
    private failureAnalyzer;
    private thinkStageCount;
    private obsLogger;
    private lastUserText;
    /** 人格仲裁管理器 */
    private personaManager;
    /** 人格漂移控制系统 */
    private driftControl;
    /** 上轮 drift 评估产生的待注入消息信号 */
    private pendingDriftSignal;
    /** 当前轮 user 消息的 content category */
    private currentCategory;
    /** 当前加载的 session，用于切换 session 时重建上下文 */
    private currentSessionId;
    /** 执行决策门 — 每轮 tool batch 后强制决策 */
    private executionGovernor;
    constructor(llmService: LlmService, ttsService: TtsService, mainWindow: BrowserWindow | null, toolScheduler: ToolScheduler, guardrail: Guardrail, goalGuardrail: GoalGuardrail, planManager: PlanManagerLike, resourceBudget: ResourceBudget, memoryService: MemoryService | null, skillManager: SkillManager | null, recoveryManager: SessionRecoveryManager | null, tokenAccount: TokenAccount | null, subAgentPool: SubAgentPool, reflectLoop: ReflectLoop);
    setMainWindow(win: BrowserWindow | null): void;
    updateDeps(deps: {
        memoryService?: MemoryService | null;
        skillManager?: SkillManager | null;
        recoveryManager?: SessionRecoveryManager | null;
        tokenAccount?: TokenAccount | null;
        mainWindow?: BrowserWindow | null;
        identityContext?: string;
        proceduralMemory?: ProceduralMemory | null;
        failureAnalyzer?: FailureAnalyzer | null;
    }): void;
    getContext(): ConversationContext;
    getSessionPlanIds(): Set<string>;
    setSessionPlanIds(ids: Set<string>): void;
    isBusy(): boolean;
    private resolvePersonaFor;
    private refreshMemory;
    /** 自动分配或续用 session_id：30 分钟无活动则新建 session */
    private resolveSessionId;
    private persistAssistantMessage;
    private noTts;
    run(text: string, requestId?: string, source?: 'electron' | 'telegram', extra?: {
        telegramChatId?: number;
        telegramUserId?: number;
        telegramFrom?: string;
        telegramMessageId?: number;
    }, sessionId?: string, noTts?: boolean): Promise<ChatResult>;
    stop(): void;
    private toolLoop;
    private handleLlmError;
    private handlePlanForceContinue;
    private checkMilestone;
    private emitToolStatus;
}
