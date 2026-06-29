/** Create an AbortController + auto-timeout timer. Clear the timer after use to avoid leaks. */
export declare function createTimeoutSignal(timeoutMs: number): {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
};
/** Race a promise against a timeout. Rejects with `errorMsg` if the timeout fires first. */
export declare function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, errorMsg?: string): Promise<T>;
/** Retry an async function on rejection. Waits `delayMs` between attempts. */
export declare function withRetry<T>(fn: () => Promise<T>, retries?: number, delayMs?: number): Promise<T>;
/**
 * Async replacement for execSync — does NOT block the event loop.
 * Returns stdout on success, or rejects with error augmented with .stdout and .stderr.
 */
export declare function execAsync(cmd: string, options?: {
    cwd?: string;
    timeout?: number;
    encoding?: string;
    windowsHide?: boolean;
    maxBuffer?: number;
}): Promise<string>;
