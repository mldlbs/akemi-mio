/**
 * IWallpaperWidget — Wallpaper Widget 插件接口
 *
 * 模式来源：Memory 架构的 IMemoryPlugin
 *
 * Memory 的插件模式解决的问题：
 * - 多种记忆存储（Vector、KG、Summary、Engineering）需要统一检索/更新接口
 * - Agent 核心无需知道各存储的内部实现细节
 * - 通过 adaptToPlugin 适配器将现有 store 包装为插件
 * - UnifiedMemoryQuery 统一管理所有插件的查询和更新
 *
 * Wallpaper 中的相同问题域：
 * - WallpaperOverlay 中有多个独立的面板/小组件
 * - 每个面板有自己的数据和可见性逻辑
 * - 添加新面板需要修改 WallpaperOverlay.tsx（712 行单体组件）
 * - 没有标准化的插件注册和生命周期管理
 *
 * 适配方式：
 * - shouldShow → IMemoryPlugin.retrieve（判断当前上下文是否匹配）
 * - Component  → IMemoryPlugin.getContext（插件提供渲染输出）
 * - priority   → 插件检索结果的排序依据
 * - onInit/onDestroy → 插件生命周期
 */

export type { IWallpaperWidgetDefinition } from './types'
export type {
  WallpaperWidgetContext,
  WallpaperWidgetZone,
  MonitoringData,
  MonitoringSystem,
  MonitoringEvolution,
  MonitoringPlan,
  MonitoringChange,
} from './types'
