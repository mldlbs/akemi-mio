export type RejectionReason = 'HARD_BLOCK' | 'GOAL_DRIFT' | 'RESOURCE_EXHAUSTED' | 'MAX_REJECTION_EXCEEDED';
export interface RejectionTrackerConfig {
    /** 熔断阈值：窗口内记录数达到此值时触发 */
    threshold: number;
    /** 滑动窗口大小（毫秒），默认 60 秒 */
    windowMs: number;
}
export declare class RejectionTracker {
    private records;
    private config;
    constructor(config?: Partial<RejectionTrackerConfig>);
    /** 记录一次拒绝 */
    record(reason: RejectionReason, toolName: string): void;
    /** 在当前滑动窗口内是否达到熔断阈值 */
    shouldTrip(): boolean;
    /**
     * 信用恢复：每次工具成功执行后调用。
     * 从最旧的记录开始清除一条，逐步降低熔断计数器。
     */
    onToolSuccess(): void;
    /** 获取当前统计信息 */
    getStats(): {
        count: number;
        reasons: RejectionReason[];
        isTripped: boolean;
    };
    /** 重置所有记录（跨会话时调用） */
    reset(): void;
    /** 获取当前窗口内已触发的拒绝原因集合（去重） */
    getActiveReasons(): RejectionReason[];
    /** 清除超出时间窗口的旧记录 */
    private prune;
}
