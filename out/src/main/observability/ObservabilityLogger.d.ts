import type { Message } from '../agent/context';
import type { ToolResult } from '../agent/ToolScheduler';
export declare class ObservabilityLogger {
    private requestId;
    private entries;
    constructor(requestId: string);
    get enabled(): boolean;
    logInput(text: string, source: string): void;
    logMemory(query: string, memCtx: string): void;
    logPrompt(messages: Message[]): void;
    logToolBatch(results: ToolResult[]): void;
    logOutput(text: string, durationMs: number): void;
    /** 记录提前退出的原因（return '' 路径标记） */
    logExit(reason: string, detail?: string): void;
    /** 记录 LLM 调用断点 */
    logLlmTrace(phase: 'before' | 'after' | 'result', payload: string): void;
    flush(): void;
}
