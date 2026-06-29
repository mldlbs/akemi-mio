import type { ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog } from './types';
export declare class DrizzleIdeaStore {
    addCombo(combo: ConceptCombo): void;
    addHypothesis(h: Hypothesis): void;
    addManyHypotheses(hs: Hypothesis[]): void;
    addExperiment(exp: ExperimentPlan): void;
    logDreamCycle(entry: DreamCycleLog): void;
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
    templateAdoptionStats(): Record<string, {
        total: number;
        active: number;
        rejected: number;
        adopted: number;
    }>;
    adoptionReport(limit?: number): string;
    addExploredPair(nameA: string, nameB: string): void;
    getExploredPairs(): string[];
    resetExploredPairs(): void;
    private insertHypothesis;
}
