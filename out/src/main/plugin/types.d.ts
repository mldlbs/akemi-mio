export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, {
        type: string;
        description: string;
    }>;
    required: string[];
}
export interface PluginManifest {
    name: string;
    version: string;
    description: string;
    permissions: string[];
}
export interface Plugin {
    manifest: PluginManifest;
    tools: ToolSchema[];
    handle(toolName: string, args: Record<string, any>): string | Promise<string>;
    onLoad?(api: PluginAPI): void | Promise<void>;
    onUnload?(): void | Promise<void>;
}
export interface PluginAPI {
    getToolRegistry(): import('./registry').ToolRegistry;
    storage: {
        get(key: string): any;
        set(key: string, value: any): void;
        delete(key: string): void;
    };
    logger: {
        info(event: string, data?: Record<string, any>): void;
        warn(event: string, data?: Record<string, any>): void;
        error(event: string, data?: Record<string, any>): void;
    };
    http: {
        get(url: string, options?: Record<string, any>): Promise<{
            status: number;
            data: any;
        }>;
        post(url: string, body: any, options?: Record<string, any>): Promise<{
            status: number;
            data: any;
        }>;
    };
}
