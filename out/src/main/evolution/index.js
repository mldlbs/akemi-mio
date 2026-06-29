import { DrizzlePlanManager } from './DrizzlePlanManager';
import { SelfEvolutionService } from './SelfEvolutionService';
export { EvolutionScheduler, EvolutionSchedulerState } from './EvolutionScheduler';
export { EvolutionHistoryManager } from './EvolutionHistory';
export { EvolutionStateManager } from './EvolutionStateManager';
export { EvolutionGitOps } from './EvolutionGitOps';
export { RollbackLevel } from './EvolutionGitOps';
export { ProposalValidator } from './ProposalValidator';
export { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder';
export { SelfEvolutionService, EvolutionSchedulerState as ServiceSchedulerState } from './SelfEvolutionService';
export { MetaLearner } from './MetaLearner';
export { EvaluatorCalibrator } from './EvaluatorCalibrator';
// Pipeline 阶段导出
export { EvolutionAnalyzer, EvolutionStrategizer, EvolutionExecutor, EvolutionReviewer, setSandboxRoot } from './pipeline';
export const planManager = new DrizzlePlanManager();
export let evolutionService = null;
export function initEvolution(agentService) {
    if (!evolutionService) {
        evolutionService = new SelfEvolutionService(agentService, undefined, undefined, planManager);
    }
    return evolutionService;
}
export function getPlanContext() {
    return planManager.getFormattedContext();
}
