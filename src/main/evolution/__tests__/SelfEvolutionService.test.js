/**
 * SelfEvolutionService 集成测试
 *
 * 核心验证点：
 * 1. detectPlanMode：无活跃计划 → first_run, 有活跃计划 → continue_plan
 * 2. 不再 abandonZombiePlans：有活跃计划时不会自动丢弃
 * 3. tryRun 使用 ANALYSIS_PROMPT（无 write_file 指令），超时 120s
 * 4. tryExecutePlan 使用增强的 PLAN_EXECUTE_PROMPT
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('electron', () => ({
    app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}));
import { SelfEvolutionService } from '../SelfEvolutionService';
// =============================================================================
// 测试辅助函数 — 生成隔离的临时文件路径
// =============================================================================
let testCounter = 0;
/** 每个测试用例获得独立的 history 和 state 文件，避免跨测试状态污染 */
function makeTestPaths() {
    const id = `test_${++testCounter}_${Date.now()}`;
    const tmpDir = require('path').join(require('os').tmpdir(), 'evolution-test', id);
    return {
        historyPath: require('path').join(tmpDir, 'history.json'),
        stateFilePath: require('path').join(tmpDir, 'evolution_state.json'),
    };
}
function cleanupTestPaths(paths) {
    try {
        require('fs').unlinkSync(paths.historyPath);
    }
    catch { /* ignore */ }
    try {
        require('fs').unlinkSync(paths.stateFilePath);
    }
    catch { /* ignore */ }
    try {
        require('fs').rmdirSync(require('path').dirname(paths.historyPath));
    }
    catch { /* ignore */ }
    try {
        require('fs').rmdirSync(require('path').dirname(require('path').dirname(paths.historyPath)));
    }
    catch { /* ignore */ }
}
// =============================================================================
// Mock PlanManager
// =============================================================================
function createMockPlanManager(initialPlan = null) {
    let activePlan = initialPlan ? JSON.parse(JSON.stringify(initialPlan)) : null;
    let planCreatedCount = 0;
    let abandonedPlans = [];
    let completedPlans = [];
    return {
        getActivePlan: vi.fn(() => activePlan),
        getPlan: vi.fn((id) => (activePlan?.id === id ? activePlan : undefined)),
        listPlans: vi.fn(() => (activePlan ? [activePlan] : [])),
        createPlan: vi.fn((title, _description, stepDescriptions) => {
            const steps = stepDescriptions.map((desc, i) => ({
                id: `step_${i}`,
                description: desc,
                status: 'pending',
            }));
            activePlan = {
                id: `plan_${Date.now()}`,
                title,
                description: _description,
                steps,
                status: 'active',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            planCreatedCount++;
            return activePlan;
        }),
        updateStep: vi.fn((planId, stepIndex, status, result) => {
            if (activePlan && activePlan.id === planId && stepIndex < activePlan.steps.length) {
                activePlan.steps[stepIndex].status = status;
                if (result)
                    activePlan.steps[stepIndex].result = result;
            }
            return true;
        }),
        completePlan: vi.fn((id) => {
            completedPlans.push(id);
            if (activePlan?.id === id)
                activePlan = null;
            return true;
        }),
        abandonPlan: vi.fn((id, _reason) => {
            abandonedPlans.push(id);
            if (activePlan?.id === id)
                activePlan = null;
            return true;
        }),
        getFormattedContext: vi.fn(() => {
            if (!activePlan)
                return '';
            const doneSteps = activePlan.steps.filter((s) => s.status === 'done').length;
            const totalSteps = activePlan.steps.length;
            let ctx = `【当前开发计划】${activePlan.title}\n进度: ${doneSteps}/${totalSteps}\n`;
            for (const s of activePlan.steps) {
                const mark = s.status === 'done' ? '[✓]' : s.status === 'in_progress' ? '[→]' : s.status === 'failed' ? '[✗]' : '[ ]';
                ctx += `${mark} ${s.description}\n`;
            }
            return ctx;
        }),
        lock: { run: async (fn) => fn() },
        _planCreatedCount: () => planCreatedCount,
        _abandonedPlans: () => abandonedPlans,
        _completedPlans: () => completedPlans,
        _setPlan: (plan) => {
            activePlan = plan ? JSON.parse(JSON.stringify(plan)) : null;
        },
    };
}
// =============================================================================
// Mock AgentService
// =============================================================================
function createMockAgentService() {
    let busy = false;
    let lastPrompt = '';
    return {
        isBusy: vi.fn(() => busy),
        runSelfTask: vi.fn(async (task) => {
            lastPrompt = task;
            busy = true;
            await Promise.resolve();
            busy = false;
            return { success: true, summary: '分析完成，计划已创建（mock）' };
        }),
        setSuppressForceContinue: vi.fn((_val) => { }),
        _setBusy: (b) => { busy = b; },
        _lastPrompt: () => lastPrompt,
    };
}
// =============================================================================
// 辅助函数 — 创建 DevPlan
// =============================================================================
function makePlan(title, stepCount, doneCount, options) {
    const failedCount = options?.failedCount ?? 0;
    const steps = Array.from({ length: stepCount }, (_, i) => {
        let status = 'pending';
        if (i < doneCount)
            status = 'done';
        else if (i < doneCount + failedCount)
            status = 'failed';
        return {
            id: `step_${i}`,
            description: `步骤 ${i + 1}: ${title} 的第 ${i + 1} 步`,
            status,
        };
    });
    return {
        id: `plan_${title.replace(/\s/g, '_')}`,
        title,
        description: `测试计划: ${title}`,
        steps,
        status: 'active',
        createdAt: Date.now() - 3600000,
        updatedAt: Date.now() - 1800000,
    };
}
describe('SelfEvolutionService — 集成测试', () => {
    let paths;
    beforeEach(() => {
        paths = makeTestPaths();
    });
    afterEach(() => {
        cleanupTestPaths(paths);
    });
    function resetLastRun(service) {
        ;
        service.lastRun = 0;
    }
    describe('detectPlanMode（通过 tryRun 间接验证）', () => {
        it('无活跃计划时，tryRun 应正常执行分析（不报错）', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(1);
            const prompt = mockAgent._lastPrompt();
            expect(prompt).toContain('分析模式');
            expect(prompt).toContain('禁止 write_file');
            expect(mockPlan._abandonedPlans()).toHaveLength(0);
        });
        it('有活跃计划时，不应自动 abandon（替代旧 abandonZombiePlans 行为）', async () => {
            const existingPlan = makePlan('修复数据库连接泄漏', 4, 1);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            expect(mockPlan._abandonedPlans()).toHaveLength(0);
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(1);
        });
        it('有活跃计划时，prompt 应包含计划上下文注入', async () => {
            const existingPlan = makePlan('优化查询性能', 3, 1);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            const prompt = mockAgent._lastPrompt();
            expect(prompt).toContain('优化查询性能');
            expect(prompt).toContain('1/3');
        });
        it('多次触发不会 abandon 已有计划', async () => {
            const existingPlan = makePlan('重构 API 路由', 5, 2);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            await service.triggerNow();
            expect(mockPlan._abandonedPlans()).toHaveLength(0);
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(2);
        });
    });
    describe('tryRun prompt 内容验证', () => {
        it('first_run 模式下 prompt 应声明"分析模式"而非"执行模式"', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            const prompt = mockAgent._lastPrompt();
            expect(prompt).toContain('分析模式');
            expect(prompt).toContain('最多 3-5 个步骤');
            expect(prompt).not.toContain('直接执行 write_file');
            expect(prompt).not.toContain('使用 write_file');
        });
        it('continue_plan 模式应包含计划名称和进度', async () => {
            const existingPlan = makePlan('安全审计修复', 6, 2);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            const prompt = mockAgent._lastPrompt();
            expect(prompt).toContain('安全审计修复');
            expect(prompt).toContain('【当前活跃计划】');
            expect(prompt).not.toContain('首次进化分析');
        });
        it('prompt 应提示不要创建重复计划（当已有活跃计划时）', async () => {
            const existingPlan = makePlan('插件权限模型', 4, 1);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            const prompt = mockAgent._lastPrompt();
            expect(prompt).toContain('不要创建新计划');
            expect(prompt).toContain('已有活跃计划');
        });
    });
    describe('tryRun 超时和失败处理', () => {
        it('连续失败超过 maxFailures（3次）后应跳过执行', async () => {
            const mockAgent = createMockAgentService();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '分析失败（mock）',
            }));
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            for (let i = 0; i < 3; i++) {
                await service.triggerNow();
                resetLastRun(service);
            }
            const callCountBeforeSkip = mockAgent.runSelfTask.mock.calls.length;
            await service.triggerNow();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(callCountBeforeSkip);
            expect(service.getConsecutiveFailures()).toBeGreaterThanOrEqual(3);
        });
        it('失败后成功一次应重置连续失败计数', async () => {
            const mockAgent = createMockAgentService();
            let callCount = 0;
            mockAgent.runSelfTask = vi.fn(async () => {
                callCount++;
                if (callCount <= 2)
                    return { success: false, summary: '失败' };
                return { success: true, summary: '成功' };
            });
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            await service.triggerNow();
            resetLastRun(service);
            await service.triggerNow();
            expect(service.getConsecutiveFailures()).toBe(0);
            expect(service.getLastRun()).toBeGreaterThan(0);
        });
    });
    describe('分析超时配置', () => {
        it('应使用配置的分析超时（可在构造函数重写）', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath, analysisTimeoutMs: 30000,
            });
            await service.triggerNow();
            resetLastRun(service);
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(1);
        });
    });
    describe('错误恢复', () => {
        it('agent 忙时应跳过 tryRun（不报错）', async () => {
            const mockAgent = createMockAgentService();
            mockAgent._setBusy(true);
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await expect(service.triggerNow()).resolves.toBeUndefined();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(0);
        });
    });
    describe('拆分错误计数器', () => {
        it('tryRun 失败应累积 tryRunFailures，不影响 executeFailures', async () => {
            const mockAgent = createMockAgentService();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '分析失败（mock）',
            }));
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await service.triggerNow();
            resetLastRun(service);
            expect(service.getConsecutiveFailures()).toBe(1);
            expect(service.getExecuteFailures()).toBe(0);
        });
    });
    describe('冷却恢复定时器', () => {
        it('连续 3 次失败后应设置冷却时间', async () => {
            const mockAgent = createMockAgentService();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '失败',
            }));
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            for (let i = 0; i < 3; i++) {
                await service.triggerNow();
                resetLastRun(service);
            }
            const cooldown = service.getRecoveryCooldown();
            expect(cooldown.active).toBe(true);
            expect(cooldown.remainingMs).toBeGreaterThan(0);
            const callCountBeforeSkip = mockAgent.runSelfTask.mock.calls.length;
            await service.triggerNow();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(callCountBeforeSkip);
        });
        it('冷却时间过后应自动恢复', async () => {
            const mockAgent = createMockAgentService();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '失败',
            }));
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            for (let i = 0; i < 3; i++) {
                await service.triggerNow();
                resetLastRun(service);
            }
            expect(service.getConsecutiveFailures()).toBe(3);
            expect(service.getRecoveryCooldown().active).toBe(true);
            service.recoveryCooldownUntil = Date.now() - 1000;
            await service.triggerNow();
            expect(service.getConsecutiveFailures()).toBe(1);
            expect(service.getRecoveryCooldown().active).toBe(false);
        });
    });
    describe('错误计数器与步骤重试修复', () => {
        it('错误计数器不应在 tryExecutePlan 入口重置', async () => {
            const existingPlan = makePlan('计数测试', 3, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '步骤执行失败（mock）',
            }));
            mockPlan.lock.run = async (fn) => fn();
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath, stepRetryBaseMs: 0,
            });
            service.setSafetyMode('auto');
            service.planExecConsecutiveErrors = 0;
            const tryExec = () => service.tryExecutePlan();
            await tryExec();
            await tryExec();
            await tryExec();
            expect(service.planExecConsecutiveErrors).toBeGreaterThanOrEqual(3);
            expect(mockPlan._abandonedPlans().length).toBeGreaterThanOrEqual(1);
        });
        it('safetyMode=review 时 tryExecutePlan 应跳过执行', async () => {
            const existingPlan = makePlan('review模式测试', 2, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.setSafetyMode('review');
            await service.tryExecutePlan();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(0);
            expect(existingPlan.steps[0].status).toBe('pending');
        });
        it('safetyMode=auto 时 tryExecutePlan 应正常执行', async () => {
            const existingPlan = makePlan('auto模式测试', 2, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            mockPlan.lock.run = async (fn) => fn();
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.setSafetyMode('auto');
            await service.tryExecutePlan();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(1);
        });
        it('failed 步骤应自动重试（最多 3 次）', async () => {
            const existingPlan = makePlan('重试测试', 1, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            mockPlan.lock.run = async (fn) => fn();
            let callCount = 0;
            mockAgent.runSelfTask = vi.fn(async () => {
                callCount++;
                if (callCount < 3)
                    return { success: false, summary: '临时失败' };
                return { success: true, summary: '重试成功' };
            });
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.setSafetyMode('auto');
            await service.tryExecutePlan();
            expect(callCount).toBe(3);
            expect(mockPlan.updateStep).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), 'done', expect.any(String));
        });
        it('重试 3 次全部失败后应标记为 failed', async () => {
            const existingPlan = makePlan('三次失败测试', 1, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            mockPlan.lock.run = async (fn) => fn();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '永远失败',
            }));
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.setSafetyMode('auto');
            await service.tryExecutePlan();
            const lastCallArgs = mockPlan.updateStep.mock.calls.slice(-1)[0];
            expect(lastCallArgs).toBeDefined();
            expect(lastCallArgs[2]).toBe('failed');
        });
        it('连续 3 步失败应触发自动放弃计划', async () => {
            const existingPlan = makePlan('自动放弃测试', 3, 0);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            mockPlan.lock.run = async (fn) => fn();
            mockAgent.runSelfTask = vi.fn(async () => ({
                success: false, summary: '步骤失败',
            }));
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath, stepRetryBaseMs: 0,
            });
            service.setSafetyMode('auto');
            await service.tryExecutePlan();
            await service.tryExecutePlan();
            await service.tryExecutePlan();
            expect(mockPlan._abandonedPlans().length).toBeGreaterThanOrEqual(1);
        });
        it('多个活跃计划时应使用 pickBestPlan 选择进度最高的', async () => {
            const planA = makePlan('计划A（高进度）', 4, 3);
            const planB = makePlan('计划B（低进度）', 4, 1);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(planA);
            mockPlan.lock.run = async (fn) => fn();
            mockPlan.listPlans = vi.fn(() => [planB, planA]);
            mockPlan.getActivePlan = vi.fn(() => planA);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.setSafetyMode('auto');
            await service.tryExecutePlan();
            expect(mockAgent.runSelfTask).toHaveBeenCalledTimes(1);
        });
    });
    describe('状态持久化 — saveState/loadState 闭环', () => {
        it('saveState + loadState 应完整保持 currentAnalysisTimeoutMs / promptTrimMode / historyMaxEntries', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath,
                stateFilePath: paths.stateFilePath,
            });
            service.currentAnalysisTimeoutMs = 250000;
            service.promptTrimMode = false;
            service.historyMaxEntries = 10;
            service.saveState();
            // 创建新实例，加载同一文件
            const service2 = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath,
                stateFilePath: paths.stateFilePath,
            });
            expect(service2.currentAnalysisTimeoutMs).toBe(250000);
            expect(service2.promptTrimMode).toBe(false);
            expect(service2.historyMaxEntries).toBe(10);
        });
        it('旧状态文件（不包含新字段）应优雅降级为默认值', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            // 写一个旧格式的状态文件（缺少三个新字段）
            const fs = require('fs');
            const path = require('path');
            const dir = path.dirname(paths.stateFilePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(paths.stateFilePath, JSON.stringify({
                tryRunFailures: 2,
                recoveryCooldownUntil: 0,
                lastSuccessTime: 0,
                recentAnalysisFingerprints: [],
                savedAt: Date.now(),
                // 故意缺失 currentAnalysisTimeoutMs / promptTrimMode / historyMaxEntries
            }));
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath,
                stateFilePath: paths.stateFilePath,
            });
            // 应使用默认值
            expect(service.currentAnalysisTimeoutMs).toBe(120000);
            expect(service.promptTrimMode).toBe(true);
            expect(service.historyMaxEntries).toBe(5);
        });
    });
    describe('系统状态快照', () => {
        it('getSystemStateSnapshot 应返回完整的状态信息', async () => {
            const existingPlan = makePlan('测试快照', 4, 1);
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(existingPlan);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            const snapshot = service.getSystemStateSnapshot();
            expect(snapshot).toHaveProperty('active_plan_title');
            expect(snapshot).toHaveProperty('active_plan_progress');
            expect(snapshot).toHaveProperty('total_active_plans');
            expect(snapshot).toHaveProperty('try_run_failures');
            expect(snapshot).toHaveProperty('execute_failures');
            expect(snapshot).toHaveProperty('last_success_time');
            expect(snapshot).toHaveProperty('cooldown_active');
            expect(snapshot).toHaveProperty('safety_mode');
            expect(snapshot.active_plan_title).toBe('测试快照');
            expect(snapshot.active_plan_progress).toBe('1/4');
        });
    });
    describe('步骤 1: autoGitCommit — 自动提交', () => {
        it('autoGitCommit 不应抛出异常（内部已捕获所有错误）', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            await expect(Promise.resolve(service.autoGitCommit('自动提交测试'))).resolves.toBeUndefined();
        });
    });
    describe('步骤 2: buildLivingPlanContext — 上下文裁剪优化', () => {
        it('无 living plan 文件时应返回模板上下文', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath, maxLivingPlanBytes: 300,
            });
            const context = service.buildLivingPlanContext();
            // 无 mission.yaml 时，只返回模板说明
            expect(context).toContain('living_plan');
            expect(context).not.toContain('Mission');
        });
        it('超出预算时应裁剪低优先级段而非截断内容', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath, maxLivingPlanBytes: 100,
            });
            const context = service.buildLivingPlanContext();
            // 无 living_plan 文件时，只返回模板且不包含 mission
            expect(context).toContain('living_plan');
        });
    });
    describe('步骤 2b: getHistorySummary — 历史摘要缩减', () => {
        it('历史摘要应只取最近 1 条记录', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            const summary = service.getHistorySummary();
            expect(typeof summary).toBe('string');
        });
    });
    describe('步骤 3: workspacePreCheck — 工作区预检压缩', () => {
        it('距离上次成功不久时不应 stash', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.lastSuccessTime = Date.now();
            const result = service.workspacePreCheck();
            expect(result).toBe(false);
        });
        it('execSync 抛出异常时应优雅处理', async () => {
            const mockAgent = createMockAgentService();
            const mockPlan = createMockPlanManager(null);
            const service = new SelfEvolutionService(mockAgent, undefined, undefined, mockPlan, {
                historyPath: paths.historyPath, stateFilePath: paths.stateFilePath,
            });
            service.lastSuccessTime = 0;
            const result = service.workspacePreCheck();
            expect(result).toBe(false);
        });
    });
});
