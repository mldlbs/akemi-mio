import { describe, it, expect } from 'vitest';
import { detectPlanMode, pickBestPlan, buildPlanInjection, ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT } from '../EvolutionPromptBuilder';
function makePlan(overrides = {}) {
    return {
        id: 'plan-1',
        title: '测试计划',
        description: '测试描述',
        steps: [
            { id: 's1', description: '步骤一', status: 'done' },
            { id: 's2', description: '步骤二', status: 'pending' },
        ],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    };
}
describe('detectPlanMode', () => {
    it('无 planManager 返回 first_run', () => {
        expect(detectPlanMode(null).mode).toBe('first_run');
    });
    it('无活跃计划返回 first_run', () => {
        const pm = { listPlans: () => [], getActivePlan: () => null, freezePlan: vi.fn() };
        expect(detectPlanMode(pm).mode).toBe('first_run');
    });
    it('有活跃计划返回 continue_plan', () => {
        const pm = { listPlans: () => [makePlan()], getActivePlan: () => makePlan(), freezePlan: vi.fn() };
        const r = detectPlanMode(pm);
        expect(r.mode).toBe('continue_plan');
        expect(r.planContext).toContain('测试计划');
        expect(r.planSummary.stepsComplete).toBe(1);
        expect(r.planSummary.stepsTotal).toBe(2);
    });
});
describe('pickBestPlan', () => {
    it('空数组返回 null', () => {
        expect(pickBestPlan([])).toBeNull();
    });
    it('选择进度最高的计划', () => {
        const p1 = makePlan({ id: '1', steps: [{ id: 'a', description: 'a', status: 'pending' }] });
        const p2 = makePlan({ id: '2', steps: [{ id: 'b', description: 'b', status: 'done' }] });
        expect(pickBestPlan([p1, p2]).id).toBe('2');
    });
});
describe('buildPlanInjection', () => {
    it('包含计划信息', () => {
        const plan = makePlan();
        const inj = buildPlanInjection(plan, 1, 2, plan.steps.filter((s) => s.status === 'pending'));
        expect(inj).toContain('测试计划');
        expect(inj).toContain('1/2');
        expect(inj).toContain('步骤二');
    });
});
describe('ANALYSIS_PROMPT', () => {
    it('first_run 禁止 write_file', () => {
        expect(ANALYSIS_PROMPT('first_run', '', '', 'auto')).toContain('禁止 write_file');
    });
    it('continue_plan 包含计划上下文', () => {
        expect(ANALYSIS_PROMPT('continue_plan', '计划内容', '', 'auto')).toContain('计划内容');
    });
    it('review_only 仅审查', () => {
        expect(ANALYSIS_PROMPT('review_only', '', '', 'review')).toContain('不要创建计划');
    });
    it('validationSummary 注入', () => {
        expect(ANALYSIS_PROMPT('first_run', '', '', 'auto', '上轮违规')).toContain('上轮违规');
    });
});
describe('PLAN_EXECUTE_PROMPT', () => {
    it('包含步骤描述', () => {
        const prompt = PLAN_EXECUTE_PROMPT('ctx', '修改 EventBus.ts');
        expect(prompt).toContain('修改 EventBus.ts');
        expect(prompt).toContain('write_file/edit_file');
        expect(prompt).toContain('update_plan_progress');
    });
});
