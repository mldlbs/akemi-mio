import { EventBus } from '../core/EventBus';
/** 进化模式 */
export type EvolutionMode = 'analyze' | 'execute' | 'review';
/** 单次工具调用的合规记录 */
export interface ToolCallRecord {
    name: string;
    args: Record<string, any>;
    timestamp: number;
    result?: string;
    error?: string;
}
/** 验证结果 */
export interface ValidationResult {
    /** 是否通过验证 */
    passed: boolean;
    /** 违规列表 */
    violations: Violation[];
    /** 警告列表（不违规但值得注意） */
    warnings: string[];
    /** 工具调用统计 */
    stats: {
        total: number;
        readOnly: number;
        write: number;
        errors: number;
    };
}
/** 违规记录 */
export interface Violation {
    type: 'forbidden_tool' | 'mode_mismatch' | 'excessive_readonly' | 'excessive_errors' | 'no_progress' | 'constitutional_violation';
    toolName?: string;
    message: string;
    severity: 'error' | 'warn';
}
export declare class ResponseValidator {
    private eventBus;
    private toolCallBuffer;
    private listeners;
    private hasSnapshot;
    constructor(bus?: EventBus);
    setRollbackState(available: boolean): void;
    /**
     * 开始监听工具调用事件。
     * 在 tryRun / tryExecutePlan 开始时调用。
     */
    startListening(): void;
    /**
     * 停止监听并返回验证结果
     */
    stopAndValidate(mode: EvolutionMode): ValidationResult;
    /**
     * 丢弃当前缓冲的工具调用（用于退化模式重置）
     */
    reset(): void;
    /**
     * 获取当前缓冲的快照（用于日志记录）
     */
    getSnapshot(): ToolCallRecord[];
    /**
     * 清理事件监听器
     */
    cleanup(): void;
}
/**
 * 创建合规摘要字符串（用于日志记录）
 */
export declare function formatValidationSummary(result: ValidationResult): string;
