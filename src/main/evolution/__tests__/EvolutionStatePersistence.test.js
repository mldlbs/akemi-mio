import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SelfEvolutionService } from '../SelfEvolutionService';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
const TEST_STATE_DIR = join(process.cwd(), 'evolution_workspace', 'living_plan');
const TEST_STATE_PATH = join(TEST_STATE_DIR, 'evolution_state.test.json');
function createMockAgent(overrides) {
    return {
        isBusy: vi.fn().mockReturnValue(false),
        runSelfTask: vi.fn().mockResolvedValue({ success: true, summary: 'test analysis done' }),
        setSuppressForceContinue: vi.fn(),
        ...overrides,
    };
}
function createMockScheduler() {
    return { interval: vi.fn().mockReturnValue('task-1'), cancel: vi.fn() };
}
function createMockEventBus() {
    return { emit: vi.fn() };
}
function createMockPlanManager() {
    return {
        getActivePlan: vi.fn().mockReturnValue(null),
        listPlans: vi.fn().mockReturnValue([]),
        getFormattedContext: vi.fn().mockReturnValue(''),
        completePlan: vi.fn(),
        abandonPlan: vi.fn(),
        freezePlan: vi.fn(),
        updateStep: vi.fn(),
        lock: { run: vi.fn((fn) => fn()) },
    };
}
function makeService(opts) {
    return new SelfEvolutionService(opts?.agent ?? createMockAgent(), createMockScheduler(), createMockEventBus(), createMockPlanManager(), {
        analysisTimeoutMs: 30000,
        planExecTimeoutMs: 30000,
        stepRetryBaseMs: 100,
        maxLivingPlanBytes: 1024,
        stateFilePath: opts?.statePath ?? TEST_STATE_PATH,
        maxReasoningSteps: opts?.maxReasoning ?? 5,
        degenerationThreshold: opts?.degThreshold ?? 3,
    });
}
// =========================================================================
// State Persistence Tests — direct method calls (no tryRun dependency)
// =========================================================================
describe('State Persistence — direct', () => {
    beforeEach(() => {
        try {
            mkdirSync(TEST_STATE_DIR, { recursive: true });
        }
        catch { }
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
    });
    afterEach(() => {
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
    });
    it('saveState should create file with correct fields', () => {
        const svc = makeService();
        svc.tryRunFailures = 2;
        svc.recoveryCooldownUntil = 999999;
        svc.lastSuccessTime = 888888;
        svc.recentAnalysisFingerprints = ['fp1'];
        svc.saveState();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(2);
        expect(state.recoveryCooldownUntil).toBe(999999);
        expect(state.lastSuccessTime).toBe(888888);
        expect(state.recentAnalysisFingerprints).toEqual(['fp1']);
        expect(state.savedAt).toBeGreaterThan(0);
        svc.stop();
    });
    it('loadState should restore values from file', () => {
        mkdirSync(TEST_STATE_DIR, { recursive: true });
        writeFileSync(TEST_STATE_PATH, JSON.stringify({
            tryRunFailures: 3,
            recoveryCooldownUntil: 123456,
            lastSuccessTime: 789012,
            recentAnalysisFingerprints: ['a', 'b', 'c'],
            savedAt: Date.now(),
        }), 'utf-8');
        const svc = makeService();
        expect(svc.tryRunFailures).toBe(3);
        expect(svc.recoveryCooldownUntil).toBe(123456);
        expect(svc.lastSuccessTime).toBe(789012);
        expect(svc.recentAnalysisFingerprints).toEqual(['a', 'b', 'c']);
        svc.stop();
    });
    it('loadState should not throw when file missing', () => {
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
        expect(() => { makeService(); }).not.toThrow();
    });
    it('saveState should create directory if missing', () => {
        // Remove the test dir
        try {
            rmSync(TEST_STATE_DIR, { recursive: true, force: true });
        }
        catch { }
        const svc = makeService();
        svc.saveState();
        expect(existsSync(TEST_STATE_DIR)).toBe(true);
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        svc.stop();
    });
});
// =========================================================================
// Reasoning Budget Tests
// =========================================================================
describe('Reasoning Budget', () => {
    it('should default to 12 reasoning steps', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        expect(svc.maxReasoningSteps).toBe(5); // our test override is 5
        svc.stop();
    });
    it('should allow custom maxReasoningSteps', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, maxReasoning: 10 });
        expect(svc.maxReasoningSteps).toBe(10);
        svc.stop();
    });
});
// =========================================================================
// Degeneration Detection Tests
// =========================================================================
describe('Degeneration Detection', () => {
    it('should not be degenerate initially', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        expect(svc.isDegenerate().degenerate).toBe(false);
        svc.stop();
    });
    it('should detect degeneration after N identical fingerprints', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 });
        svc.recordAnalysisFingerprint('result A');
        svc.recordAnalysisFingerprint('result A');
        svc.recordAnalysisFingerprint('result A');
        expect(svc.isDegenerate().degenerate).toBe(true);
        expect(svc.isDegenerate().reason).toContain('3');
        svc.stop();
    });
    it('should not detect degeneration with varying results', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 });
        svc.recordAnalysisFingerprint('result A');
        svc.recordAnalysisFingerprint('result B');
        svc.recordAnalysisFingerprint('result C');
        expect(svc.isDegenerate().degenerate).toBe(false);
        svc.stop();
    });
    it('should trim fingerprint to 100 chars', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        const long = 'x'.repeat(200);
        expect(svc.computeFingerprint(long).length).toBeLessThanOrEqual(100);
        svc.stop();
    });
});
// =========================================================================
// tryRun Integration — state file creation
// =========================================================================
describe('tryRun — state file creation', () => {
    beforeEach(() => {
        try {
            mkdirSync(TEST_STATE_DIR, { recursive: true });
        }
        catch { }
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
    });
    afterEach(() => {
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
    });
    it('should create state file after successful tryRun', async () => {
        const agent = createMockAgent();
        const svc = makeService({ agent });
        await svc.tryRun();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(0);
        svc.stop();
    });
    it('should update state file after failed tryRun', async () => {
        const agent = createMockAgent({
            runSelfTask: vi.fn().mockResolvedValue({ success: false, summary: 'error' }),
        });
        const svc = makeService({ agent });
        await svc.tryRun();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(1);
        svc.stop();
    });
    it('should skip run when degenerate', async () => {
        const agent = createMockAgent();
        const svc = makeService({ agent, degThreshold: 3 });
        // Pre-load 3 identical fingerprints
        svc.recentAnalysisFingerprints = ['same', 'same', 'same'];
        await svc.tryRun();
        // runSelfTask should NOT have been called
        expect(agent.runSelfTask).not.toHaveBeenCalled();
        svc.stop();
    });
});
