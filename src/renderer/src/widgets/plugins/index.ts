/**
 * Widget 插件注册入口
 *
 * 将所有内置 widget 注册到全局 wallpaperWidgetRegistry 中。
 * 在应用初始化时调用 registerAllWidgets()。
 *
 * 模式来源：Memory 架构中通过 UnifiedMemoryQuery.registerPlugin()
 * 统一注册所有记忆存储插件的方式。
 */

import { wallpaperWidgetRegistry } from '../WallpaperWidgetRegistry'
import { evolutionStatusWidget } from './EvolutionStatusWidget'
import { planProgressWidget } from './PlanProgressWidget'
import { systemResourceWidget } from './SystemResourceWidget'
import { evolutionDashboardCanvasWidget } from './EvolutionDashboardCanvas'
import { modeBadgeWidget } from './ModeBadgeWidget'
import { contextBadgeWidget } from './ContextBadgeWidget'
import { natureAnimationWidget } from './NatureAnimationWidget'
import { shortcutsGuideWidget } from './ShortcutsGuideWidget'
import { rssSummaryWidget } from './RssSummaryWidget'
import { memoryContextWidget } from './MemoryContextWidget'
import { memoryFlashWidget } from './MemoryFlashWidget'
import { conversationContextWidget } from './ConversationContextWidget'
import { fileOrganizerProgressWidget } from './FileOrganizerProgressWidget'
import { taskPanelWidget } from './TaskPanelWidget'
import { voiceWallpaperWidget } from './VoiceWallpaperWidget'

/**
 * 注册所有内置 wallpaper widget 插件。
 * 在 WallpaperOverlay 挂载时调用。
 */
export function registerAllWidgets(): void {
  // 按 priority 顺序注册（低值优先）

  // badge 区
  wallpaperWidgetRegistry.register(modeBadgeWidget)
  wallpaperWidgetRegistry.register(contextBadgeWidget)

  // decoration 区
  wallpaperWidgetRegistry.register(natureAnimationWidget)
  wallpaperWidgetRegistry.register(voiceWallpaperWidget)

  // overlay 区
  wallpaperWidgetRegistry.register(shortcutsGuideWidget)
  wallpaperWidgetRegistry.register(rssSummaryWidget)
  // memoryContextWidget 已移至 SystemDock
  wallpaperWidgetRegistry.register(conversationContextWidget)
  wallpaperWidgetRegistry.register(memoryFlashWidget)
  wallpaperWidgetRegistry.register(fileOrganizerProgressWidget)

  // overlay 区 — 实时 Canvas 仪表盘
  wallpaperWidgetRegistry.register(evolutionDashboardCanvasWidget)

  // overlay 区 — 桌面悬浮任务面板
  wallpaperWidgetRegistry.register(taskPanelWidget)

  // monitor 区
  wallpaperWidgetRegistry.register(evolutionStatusWidget)
  wallpaperWidgetRegistry.register(planProgressWidget)
  wallpaperWidgetRegistry.register(systemResourceWidget)
}
