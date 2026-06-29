import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { app } from 'electron';
import { eventBus } from '../core/EventBus';
import { AsyncLock } from '../utils/AsyncLock';
import { log } from '../logger/Logger';
let idCounter = 0;
export class PlanManager {
    constructor() {
        this.lock = new AsyncLock();
        const userData = app.getPath('userData');
        this.filePath = join(userData, 'dev-plans.json');
        this.data = this.load();
    }
    load() {
        try {
            if (!existsSync(this.filePath)) {
                return { version: 1, plans: [] };
            }
            return JSON.parse(readFileSync(this.filePath, 'utf-8'));
        }
        catch {
            return { version: 1, plans: [] };
        }
    }
    save() {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            const tmp = this.filePath + '.tmp.' + Date.now();
            writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
            renameSync(tmp, this.filePath);
        }
        catch (err) {
            log('ERROR', 'plan_save_failed', { error: String(err) });
        }
    }
    createPlan(title, description, stepDescriptions, priority) {
        const existing = this.data.plans.find((p) => p.title === title && p.status === 'active');
        if (existing) {
            log('INFO', 'plan_duplicate_skipped', { plan_id: existing.id, title });
            return existing;
        }
        // 计划膨胀治理：活跃计划上限检查
        const activeCount = this.data.plans.filter((p) => p.status === 'active').length;
        if (activeCount >= PlanManager.MAX_ACTIVE_PLANS) {
            const msg = `活跃计划已达上限（${activeCount}/${PlanManager.MAX_ACTIVE_PLANS}）。请先完成或放弃现有计划。`;
            log('WARN', 'plan_limit_exceeded', { active_count: activeCount, max: PlanManager.MAX_ACTIVE_PLANS });
            throw new Error(msg);
        }
        const plan = {
            id: `plan_${Date.now()}_${++idCounter}`,
            title,
            description,
            steps: stepDescriptions.map((desc, i) => ({
                id: `step_${i}_${Date.now()}`,
                description: desc,
                status: 'pending',
            })),
            status: 'active',
            priority: priority ?? 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.data.plans.push(plan);
        this.save();
        eventBus.emit('agent.plan.created', { planId: plan.id, title });
        log('INFO', 'plan_created', { plan_id: plan.id, title, steps: stepDescriptions.length });
        return plan;
    }
    getPlan(id) {
        return this.data.plans.find((p) => p.id === id);
    }
    getActivePlan() {
        // 返回最新的活跃计划（而非第一个），避免多轮进化循环后指向旧僵尸计划
        const active = this.data.plans.filter((p) => p.status === 'active');
        return active.length > 0 ? active[active.length - 1] : undefined;
    }
    listPlans() {
        return [...this.data.plans].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    updateStep(planId, stepIndex, status, result) {
        const plan = this.data.plans.find((p) => p.id === planId);
        if (!plan || stepIndex >= plan.steps.length)
            return false;
        plan.steps[stepIndex].status = status;
        if (result)
            plan.steps[stepIndex].result = result;
        plan.updatedAt = Date.now();
        this.save();
        eventBus.emit('agent.plan.step', { planId, stepIndex, status });
        log('INFO', 'plan_step_update', { plan_id: planId, step: stepIndex, status });
        return true;
    }
    completePlan(planId, reflection) {
        const plan = this.data.plans.find((p) => p.id === planId);
        if (!plan)
            return false;
        plan.status = 'completed';
        plan.updatedAt = Date.now();
        if (reflection)
            plan.reflection = reflection;
        this.save();
        eventBus.emit('agent.plan.completed', { planId });
        log('INFO', 'plan_completed', { plan_id: planId });
        return true;
    }
    abandonPlan(planId, reason) {
        const plan = this.data.plans.find((p) => p.id === planId);
        if (!plan)
            return false;
        plan.status = 'abandoned';
        plan.updatedAt = Date.now();
        if (reason)
            plan.reflection = reason;
        this.save();
        log('INFO', 'plan_abandoned', { plan_id: planId, reason });
        return true;
    }
    freezePlan(planId, reason) {
        const plan = this.data.plans.find((p) => p.id === planId);
        if (!plan)
            return false;
        if (plan.status !== 'active')
            return false;
        plan.status = 'frozen';
        plan.updatedAt = Date.now();
        if (reason)
            plan.reflection = reason;
        this.save();
        log('INFO', 'plan_frozen', { plan_id: planId, reason });
        return true;
    }
    getFormattedContext() {
        const active = this.getActivePlan();
        if (!active)
            return '';
        const doneSteps = active.steps.filter((s) => s.status === 'done').length;
        const totalSteps = active.steps.length;
        let ctx = `【当前开发计划】${active.title}\n进度: ${doneSteps}/${totalSteps}\n`;
        for (let i = 0; i < active.steps.length; i++) {
            const s = active.steps[i];
            const mark = s.status === 'done' ? '[✓]' : s.status === 'in_progress' ? '[→]' : s.status === 'failed' ? '[✗]' : '[ ]';
            ctx += `${mark} ${s.description}\n`;
        }
        return ctx;
    }
    /**
     * 清理旧计划：删除 completed（超过 completedCutoff）和 abandoned（超过 abandonedCutoff）的计划。
     * 返回删除的计划数量。
     */
    cleanupOldPlans(completedCutoff, abandonedCutoff) {
        const before = this.data.plans.length;
        this.data.plans = this.data.plans.filter((p) => {
            if (p.status === 'completed' && p.createdAt < completedCutoff)
                return false;
            if (p.status === 'abandoned' && p.createdAt < abandonedCutoff)
                return false;
            return true;
        });
        const removed = before - this.data.plans.length;
        if (removed > 0)
            this.save();
        return removed;
    }
}
/** 当前活跃计划上限 */
PlanManager.MAX_ACTIVE_PLANS = 3;
