import type { ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog } from './types';
export declare class IdeaStore {
    private data;
    private filePath;
    constructor(filePath: string);
    private load;
    private save;
    addCombo(combo: ConceptCombo): void;
    addHypothesis(h: Hypothesis): void;
    addManyHypotheses(hs: Hypothesis[]): void;
    addExperiment(exp: ExperimentPlan): void;
    logDreamCycle(logEntry: DreamCycleLog): void;
    getHypotheses(options?: {
        status?: string;
        limit?: number;
    }): Hypothesis[];
    getNovelHypotheses(threshold?: number, limit?: number): Hypothesis[];
    getActiveExperiments(): ExperimentPlan[];
    getRecentCombos(limit?: number): ConceptCombo[];
    getRecentDreamCycles(limit?: number): DreamCycleLog[];
    updateHypothesisStatus(id: string, status: Hypothesis['status']): boolean;
    count(): {
        combos: number;
        hypotheses: number;
        experiments: number;
        dreamCycles: number;
    };
    /** 按来源对统计每个模板的假设状态分布 */
    templateAdoptionStats(): Record<string, {
        total: number;
        active: number;
        rejected: number;
        adopted: number;
    }>;
    /** 报告采纳率最低/最高的来源对 */
    adoptionReport(limit?: number): string;
}
