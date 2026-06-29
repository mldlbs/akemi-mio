export class EngineRegistry {
    constructor(eventBus) {
        this.engines = new Map();
        this.active = null;
        this.strictOrder = [];
        this.cascadeCache = null;
        this.eventBus = eventBus || { emit: () => { } };
    }
    invalidateCache() {
        this.cascadeCache = null;
    }
    register(engine) {
        this.engines.set(engine.name, engine);
        if (!this.active) {
            this.active = engine.name;
            this.eventBus.emit('engine.activated', { name: engine.name, previous: null });
        }
        this.eventBus.emit('engine.registered', { name: engine.name, type: engine.type });
        this.invalidateCache();
    }
    unregister(name) {
        const existed = this.engines.has(name);
        this.engines.delete(name);
        if (this.active === name) {
            const previous = this.active;
            this.active = this.engines.keys().next().value || null;
            this.eventBus.emit('engine.activated', { name: this.active, previous });
        }
        if (existed) {
            this.eventBus.emit('engine.unregistered', { name });
        }
        this.invalidateCache();
        return true;
    }
    setActive(name) {
        if (!this.engines.has(name))
            return false;
        const previous = this.active;
        this.active = name;
        this.eventBus.emit('engine.switched', { name, previous });
        this.invalidateCache();
        return true;
    }
    getActive() {
        return this.active ? this.engines.get(this.active) : undefined;
    }
    setOrder(names) {
        this.strictOrder = [...names];
        this.invalidateCache();
    }
    /**
     * 按优先级（或 strictOrder）返回可用引擎列表
     * 用于级联降级：第一个引擎失败时自动尝试下一个
     * 结果缓存至下一次注册/注销/切换操作
     */
    getCascade() {
        if (this.cascadeCache)
            return this.cascadeCache;
        let result;
        if (this.strictOrder.length > 0) {
            result = this.strictOrder
                .map(n => this.engines.get(n))
                .filter(e => e && e.available);
        }
        else {
            result = Array.from(this.engines.values())
                .filter(e => e.available)
                .sort((a, b) => b.priority - a.priority);
        }
        this.cascadeCache = result;
        return result;
    }
    list() {
        return Array.from(this.engines.values());
    }
    get(name) {
        return this.engines.get(name);
    }
}
