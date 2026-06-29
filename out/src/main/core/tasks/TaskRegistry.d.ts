import type { TaskHandler } from './types';
export declare class TaskRegistry {
    private handlers;
    register(type: string, handler: TaskHandler, label: string): void;
    getHandler(type: string): TaskHandler | undefined;
    hasHandler(type: string): boolean;
    listTypes(): {
        type: string;
        label: string;
    }[];
    unregister(type: string): boolean;
    clear(): void;
    get size(): number;
}
