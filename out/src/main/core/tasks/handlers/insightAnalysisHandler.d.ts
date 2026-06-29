import { type TaskHandler } from '../types';
/**
 * InsightService 定时分析 handler。
 * 在 handler 内调用服务的 tick() 方法驱动检查循环。
 */
export declare const insightAnalysisHandler: TaskHandler;
