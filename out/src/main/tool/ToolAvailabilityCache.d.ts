/**
 * ToolAvailabilityCache — 工具可用性缓存
 *
 * 当工具在某 host 上因确定性错误（command_not_found / binary_missing）失败后，
 * 缓存该结果 30 分钟，避免重复浪费 toolLoop 轮次。
 *
 * 基于日志实证：agent 在 centos 远端反复尝试 node/pm2/SIGTERM
 *   28 次 retry → 8 次 ERROR → 直接导致预算耗尽
 */
declare class ToolAvailabilityCache {
    private cache;
    /** 检查工具在当前上下文中是否已知不可用。null = 可用 */
    check(name: string, args: Record<string, any>): string | null;
    /** 记录失败。只有确定性错误才会被缓存 */
    record(name: string, args: Record<string, any>, errorMessage: string): void;
    clear(toolName?: string): void;
    private buildKey;
}
export declare const toolAvailabilityCache: ToolAvailabilityCache;
export {};
