import { AuditTrail } from './AuditTrail';
/**
 * 已知权限类型
 * 'filesystem:read'  — 读取文件系统
 * 'filesystem:write' — 写入文件系统
 * 'network:http'     — 发起 HTTP 请求
 * 'shell:exec'       — 执行 shell 命令
 * 'system:manage'    — 管理系统（插件、配置等）
 * 'storage:read'     — 读取插件存储
 * 'storage:write'    — 写入插件存储
 */
export type Permission = 'filesystem:read' | 'filesystem:write' | `filesystem:read:${string}` | `filesystem:write:${string}` | 'network:http' | 'shell:exec' | 'system:manage' | 'storage:read' | 'storage:write';
/** 将 manifest.permissions 中的短名称展开为标准权限列表 */
export declare function expandPermissions(shortNames: string[]): Permission[];
export interface ToolRegistration {
    name: string;
    description: string;
    parameters: Record<string, {
        type: string;
        description: string;
    }>;
    required: string[];
    handler: (args: Record<string, any>) => string | Promise<string>;
    pluginName: string;
    /** 工具运行所需权限（从插件 manifest.permissions 派生） */
    requiredPermissions?: Permission[];
}
export declare class ToolRegistry {
    private tools;
    /** 默认权限集 — 不设置时拥有全部权限（完全兼容现有行为） */
    private defaultPermissions;
    private auditTrail;
    setAuditTrail(audit: AuditTrail): void;
    register(reg: ToolRegistration): void;
    unregister(name: string): void;
    unregisterAll(pluginName: string): void;
    get(name: string): ToolRegistration | undefined;
    has(name: string): boolean;
    getAllSchemas(): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: {
                type: 'object';
                properties: Record<string, {
                    type: string;
                    description: string;
                }>;
                required: string[];
            };
        };
    }>;
    execute(name: string, args: Record<string, any>, callerPermissions?: Permission[]): Promise<string>;
    listTools(): string[];
    getAllRegistrations(): ToolRegistration[];
    /**
     * 在工具执行前强制执行权限检查。
     * 如果调用方缺少所需权限则抛出错误。
     */
    enforce(toolName: string, callerPermissions?: Permission[]): void;
    /**
     * 设置 Registry 的默认权限集。
     * 不调用此方法时，默认拥有全部权限（完全兼容现有行为）。
     */
    setDefaultPermissions(perms: Permission[]): void;
    /**
     * 检查工具是否允许被具有指定权限的调用者执行。
     * @param toolName 工具名
     * @param requiredPermission 调用者拥有的权限（空字符串 = 不校验）
     * @returns true 如果允许执行
     */
    checkPermission(toolName: string, requiredPermission: string): boolean;
    /**
     * 校验调用者是否有权执行某个工具的所有权限要求。
     * @param toolName 工具名
     * @param callerPermissions 调用者拥有的权限列表
     * @returns { allowed: boolean; missing: string[] }
     */
    verifyPermissions(toolName: string, callerPermissions: Permission[]): {
        allowed: boolean;
        missing: Permission[];
    };
}
export declare const toolRegistry: ToolRegistry;
