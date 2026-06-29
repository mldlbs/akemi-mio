type Level = 'INFO' | 'WARN' | 'ERROR' | 'PERF' | 'CHAT' | 'DEBUG';
export declare function createRequestId(): string;
export declare function setRequestId(id: string): void;
export declare function getRequestId(): string;
export declare function sanitizeForLog(text: string): string;
export declare function initLogFile(userDataPath: string): void;
export declare function getLogFilePath(): string | null;
export declare function log(level: Level, event: string, meta?: Record<string, unknown>): void;
export {};
