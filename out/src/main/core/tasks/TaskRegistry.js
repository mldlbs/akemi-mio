export class TaskRegistry {
    constructor() {
        this.handlers = new Map();
    }
    register(type, handler, label) {
        if (this.handlers.has(type)) {
            throw new Error(`Handler already registered for task type "${type}"`);
        }
        this.handlers.set(type, { handler, label });
    }
    getHandler(type) {
        return this.handlers.get(type)?.handler;
    }
    hasHandler(type) {
        return this.handlers.has(type);
    }
    listTypes() {
        return Array.from(this.handlers.entries()).map(([type, reg]) => ({ type, label: reg.label }));
    }
    unregister(type) {
        return this.handlers.delete(type);
    }
    clear() {
        this.handlers.clear();
    }
    get size() {
        return this.handlers.size;
    }
}
