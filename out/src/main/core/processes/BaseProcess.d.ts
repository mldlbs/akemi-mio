/**
 * BaseProcess — Agent OS 子进程基类入口。
 *
 * 所有通过 ProcessManager.fork() 启动的子进程使用此入口。
 * 提供标准 IPC 协议：request/response、ping/pong、lifecycle 事件、shutdown。
 */
export type ProcessHandler = (method: string, data: unknown) => Promise<unknown> | unknown;
export declare function setProcessHandler(handler: ProcessHandler): void;
/** 标记进程已就绪 */
export declare function markReady(): void;
