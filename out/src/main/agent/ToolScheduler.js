import { log } from '../logger/Logger';
import { toolAvailabilityCache } from '../tool/ToolAvailabilityCache';
const DEFAULT_CONFIG = {
    maxConcurrency: 5,
    toolTimeoutMs: 60000,
    maxRetries: 2,
    retryBaseMs: 1000,
};
/**
 * ToolScheduler — 并发工具调度器
 *
 * 职责：
 * - 并行执行 LLM 一次发起的多个工具调用
 * - 单工具超时/重试
 * - 信号量限流
 * - 返回统一 ToolResult[]，按原顺序排列
 */
export class ToolScheduler {
    constructor(mcpManager, config) {
        this.mcpManager = mcpManager;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * 并发执行一批工具调用
     * 按传入顺序返回结果，失败工具会重试（最多 maxRetries 次）
     */
    async executeAll(toolCalls, abortSignal) {
        // 信号量控制并发度
        const semaphore = new Semaphore(this.config.maxConcurrency);
        const tasks = toolCalls.map((call) => semaphore.run(() => this.executeSingle(call, abortSignal)));
        return Promise.all(tasks);
    }
    async executeSingle(call, abortSignal) {
        const t0 = Date.now();
        // 预检：工具在此上下文中是否已知不可用（避免浪费 toolLoop 轮次）
        const cachedReason = toolAvailabilityCache.check(call.name, call.arguments);
        if (cachedReason) {
            log('INFO', 'tool_availability_skip', { tool: call.name, reason: cachedReason });
            return {
                id: call.id,
                name: call.name,
                success: false,
                content: '',
                error: `工具不可用（已缓存）: ${cachedReason}`,
                latencyMs: 0,
            };
        }
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            if (abortSignal?.aborted) {
                return { id: call.id, name: call.name, success: false, content: '', error: 'cancelled', latencyMs: Date.now() - t0 };
            }
            try {
                const content = await this.callWithTimeout(call, abortSignal);
                log('INFO', 'tool_scheduler_ok', { tool: call.name, attempt: attempt + 1, latencyMs: Date.now() - t0 });
                return { id: call.id, name: call.name, success: true, content, latencyMs: Date.now() - t0 };
            }
            catch (err) {
                // 确定性错误：记录到可用性缓存，避免未来重复浪费
                toolAvailabilityCache.record(call.name, call.arguments, err.message);
                // 确定性错误：重试也无法改变结果，直接跳过重试
                if (isDeterministicError(err.message)) {
                    log('WARN', 'tool_scheduler_retry', {
                        tool: call.name,
                        attempt: attempt + 1,
                        error: err.message,
                        willRetry: false,
                        skipRetry: true,
                    });
                    return { id: call.id, name: call.name, success: false, content: '', error: err.message, latencyMs: Date.now() - t0 };
                }
                const isLastAttempt = attempt >= this.config.maxRetries;
                log(isLastAttempt ? 'ERROR' : 'WARN', 'tool_scheduler_retry', {
                    tool: call.name,
                    attempt: attempt + 1,
                    error: err.message,
                    willRetry: !isLastAttempt,
                });
                if (isLastAttempt) {
                    return { id: call.id, name: call.name, success: false, content: '', error: err.message, latencyMs: Date.now() - t0 };
                }
                // 退避等待
                await sleep(this.config.retryBaseMs * Math.pow(2, attempt));
            }
        }
        return { id: call.id, name: call.name, success: false, content: '', error: 'unknown', latencyMs: Date.now() - t0 };
    }
    async callWithTimeout(call, abortSignal) {
        return new Promise((resolve, reject) => {
            // 超时定时器
            const timer = setTimeout(() => {
                reject(new Error('tool timeout'));
            }, this.config.toolTimeoutMs);
            // 外部取消
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error(abortSignal?.reason?.toString() || 'cancelled'));
            };
            if (abortSignal?.aborted) {
                onAbort();
                return;
            }
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.mcpManager.callTool(call.name, call.arguments).then((content) => {
                clearTimeout(timer);
                abortSignal?.removeEventListener('abort', onAbort);
                resolve(content);
            }, (err) => {
                clearTimeout(timer);
                abortSignal?.removeEventListener('abort', onAbort);
                reject(err);
            });
        });
    }
}
// ── 工具函数 ──
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 确定性错误特征：重试也无法改变结果 */
function isDeterministicError(message) {
    if (!message)
        return false;
    const deterministricPatterns = [
        '目录不存在',
        '路径不存在',
        '路径是目录',
        'path 参数必须为字符串',
        '路径 .. 超出工作区目录',
        '路径 / 超出工作区目录',
        '超出项目根目录',
        '目录不存在',
        '不允许执行命令',
        '未在',
        '中找到匹配的文本',
        '超出工作区目录',
        '子目录不存在',
        '不能直接写入',
        // English counterparts
        'File not found',
        'file not found',
        'ENOENT',
        'not a directory',
        'EISDIR',
        'EACCES',
        // ToolScheduler 级别错误（非网络类）
        '未知工具',
        // JSON 解析错误（centos-server Python 脚本输出空内容）
        'JSONDecodeError',
        'Expecting value',
        // MCP 连接已断开后遗留的调用（无需重试，等重连）
        'The operation was aborted',
        // 确定性语义错误
        '找不到',
        '没有找到',
        '不存在',
        'is not defined',
        'Cannot find module',
        // 命令执行失败：run_command 返回的确定性错误（命令本身出错，重试没用）
        '命令执行失败',
        'nginx: command not found',
    ];
    return deterministricPatterns.some((p) => message.includes(p));
}
/** 简单信号量 */
class Semaphore {
    constructor(max) {
        this.current = 0;
        this.queue = [];
        this.max = max;
    }
    async run(fn) {
        if (this.current >= this.max) {
            await new Promise((resolve) => this.queue.push(resolve));
        }
        this.current++;
        try {
            return await fn();
        }
        finally {
            this.current--;
            this.queue.shift()?.();
        }
    }
}
