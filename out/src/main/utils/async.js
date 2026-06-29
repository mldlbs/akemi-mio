import { exec } from 'child_process';
/** Create an AbortController + auto-timeout timer. Clear the timer after use to avoid leaks. */
export function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return { controller, timer };
}
/** Race a promise against a timeout. Rejects with `errorMsg` if the timeout fires first. */
export async function withTimeout(fn, timeoutMs, errorMsg = 'timeout') {
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs));
    return Promise.race([fn(), timer]);
}
/** Retry an async function on rejection. Waits `delayMs` between attempts. */
export async function withRetry(fn, retries = 2, delayMs = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (attempt === retries)
                throw err;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw new Error('unreachable');
}
/**
 * Async replacement for execSync — does NOT block the event loop.
 * Returns stdout on success, or rejects with error augmented with .stdout and .stderr.
 */
export function execAsync(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, {
            cwd: options.cwd || process.cwd(),
            timeout: options.timeout || 60000,
            maxBuffer: options.maxBuffer || 1024 * 1024,
            windowsHide: options.windowsHide !== false,
        }, (error, stdout, stderr) => {
            if (error) {
                ;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            }
            else {
                resolve(stdout);
            }
        });
    });
}
