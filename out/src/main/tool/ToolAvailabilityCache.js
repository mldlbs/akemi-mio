/**
 * ToolAvailabilityCache — 工具可用性缓存
 *
 * 当工具在某 host 上因确定性错误（command_not_found / binary_missing）失败后，
 * 缓存该结果 30 分钟，避免重复浪费 toolLoop 轮次。
 *
 * 基于日志实证：agent 在 centos 远端反复尝试 node/pm2/SIGTERM
 *   28 次 retry → 8 次 ERROR → 直接导致预算耗尽
 */
import { log } from '../logger/Logger';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_SIZE = 200;
const DETERMINISTIC_PATTERNS = [
    'command not found',
    'No such file or directory',
    'is not recognized as an internal',
    'is not recognized as an operable',
    'Invalid signal specification',
    'pm2 not found',
    'not found',
    'cannot find',
];
class ToolAvailabilityCache {
    constructor() {
        this.cache = new Map();
    }
    /** 检查工具在当前上下文中是否已知不可用。null = 可用 */
    check(name, args) {
        const key = this.buildKey(name, args);
        const entry = this.cache.get(key);
        if (entry && Date.now() < entry.until)
            return entry.reason;
        if (entry)
            this.cache.delete(key);
        return null;
    }
    /** 记录失败。只有确定性错误才会被缓存 */
    record(name, args, errorMessage) {
        const isDeterministic = DETERMINISTIC_PATTERNS.some((p) => errorMessage.toLowerCase().includes(p.toLowerCase()));
        if (!isDeterministic)
            return;
        const key = this.buildKey(name, args);
        this.cache.set(key, {
            key,
            reason: errorMessage.slice(0, 200),
            until: Date.now() + CACHE_TTL_MS,
        });
        if (this.cache.size > MAX_CACHE_SIZE) {
            const entries = [...this.cache.entries()].sort((a, b) => a[1].until - b[1].until);
            for (let i = 0; i < Math.floor(MAX_CACHE_SIZE * 0.2); i++) {
                this.cache.delete(entries[i][0]);
            }
        }
        log('INFO', 'tool_availability_cached', { tool: name, reason: errorMessage.slice(0, 100) });
    }
    clear(toolName) {
        if (toolName) {
            for (const [key] of this.cache) {
                if (key.startsWith(toolName + '|'))
                    this.cache.delete(key);
            }
        }
        else {
            this.cache.clear();
        }
    }
    buildKey(name, args) {
        const parts = [name];
        if (typeof args.command === 'string') {
            parts.push(args.command.trim().split(/\s+/).slice(0, 2).join(' '));
        }
        if (typeof args.workspace === 'string')
            parts.push(args.workspace);
        if (typeof args.path === 'string')
            parts.push('file:' + args.path.slice(0, 50));
        return parts.join('|');
    }
}
export const toolAvailabilityCache = new ToolAvailabilityCache();
