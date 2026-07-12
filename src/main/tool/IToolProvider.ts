/**
 * IToolProvider — 工具提供者插件接口
 *
 * 使工具定义和生命周期与 Tool 核心解耦。
 * 与 Memory 系统的 IMemoryPlugin 模式一致：
 * - 插件实现此接口注册到 ToolProviderRegistry
 * - 注册/注销触发 onRegister/onUnregister 生命周期 hooks
 * - 提供统一的 getTools() 接口获取工具集合
 *
 * ## Memory 中的对应模式：IMemoryPlugin
 *
 * | IMemoryPlugin         | IToolProvider         | 说明                           |
 * |-----------------------|-----------------------|-------------------------------|
 * | name                  | name                  | 唯一标识                       |
 * | retrieve()            | getTools()            | 统一获取能力                   |
 * | update()              | —                     | 工具侧通过 handler 执行操作     |
 * | getContext()          | description           | 元信息描述                     |
 * | dispose()             | dispose()             | 资源清理                       |
 * | (无)                  | onRegister/onUnregister| 生命周期 hooks（新加）          |
 *
 * ## 解决的问题
 * Memory 中多个存储后端（Vector、KG、Summary、Engineering）需要统一接口，
 * 通过 IMemoryPlugin + adaptToPlugin() 解耦。
 *
 * MCP/Tool 中存在相同问题：工具定义分散在多个文件中，通过 getAllTools()
 * 静态数组注册，缺少动态注册/注销和生命周期管理。
 *
 * IToolProvider 为此提供相同性质的解决方案。
 */

import type { Tool } from './types'

/**
 * 工具提供者插件接口。
 * 所有需要向 MCP 注册工具集合的模块应实现此接口。
 */
export interface IToolProvider {
  /** 提供者唯一标识 */
  readonly name: string

  /** 提供者描述 */
  readonly description: string

  /**
   * 获取此提供者提供的所有工具定义。
   * 在注册时由 ToolProviderRegistry 调用。
   */
  getTools(): Tool[]

  /**
   * 注册完成后回调（可选）。
   * 可用于初始化资源、注册依赖、记录日志等。
   */
  onRegister?(): void | Promise<void>

  /**
   * 注销前回调（可选）。
   * 可用于清理注册的依赖、释放临时资源等。
   */
  onUnregister?(): void | Promise<void>

  /**
   * 清理资源（可选）。
   * 在提供者被移除或系统关闭时调用，释放长期资源。
   */
  dispose?(): void | Promise<void>
}

/**
 * 将 Tool 对象数组适配为 IToolProvider 的工厂函数。
 *
 * 与 Memory 系统的 adaptToPlugin() 模式一致：
 * - adaptToPlugin(name, store) → IMemoryPlugin
 * - adaptToToolProvider(name, description, tools) → IToolProvider
 *
 * 适用于已有的工具集合，无需单独实现 IToolProvider 接口。
 * 通过鸭子类型检查支持可选生命周期 hooks
 * （传入对象的 onRegister/onUnregister/dispose 方法会被自动识别）。
 */
export function adaptToToolProvider(
  name: string,
  description: string,
  tools: Tool[],
  hooks?: {
    onRegister?: () => void | Promise<void>
    onUnregister?: () => void | Promise<void>
    dispose?: () => void | Promise<void>
  },
): IToolProvider {
  return {
    name,
    description,
    getTools: () => tools,
    ...(hooks?.onRegister ? { onRegister: hooks.onRegister } : {}),
    ...(hooks?.onUnregister ? { onUnregister: hooks.onUnregister } : {}),
    ...(hooks?.dispose ? { dispose: hooks.dispose } : {}),
  }
}
