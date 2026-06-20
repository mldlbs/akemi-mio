import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngineRegistry } from '../core/EngineRegistry';
describe('EngineRegistry', () => {
    let mockBus;
    let registry;
    const ttsEngine1 = { name: 'edge-tts', type: 'tts', priority: 10, available: true };
    const ttsEngine2 = { name: 'elevenlabs', type: 'tts', priority: 5, available: true };
    const ttsEngine3 = { name: 'offline', type: 'tts', priority: 1, available: false };
    const asrEngine = { name: 'whisper', type: 'asr', priority: 8, available: true };
    beforeEach(() => {
        mockBus = { emit: vi.fn() };
        registry = new EngineRegistry(mockBus);
    });
    describe('register', () => {
        it('应该注册引擎并广播 registered 事件', () => {
            registry.register(ttsEngine1);
            expect(registry.get('edge-tts')).toEqual(ttsEngine1);
            expect(mockBus.emit).toHaveBeenCalledWith('engine.registered', {
                name: 'edge-tts',
                type: 'tts',
            });
        });
        it('注册第一个引擎时应自动设为激活并广播 activated 事件', () => {
            registry.register(ttsEngine1);
            expect(registry.getActive()).toEqual(ttsEngine1);
            expect(mockBus.emit).toHaveBeenCalledWith('engine.activated', {
                name: 'edge-tts',
                previous: null,
            });
        });
        it('注册非首个引擎时不自动切换激活', () => {
            registry.register(ttsEngine1);
            mockBus.emit.mockClear();
            registry.register(ttsEngine2);
            expect(registry.getActive()).toEqual(ttsEngine1);
            expect(mockBus.emit).not.toHaveBeenCalledWith('engine.activated', expect.anything());
        });
        it('重复注册同名引擎应覆盖旧值', () => {
            registry.register(ttsEngine1);
            const updated = { ...ttsEngine1, priority: 20 };
            registry.register(updated);
            expect(registry.get('edge-tts')?.priority).toBe(20);
            expect(registry.list()).toHaveLength(1);
        });
        it('注册不同引擎类型的引擎应正常共存', () => {
            registry.register(ttsEngine1);
            registry.register(asrEngine);
            expect(registry.list()).toHaveLength(2);
        });
        it('注册引擎后应使级联缓存失效', () => {
            registry.register(ttsEngine1);
            registry.getCascade(); // 填充缓存
            registry.register(ttsEngine2);
            // 再次获取应包含新引擎
            const cascade = registry.getCascade();
            expect(cascade.find(e => e.name === 'elevenlabs')).toBeDefined();
        });
    });
    describe('unregister', () => {
        it('应该移除引擎并广播 unregistered 事件', () => {
            registry.register(ttsEngine1);
            mockBus.emit.mockClear();
            const result = registry.unregister('edge-tts');
            expect(result).toBe(true);
            expect(registry.get('edge-tts')).toBeUndefined();
            expect(mockBus.emit).toHaveBeenCalledWith('engine.unregistered', { name: 'edge-tts' });
        });
        it('移除激活中的引擎时应自动切换到下一个可用引擎并广播 activated', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            mockBus.emit.mockClear();
            registry.unregister('edge-tts');
            expect(registry.getActive()).toEqual(ttsEngine2);
            expect(mockBus.emit).toHaveBeenCalledWith('engine.activated', {
                name: 'elevenlabs',
                previous: 'edge-tts',
            });
        });
        it('移除唯一引擎后 active 应为 undefined', () => {
            registry.register(ttsEngine1);
            mockBus.emit.mockClear();
            registry.unregister('edge-tts');
            expect(registry.getActive()).toBeUndefined();
        });
        it('移除不存在的引擎应返回 true（不报错）', () => {
            const result = registry.unregister('nonexistent');
            expect(result).toBe(true);
        });
        it('移除引擎后应使级联缓存失效', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.getCascade(); // 填充缓存
            registry.unregister('edge-tts');
            const cascade = registry.getCascade();
            expect(cascade.find(e => e.name === 'edge-tts')).toBeUndefined();
        });
    });
    describe('setActive', () => {
        it('应切换激活引擎并广播 switched 事件', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            mockBus.emit.mockClear();
            const result = registry.setActive('elevenlabs');
            expect(result).toBe(true);
            expect(registry.getActive()).toEqual(ttsEngine2);
            expect(mockBus.emit).toHaveBeenCalledWith('engine.switched', {
                name: 'elevenlabs',
                previous: 'edge-tts',
            });
        });
        it('切换不存在的引擎应返回 false', () => {
            registry.register(ttsEngine1);
            const result = registry.setActive('nonexistent');
            expect(result).toBe(false);
        });
        it('切换到当前激活引擎应返回 true 并广播事件', () => {
            registry.register(ttsEngine1);
            mockBus.emit.mockClear();
            const result = registry.setActive('edge-tts');
            expect(result).toBe(true);
            expect(mockBus.emit).toHaveBeenCalledWith('engine.switched', {
                name: 'edge-tts',
                previous: 'edge-tts',
            });
        });
        it('切换引擎后应使级联缓存失效', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.getCascade(); // 填充缓存
            registry.setActive('elevenlabs');
            // 缓存应仍有效但 active 已切换
            expect(registry.getActive()?.name).toBe('elevenlabs');
        });
    });
    describe('getCascade', () => {
        it('未设置 strictOrder 时应按优先级降序返回可用引擎', () => {
            registry.register(ttsEngine2);
            registry.register(ttsEngine3);
            registry.register(ttsEngine1);
            const cascade = registry.getCascade();
            expect(cascade).toHaveLength(2);
            expect(cascade[0].name).toBe('edge-tts');
            expect(cascade[1].name).toBe('elevenlabs');
        });
        it('设置了 strictOrder 时应按指定顺序返回', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.setOrder(['elevenlabs', 'edge-tts']);
            const cascade = registry.getCascade();
            expect(cascade[0].name).toBe('elevenlabs');
            expect(cascade[1].name).toBe('edge-tts');
        });
        it('应过滤掉不可用的引擎', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine3);
            const cascade = registry.getCascade();
            expect(cascade).toHaveLength(1);
            expect(cascade[0].name).toBe('edge-tts');
        });
        it('无可用引擎时应返回空数组', () => {
            registry.register(ttsEngine3);
            const cascade = registry.getCascade();
            expect(cascade).toHaveLength(0);
        });
        it('空注册表时应返回空数组', () => {
            const cascade = registry.getCascade();
            expect(cascade).toHaveLength(0);
        });
        it('strictOrder 中不存在的引擎应被忽略', () => {
            registry.register(ttsEngine1);
            registry.setOrder(['nonexistent', 'edge-tts']);
            const cascade = registry.getCascade();
            expect(cascade).toHaveLength(1);
            expect(cascade[0].name).toBe('edge-tts');
        });
        it('级联缓存生效：多次调用应返回同一引用', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            const first = registry.getCascade();
            const second = registry.getCascade();
            expect(first).toBe(second);
        });
    });
    describe('setOrder', () => {
        it('应更新 strictOrder 配置', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.setOrder(['elevenlabs', 'edge-tts']);
            const cascade = registry.getCascade();
            expect(cascade[0].name).toBe('elevenlabs');
        });
        it('设置空数组应回到按优先级排序', () => {
            registry.register(ttsEngine2);
            registry.register(ttsEngine1);
            registry.setOrder([]);
            const cascade = registry.getCascade();
            expect(cascade[0].name).toBe('edge-tts');
        });
        it('设置顺序后应使级联缓存失效', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.getCascade(); // 填充缓存
            registry.setOrder(['elevenlabs', 'edge-tts']);
            const cascade = registry.getCascade();
            expect(cascade[0].name).toBe('elevenlabs');
        });
    });
    describe('get', () => {
        it('应返回指定名称的引擎', () => {
            registry.register(ttsEngine1);
            expect(registry.get('edge-tts')).toEqual(ttsEngine1);
        });
        it('不存在的引擎应返回 undefined', () => {
            expect(registry.get('nonexistent')).toBeUndefined();
        });
    });
    describe('getActive', () => {
        it('未注册任何引擎时应返回 undefined', () => {
            expect(registry.getActive()).toBeUndefined();
        });
        it('应返回当前激活的引擎', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            registry.setActive('elevenlabs');
            expect(registry.getActive()).toEqual(ttsEngine2);
        });
    });
    describe('list', () => {
        it('应返回所有注册的引擎（包括不可用的）', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine3);
            const all = registry.list();
            expect(all).toHaveLength(2);
        });
        it('空注册表时应返回空数组', () => {
            expect(registry.list()).toHaveLength(0);
        });
        it('返回的数组应为副本（不受外部修改影响）', () => {
            registry.register(ttsEngine1);
            const all = registry.list();
            all.pop();
            expect(registry.list()).toHaveLength(1);
        });
    });
    describe('EventBus 事件广播完整性', () => {
        it('注册首个引擎应依次广播 registered 和 activated', () => {
            registry.register(ttsEngine1);
            expect(mockBus.emit.mock.calls.map(c => c[0])).toEqual([
                'engine.activated',
                'engine.registered',
            ]);
        });
        it('注册后续引擎应只广播 registered', () => {
            registry.register(ttsEngine1);
            mockBus.emit.mockClear();
            registry.register(ttsEngine2);
            const events = mockBus.emit.mock.calls.map(c => c[0]);
            expect(events).toEqual(['engine.registered']);
        });
        it('unregister 不活跃引擎应只广播 unregistered', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            mockBus.emit.mockClear();
            registry.unregister('elevenlabs');
            const events = mockBus.emit.mock.calls.map(c => c[0]);
            expect(events).toEqual(['engine.unregistered']);
        });
        it('unregister 活跃引擎应广播 unregistered 和 activated', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            mockBus.emit.mockClear();
            registry.unregister('edge-tts');
            const events = mockBus.emit.mock.calls.map(c => c[0]);
            expect(events).toContain('engine.unregistered');
            expect(events).toContain('engine.activated');
        });
        it('setActive 应广播 switched', () => {
            registry.register(ttsEngine1);
            registry.register(ttsEngine2);
            mockBus.emit.mockClear();
            registry.setActive('elevenlabs');
            expect(mockBus.emit).toHaveBeenCalledWith('engine.switched', expect.anything());
        });
    });
    describe('无 EventBus 构造', () => {
        it('不传 eventBus 时应正常工作不抛出', () => {
            const r = new EngineRegistry();
            r.register(ttsEngine1);
            expect(r.getActive()).toEqual(ttsEngine1);
        });
        it('不传 eventBus 时切换引擎不应抛出', () => {
            const r = new EngineRegistry();
            r.register(ttsEngine1);
            r.register(ttsEngine2);
            expect(() => r.setActive('elevenlabs')).not.toThrow();
        });
    });
});
