export declare class CircuitBreaker {
    private readonly threshold;
    private readonly cooldownMs;
    private readonly halfOpenMax;
    private states;
    constructor(threshold?: number, cooldownMs?: number, halfOpenMax?: number);
    /** 检查调用是否允许通过。不允许时返回 reason 字符串，允许返回 null */
    allow(circuit: string): string | null;
    /** 记录成功 —— 重置状态 */
    onSuccess(circuit: string): void;
    /** 记录失败 —— 达到阈值则熔断 */
    onFailure(circuit: string): void;
    /** 获取当前熔断器快照 */
    getSnapshot(): Record<string, {
        state: string;
        failures: number;
    }>;
}
