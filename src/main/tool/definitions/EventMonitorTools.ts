/**
 * EventMonitorTools — 实时事件离线语音播报 MCP 工具
 *
 * 这套工具让 Agent 可以管理事件监测器（CRUD），
 * 实现"配置 HTTP 轮询 → 变化检测 → PiperTTS 离线播报"的完整管线。
 *
 * 设计原则：
 * - 所有监测器状态由 EventMonitorService 单例管理
 * - 语音播报复用 TtsNotifyTool 的 notificationQueue（alert 标签）
 * - 静默时间段、冷却、关键词过滤在服务层统一处理
 * - 工具层做参数校验和人性化输出
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { log } from '../../logger/Logger'
import { eventMonitorService } from '../../event-monitor/EventMonitorService'
import {
  type EventMonitorConfig,
  type EventFilterConfig,
  type EventMonitorGlobalConfig,
  type BroadcastStyle,
  createDefaultMonitorConfig,
  generateMonitorId,
  DEFAULT_EVENT_FILTER,
  DEFAULT_GLOBAL_CONFIG,
} from '../../event-monitor/types'

// =============================================================================
//  工具：create_event_monitor
// =============================================================================

export const createEventMonitorTool = buildTool({
  name: 'create_event_monitor',
  description:
    '创建实时事件监测器。配置一个 HTTP API 地址和轮询间隔，系统将定时拉取数据，检测变化后通过语音播报。' +
    '适合台风路径跟踪、股票价格预警、天气突变通知等实时场景。' +
    '创建成功后自动开始轮询（除非禁用）。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '监测器名称，如 "台风摩羯路径"、"比特币价格"、"本地天气"。',
      },
      url: {
        type: 'string',
        description: 'HTTP API 地址，返回 JSON 或纯文本。如台风路径 API、天气 API、加密货币 API。',
      },
      poll_interval_ms: {
        type: 'number',
        description: '轮询间隔（毫秒）。最小 5000（5 秒），建议 60000（1 分钟）以上避免过度请求。默认 60000。',
      },
      method: {
        type: 'string',
        description: 'HTTP 请求方法。可选 GET（默认）或 POST。',
        enum: ['GET', 'POST'],
      },
      headers: {
        type: 'string',
        description: 'HTTP 请求头，JSON 字符串格式。如 {"Authorization": "Bearer xxx"}。可选。',
      },
      body: {
        type: 'string',
        description: 'POST 请求体（JSON 字符串）。仅在 method=POST 时使用。可选。',
      },
      data_path: {
        type: 'string',
        description: 'JSON 路径，用于从响应中提取比较值。如 "data.temperature"、"wind.speed"、"price"。' +
          '留空表示使用完整响应文本前 200 字符。',
      },
      change_threshold: {
        type: 'number',
        description: '变化阈值 0-1，超过此百分比触发播报。0=任何变化都播报。如 0.05 表示变化 5% 时播报。默认 0。',
      },
      broadcast_template: {
        type: 'string',
        description: '播报文本模板。可用占位符：{{name}}（名称）、{{value}}（新值）、' +
          '{{prevValue}}（旧值）、{{change}}（变化描述）、{{time}}（时间）。' +
          '默认: "{name}更新：从 {prevValue} 变为 {value}"',
      },
      enabled: {
        type: 'boolean',
        description: '创建后是否立即启用。默认 true。',
      },
      mute_time_ranges: {
        type: 'string',
        description: '静音时间段，JSON 数组格式。如 [{"start": "23:00", "end": "07:00"}]。' +
          '在此时间段内检测到变化会记录但不播报。默认 23:00-07:00。',
      },
      broadcast_cooldown_ms: {
        type: 'number',
        description: '播报冷却时间（毫秒），同一事件两次播报最小间隔。默认 600000（10 分钟）。',
      },
    },
    required: ['name', 'url'],
  },
  handler: async (args: {
    name: string
    url: string
    poll_interval_ms?: number
    method?: string
    headers?: string
    body?: string
    data_path?: string
    change_threshold?: number
    broadcast_template?: string
    enabled?: boolean
    mute_time_ranges?: string
    broadcast_cooldown_ms?: number
  }) => {
    const id = generateMonitorId()

    // 解析可选参数
    let parsedHeaders: Record<string, string> = {}
    if (args.headers) {
      try {
        parsedHeaders = JSON.parse(args.headers)
        if (typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
          return formatToolError('headers 必须是 JSON 对象格式')
        }
      } catch {
        return formatToolError('headers 格式无效，必须是有效的 JSON 字符串')
      }
    }

    // 解析静音时间段
    let muteTimeRanges = DEFAULT_EVENT_FILTER.muteTimeRanges
    if (args.mute_time_ranges) {
      try {
        const parsed = JSON.parse(args.mute_time_ranges)
        if (!Array.isArray(parsed)) {
          return formatToolError('mute_time_ranges 必须是 JSON 数组')
        }
        for (const r of parsed) {
          if (!r.start || !r.end || typeof r.start !== 'string' || typeof r.end !== 'string') {
            return formatToolError('每个静音时间段必须包含 start 和 end 字符串字段')
          }
          if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) {
            return formatToolError('时间格式必须为 HH:mm（如 "23:00", "07:00"）')
          }
        }
        muteTimeRanges = parsed
      } catch {
        return formatToolError('mute_time_ranges 格式无效，必须是有效的 JSON 字符串')
      }
    }

    const config: EventMonitorConfig = {
      id,
      name: args.name,
      url: args.url,
      pollIntervalMs: Math.max(5000, args.poll_interval_ms ?? DEFAULT_GLOBAL_CONFIG.defaultPollIntervalMs),
      method: (args.method as 'GET' | 'POST') || 'GET',
      headers: parsedHeaders,
      body: args.body,
      enabled: args.enabled !== false,
      dataPath: args.data_path || '',
      changeThreshold: args.change_threshold ?? 0,
      broadcastTemplate: args.broadcast_template || `${args.name}更新：从 {{prevValue}} 变为 {{value}}`,
      filters: {
        muteTimeRanges,
        minChange: 0,
        broadcastCooldownMs: Math.max(10000, args.broadcast_cooldown_ms ?? 600000),
        allowKeywords: [],
        blockKeywords: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const result = eventMonitorService.createMonitor(config)
    if (!result.success) {
      return formatToolError(result.error || '创建失败')
    }

    const intervalSec = Math.round(config.pollIntervalMs / 1000)
    const muteDesc = muteTimeRanges.map((r) => `${r.start}-${r.end}`).join(', ')

    log('INFO', 'event_monitor_tool_created', {
      id,
      name: args.name,
      url: args.url,
      interval: config.pollIntervalMs,
    })

    return formatToolResult(
      [
        `✅ 事件监测器已创建: ${config.name}`,
        `  ID: ${id}`,
        `  目标: ${config.url}`,
        `  轮询间隔: ${intervalSec} 秒`,
        `  数据路径: ${config.dataPath || '（完整响应）'}`,
        `  变化阈值: ${config.changeThreshold > 0 ? `${config.changeThreshold * 100}%` : '任何变化'}`,
        `  状态: ${config.enabled ? '🟢 已启用' : '🔴 已禁用'}`,
        `  静音时段: ${muteDesc || '无'}`,
        `  播报冷却: ${Math.round(config.filters.broadcastCooldownMs / 1000)} 秒`,
        '',
        '提示: 系统将在轮询检测到变化后通过语音播报通知。可用静音时间段和关键词过滤器控制播报时机。',
      ].join('\n'),
    )
  },
  isReadOnly: false,
})

// =============================================================================
//  工具：list_event_monitors
// =============================================================================

export const listEventMonitorsTool = buildTool({
  name: 'list_event_monitors',
  description: '列出所有已配置的实时事件监测器及其运行状态。显示每个监测器的名称、目标 URL、轮询间隔、启用状态和最近活动。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const monitors = eventMonitorService.listMonitors()
    const statuses = eventMonitorService.getRuntimeStatuses()
    const globalConfig = eventMonitorService.getGlobalConfig()

    if (monitors.length === 0) {
      return formatToolResult(
        [
          '═ 事件监测器列表 ═',
          `状态: ${globalConfig.enabled ? '🟢 全局启用' : '🔴 全局禁用'}`,
          '',
          '暂无监测器。使用 create_event_monitor 创建一个。',
        ].join('\n'),
      )
    }

    const statusMap = new Map(statuses.map((s) => [s.id, s]))

    const lines: string[] = [
      '═ 事件监测器列表 ═',
      `总数: ${monitors.length} | 活跃: ${eventMonitorService.countActiveMonitors()}`,
      `状态: ${globalConfig.enabled ? '🟢 全局启用' : '🔴 全局禁用'}`,
      '',
    ]

    for (const m of monitors) {
      const s = statusMap.get(m.id)
      const isActive = s?.active ?? false
      const isEnabled = m.enabled
      const statusIcon = isActive && isEnabled ? '🟢' : isEnabled ? '🟡' : '🔴'
      const lastPoll = s?.lastPollTime ? new Date(s.lastPollTime).toLocaleString('zh-CN') : '从未'
      const lastBroadcast = s?.lastBroadcastTime ? new Date(s.lastBroadcastTime).toLocaleString('zh-CN') : '从未'

      lines.push(`  ${statusIcon} ${m.name} (${m.id.slice(0, 16)}...)`)
      lines.push(`    URL: ${m.url}`)
      lines.push(`    轮询: 每 ${Math.round(m.pollIntervalMs / 1000)}s | 活跃: ${isActive ? '是' : '否'}`)
      lines.push(`    数据路径: ${m.dataPath || '（完整）'} | 阈值: ${m.changeThreshold > 0 ? `${m.changeThreshold * 100}%` : '任何'}`)
      lines.push(`    最近轮询: ${lastPoll} | 最近播报: ${lastBroadcast}`)
      if (s && s.consecutiveFailures > 0) {
        lines.push(`    ⚠ 连续失败: ${s.consecutiveFailures} 次`)
      }
      lines.push('')
    }

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: true,
})

// =============================================================================
//  工具：get_event_monitor
// =============================================================================

export const getEventMonitorTool = buildTool({
  name: 'get_event_monitor',
  description: '获取指定事件监测器的详细配置和运行时状态。需要监测器 ID（通过 list_event_monitors 获取）。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '监测器 ID，通过 list_event_monitors 获取。',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string }) => {
    const config = eventMonitorService.getMonitor(args.id)
    if (!config) {
      return formatToolError(`监测器 "${args.id}" 不存在`)
    }

    const statuses = eventMonitorService.getRuntimeStatuses()
    const status = statuses.find((s) => s.id === args.id)
    const logs = eventMonitorService.getLogs(args.id, 10)

    const muteDesc = config.filters.muteTimeRanges
      .map((r) => `${r.start}-${r.end}`)
      .join(', ')

    const lines: string[] = [
      `═ 监测器详情: ${config.name} ═`,
      `  ID: ${config.id}`,
      `  URL: ${config.url}`,
      `  方法: ${config.method}`,
      `  轮询间隔: ${Math.round(config.pollIntervalMs / 1000)} 秒`,
      `  数据路径: ${config.dataPath || '（完整响应文本）'}`,
      `  变化阈值: ${config.changeThreshold > 0 ? `${config.changeThreshold * 100}%` : '任何变化'}`,
      `  播报模板: ${config.broadcastTemplate}`,
      `  启用: ${config.enabled ? '是' : '否'}`,
      `  状态: ${status?.active ? '🟢 轮询中' : '⏹ 已停止'}`,
      '',
      '  过滤器配置:',
      `    静音时段: ${muteDesc || '无'}`,
      `    播报冷却: ${Math.round(config.filters.broadcastCooldownMs / 1000)} 秒`,
      `    关键词白名单: ${config.filters.allowKeywords.length > 0 ? config.filters.allowKeywords.join(', ') : '（全部）'}`,
      `    关键词黑名单: ${config.filters.blockKeywords.length > 0 ? config.filters.blockKeywords.join(', ') : '（无）'}`,
      '',
      '  运行时:',
      `    最近轮询: ${status?.lastPollTime ? new Date(status.lastPollTime).toLocaleString('zh-CN') : '从未'}`,
      `    最近播报: ${status?.lastBroadcastTime ? new Date(status.lastBroadcastTime).toLocaleString('zh-CN') : '从未'}`,
      `    连续失败: ${status?.consecutiveFailures ?? 0}`,
      `    最后比较值: ${status?.lastComparisonValue || '（空）'}`,
      '',
    ]

    if (logs.length > 0) {
      lines.push('  最近日志:')
      for (const entry of logs.slice(-10)) {
        const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
        const icon: Record<string, string> = { poll: 'ℹ', change: '📊', broadcast: '🔊', error: '❌', skip: '⏭' }
        lines.push(`    [${time}] ${icon[entry.type] || '•'} ${entry.message}`)
      }
    }

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: true,
})

// =============================================================================
//  工具：update_event_monitor
// =============================================================================

export const updateEventMonitorTool = buildTool({
  name: 'update_event_monitor',
  description:
    '更新现有事件监测器的配置。可以修改目标 URL、轮询间隔、数据路径、阈值、播报模板和过滤器。' +
    '未提供的参数保持原值。修改后如果启用状态或轮询间隔变化，会自动重启轮询。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '要修改的监测器 ID。',
      },
      name: {
        type: 'string',
        description: '新名称。',
      },
      url: {
        type: 'string',
        description: '新 HTTP API 地址。',
      },
      poll_interval_ms: {
        type: 'number',
        description: '新轮询间隔（毫秒）。最小 5000。',
      },
      method: {
        type: 'string',
        description: 'HTTP 方法。GET 或 POST。',
        enum: ['GET', 'POST'],
      },
      headers: {
        type: 'string',
        description: 'HTTP 请求头，JSON 字符串。',
      },
      body: {
        type: 'string',
        description: 'POST 请求体。',
      },
      data_path: {
        type: 'string',
        description: 'JSON 路径。空字符串表示使用完整响应。',
      },
      change_threshold: {
        type: 'number',
        description: '变化阈值 0-1。',
      },
      broadcast_template: {
        type: 'string',
        description: '播报模板。',
      },
      enabled: {
        type: 'boolean',
        description: '启用/禁用。',
      },
      mute_time_ranges: {
        type: 'string',
        description: '静音时间段，JSON 数组。',
      },
      broadcast_cooldown_ms: {
        type: 'number',
        description: '播报冷却（毫秒）。',
      },
    },
    required: ['id'],
  },
  handler: async (args: {
    id: string
    name?: string
    url?: string
    poll_interval_ms?: number
    method?: string
    headers?: string
    body?: string
    data_path?: string
    change_threshold?: number
    broadcast_template?: string
    enabled?: boolean
    mute_time_ranges?: string
    broadcast_cooldown_ms?: number
  }) => {
    const existing = eventMonitorService.getMonitor(args.id)
    if (!existing) {
      return formatToolError(`监测器 "${args.id}" 不存在`)
    }

    const updates: Partial<EventMonitorConfig> = {}

    if (args.name !== undefined) updates.name = args.name
    if (args.url !== undefined) updates.url = args.url
    if (args.poll_interval_ms !== undefined) updates.pollIntervalMs = Math.max(5000, args.poll_interval_ms)
    if (args.method !== undefined) updates.method = args.method as 'GET' | 'POST'
    if (args.body !== undefined) updates.body = args.body
    if (args.data_path !== undefined) updates.dataPath = args.data_path
    if (args.change_threshold !== undefined) updates.changeThreshold = args.change_threshold
    if (args.broadcast_template !== undefined) updates.broadcastTemplate = args.broadcast_template
    if (args.enabled !== undefined) updates.enabled = args.enabled

    if (args.headers !== undefined) {
      try {
        const parsed = JSON.parse(args.headers)
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          return formatToolError('headers 必须是 JSON 对象')
        }
        updates.headers = parsed
      } catch {
        return formatToolError('headers 格式无效')
      }
    }

    // 更新过滤器
    const filterUpdates: Partial<EventFilterConfig> = {}

    if (args.mute_time_ranges !== undefined) {
      try {
        const parsed = JSON.parse(args.mute_time_ranges)
        if (!Array.isArray(parsed)) return formatToolError('mute_time_ranges 必须是数组')
        for (const r of parsed) {
          if (!r.start || !r.end || !/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) {
            return formatToolError('时间格式必须为 HH:mm')
          }
        }
        filterUpdates.muteTimeRanges = parsed
      } catch {
        return formatToolError('mute_time_ranges 格式无效')
      }
    }

    if (args.broadcast_cooldown_ms !== undefined) {
      filterUpdates.broadcastCooldownMs = Math.max(10000, args.broadcast_cooldown_ms)
    }

    if (Object.keys(filterUpdates).length > 0) {
      updates.filters = { ...existing.filters, ...filterUpdates }
    }

    const result = eventMonitorService.updateMonitor(args.id, updates)
    if (!result.success) {
      return formatToolError(result.error || '更新失败')
    }

    const changedFields = Object.keys(updates).filter((k) => k !== 'filters')
    if (updates.filters) changedFields.push('filters')

    log('INFO', 'event_monitor_tool_updated', {
      id: args.id,
      fields: changedFields,
    })

    return formatToolResult(
      `✅ 监测器 "${args.name || existing.name}" 已更新 (${changedFields.join(', ')})`,
    )
  },
  isReadOnly: false,
})

// =============================================================================
//  工具：delete_event_monitor
// =============================================================================

export const deleteEventMonitorTool = buildTool({
  name: 'delete_event_monitor',
  description: '删除指定的事件监测器。停止轮询并清除所有状态和日志。不可恢复。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '要删除的监测器 ID。',
      },
      confirm: {
        type: 'boolean',
        description: '确认删除。必须为 true 才能执行删除操作。',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string; confirm?: boolean }) => {
    if (args.confirm !== true) {
      return formatToolResult(
        `⚠ 请设置 confirm=true 确认删除监测器 "${args.id}"。此操作不可恢复。`,
      )
    }

    const monitor = eventMonitorService.getMonitor(args.id)
    const name = monitor?.name || args.id

    const result = eventMonitorService.deleteMonitor(args.id)
    if (!result.success) {
      return formatToolError(result.error || '删除失败')
    }

    log('INFO', 'event_monitor_tool_deleted', { id: args.id })

    return formatToolResult(`✅ 监测器 "${name}" 已删除`)
  },
  isReadOnly: false,
})

// =============================================================================
//  工具：get_event_monitor_logs
// =============================================================================

export const getEventMonitorLogsTool = buildTool({
  name: 'get_event_monitor_logs',
  description: '获取指定事件监测器的运行日志。包括轮询记录、变化检测、播报记录和错误信息。用于排查监测器是否正常工作。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '监测器 ID。不指定则返回所有监测器的最近日志。',
      },
      limit: {
        type: 'number',
        description: '每个监测器返回的日志条数上限。默认 20，最大 100。',
      },
    },
    required: [],
  },
  handler: async (args: { id?: string; limit?: number }) => {
    const maxLimit = Math.min(100, args.limit ?? 20)

    if (args.id) {
      const monitor = eventMonitorService.getMonitor(args.id)
      if (!monitor) {
        return formatToolError(`监测器 "${args.id}" 不存在`)
      }

      const logs = eventMonitorService.getLogs(args.id, maxLimit)
      if (logs.length === 0) {
        return formatToolResult(`监测器 "${monitor.name}" 暂无日志`)
      }

      const lines: string[] = [`═ 日志: ${monitor.name} ═`]
      for (const entry of logs) {
        const time = new Date(entry.timestamp).toLocaleString('zh-CN')
        const icon: Record<string, string> = { poll: 'ℹ️', change: '📊', broadcast: '🔊', error: '❌', skip: '⏭️' }
        lines.push(`  [${time}] ${icon[entry.type] || '•'} ${entry.message}`)
      }

      return formatToolResult(lines.join('\n'))
    }

    // 无 ID：返回所有监测器的最近日志
    const allLogs = eventMonitorService.getAllLogs(maxLimit)
    const monitorIds = Object.keys(allLogs)

    if (monitorIds.length === 0) {
      return formatToolResult('暂无监测器日志')
    }

    const lines: string[] = ['═ 所有监测器日志 ═']
    for (const id of monitorIds) {
      const monitor = eventMonitorService.getMonitor(id)
      const name = monitor?.name || id
      const logs = allLogs[id]

      lines.push(`\n--- ${name} (${id.slice(0, 12)}...) ---`)
      for (const entry of logs) {
        const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
        const icon: Record<string, string> = { poll: 'ℹ️', change: '📊', broadcast: '🔊', error: '❌', skip: '⏭️' }
        lines.push(`  [${time}] ${icon[entry.type] || '•'} ${entry.message}`)
      }
    }

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: true,
})

// =============================================================================
//  工具：poll_event_monitor_now
// =============================================================================

export const pollEventMonitorNowTool = buildTool({
  name: 'poll_event_monitor_now',
  description: '立即触发一次指定事件监测器的轮询。强制请求目标 API、比对数据、如有变化则播报。用于手动验证配置是否正确。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '要立即轮询的监测器 ID。',
      },
    },
    required: ['id'],
  },
  handler: async (args: { id: string }) => {
    const monitor = eventMonitorService.getMonitor(args.id)
    if (!monitor) {
      return formatToolError(`监测器 "${args.id}" 不存在`)
    }

    const result = await eventMonitorService.pollNow(args.id)

    if (result.success) {
      const msg = result.message
        ? `✅ 轮询完成: ${msg}`
        : `✅ 轮询完成（${monitor.url}），无变化。`
      return formatToolResult(msg)
    }

    return formatToolError(`❌ 轮询失败: ${result.message}`)
  },
  isReadOnly: false,
})

// =============================================================================
//  工具：event_monitor_global_config
// =============================================================================

export const eventMonitorGlobalConfigTool = buildTool({
  name: 'event_monitor_global_config',
  description:
    '配置事件监测系统全局设置：全局启停、播报风格、默认轮询间隔等。' +
    '无需参数时返回当前全局配置。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description: '全局启用/禁用所有监测器。true=启用（恢复所有已启用监测器的轮询），false=禁用（停止所有轮询）。',
      },
      broadcast_style: {
        type: 'string',
        description: '全局播报风格。natural=自然（完整播报）、brief=简洁（仅摘要）、detail=详细（含变化数据）。默认 brief。',
        enum: ['natural', 'brief', 'detail'],
      },
      default_poll_interval_ms: {
        type: 'number',
        description: '新建监测器的默认轮询间隔（毫秒）。最小 5000。',
      },
    },
    required: [],
  },
  handler: async (args: {
    enabled?: boolean
    broadcast_style?: string
    default_poll_interval_ms?: number
  }) => {
    const current = eventMonitorService.getGlobalConfig()
    const changes: string[] = []

    if (args.enabled !== undefined) {
      eventMonitorService.updateGlobalConfig({ enabled: args.enabled })
      changes.push(`全局${args.enabled ? '启用' : '禁用'}`)
    }

    if (args.broadcast_style) {
      const validStyles = ['natural', 'brief', 'detail']
      if (!validStyles.includes(args.broadcast_style)) {
        return formatToolError(`无效的播报风格: ${args.broadcast_style}。可选: ${validStyles.join(', ')}`)
      }
      eventMonitorService.updateGlobalConfig({ broadcastStyle: args.broadcast_style as BroadcastStyle })
      changes.push(`播报风格: ${args.broadcast_style}`)
    }

    if (args.default_poll_interval_ms !== undefined) {
      const interval = Math.max(5000, args.default_poll_interval_ms)
      eventMonitorService.updateGlobalConfig({ defaultPollIntervalMs: interval })
      changes.push(`默认轮询间隔: ${Math.round(interval / 1000)} 秒`)
    }

    const updated = eventMonitorService.getGlobalConfig()

    const lines: string[] = [
      '═ 事件监测全局配置 ═',
      `全局状态: ${updated.enabled ? '🟢 已启用' : '🔴 已禁用'}`,
      `播报风格: ${updated.broadcastStyle === 'natural' ? '自然' : updated.broadcastStyle === 'brief' ? '简洁' : '详细'}`,
      `默认轮询间隔: ${Math.round(updated.defaultPollIntervalMs / 1000)} 秒`,
      `并发限制: ${updated.maxConcurrentPolls}`,
    ]

    if (changes.length > 0) {
      lines.push('', '本次变更:', ...changes.map((c) => `  ✓ ${c}`))
    }

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: false,
})
