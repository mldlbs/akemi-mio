export class WorkerManager {
    constructor(registry, options) {
        this.slots = [];
        this.services = {};
        this.budget = null;
        this.registry = registry;
        this.emitFn = options?.emit ?? (() => { });
        this.logFn = options?.log ?? (() => { });
        this.budget = options?.budget ?? null;
        const maxSlots = options?.maxConcurrency ?? 4;
        for (let i = 0; i < maxSlots; i++) {
            this.slots.push({
                name: `slot_${i}`,
                busy: false,
                currentTaskId: null,
                startedAt: null,
            });
        }
    }
    setServices(svcs) {
        this.services = svcs;
    }
    setBudget(budget) {
        this.budget = budget;
    }
    async execute(task) {
        // Hard Budget: consume 会抛出 BudgetExceededError
        if (this.budget) {
            this.budget.consumeToolLoopTurn();
        }
        const slot = await this.acquireSlot(task.id);
        try {
            slot.busy = true;
            slot.currentTaskId = task.id;
            slot.startedAt = Date.now();
            const handler = this.registry.getHandler(task.type);
            if (!handler) {
                throw new Error(`No handler for task type "${task.type}"`);
            }
            const context = {
                signal: new AbortController().signal,
                services: this.services,
                emit: (event, payload) => this.emitFn(event, payload),
                log: (level, msg, meta) => this.logFn(level, msg, meta),
            };
            return await handler(task, context);
        }
        finally {
            this.budget?.startRequest();
            slot.busy = false;
            slot.currentTaskId = null;
            slot.startedAt = null;
        }
    }
    getBusyCount() {
        return this.slots.filter((s) => s.busy).length;
    }
    getAvailableSlots() {
        return this.slots.filter((s) => !s.busy).length;
    }
    listSlots() {
        return this.slots.map((s) => ({ ...s }));
    }
    async acquireSlot(taskId) {
        const free = this.slots.find((s) => !s.busy);
        if (free)
            return free;
        return new Promise((resolve) => {
            const check = () => {
                const slot = this.slots.find((s) => !s.busy);
                if (slot)
                    return resolve(slot);
                setTimeout(check, 100);
            };
            check();
        });
    }
}
