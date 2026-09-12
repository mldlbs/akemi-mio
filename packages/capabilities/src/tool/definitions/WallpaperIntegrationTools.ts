/**
 * WallpaperIntegrationTools — MCP × Wallpaper 深度融合工具定义
 *
 * 提供 MCP 工具与 Wallpaper 系统双向交互的接口：
 *   - wallpaper_get_state:  查询当前 Wallpaper 状态（模式、情境、工具活动统计）
 *   - wallpaper_get_adaptation: 获取 Wallpaper 工具适配建议（是否应跳过/节流/安全模式）
 *   - wallpaper_set_config:  调整 Wallpaper 配置（模式建议、叠加层透明度等）
 *
 * 数据流:
 *   MCP 工具 → WallpaperToolBridge.getToolContext() → 统一上下文快照
 *   MCP 工具 → EventBus"wallpaper.config.changed" → Wallpaper 行为调整
 *
 * @see WallpaperToolBridge — 统一上下文提供者
 * @see WallpaperEventBridge — 行为→壁纸事件桥接
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getWallpaperToolBridge } from '@akemi-mio/capabilities/tool/deps'
import { eventBus } from '@akemi-mio/core/core/EventBus'

// ════════════════════════════════════════════════════════════
//  wallpaper_get_state — 查询 Wallpaper 统一上下文
// ════════════════════════════════════════════════════════════

export const wallpaperGetStateTool = buildTool({
  name: 'wallpaper_get_state',
  description: '查询当前 Wallpaper 行为模式、情境以及 MCP 工具活动统计的融合上下文。用于工具感知用户状态（专注/多任务/休息）并自适应行为。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const bridge = getWallpaperToolBridge()
      if (!bridge) return formatToolError('Wallpaper 工具桥接器尚未初始化')

      const ctx = bridge.getToolContext()
      const modeLabel: Record<string, string> = {
        focus: '专注模式',
        multitasking: '多任务模式',
        break: '休息模式',
      }
      const contextLabel: Record<string, string> = {
        coding: '编程',
        browsing: '浏览',
        resting: '休息',
      }
      const alertLabel: Record<string, string> = {
        normal: '正常',
        warning: '警告',
        error: '严重',
      }

      const lines: string[] = [
        '【Wallpaper × MCP 融合上下文】',
        '',
        `行为模式: ${modeLabel[ctx.mode] ?? ctx.mode}`,
        `活动情境: ${contextLabel[ctx.context] ?? ctx.context}`,
        `活动状态: ${ctx.activityState}`,
        `置信度: ${(ctx.confidence * 100).toFixed(0)}%`,
        '',
        `告警级别: ${alertLabel[ctx.alertLevel] ?? ctx.alertLevel}`,
        `推荐叠加层强度: ${(ctx.recommendedOverlayIntensity * 100).toFixed(0)}%`,
        '',
        '—— MCP 工具活动（最近 60 秒）——',
        `最后工具: ${ctx.toolActivity.lastToolName ?? '（无）'}`,
        `调用次数: ${ctx.toolActivity.toolCallCount}`,
        `成功: ${ctx.toolActivity.toolSuccessCount}`,
        `失败: ${ctx.toolActivity.toolFailuresLastMinute}`,
        `连续失败: ${ctx.toolActivity.consecutiveFailures}`,
        `失败率: ${(ctx.toolActivity.failureRate * 100).toFixed(0)}%`,
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`查询 Wallpaper 状态失败: ${err.message}`)
    }
  },
  isReadOnly: true,
  serverName: '@builtin/core',
})

// ════════════════════════════════════════════════════════════
//  wallpaper_get_adaptation — 获取 Wallpaper 的工具适配建议
// ════════════════════════════════════════════════════════════

export const wallpaperGetAdaptationTool = buildTool({
  name: 'wallpaper_get_adaptation',
  description: '获取 Wallpaper 系统对当前 MCP 工具执行的适配建议。工具链可根据建议决定是否跳过非关键操作、降低调用频率或进入只读安全模式。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const bridge = getWallpaperToolBridge()
      if (!bridge) return formatToolError('Wallpaper 工具桥接器尚未初始化')

      const adapt = bridge.getToolAdaptation()
      const lines: string[] = [
        '【Wallpaper 工具适配建议】',
        '',
        `跳过非关键操作: ${adapt.shouldSkipNonCritical ? '是 ⚠️' : '否'}`,
        `降低调用频率: ${adapt.shouldThrottle ? '是 ⚠️' : '否'}`,
        `进入只读安全模式: ${adapt.shouldEnterSafeMode ? '是 🚨' : '否'}`,
        `原因: ${adapt.reason}`,
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`获取适配建议失败: ${err.message}`)
    }
  },
  isReadOnly: true,
  serverName: '@builtin/core',
})

// ════════════════════════════════════════════════════════════
//  wallpaper_set_config — 调整 Wallpaper 配置
// ════════════════════════════════════════════════════════════

export const wallpaperSetConfigTool = buildTool({
  name: 'wallpaper_set_config',
  description:
    '通过 MCP 调整 Wallpaper 叠加层配置。可建议模式切换、调整透明度、切换显示元素。配置变化通过 EventBus 广播到 Wallpaper 系统。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      opacity: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: '建议的叠加层基础透明度 (0-1)。仅对非锁定状态生效。',
      },
      modeHint: {
        type: 'string',
        enum: ['focus', 'multitasking', 'break'],
        description: '模式建议 —— 向 Wallpaper 提示当前用户可能的行为模式。Wallpaper 根据置信度决定是否采纳。',
      },
      showMemoryCards: {
        type: 'boolean',
        description: '是否显示记忆卡片浮窗',
      },
      showEvolutionDashboard: {
        type: 'boolean',
        description: '是否显示进化仪表盘',
      },
    },
    required: [],
  },
  handler: async (args: { opacity?: number; modeHint?: string; showMemoryCards?: boolean; showEvolutionDashboard?: boolean }) => {
    try {
      const changes: Array<{ key: string; oldValue: unknown; newValue: unknown }> = []

      if (args.modeHint) {
        changes.push({
          key: 'modeHint',
          oldValue: null,
          newValue: args.modeHint,
        })
      }

      if (args.opacity !== undefined) {
        // 通过 credentialsManager 持久化透明度配置
        const { credentialsManager } = await import('@akemi-mio/core/credentials/CredentialsManager')
        const oldVal = credentialsManager.get('wp_normal_opacity') ?? '未设置'
        credentialsManager.set('wp_normal_opacity', String(args.opacity))
        changes.push({
          key: 'wp_normal_opacity',
          oldValue: oldVal,
          newValue: String(args.opacity),
        })
      }

      if (args.showMemoryCards !== undefined) {
        const { credentialsManager } = await import('@akemi-mio/core/credentials/CredentialsManager')
        credentialsManager.set('wp_memctx_enabled', args.showMemoryCards ? 'true' : 'false')
        changes.push({
          key: 'wp_memctx_enabled',
          oldValue: null,
          newValue: args.showMemoryCards ? 'true' : 'false',
        })
      }

      if (args.showEvolutionDashboard !== undefined) {
        const { credentialsManager } = await import('@akemi-mio/core/credentials/CredentialsManager')
        credentialsManager.set('wp_evo_dashboard', args.showEvolutionDashboard ? 'true' : 'false')
        changes.push({
          key: 'wp_evo_dashboard',
          oldValue: null,
          newValue: args.showEvolutionDashboard ? 'true' : 'false',
        })
      }

      // 发射配置变化事件
      if (changes.length > 0) {
        eventBus.emit('wallpaper.config.changed' as any, {
          version: 1,
          changes,
          timestamp: Date.now(),
        })
      }

      const summary = changes.length > 0 ? `Wallpaper 配置已更新 ${changes.length} 项` : '未指定任何配置项'

      return formatToolResult(summary)
    } catch (err: any) {
      return formatToolError(`调整 Wallpaper 配置失败: ${err.message}`)
    }
  },
  isReadOnly: false,
  serverName: '@builtin/core',
})

