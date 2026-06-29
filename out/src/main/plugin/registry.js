import { log } from '../logger/Logger';
/** 内置插件权限映射（短名称 → 标准权限） */
const BUILTIN_PERMISSION_MAP = {
    file: ['filesystem:read', 'filesystem:write'],
    system: ['shell:exec', 'system:manage'],
    network: ['network:http'],
    storage: ['storage:read', 'storage:write'],
};
/** 将 manifest.permissions 中的短名称展开为标准权限列表 */
export function expandPermissions(shortNames) {
    const result = [];
    for (const name of shortNames) {
        if (name in BUILTIN_PERMISSION_MAP) {
            result.push(...BUILTIN_PERMISSION_MAP[name]);
        }
        else if (name.startsWith('filesystem:') ||
            name.startsWith('network:') ||
            name.startsWith('shell:') ||
            name.startsWith('system:') ||
            name.startsWith('storage:')) {
            result.push(name);
        }
    }
    return [...new Set(result)];
}
export class ToolRegistry {
    constructor() {
        this.tools = new Map();
        /** 默认权限集 — 不设置时拥有全部权限（完全兼容现有行为） */
        this.defaultPermissions = [
            'filesystem:read',
            'filesystem:write',
            'network:http',
            'shell:exec',
            'system:manage',
            'storage:read',
            'storage:write',
        ];
        this.auditTrail = null;
    }
    setAuditTrail(audit) {
        this.auditTrail = audit;
    }
    register(reg) {
        if (this.tools.has(reg.name)) {
            throw new Error(`Tool ${reg.name} already registered by ${this.tools.get(reg.name).pluginName}`);
        }
        this.tools.set(reg.name, reg);
    }
    unregister(name) {
        this.tools.delete(name);
    }
    unregisterAll(pluginName) {
        for (const [name, reg] of this.tools) {
            if (reg.pluginName === pluginName)
                this.tools.delete(name);
        }
    }
    get(name) {
        return this.tools.get(name);
    }
    has(name) {
        return this.tools.has(name);
    }
    getAllSchemas() {
        const result = [];
        for (const reg of this.tools.values()) {
            result.push({
                type: 'function',
                function: {
                    name: reg.name,
                    description: reg.description,
                    parameters: {
                        type: 'object',
                        properties: reg.parameters,
                        required: reg.required,
                    },
                },
            });
        }
        return result;
    }
    async execute(name, args, callerPermissions) {
        const reg = this.tools.get(name);
        if (!reg)
            throw new Error(`Unknown tool: ${name}`);
        const start = Date.now();
        // 权限强制检查
        this.enforce(name, callerPermissions);
        log('INFO', 'tool_execute', { tool: name, plugin: reg.pluginName });
        try {
            const result = await reg.handler(args);
            this.auditTrail?.record({
                source: 'plugin',
                action: 'tool_call',
                target: name,
                pluginName: reg.pluginName,
                toolName: name,
                details: { args: Object.keys(args) },
                allowed: true,
                duration: Date.now() - start,
            });
            return result;
        }
        catch (err) {
            this.auditTrail?.record({
                source: 'plugin',
                action: 'tool_call',
                target: name,
                pluginName: reg.pluginName,
                toolName: name,
                details: { args: Object.keys(args), error: String(err) },
                allowed: false,
                duration: Date.now() - start,
                reason: String(err),
            });
            throw err;
        }
    }
    listTools() {
        return Array.from(this.tools.keys());
    }
    getAllRegistrations() {
        return Array.from(this.tools.values());
    }
    /**
     * 在工具执行前强制执行权限检查。
     * 如果调用方缺少所需权限则抛出错误。
     */
    enforce(toolName, callerPermissions) {
        const reg = this.tools.get(toolName);
        if (!reg)
            throw new Error(`工具不存在: ${toolName}`);
        // 内置插件完全信任
        if (reg.pluginName.startsWith('@builtin/'))
            return;
        // 无权限要求 = 公开工具
        if (!reg.requiredPermissions || reg.requiredPermissions.length === 0)
            return;
        const perms = callerPermissions ?? this.defaultPermissions;
        const missing = reg.requiredPermissions.filter((p) => !perms.includes(p));
        if (missing.length > 0) {
            throw new Error(`[PermissionDenied] 无权执行工具 "${toolName}"。需要权限: ${missing.join(', ')}`);
        }
    }
    /**
     * 设置 Registry 的默认权限集。
     * 不调用此方法时，默认拥有全部权限（完全兼容现有行为）。
     */
    setDefaultPermissions(perms) {
        this.defaultPermissions = perms;
    }
    /**
     * 检查工具是否允许被具有指定权限的调用者执行。
     * @param toolName 工具名
     * @param requiredPermission 调用者拥有的权限（空字符串 = 不校验）
     * @returns true 如果允许执行
     */
    checkPermission(toolName, requiredPermission) {
        const reg = this.tools.get(toolName);
        if (!reg)
            return false;
        if (reg.pluginName.startsWith('@builtin/'))
            return true;
        if (!requiredPermission)
            return true;
        return !!reg.requiredPermissions?.includes(requiredPermission);
    }
    /**
     * 校验调用者是否有权执行某个工具的所有权限要求。
     * @param toolName 工具名
     * @param callerPermissions 调用者拥有的权限列表
     * @returns { allowed: boolean; missing: string[] }
     */
    verifyPermissions(toolName, callerPermissions) {
        const reg = this.tools.get(toolName);
        if (!reg)
            return { allowed: false, missing: [] };
        if (reg.pluginName.startsWith('@builtin/'))
            return { allowed: true, missing: [] };
        if (!reg.requiredPermissions || reg.requiredPermissions.length === 0)
            return { allowed: true, missing: [] };
        const missing = reg.requiredPermissions.filter((p) => !callerPermissions.includes(p));
        return { allowed: missing.length === 0, missing };
    }
}
export const toolRegistry = new ToolRegistry();
