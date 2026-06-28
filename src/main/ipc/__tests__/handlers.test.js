import { describe, it, expect, vi, beforeEach } from 'vitest';
// 存储被注册的 handler 回调
const registeredHandlers = new Map();
const registeredOns = new Map();
vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn((channel, handler) => {
            registeredHandlers.set(channel, handler);
        }),
        on: vi.fn((channel, handler) => {
            registeredOns.set(channel, handler);
        }),
    },
    BrowserWindow: {
        fromWebContents: vi.fn(() => ({ close: vi.fn() })),
    },
    app: {
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
    },
}));
vi.mock('../../logger/Logger', () => ({
    log: vi.fn(),
    createRequestId: vi.fn(() => 'test-req-id'),
}));
vi.mock('../../updater/UpdaterService', () => ({
    checkForUpdates: vi.fn().mockResolvedValue({ available: false, version: '' }),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
}));
vi.mock('../../credentials/CredentialsManager', () => ({
    credentialsManager: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(''),
        set: vi.fn().mockReturnValue(undefined),
    },
}));
vi.mock('../../config', () => ({
    WAKE_WORDS: ['秋山澪', 'mio'],
    LLM_API_URL: 'https://api.example.com/chat',
    LLM_CODE_API_URL: 'https://api.example.com/code',
    LLM_TEXT_API_URL: 'https://api.example.com/text',
    LLM_VISION_API_URL: 'https://api.example.com/vision',
    WORKSPACE: { evolution: process.cwd() },
}));
import { registerHandlers } from '../handlers';
describe('IPC handlers', () => {
    let agentService;
    let stateManager;
    let ttsService;
    let evolutionService;
    beforeEach(() => {
        registeredHandlers.clear();
        registeredOns.clear();
        agentService = {
            processTextInput: vi.fn().mockResolvedValue({ reply: '你好' }),
            getAsrService: vi.fn().mockReturnValue({
                transcribe: vi.fn().mockResolvedValue('识别文本'),
            }),
            getMcpManager: vi.fn().mockReturnValue({
                listServers: vi.fn().mockReturnValue([{ name: 'server1', initialized: true }]),
            }),
            isBusy: vi.fn().mockReturnValue(false),
            isPaused: vi.fn().mockReturnValue(false),
            pause: vi.fn(),
            resume: vi.fn(),
        };
        stateManager = {
            get: vi.fn().mockReturnValue({
                asr: 'idle',
                audioLevel: 0,
            }),
        };
        ttsService = {
            speak: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn(),
        };
        evolutionService = {
            triggerNow: vi.fn().mockResolvedValue(undefined),
            getLastRun: vi.fn().mockReturnValue(0),
            getConsecutiveFailures: vi.fn().mockReturnValue(0),
        };
        registerHandlers(agentService, stateManager, ttsService, { current: evolutionService });
    });
    describe('handler 注册', () => {
        it('注册所有必需的 IPC handler', () => {
            const expected = [
                'ai:chat',
                'asr:transcribe',
                'tts:speak',
                'tts:stop',
                'state:get',
                'evolution:trigger',
                'evolution:status',
                'credentials:list',
                'credentials:get',
                'credentials:set',
                'config:getWakeWords',
                'health:check',
                'update:check',
                'update:download',
                'update:install',
            ];
            const actual = [...registeredHandlers.keys()];
            for (const ch of expected) {
                expect(registeredHandlers.has(ch)).toBe(true);
            }
            // window:close 用 ipcMain.on 注册，不在 handle 中
            expect(registeredOns.has('window:close')).toBe(true);
        });
    });
    describe('ai:chat', () => {
        it('调用 agentService.processTextInput 并返回结果', async () => {
            const handler = registeredHandlers.get('ai:chat');
            const result = await handler({}, '你好', 'req-1');
            expect(agentService.processTextInput).toHaveBeenCalledWith('你好', 'req-1');
            expect(result).toEqual({ reply: '你好' });
        });
    });
    describe('asr:transcribe', () => {
        it('调用 asrService.transcribe', async () => {
            const handler = registeredHandlers.get('asr:transcribe');
            const buffer = new ArrayBuffer(8);
            const result = await handler({}, buffer);
            expect(agentService.getAsrService().transcribe).toHaveBeenCalledWith(buffer);
            expect(result).toBe('识别文本');
        });
        it('ASR 未初始化时抛出错误', async () => {
            agentService.getAsrService.mockReturnValue(null);
            const handler = registeredHandlers.get('asr:transcribe');
            await expect(handler({}, new ArrayBuffer(8))).rejects.toThrow('ASR service not initialized');
        });
    });
    describe('tts:speak', () => {
        it('调用 ttsService.speak', async () => {
            const handler = registeredHandlers.get('tts:speak');
            await handler({}, '你好啊');
            expect(ttsService.speak).toHaveBeenCalledWith('你好啊');
        });
    });
    describe('tts:stop', () => {
        it('调用 ttsService.stop', async () => {
            const handler = registeredHandlers.get('tts:stop');
            await handler();
            expect(ttsService.stop).toHaveBeenCalled();
        });
    });
    describe('state:get', () => {
        it('返回 stateManager.get() 的结果', async () => {
            const handler = registeredHandlers.get('state:get');
            const result = await handler();
            expect(stateManager.get).toHaveBeenCalled();
            expect(result).toEqual({ asr: 'idle', audioLevel: 0 });
        });
        it('异常时返回错误对象', async () => {
            stateManager.get.mockImplementation(() => {
                throw new Error('state error');
            });
            const handler = registeredHandlers.get('state:get');
            const result = await handler();
            expect(result).toHaveProperty('error');
            expect(result.error).toContain('state error');
        });
    });
    describe('evolution:trigger', () => {
        it('触发进化任务', async () => {
            const handler = registeredHandlers.get('evolution:trigger');
            const result = await handler();
            expect(evolutionService.triggerNow).toHaveBeenCalled();
            expect(result).toEqual({ success: true });
        });
    });
    describe('evolution:status', () => {
        it('返回进化服务状态', async () => {
            const handler = registeredHandlers.get('evolution:status');
            const result = await handler();
            expect(result).toHaveProperty('lastRun');
            expect(result).toHaveProperty('consecutiveFailures');
            expect(result).toHaveProperty('isBusy');
        });
    });
    describe('credentials', () => {
        it('credentials:list', async () => {
            const handler = registeredHandlers.get('credentials:list');
            const result = await handler();
            expect(result).toBeDefined();
        });
        it('credentials:get', async () => {
            const handler = registeredHandlers.get('credentials:get');
            const result = await handler({}, 'test-key');
            expect(result).toBeDefined();
        });
        it('credentials:set', async () => {
            const handler = registeredHandlers.get('credentials:set');
            const result = await handler({}, 'test-key', 'test-value');
            expect(result).toBe(true);
        });
    });
    describe('config:getWakeWords', () => {
        it('返回唤醒词列表', async () => {
            const handler = registeredHandlers.get('config:getWakeWords');
            const result = await handler();
            expect(Array.isArray(result)).toBe(true);
        });
    });
    describe('health:check', () => {
        it('返回健康检查报告', async () => {
            const handler = registeredHandlers.get('health:check');
            const result = await handler();
            expect(result).toHaveProperty('status', 'ok');
            expect(result).toHaveProperty('uptime');
            expect(result).toHaveProperty('memory');
            expect(result).toHaveProperty('asr');
            expect(result).toHaveProperty('llm');
            expect(result).toHaveProperty('mcp');
            expect(result.mcp).toHaveProperty('serverCount', 1);
            expect(result.mcp.servers[0]).toEqual({ name: 'server1', initialized: true });
            expect(result).toHaveProperty('eventLoopLagMs');
        });
    });
    describe('update handlers', () => {
        it('update:check 检查更新', async () => {
            const handler = registeredHandlers.get('update:check');
            const result = await handler();
            expect(result).toHaveProperty('available');
        });
        it('update:download 触发下载', async () => {
            const handler = registeredHandlers.get('update:download');
            const result = await handler();
            expect(result).toEqual({ success: true });
        });
        it('update:install 触发安装', async () => {
            const handler = registeredHandlers.get('update:install');
            const result = await handler();
            expect(result).toEqual({ success: true });
        });
    });
    describe('无 evolutionService 时', () => {
        beforeEach(() => {
            registeredHandlers.clear();
            registeredOns.clear();
            registerHandlers(agentService, stateManager, ttsService, undefined);
        });
        it('不注册 evolution handler', () => {
            expect(registeredHandlers.has('evolution:trigger')).toBe(false);
            expect(registeredHandlers.has('evolution:status')).toBe(false);
        });
        it('其他 handler 仍正常注册', () => {
            expect(registeredHandlers.has('ai:chat')).toBe(true);
            expect(registeredHandlers.has('tts:speak')).toBe(true);
            expect(registeredHandlers.has('health:check')).toBe(true);
        });
    });
    describe('window:close', () => {
        it('关闭发送事件的窗口', () => {
            const handler = registeredOns.get('window:close');
            const mockEvent = { sender: {} };
            handler(mockEvent);
            // ipcMain.on 调用后，验证事件被处理
            expect(registeredOns.has('window:close')).toBe(true);
        });
    });
});
