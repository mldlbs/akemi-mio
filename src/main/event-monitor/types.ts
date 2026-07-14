/**
 * EventMonitor — 事件监测类型定义
 *
 * 定义实时事件离线语音播报所需的配置、状态和运行时类型。
 * 与 EventMonitorService（核心服务）和 EventMonitorTools（MCP 工具层）配套使用。
 */

// =============================================================================
// 配置类型
// =============================================================================

/** 静音时间段 */
export interface MuteTimeRange {
  /** 开始时间 HH:mm (24h) */
  start: string
  /** 结束时间 HH:mm (24h) */
  end: string
}

/** 事件过滤器配置 */
export interface EventFilterConfig {
  /** 静音时间段列表（此时间段内不播报） */
  muteTimeRanges: MuteTimeRange[]
  /** 最小变化量触发阈值（数值变化绝对值，0=全部触发） */
  minChange: number
  /** 播报冷却时间（毫秒），同一事件两次播报之间最小间隔 */
  broadcastCooldownMs: number
  /** 关键词过滤器：仅当响应包含这些关键词时才播报（空=全部播报） */
  allowKeywords: string[]
  /** 关键词过滤器：响应包含这些关键词时跳过播报 */
  blockKeywords: string[]
}

export const DEFAULT_EVENT_FILTER: EventFilterConfig = {
  muteTimeRanges: [{ start: '23:00', end: '07:00' }],
  minChange: 0,
  broadcastCooldownMs: 10 * 60 * 1000, // 10 分钟冷却
  allowKeywords: [],
  blockKeywords: [],
}

/** 事件监测器配置 */
export interface EventMonitorConfig {
  /** 唯一标识 */
  id: string
  /** 用户可读的名称 */
  name: string
  /** 轮询的 HTTP API URL */
  url: string
  /** 轮询间隔（毫秒），默认 60000 */
  pollIntervalMs: number
  /** HTTP 请求方法，默认 GET */
  method: 'GET' | 'POST'
  /** HTTP 请求头 */
  headers: Record<string, string>
  /** POST 请求体（JSON 字符串） */
  body?: string
  /** 启用/禁用 */
  enabled: boolean
  /** 响应 JSON Path（如 "data.temperature"），用于从响应中提取比较值。留空表示使用完整响应文本。 */
  dataPath: string
  /** 变化阈值 0-1（百分比），超过此值触发播报。0=任何变化都触发。 */
  changeThreshold: number
  /** 自定义播报模板。可用占位符: {{name}} {{value}} {{prevValue}} {{change}} {{time}} */
  broadcastTemplate: string
  /** 事件过滤器 */
  filters: EventFilterConfig
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

export type BroadcastStyle = 'natural' | 'brief' | 'detail'

/** 全局事件监测配置 */
export interface EventMonitorGlobalConfig {
  /** 全局启用/禁用所有监测器 */
  enabled: boolean
  /** 全局播报风格 */
  broadcastStyle: BroadcastStyle
  /** 全局默认轮询间隔（毫秒） */
  defaultPollIntervalMs: number
  /** 并发请求限制 */
  maxConcurrentPolls: number
}

export const DEFAULT_GLOBAL_CONFIG: EventMonitorGlobalConfig = {
  enabled: true,
  broadcastStyle: 'brief',
  defaultPollIntervalMs: 60000,
  maxConcurrentPolls: 3,
}

// =============================================================================
// 运行时状态
// =============================================================================

/** 监测器运行时状态 */
export interface EventMonitorState {
  /** 上次轮询获取的原始数据 */
  lastDataRaw: string
  /** 上次通过 dataPath 提取的比较值（字符串形式，便于 JSON 变化检测） */
  lastComparisonValue: string
  /** 上次成功播报的时间戳 */
  lastBroadcastTime: number
  /** 上次轮询时间戳 */
  lastPollTime: number
  /** 连续失败次数 */
  consecutiveFailures: number
}

/** 监测器运行时快照（对外展示） */
export interface EventMonitorRuntimeStatus {
  id: string
  name: string
  url: string
  pollIntervalMs: number
  enabled: boolean
  active: boolean
  lastPollTime: number | null
  lastBroadcastTime: number | null
  consecutiveFailures: number
  lastComparisonValue: string
  error?: string
}

/** 监测器日志条目 */
export interface EventMonitorLogEntry {
  timestamp: number
  type: 'poll' | 'change' | 'broadcast' | 'error' | 'skip'
  message: string
  detail?: string
}

// =============================================================================
// 持久化结构
// =============================================================================

export interface EventMonitorStore {
  version: number
  globalConfig: EventMonitorGlobalConfig
  monitors: Record<string, EventMonitorConfig>
  states: Record<string, EventMonitorState>
}

// =============================================================================
// API 工具函数
// =============================================================================

/** 默认播报模板，根据监测器名称智能生成 */
export function getDefaultBroadcastTemplate(name: string): string {
  return `${name}更新：从 {{prevValue}} 变为 {{value}}`
}

/** 默认监测器配置工厂 */
export function createDefaultMonitorConfig(id: string, name: string, url: string): EventMonitorConfig {
  return {
    id,
    name,
    url,
    pollIntervalMs: DEFAULT_GLOBAL_CONFIG.defaultPollIntervalMs,
    method: 'GET',
    headers: {},
    enabled: true,
    dataPath: '',
    changeThreshold: 0,
    broadcastTemplate: getDefaultBroadcastTemplate(name),
    filters: { ...DEFAULT_EVENT_FILTER, muteTimeRanges: [{ start: '23:00', end: '07:00' }] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 判断当前时间是否在静音时间段内 */
export function isInMuteTime(ranges: MuteTimeRange[]): boolean {
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  for (const range of ranges) {
    const [startH, startM] = range.start.split(':').map(Number)
    const [endH, endM] = range.end.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes <= endMinutes) {
      // 正常时间段（如 08:00-22:00）
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
        return true
      }
    } else {
      // 跨天时间段（如 23:00-07:00）
      if (currentMinutes >= startMinutes || currentMinutes < endMinutes) {
        return true
      }
    }
  }

  return false
}

/** 生成监测器 ID */
export function generateMonitorId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
