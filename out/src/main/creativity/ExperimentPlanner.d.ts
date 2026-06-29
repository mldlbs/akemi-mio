import type { Hypothesis, ExperimentPlan } from './types';
/**
 * ExperimentPlanner — 将假设转化为可验证的实验方案
 *
 * 创造力最大的敌人是"幻想"。
 * 每个想法必须有办法验证它是否可行。
 */
export declare class ExperimentPlanner {
    private rng;
    constructor(seed?: number);
    plan(hypothesis: Hypothesis): ExperimentPlan | null;
    private concretePlan;
    private researchPlan;
}
