export interface ScheduledTask {
    id: string;
    pluginName: string;
    type: 'once' | 'interval' | 'cron';
    handler: () => string | Promise<string>;
    cancelled: boolean;
}
export declare class Scheduler {
    private tasks;
    private timers;
    private nextId;
    once(delayMs: number, handler: () => string | Promise<string>, pluginName?: string): string;
    interval(intervalMs: number, handler: () => string | Promise<string>, pluginName?: string): string;
    cron(minute: number | '*', hour: number | '*', handler: () => string | Promise<string>, pluginName?: string): string;
    cancel(id: string): boolean;
    cancelAll(pluginName: string): number;
    list(): ScheduledTask[];
    count(): number;
    private executeTask;
    shutdown(): void;
}
export declare const scheduler: Scheduler;
