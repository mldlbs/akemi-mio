import { ToolProviderRegistry } from './ToolProviderRegistry'

/**
 * 全局工具提供者注册表实例。
 * 对应 Memory 系统 UnifiedMemoryQuery 的全局单例。
 *
 * 所有工具提供者（内置、插件、外部）通过此实例注册/注销。
 * LocalProviderAdapter 使用此实例作为工具定义的单一数据源。
 */
export const toolProviderRegistry = new ToolProviderRegistry()

export { ToolProviderRegistry } from './ToolProviderRegistry'
