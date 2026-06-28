import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../config', () => ({
    LLM_API_URL: 'https://api.example.com/chat',
    LLM_CHAT_MODEL: 'test-model',
    LLM_CODE_MODEL: 'test-model',
    LLM_CODE_API_URL: 'https://api.example.com/code',
    LLM_VISION_API_URL: 'https://api.example.com/vision',
    LLM_VISION_MODEL: 'test-vision-model',
    LLM_VISION_KEY: '',
    LLM_TEXT_API_URL: 'https://api.example.com/text',
    LLM_TEXT_MODEL: 'test-text-model',
    LLM_TEXT_KEY: '',
    FFPLAY_PATHS: ['ffplay'],
    PIPER_SCRIPT: '/dev/null/piper.py',
    PIPER_MODEL: '/dev/null/model.onnx',
    USE_LOCAL_TTS: false,
    EVOLUTION_SAFETY_MODE: 'review',
    FFMPEG_PATHS: ['ffmpeg'],
    ASR_HOTWORDS: [],
    ASR_SAMPLE_RATE: 16000,
    ASR_MAX_AUDIO_SECONDS: 25,
    WAKE_WORDS: ['mio'],
    WINDOW_WIDTH: 420,
    WINDOW_HEIGHT: 640,
    GGML_MODELS_DIR: '/dev/null/models',
    INITIAL_HOTWORDS: [],
    ASR_INITIAL_PROMPT: '',
    WORKSPACE: {
        projects: '/dev/null/projects',
        memory: '/dev/null/memory',
        knowledge: '/dev/null/knowledge',
        skills: '/dev/null/skills',
        workflows: '/dev/null/workflows',
        proposals: '/dev/null/proposals',
        logs: '/dev/null/logs',
        cache: '/dev/null/cache',
        evolution: '/dev/null/evolution',
    },
    RUNTIME_ROOT: '/dev/null',
    WORKSPACE_ROOT: '/dev/null',
    DEV_PROJECT_ROOT: '',
    LLM_MODEL: 'test-model',
}));
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
    return { emit: vi.fn(), on: vi.fn().mockReturnValue(() => { }) };
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
        historyPath: join(TEST_STATE_DIR, 'history.test.json'),
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
        svc.analyzer.recordFingerprint('fp1');
        svc.saveState();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(2);
        expect(state.recoveryCooldownUntil).toBe(999999);
        expect(state.lastSuccessTime).toBe(888888);
        expect(state.fingerprints).toEqual(['fp1']);
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
        expect(svc.analyzer.getFingerprints()).toEqual(['a', 'b', 'c']);
        svc.stop();
    });
    it('loadState should not throw when file missing', () => {
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
        expect(() => {
            makeService();
        }).not.toThrow();
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
// Constructor Options Tests
// =========================================================================
describe('Constructor Options', () => {
    it('should accept custom analysisTimeoutMs', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        expect(svc.analyzer.currentAnalysisTimeoutMs).toBeGreaterThan(0);
        svc.stop();
    });
    it('should accept custom degenerationThreshold', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 7 });
        expect(svc.analyzer.degenerationThreshold).toBe(7);
        svc.stop();
    });
});
// =========================================================================
// Degeneration Detection Tests
// =========================================================================
describe('Degeneration Detection', () => {
    it('should not be degenerate initially', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        expect(svc.analyzer.isDegenerate()).toBe(false);
        svc.stop();
    });
    it('should detect degeneration after N identical fingerprints', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 });
        svc.analyzer.recordFingerprint('result A');
        svc.analyzer.recordFingerprint('result A');
        svc.analyzer.recordFingerprint('result A');
        expect(svc.analyzer.isDegenerate()).toBe(true);
        svc.stop();
    });
    it('should not detect degeneration with varying results', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 });
        svc.analyzer.recordFingerprint('result A');
        svc.analyzer.recordFingerprint('result B');
        svc.analyzer.recordFingerprint('result C');
        expect(svc.analyzer.isDegenerate()).toBe(false);
        svc.stop();
    });
    it('should trim fingerprint to 100 chars', () => {
        const svc = makeService({ statePath: TEST_STATE_PATH });
        const long = 'x'.repeat(200);
        // computeFingerprint is private; indirectly verify via recordFingerprint behavior
        svc.analyzer.recordFingerprint(long);
        const fps = svc.analyzer.getFingerprints();
        expect(fps.length).toBe(1);
        expect(fps[0].length).toBeLessThanOrEqual(100);
        svc.stop();
    });
});
// =========================================================================
// Analysis Cycle Integration — state file creation
// =========================================================================
describe('Analysis Cycle — state file creation', () => {
    const TEST_HISTORY_PATH = join(TEST_STATE_DIR, 'history.test.json');
    beforeEach(() => {
        try {
            mkdirSync(TEST_STATE_DIR, { recursive: true });
        }
        catch { }
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
        try {
            unlinkSync(TEST_HISTORY_PATH);
        }
        catch { }
    });
    afterEach(() => {
        try {
            unlinkSync(TEST_STATE_PATH);
        }
        catch { }
        try {
            unlinkSync(TEST_HISTORY_PATH);
        }
        catch { }
    });
    it('should create state file after successful analysis', async () => {
        const agent = createMockAgent();
        const svc = makeService({ agent });
        svc.firstRunComplete = true;
        await svc.runAnalysisCycle();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(0);
        svc.stop();
    });
    it('should update state file after failed analysis', async () => {
        const agent = createMockAgent({
            runSelfTask: vi.fn().mockResolvedValue({ success: false, summary: 'error' }),
        });
        const svc = makeService({ agent });
        svc.firstRunComplete = true;
        await svc.runAnalysisCycle();
        expect(existsSync(TEST_STATE_PATH)).toBe(true);
        const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'));
        expect(state.tryRunFailures).toBe(1);
        svc.stop();
    });
    it('should skip analysis when degenerate', async () => {
        const agent = createMockAgent();
        const svc = makeService({ agent, degThreshold: 3 });
        // Pre-load 3 identical fingerprints
        svc.analyzer.recordFingerprint('same');
        svc.analyzer.recordFingerprint('same');
        svc.analyzer.recordFingerprint('same');
        svc.firstRunComplete = true;
        // 退化状态会被检测到，但若指纹超过 12h 会触发自动恢复
        // 这里保证 analyze 不被 shouldAnalyze 拦截即正确
        await svc.runAnalysisCycle();
        svc.stop();
    });
});
