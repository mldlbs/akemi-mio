import { EventBus } from './EventBus';
import type { ResourceBudget } from './ResourceBudget';
/**
 * BudgetRebalancer — 预算再平衡器。
 *
 * 监听 budget.exhausted 事件，在 pool 之间动态调配预算。
 * 当某个 pool 耗尽时，从其他有富余的 pool 借调配额。
 * 带防抖机制避免频繁调整。
 */
export declare class BudgetRebalancer {
    private resourceBudget;
    private lastRebalance;
    private readonly DEBOUNCE_MS;
    private readonly STEAL_AMOUNT;
    private unsubscribers;
    private readonly originalMaxChat;
    private readonly originalMaxEvolution;
    constructor(resourceBudget: ResourceBudget, bus?: EventBus);
    private start;
    stop(): void;
    private handleExhausted;
}
