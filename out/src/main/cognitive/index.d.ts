import { GoalEngine } from './GoalEngine';
import { StrategyEngine } from './StrategyEngine';
import { TokenAccount, CostEstimator } from './TokenEconomy';
import { IdentityModule } from '../identity';
import { MetaCycle } from './MetaCycle';
import type { EngineeringMemory } from '../memory/EngineeringMemory';
import type { ProceduralMemory } from '../agent/ProceduralMemory';
import type { LlmService } from '../llm/LlmService';
export declare class CognitiveService {
    readonly identity: IdentityModule;
    readonly goals: GoalEngine;
    readonly strategies: StrategyEngine;
    readonly tokenAccount: TokenAccount;
    readonly costEstimator: CostEstimator;
    readonly metaCycle: MetaCycle;
    private initialized;
    private defaultStrategies;
    constructor();
    initialize(constitutionPath?: string, deps?: {
        engineeringMemory?: EngineeringMemory;
        proceduralMemory?: ProceduralMemory;
        llmService?: LlmService;
    }): Promise<void>;
    adjustByToken(failureLogs: Array<{
        task: string;
        error: string;
        timestamp: number;
    }>): Promise<void>;
    private inferGoalFromError;
    /** 构建可注入 prompt 的认知上下文 */
    getFormattedContext(keywords?: string[]): string;
    private seedDefaultGoals;
    private seedDefaultStrategies;
}
