/**
 * Dynamic Tool Module — 动态工具集市
 *
 * 提供对话内动态工具注册/注销、沙箱执行、生命周期管理和权限控制。
 *
 * ## 组件
 *
 * - DynamicToolSandbox — 基于 vm 模块的轻量级沙箱执行环境
 * - DynamicToolLifecycle — 会话级工具生命周期管理
 * - DynamicToolPermission — 分级权限控制
 *
 * ## 使用流程
 *
 * Agent 通过 register_tool / unregister_tool MCP 工具注册临时工具：
 * 1. register_tool(name, description, inputSchema, handlerBody, permission)
 * 2. 系统检查权限 → 沙箱安全检查 → 注册到运行时
 * 3. 工具立即可用
 * 4. 对话结束时自动清理
 */

export { executeInSandbox, checkHandlerSafety, dynamicToolSandbox } from './DynamicToolSandbox'
export type { SandboxConfig, SandboxResult } from './DynamicToolSandbox'

export { DynamicToolLifecycle, dynamicToolLifecycle, SESSION_PROVIDER_PREFIX } from './DynamicToolLifecycle'
export type { DynamicToolRecord, CleanupOptions } from './DynamicToolLifecycle'

export { DynamicToolPermission, dynamicToolPermission, PermissionLevel, parsePermissionLevel } from './DynamicToolPermission'
export type { ToolPermissionConfig, PermissionCheckResult } from './DynamicToolPermission'
export { PERMISSION_LABELS } from './DynamicToolPermission'
