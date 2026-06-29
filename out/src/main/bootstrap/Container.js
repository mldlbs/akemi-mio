/**
 * 极简服务容器 — factory + lazy init。
 * 不用 DI 框架，只是一个带延迟初始化的 Map。
 */
export class Container {
    constructor() {
        this.factories = new Map();
        this.instances = new Map();
    }
    register(key, factory) {
        this.factories.set(key, factory);
        // 清除旧实例，下次 resolve 重新创建
        this.instances.delete(key);
    }
    resolve(key) {
        if (!this.instances.has(key)) {
            const factory = this.factories.get(key);
            if (!factory)
                throw new Error(`Service not registered: ${key}`);
            this.instances.set(key, factory());
        }
        return this.instances.get(key);
    }
    has(key) {
        return this.factories.has(key);
    }
    /** 解析并初始化所有已注册服务（强制实例化） */
    resolveAll() {
        for (const key of this.factories.keys()) {
            this.resolve(key);
        }
    }
    /** 重置指定服务（下次 resolve 重新创建） */
    reset(key) {
        this.instances.delete(key);
    }
}
