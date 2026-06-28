import { describe, it, expect, vi } from 'vitest';
import { RuntimeHealthManager } from '../RuntimeHealthManager';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
describe('RuntimeHealthManager 压力测试', () => {
    it('1000 次 evaluateAll 后 compositeScore 始终在 [0,100]', () => {
        const manager = new RuntimeHealthManager();
        const scores = [];
        for (let i = 0; i < 1000; i++) {
            const cycle = i % 10;
            const s = cycle < 2 ? 100 : cycle < 5 ? Math.floor(Math.random() * 50) + 50 : Math.floor(Math.random() * 50);
            const session = { getScore: () => s, getLevel: () => 'NORMAL', getConsecutiveFailures: () => (s < 50 ? 10 : 0) };
            const cap = {
                getCapabilitySummary: () => ({
                    totalCapabilityHealth: s,
                    servers: [{ name: `srv${i % 3}`, healthScore: s, driftDetected: s < 80 }],
                }),
            };
            const task = {
                getTaskHealthSummary: () => [
                    { type: 't1', status: s < 50 ? 'cooldown' : 'idle', consecutiveFailures: s < 50 ? 5 : 0, tier: 'best_effort', disabled: s < 50 },
                ],
            };
            manager.setSessionHealthProvider(session);
            manager.setCapabilityHealthProvider(cap);
            manager.setTaskHealthProvider(task);
            manager.evaluateAll();
            const comp = manager.getCompositeScore();
            expect(comp).toBeGreaterThanOrEqual(0);
            expect(comp).toBeLessThanOrEqual(100);
            scores.push(comp);
        }
        const unique = new Set(scores);
        expect(unique.size).toBeGreaterThan(1);
    });
    it('10 并发 getSnapshot 不崩溃', async () => {
        const manager = new RuntimeHealthManager();
        const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => manager.getSnapshot())));
        expect(results).toHaveLength(10);
        for (const snap of results) {
            expect(snap.composite.score).toBeGreaterThanOrEqual(0);
            expect(snap.composite.score).toBeLessThanOrEqual(100);
            expect(snap.recommendedActions).toBeInstanceOf(Array);
        }
    });
    it('10000 ModelHealthTracker 事件模拟收敛正确', () => {
        const manager = new RuntimeHealthManager();
        manager.modelHealth.start();
        for (let i = 0; i < 10000; i++) {
            const mod = i % 10;
            if (mod < 7) {
                ;
                manager.modelHealth.successCount++;
            }
            else {
                ;
                manager.modelHealth.failureCount++;
            }
            if (mod >= 8) {
                const cat = i % 2 === 0 ? 'RETRYABLE' : 'TIMEOUT';
                manager.modelHealth.errorCounts[cat] = (manager.modelHealth.errorCounts[cat] || 0) + 1;
            }
        }
        const h = manager.modelHealth.getHealth();
        expect(h.totalToolCalls).toBe(10000);
        expect(h.successCount).toBe(7000);
        expect(h.failureCount).toBe(3000);
        // 0.7 * (1 - 2*0.15) = 0.7 * 0.7 = 0.49 → 49
        expect(h.score).toBe(49);
        manager.modelHealth.stop();
    });
});
