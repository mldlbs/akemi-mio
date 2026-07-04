import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessManager } from '../ProcessManager';
describe('ProcessManager', () => {
    let pm;
    beforeEach(() => {
        pm = new ProcessManager();
    });
    it('initializes with default config', async () => {
        await pm.init();
        expect(pm.state).toBe('ready');
    });
    it('start/stop lifecycle', async () => {
        await pm.init();
        await pm.start();
        expect(pm.state).toBe('running');
        await pm.stop();
        expect(pm.state).toBe('stopped');
    });
    it('healthCheck returns healthy with no processes', async () => {
        await pm.init();
        await pm.start();
        const hc = await pm.healthCheck();
        expect(hc.healthy).toBe(true);
        expect(hc.detail).toContain('0/0');
        await pm.stop();
    });
    it('isRunning returns false for unregistered process', () => {
        expect(pm.isRunning('nonexistent')).toBe(false);
    });
    it('getUtilization returns null for unregistered process', () => {
        expect(pm.getUtilization('nonexistent')).toBeNull();
    });
    it('allows custom config via constructor', () => {
        const custom = new ProcessManager({ maxRestarts: 3, maxMemoryMb: 512 });
        expect(custom).toBeInstanceOf(ProcessManager);
    });
    it('handles registration before init gracefully', () => {
        pm.register('test', 'some/path.ts', { maxMemoryMb: 128 });
        expect(pm.isRunning('test')).toBe(false);
    });
});
