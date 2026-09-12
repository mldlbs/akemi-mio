/**
 * ContentClassifierPlugin — Agent ContentClassifier 的 Wallpaper 插件实现
 *
 * 将 Agent 的 ContentClassifier（纯函数消息内容类型分类）替换为 Wallpaper 插件。
 * 这是 Agent 模块 Wallpaper 化改造的 Phase 1 成果。
 *
 * ── 迁移目的 ──
 * ContentClassifier 是纯函数（无状态、无依赖），
 * 与 Chat/Task 执行路径完全解耦，是最适合首先迁移到 Wallpaper 的子模块。
 *
 * ── 替换策略 ──
 * 1. 本插件注册到 WallpaperPluginRegistry，声明 content_classifier 能力
 * 2. AgentWallpaperBridge 检测到本插件后，标记 ContentClassifier 为「已替换」
 * 3. ChatExecutor 和 db/connection.ts 改为通过 bridge.classifyContent() 调用
 * 4. 原 classifyContent 函数保留（不删除），作为回退路径
 *
 * ── 向后兼容 ──
 * 保留原 classifyContent() 导出（不删除），作为回退路径。
 * 通过 bridge.isReplaced('ContentClassifier') 标志控制路径选择。
 *
 * @see classifyContent — 原 Agent 子模块纯函数（保留作回退）
 * @see AgentWallpaperBridge — 增量迁移桥梁
 * @see wallpaperReplacements — 替换锚点标志
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { IWallpaperPlugin, WallpaperPluginManifest } from '@akemi-mio/platform/wallpaper/plugin/types'
import { WallpaperPluginRegistry } from '@akemi-mio/platform/wallpaper/plugin/WallpaperPluginRegistry'
import { classifyContent, CATEGORY_META, type MessageCategory } from '../../ContentClassifier'

// ════════════════════════════════════════════════════════════
//  ContentClassifierPlugin 实现
// ════════════════════════════════════════════════════════════

export class ContentClassifierPlugin implements IWallpaperPlugin {
  readonly manifest: WallpaperPluginManifest = {
    name: 'agent-content-classifier',
    version: '1.0.0',
    description: '消息内容类型分类（chat/writing/image_gen/evolution/creativity/dream）',
    capabilities: ['content_classifier'],
  }

  // ═════════════════════════════════════════════════════════════
  //  生命周期
  // ═════════════════════════════════════════════════════════════

  async onLoad(): Promise<void> {
    log('INFO', 'content_classifier_plugin_loaded')
  }

  async onUnload(): Promise<void> {
    log('INFO', 'content_classifier_plugin_unloaded')
  }

  // ═════════════════════════════════════════════════════════════
  //  核心分类方法
  // ═════════════════════════════════════════════════════════════

  /**
   * 检测用户消息的内容类型。
   * 直接委托给原 Agent 的 classifyContent 实现。
   *
   * @param text 用户输入文本
   * @returns 消息分类
   */
  classify(text: string): MessageCategory {
    return classifyContent(text)
  }

  /**
   * 获取所有分类的中文标签和图标。
   * 供 Wallpaper 渲染层展示消息分类标识。
   */
  getCategoryMeta(): Record<MessageCategory, { label: string; icon: string }> {
    return CATEGORY_META
  }
}

// =============================================================================
//  注册辅助
// =============================================================================

/**
 * 工厂函数 — 创建并注册 ContentClassifierPlugin 到 WallpaperPluginRegistry。
 *
 * @example
 *   const classifierPlugin = registerContentClassifierPlugin()
 *   // 注册后，AgentWallpaperBridge 自动检测替换
 *
 * @returns ContentClassifierPlugin 实例
 */
export function registerContentClassifierPlugin(): ContentClassifierPlugin {
  const registry = WallpaperPluginRegistry.getInstance()
  const existing = registry.getByCapability('content_classifier')

  if (existing.length > 0) {
    log('INFO', 'content_classifier_plugin_already_registered', {
      name: existing[0].manifest.name,
    })
    return existing[0] as ContentClassifierPlugin
  }

  const plugin = new ContentClassifierPlugin()
  registry.register(plugin)
  log('INFO', 'content_classifier_plugin_registered')

  return plugin
}
