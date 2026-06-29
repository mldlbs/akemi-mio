export type ErrorCategory = 'RETRYABLE' | 'CONTEXT_OVERFLOW' | 'INVALID_REQUEST' | 'TOOL_SCHEMA_ERROR' | 'FATAL' | 'CAPABILITY_LOSS' | 'CONFIGURATION_ERROR' | 'CORRUPTED_STATE';
export interface RecoveryStrategy {
    category: ErrorCategory;
    shouldRetry: boolean;
    maxRetries: number;
    backoffBaseMs: number;
    contextAction: 'preserve' | 'compress' | 'clear' | 'reject';
    message: string;
}
export interface ClassificationResult {
    category: ErrorCategory;
    strategy: RecoveryStrategy;
    retryDelayMs: number;
    originalError: string;
}
/**
 * 计算指数退避延迟（毫秒）
 */
export declare function computeBackoff(baseMs: number, attempt: number, jitter?: boolean): number;
/**
 * 分类错误并返回策略
 */
export declare function classify(error: string): ClassificationResult;
/**
 * 获取友好的用户消息
 */
export declare function getUserMessage(category: ErrorCategory, originalError: string): string;
