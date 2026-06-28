import { describe, it, expect, beforeEach } from 'vitest';
import { MetaLearner } from '../MetaLearner';
describe('MetaLearner', () => {
    let learner;
    beforeEach(() => {
        learner = new MetaLearner();
    });
    it('记录变异并返回 ID', () => {
        const id = learner.recordMutation({
            parentStrategy: 'balanced',
            childStrategy: 'balanced_mut_abc',
            paramName: 'timeoutMs',
            oldValue: 120000,
            newValue: 90000,
            operation: 'mutate',
        });
        expect(id).toContain('meta_');
    });
    it('空状态下 getParamEffectiveness 返回空数组', () => {
        expect(learner.getParamEffectiveness()).toEqual([]);
    });
    it('空状态下 recommendMutationParam 推荐未尝试参数', () => {
        const rec = learner.recommendMutationParam();
        expect(rec.paramName).toBeTruthy();
        expect(rec.insight).toContain('探索');
    });
    it('所有参数都试过后推荐尝试最少的', () => {
        const params = ['timeoutMs', 'promptMode', 'trimMode', 'degenerationThreshold', 'maxHistoryEntries'];
        for (const p of params) {
            learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `${p}_mut`,
                paramName: p,
                oldValue: 'x',
                newValue: 'y',
                operation: 'mutate',
            });
        }
        const rec = learner.recommendMutationParam();
        expect(rec.paramName).toBeTruthy();
    });
    it('recordOutcome 更新变异结果', () => {
        const id = learner.recordMutation({
            parentStrategy: 'balanced',
            childStrategy: 'balanced_mut_1',
            paramName: 'promptMode',
            oldValue: 'full',
            newValue: 'balanced',
            operation: 'mutate',
        });
        learner.recordOutcome(id, 70, 85, 3);
        const eff = learner.getParamEffectiveness();
        expect(eff.length).toBe(1);
        expect(eff[0].avgDelta).toBe(15);
        expect(eff[0].improvements).toBe(1);
    });
    it('getParamEffectiveness 聚合多个同参数变异', () => {
        for (let i = 0; i < 3; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `t_mut_${i}`,
                paramName: 'timeoutMs',
                oldValue: 120000,
                newValue: 90000,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 70 + i * 5, 2);
        }
        const eff = learner.getParamEffectiveness();
        expect(eff.length).toBe(1);
        expect(eff[0].attempts).toBe(3);
        expect(eff[0].reliable).toBe(true);
    });
    it('recommendMutationParam 选效果最佳参数', () => {
        // timeoutMs: +10 avg
        for (let i = 0; i < 3; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `t_${i}`,
                paramName: 'timeoutMs',
                oldValue: 120000,
                newValue: 90000,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 80, 2);
        }
        // trimMode: -5 avg
        for (let i = 0; i < 3; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `tr_${i}`,
                paramName: 'trimMode',
                oldValue: false,
                newValue: true,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 65, 2);
        }
        const rec = learner.recommendMutationParam();
        expect(rec.paramName).toBe('timeoutMs');
    });
    it('shouldSuppressMutation 当所有可靠参数效果为负', () => {
        for (const param of ['timeoutMs', 'promptMode', 'trimMode']) {
            for (let i = 0; i < 3; i++) {
                const id = learner.recordMutation({
                    parentStrategy: 'balanced',
                    childStrategy: `${param}_${i}`,
                    paramName: param,
                    oldValue: 'x',
                    newValue: 'y',
                    operation: 'mutate',
                });
                learner.recordOutcome(id, 70, 60, 2);
            }
        }
        expect(learner.shouldSuppressMutation()).toBe(true);
    });
    it('不抑制当有效果好的参数', () => {
        for (let i = 0; i < 3; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `t_${i}`,
                paramName: 'timeoutMs',
                oldValue: 120000,
                newValue: 90000,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 85, 2);
        }
        expect(learner.shouldSuppressMutation()).toBe(false);
    });
    it('最近 N 次无改善时抑制', () => {
        for (let i = 0; i < 10; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `b_${i}`,
                paramName: 'timeoutMs',
                oldValue: 120000,
                newValue: 90000,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 72, 2);
        }
        expect(learner.shouldSuppressMutation()).toBe(true);
    });
    it('getMetaSummary 数据不足返回 null', () => {
        expect(learner.getMetaSummary()).toBeNull();
    });
    it('getMetaSummary 有足够数据后返回总结', () => {
        for (let i = 0; i < 5; i++) {
            const id = learner.recordMutation({
                parentStrategy: 'balanced',
                childStrategy: `b_${i}`,
                paramName: 'timeoutMs',
                oldValue: 120000,
                newValue: 90000,
                operation: 'mutate',
            });
            learner.recordOutcome(id, 70, 85, 3);
        }
        const summary = learner.getMetaSummary();
        expect(summary).not.toBeNull();
        expect(summary.details.activeMutations).toBe(5);
        expect(summary.recommendation).toBe('timeoutMs');
    });
    it('incrementCycle 和 getCycleCount', () => {
        expect(learner.getCycleCount()).toBe(0);
        learner.incrementCycle();
        expect(learner.getCycleCount()).toBe(1);
    });
    it('getDiagnostics 返回完整快照', () => {
        const diag = learner.getDiagnostics();
        expect(diag.trackedMutations).toBe(0);
        expect(diag.completedMutations).toBe(0);
    });
});
