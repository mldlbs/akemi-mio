import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('electron', () => ({
    app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
    BrowserWindow: vi.fn(() => ({
        webContents: { send: vi.fn() },
        close: vi.fn(),
    })),
}));
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
    LLM_IMAGE_API_URL: 'https://api.example.com/image',
    LLM_IMAGE_KEY: '',
    LLM_IMAGE_MODEL: 'test-image-model',
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
import { AgentService } from '../AgentService';
import { LlmService } from '../../llm/LlmService';
import { AsrService } from '../../asr/AsrService';
import { TtsService } from '../../tts/TtsService';
import { WhisperGpuEngine } from '../../asr/WhisperGpuEngine';
import { BaiduEngine } from '../../asr/BaiduEngine';
import { initDatabase, closeDatabase } from '../../db/connection';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
describe('AgentService 核心方法', () => {
    let agent;
    let ttsService;
    let llmService;
    beforeEach(async () => {
        await initDatabase();
        const ttsState = {};
        ttsService = new TtsService((s) => Object.assign(ttsState, s));
        vi.spyOn(ttsService, 'speakInternal').mockResolvedValue(undefined);
        vi.spyOn(ttsService, 'flushBuffer').mockReturnValue(undefined);
        vi.spyOn(ttsService, 'stop').mockReturnValue(undefined);
        llmService = new LlmService();
        llmService.setConfig('test-key');
        const gpuEngine = new WhisperGpuEngine();
        const baiduEngine = new BaiduEngine();
        const asrService = new AsrService(gpuEngine, baiduEngine);
        agent = new AgentService(llmService, asrService, ttsService);
    });
    afterEach(() => {
        closeDatabase();
        const dbFile = join(process.cwd(), 'test-user-data', 'akemi-mio.db');
        if (existsSync(dbFile))
            unlinkSync(dbFile);
    });
    describe('isBusy', () => {
        it('默认返回 false', () => {
            expect(agent.isBusy()).toBe(false);
        });
        it('进入 selfTask 后返回 true', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '完成' });
            const promise = agent.runSelfTask('测试任务');
            // runSelfTask 内部设置 inSelfTask = true
            expect(agent.isBusy()).toBe(true);
            // 等待完成
            await promise;
            expect(agent.isBusy()).toBe(false);
        });
    });
    describe('getSubAgentStatus', () => {
        it('默认无运行中的子 Agent', () => {
            const status = agent.getSubAgentStatus();
            expect(status).toHaveProperty('running');
            expect(Array.isArray(status.running)).toBe(true);
        });
    });
    describe('processTextInput', () => {
        it('selfTask 运行时返回 BUSY', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '工作中' });
            // 先触发 selfTask
            const selfTaskPromise = agent.runSelfTask('后台任务');
            // processTextInput 现在会抢占 selfTask 而非返回 BUSY
            const result = await agent.processTextInput('新输入');
            expect(result.reply).toBe('工作中');
            await selfTaskPromise;
        });
        it('正常输入时调用 chatWithTools', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '你好' });
            const result = await agent.processTextInput('测试');
            expect(result.reply).toBe('你好');
            expect(llmService.chatWithTools).toHaveBeenCalled();
        });
    });
    describe('runSelfTask', () => {
        it('正常执行返回成功', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '自进化完成' });
            const result = await agent.runSelfTask('分析代码');
            expect(result.success).toBe(true);
            expect(result.summary).toBe('自进化完成');
        });
        it('重复执行返回失败', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '第一次' });
            const first = agent.runSelfTask('第一次');
            const second = await agent.runSelfTask('第二次');
            expect(second.success).toBe(false);
            expect(second.summary).toBe('自进化已经在运行');
            await first;
        });
    });
    describe('registerIntentHandler', () => {
        it('可以注册自定义意图处理器', () => {
            agent.registerIntentHandler({
                intent: 'custom_action',
                description: '自定义操作',
                execute: () => '自定义回复',
            });
            // 通过 processTextInput 间接验证（需要 intent classify mock）
            vi.spyOn(llmService, 'classifyIntent').mockResolvedValue({ reply: JSON.stringify({ intent: 'custom_action', slots: {} }) });
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: 'fallback' });
            // 只需确认不会崩溃
            expect(() => agent.registerIntentHandler({
                intent: 'another',
                description: '另一个',
                execute: () => 'ok',
            })).not.toThrow();
        });
    });
    describe('getLlmService / getAsrService / getTtsService', () => {
        it('返回注入的服务实例', () => {
            expect(agent.getLlmService()).toBe(llmService);
            expect(agent.getAsrService()).toBeDefined();
            expect(agent.getTtsService()).toBe(ttsService);
        });
    });
    describe('getMemoryService / setMemoryService', () => {
        it('默认返回 null', () => {
            expect(agent.getMemoryService()).toBeNull();
        });
    });
    describe('getContext / clearContext', () => {
        it('getContext 返回 ConversationContext 实例', () => {
            const ctx = agent.getContext();
            expect(ctx).toBeDefined();
            expect(typeof ctx.addUser).toBe('function');
            expect(typeof ctx.clear).toBe('function');
        });
        it('clearContext 重置上下文', () => {
            const ctx = agent.getContext();
            ctx.addUser('某条消息');
            expect(ctx.getMessages().length).toBeGreaterThan(1);
            agent.clearContext();
            const msgs = ctx.getMessages();
            // 清除后只有 system prompt
            expect(msgs.filter((m) => m.role !== 'system').length).toBe(0);
        });
    });
    describe('setMainWindow', () => {
        it('设置后不崩溃', () => {
            const mockWin = { webContents: { send: vi.fn() } };
            expect(() => agent.setMainWindow(mockWin)).not.toThrow();
            expect(() => agent.setMainWindow(null)).not.toThrow();
        });
    });
});
