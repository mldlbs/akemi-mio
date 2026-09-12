/**
 * EventMonitorService — 实时事件离线语音播报核心服务
 *
 * 职责：
 * 1. 管理多个事件监测器的生命周期（CRUD + 启停）
 * 2. 按配置的轮询间隔定时调用 HTTP API 获取外部数据
 * 3. 比对本地缓存状态，检测变化是否超过阈值
 * 4. 通过 TtsNotifyTool 的 notificationQueue 将播报文本合成为语音
 * 5. 静默时间段检查、播报冷却控制、关键词过滤
 * 6. 状态持久化到 JSON 文件（跨重启恢复）
 *
 * 使用场景：
 * - 台风路径实时更新语音提醒
 * - 股票/加密货币价格波动通知
 * - 天气预警信息播报
 * - 任何 HTTP API 可获取的实时事件
 */

import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import { cleanTTS } from '@akemi-mio/audio/TtsService'
import { notificationQueue } from '@akemi-mio/capabilities/tool/definitions/TtsNotifyTool'
import type { NotifyPriority } from '@akemi-mio/capabilities/tool/definitions/TtsNotifyTool'
import {
  type EventMonitorConfig,
  type EventMonitorState,
  type EventMonitorStore,
  type EventMonitorRuntimeStatus,
  type EventMonitorLogEntry,
  type EventMonitorGlobalConfig,
  type BroadcastStyle,
  type MuteTimeRange,
  DEFAULT_GLOBAL_CONFIG,
  DEFAULT_EVENT_FILTER,
  isInMuteTime,
} from '@akemi-mio/monitoring/event-monitor/types'

// =============================================================================
// 常量
// =============================================================================

/** 状态存储文件名 */
const STATE_FILE = 'event-monitor-state.json'

/** 每个监测器最大日志条目数 */
const MAX_LOG_ENTRIES = 200

/** 状态存储版本号 */
const STORE_VERSION = 1

/** 默认请求超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000

// =============================================================================
// EventMonitorService
// =============================================================================

export class EventMonitorService {
  // ── 状态 ──

  /** 所有监测器配置 */
  private monitors = new Map<string, EventMonitorConfig>()

  /** 所有监测器运行时状态 */
  private states = new Map<string, EventMonitorState>()

  /** 全局配置 */
  private globalConfig: EventMonitorGlobalConfig = { ...DEFAULT_GLOBAL_CONFIG }

  /** 活跃的轮询定时器（monitorId → interval timer） */
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>()

  /** 每个监测器的日志 */
  private logs = new Map<string, EventMonitorLogEntry[]>()

  /** 存储文件路径 */
  private storePath: string = ''

  /** 服务是否已初始化 */
  private initialized = false

  // ── 单例 ──

  private static instance: EventMonitorService

  static getInstance(): EventMonitorService {
    if (!EventMonitorService.instance) {
      EventMonitorService.instance = new EventMonitorService()
    }
    return EventMonitorService.instance
  }

  // ── 生命周期 ──

  /**
   * 初始化服务。
   * @param storeDir 状态持久化目录（通常为 WORKSPACE/data/）
   */
  async init(storeDir: string): Promise<void> {
    if (this.initialized) return

    this.storePath = join(storeDir, STATE_FILE)

    // 确保目录存在
    const dir = dirname(this.storePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // 从文件恢复状态
    await this.loadFromDisk()

    // 启动所有已启用的监测器
    for (const [id, config] of this.monitors) {
      if (config.enabled) {
        this.startPolling(id)
      }
    }

    this.initialized = true
    log('INFO', 'event_monitor_init', {
      monitorCount: this.monitors.size,
      activeCount: this.countActiveMonitors(),
    })
  }

  /**
   * 停止所有轮询并持久化状态。
   */
  async destroy(): Promise<void> {
    for (const id of this.pollTimers.keys()) {
      this.stopPolling(id)
    }
    await this.saveToDisk()
    this.initialized = false
    log('INFO', 'event_monitor_destroyed')
  }

  // ── 监测器管理 ──

  /**
   * 创建新的监测器。
   * 如果 enabled=true 且服务已初始化，立即开始轮询。
   */
  createMonitor(config: EventMonitorConfig): { success: boolean; error?: string } {
    if (this.monitors.has(config.id)) {
      return { success: false, error: `监测器 "${config.id}" 已存在` }
    }

    this.monitors.set(config.id, { ...config })
    this.states.set(config.id, this.createInitialState())
    this.logs.set(config.id, [])

    this.addLog(config.id, 'poll', `监测器 "${config.name}" 已创建`)

    // 如果启用了，开始轮询
    if (config.enabled && this.initialized) {
      this.startPolling(config.id)
    }

    this.saveToDisk().catch(() => {})

    log('INFO', 'event_monitor_created', {
      id: config.id,
      name: config.name,
      url: config.url,
      interval: config.pollIntervalMs,
    })

    return { success: true }
  }

  /**
   * 更新监测器配置。
   * 会重启轮询（如果运行时变更）。
   */
  updateMonitor(id: string, updates: Partial<EventMonitorConfig>): { success: boolean; error?: string } {
    const existing = this.monitors.get(id)
    if (!existing) {
      return { success: false, error: `监测器 "${id}" 不存在` }
    }

    const wasEnabled = existing.enabled
    const prevInterval = existing.pollIntervalMs

    // 合并更新
    const updated: EventMonitorConfig = { ...existing, ...updates, id, updatedAt: Date.now() }
    this.monitors.set(id, updated)

    // 如果轮询间隔或启用状态变了，重启轮询
    const needsRestart =
      wasEnabled !== updated.enabled ||
      (wasEnabled && prevInterval !== updated.pollIntervalMs) ||
      (wasEnabled && existing.url !== updated.url)

    if (needsRestart) {
      if (wasEnabled) this.stopPolling(id)
      if (updated.enabled && this.initialized) this.startPolling(id)
    }

    this.addLog(id, 'poll', `监测器 "${updated.name}" 已更新`)

    this.saveToDisk().catch(() => {})

    log('INFO', 'event_monitor_updated', { id, name: updated.name })
    return { success: true }
  }

  /**
   * 删除监测器。
   */
  deleteMonitor(id: string): { success: boolean; error?: string } {
    if (!this.monitors.has(id)) {
      return { success: false, error: `监测器 "${id}" 不存在` }
    }

    this.stopPolling(id)
    this.monitors.delete(id)
    this.states.delete(id)
    this.logs.delete(id)

    this.saveToDisk().catch(() => {})

    log('INFO', 'event_monitor_deleted', { id })
    return { success: true }
  }

  /**
   * 获取单个监测器配置。
   */
  getMonitor(id: string): EventMonitorConfig | undefined {
    return this.monitors.get(id)
  }

  /**
   * 获取所有监测器列表。
   */
  listMonitors(): EventMonitorConfig[] {
    return Array.from(this.monitors.values())
  }

  // ── 运行时状态 ──

  /**
   * 获取所有监测器的运行时状态快照。
   */
  getRuntimeStatuses(): EventMonitorRuntimeStatus[] {
    const result: EventMonitorRuntimeStatus[] = []

    for (const [id, config] of this.monitors) {
      const state = this.states.get(id)
      const active = this.pollTimers.has(id)

      result.push({
        id,
        name: config.name,
        url: config.url,
        pollIntervalMs: config.pollIntervalMs,
        enabled: config.enabled,
        active,
        lastPollTime: state?.lastPollTime ?? null,
        lastBroadcastTime: state?.lastBroadcastTime ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastComparisonValue: state?.lastComparisonValue ?? '',
      })
    }

    return result
  }

  /**
   * 获取监测器日志。
   */
  getLogs(id: string, limit = 50): EventMonitorLogEntry[] {
    const entries = this.logs.get(id)
    if (!entries) return []
    return entries.slice(-limit)
  }

  /**
   * 获取所有监测器日志。
   */
  getAllLogs(limit = 20): Record<string, EventMonitorLogEntry[]> {
    const result: Record<string, EventMonitorLogEntry[]> = {}
    for (const [id] of this.monitors) {
      result[id] = this.getLogs(id, limit)
    }
    return result
  }

  /**
   * 获取全局配置。
   */
  getGlobalConfig(): EventMonitorGlobalConfig {
    return { ...this.globalConfig }
  }

  /**
   * 更新全局配置。
   */
  updateGlobalConfig(updates: Partial<EventMonitorGlobalConfig>): void {
    this.globalConfig = { ...this.globalConfig, ...updates }
    this.saveToDisk().catch(() => {})
    log('INFO', 'event_monitor_global_config_updated', { updates: Object.keys(updates) })
  }

  /**
   * 立即触发一次指定监测器的轮询。
   */
  async pollNow(id: string): Promise<{ success: boolean; message: string }> {
    const config = this.monitors.get(id)
    if (!config) {
      return { success: false, message: `监测器 "${id}" 不存在` }
    }

    try {
      const result = await this.executePoll(config)
      return { success: true, message: result || '轮询完成，无变化' }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      return { success: false, message: `轮询失败: ${errorMsg}` }
    }
  }

  /** 获取活跃监测器数量 */
  countActiveMonitors(): number {
    return this.pollTimers.size
  }

  /** 获取监测器总数 */
  countMonitors(): number {
    return this.monitors.size
  }

  // ── 轮询核心 ──

  /**
   * 启动指定监测器的轮询定时器。
   */
  private startPolling(id: string): void {
    const config = this.monitors.get(id)
    if (!config) return

    // 避免重复启动
    if (this.pollTimers.has(id)) return

    const timer = setInterval(
      async () => {
        await this.executePoll(config).catch((err) => {
          log('WARN', 'event_monitor_poll_error', {
            id,
            name: config.name,
            error: String(err),
          })
        })
      },
      Math.max(5000, config.pollIntervalMs),
    ) // 最小 5 秒

    this.pollTimers.set(id, timer)

    log('INFO', 'event_monitor_poll_started', {
      id,
      name: config.name,
      interval: config.pollIntervalMs,
    })

    // 启动后立即执行一次
    this.executePoll(config).catch(() => {})
  }

  /**
   * 停止指定监测器的轮询定时器。
   */
  private stopPolling(id: string): void {
    const timer = this.pollTimers.get(id)
    if (timer) {
      clearInterval(timer)
      this.pollTimers.delete(id)
      log('INFO', 'event_monitor_poll_stopped', { id })
    }
  }

  /**
   * 执行一次完整轮询：请求 → 提取 → 比较 → 播报
   */
  private async executePoll(config: EventMonitorConfig): Promise<string | null> {
    const t0 = Date.now()
    const state = this.states.get(config.id)
    if (!state) return null

    // 更新轮询时间
    state.lastPollTime = Date.now()

    // 1. HTTP 请求获取数据
    let responseText: string
    try {
      responseText = await this.httpFetch(config)
    } catch (err) {
      state.consecutiveFailures++
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.addLog(config.id, 'error', `HTTP 请求失败: ${errorMsg}`)
      log('WARN', 'event_monitor_http_failed', {
        id: config.id,
        name: config.name,
        error: errorMsg,
      })
      this.autoDisableIfFailing(config)
      return null
    }

    // 重置连续失败计数
    state.consecutiveFailures = 0

    // 2. 提取比较值
    const currentValue = this.extractValue(responseText, config.dataPath)

    // 3. 与缓存比较，检测变化
    const prevValue = state.lastComparisonValue
    const hasChanged = this.detectChange(prevValue, currentValue, config)

    if (!hasChanged) {
      state.lastComparisonValue = currentValue
      state.lastDataRaw = responseText
      this.addLog(config.id, 'poll', `轮询完成：值未变化 (${currentValue.slice(0, 60)})`)
      return null
    }

    // 记录新值
    state.lastComparisonValue = currentValue
    state.lastDataRaw = responseText

    // 4. 检查静音时间段
    if (isInMuteTime(config.filters.muteTimeRanges)) {
      this.addLog(config.id, 'skip', `变化检测到但处于静音时间段，跳过播报`)
      log('INFO', 'event_monitor_muted', {
        id: config.id,
        name: config.name,
        prev: prevValue.slice(0, 60),
        current: currentValue.slice(0, 60),
      })
      return '变化已检测到，但处于静音时间段'
    }

    // 5. 检查播报冷却
    const cooldownRemaining = config.filters.broadcastCooldownMs - (Date.now() - state.lastBroadcastTime)
    if (cooldownRemaining > 0) {
      this.addLog(config.id, 'skip', `播报冷却中，剩余 ${Math.round(cooldownRemaining / 1000)}s`)
      return '变化检测到但处于播报冷却中'
    }

    // 6. 检查关键词过滤
    if (!this.passesKeywordFilter(responseText, config)) {
      this.addLog(config.id, 'skip', `变化检测到但被关键词过滤器拦截`)
      return '变化检测到但被关键词过滤器拦截'
    }

    // 7. 生成播报文本
    const broadcastText = this.generateBroadcastText(config, prevValue, currentValue)

    // 8. 通过 TTS 通知队列播报
    this.broadcast(broadcastText)

    state.lastBroadcastTime = Date.now()

    const elapsed = Date.now() - t0

    this.addLog(config.id, 'broadcast', `播报: ${broadcastText}`)
    log('INFO', 'event_monitor_broadcast', {
      id: config.id,
      name: config.name,
      prev: prevValue.slice(0, 60),
      current: currentValue.slice(0, 60),
      broadcast: broadcastText.slice(0, 80),
      elapsed,
    })

    return broadcastText
  }

  // ── HTTP 请求 ──

  /**
   * 执行 HTTP(S) 请求获取数据。
   * 使用 Node.js 原生 fetch（Electron 环境可用）。
   */
  private async httpFetch(config: EventMonitorConfig): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS)

    try {
      const fetchOptions: RequestInit & { signal: AbortSignal } = {
        method: config.method || 'GET',
        headers: {
          'User-Agent': 'AkemiMio/1.0 EventMonitor',
          Accept: 'application/json, text/plain, */*',
          ...config.headers,
        },
        signal: controller.signal,
      }

      if (config.body && config.method === 'POST') {
        fetchOptions.body = config.body
      }

      const response = await fetch(config.url, fetchOptions)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const text = await response.text()
      return text
    } finally {
      clearTimeout(timeout)
    }
  }

  // ── 值提取与变化检测 ──

  /**
   * 从 HTTP 响应文本中提取比较值。
   * 如果配置了 dataPath，尝试 JSON 解析后用路径提取；否则返回原始文本前 200 字符。
   */
  private extractValue(responseText: string, dataPath: string): string {
    if (!dataPath) {
      // 没有 dataPath，用整个响应文本的摘要
      return responseText.trim().slice(0, 200)
    }

    try {
      const parsed = JSON.parse(responseText)
      const value = this.resolveJsonPath(parsed, dataPath)
      return value !== undefined ? String(value) : responseText.trim().slice(0, 200)
    } catch {
      // JSON 解析失败，用原始文本
      return responseText.trim().slice(0, 200)
    }
  }

  /**
   * 简单 JSON Path 解析器（支持点号分隔路径）。
   * 如 "data.temperature" 或 "result.wind.speed"。
   * 也支持数组索引： "data.items[0].name"
   */
  private resolveJsonPath(obj: unknown, path: string): unknown {
    const parts = path.split('.')

    let current: unknown = obj
    for (const part of parts) {
      if (current === null || current === undefined) return undefined

      // 处理数组索引如 items[0]
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/)
      if (arrayMatch) {
        const [, key, indexStr] = arrayMatch
        const index = parseInt(indexStr, 10)
        if (typeof current === 'object' && current !== null && key in (current as Record<string, unknown>)) {
          const arr = (current as Record<string, unknown>)[key]
          if (Array.isArray(arr) && index < arr.length) {
            current = arr[index]
          } else {
            return undefined
          }
        } else {
          return undefined
        }
      } else if (typeof current === 'object' && current !== null && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }

    return current
  }

  /**
   * 检测值是否发生了变化（超过阈值）。
   */
  private detectChange(prevValue: string, currentValue: string, config: EventMonitorConfig): boolean {
    if (!prevValue) {
      // 首次轮询，无历史值，记录但不触发
      return false
    }

    if (prevValue === currentValue) {
      return false
    }

    // 如果阈值为 0，任何变化都触发
    if (config.changeThreshold <= 0) {
      return true
    }

    // 尝试数值比较
    const prevNum = parseFloat(prevValue)
    const currentNum = parseFloat(currentValue)

    if (!isNaN(prevNum) && !isNaN(currentNum) && prevNum !== 0) {
      const changePercent = Math.abs((currentNum - prevNum) / prevNum)
      return changePercent >= config.changeThreshold
    }

    // 非数值比较：字符串变化即触发
    return true
  }

  // ── 播报文本生成 ──

  /**
   * 生成播报文本。
   * 使用配置的模板，支持占位符替换。
   */
  private generateBroadcastText(config: EventMonitorConfig, prevValue: string, currentValue: string): string {
    const template = config.broadcastTemplate

    const changeDesc = this.describeChange(prevValue, currentValue)

    return template
      .replace(/\{\{name\}\}/g, config.name)
      .replace(/\{\{value\}\}/g, currentValue)
      .replace(/\{\{prevValue\}\}/g, prevValue)
      .replace(/\{\{change\}\}/g, changeDesc)
      .replace(/\{\{time\}\}/g, new Date().toLocaleString('zh-CN'))
  }

  /**
   * 生成变化描述文本。
   */
  private describeChange(prevValue: string, currentValue: string): string {
    const prevNum = parseFloat(prevValue)
    const currentNum = parseFloat(currentValue)

    if (!isNaN(prevNum) && !isNaN(currentNum)) {
      const diff = currentNum - prevNum
      const sign = diff >= 0 ? '上升' : '下降'
      const percent = prevNum !== 0 ? Math.abs((diff / prevNum) * 100).toFixed(1) : '0'
      return `${sign} ${Math.abs(diff).toFixed(1)} (${percent}%)`
    }

    return `从 "${prevValue}" 变为 "${currentValue}"`
  }

  // ── 播报 ──

  /**
   * 通过 TTS 通知队列播报文本。
   * 使用高优先级通知以确保重要事件不被低优先级任务阻塞。
   */
  private broadcast(text: string): void {
    const cleaned = cleanTTS(text)
    if (!cleaned || cleaned.length < 2) return

    notificationQueue.enqueue(cleaned, 'high')
  }

  // ── 关键词过滤 ──

  /**
   * 检查响应文本是否通过关键词过滤器。
   * allowKeywords 优先于 blockKeywords。
   */
  private passesKeywordFilter(responseText: string, config: EventMonitorConfig): boolean {
    const { allowKeywords, blockKeywords } = config.filters

    // 如果有关键词白名单，至少需要匹配一个
    if (allowKeywords.length > 0) {
      const matched = allowKeywords.some((kw) => responseText.includes(kw))
      if (!matched) return false
    }

    // 检查黑名单
    if (blockKeywords.length > 0) {
      const blocked = blockKeywords.some((kw) => responseText.includes(kw))
      if (blocked) return false
    }

    return true
  }

  // ── 自动禁用 ──

  /**
   * 如果连续失败超过 5 次，自动禁用监测器。
   */
  private autoDisableIfFailing(config: EventMonitorConfig): void {
    const state = this.states.get(config.id)
    if (state && state.consecutiveFailures >= 5) {
      config.enabled = false
      this.stopPolling(config.id)
      this.addLog(config.id, 'error', `连续失败 ${state.consecutiveFailures} 次，已自动禁用`)
      log('WARN', 'event_monitor_auto_disabled', {
        id: config.id,
        name: config.name,
        failures: state.consecutiveFailures,
      })
      this.saveToDisk().catch(() => {})
    }
  }

  // ── 日志 ──

  private addLog(id: string, type: EventMonitorLogEntry['type'], message: string): void {
    const entries = this.logs.get(id)
    if (!entries) return

    entries.push({ timestamp: Date.now(), type, message })
    if (entries.length > MAX_LOG_ENTRIES) {
      entries.splice(0, entries.length - MAX_LOG_ENTRIES)
    }
  }

  // ── 持久化 ──

  private createInitialState(): EventMonitorState {
    return {
      lastDataRaw: '',
      lastComparisonValue: '',
      lastBroadcastTime: 0,
      lastPollTime: 0,
      consecutiveFailures: 0,
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.storePath)) return

      const raw = readFileSync(this.storePath, 'utf-8')
      const store: EventMonitorStore = JSON.parse(raw)

      if (store.version !== STORE_VERSION) {
        log('WARN', 'event_monitor_store_version_mismatch', {
          file: store.version,
          expected: STORE_VERSION,
        })
        return
      }

      // 恢复全局配置
      if (store.globalConfig) {
        this.globalConfig = { ...DEFAULT_GLOBAL_CONFIG, ...store.globalConfig }
      }

      // 恢复监测器配置
      if (store.monitors) {
        for (const [id, config] of Object.entries(store.monitors)) {
          this.monitors.set(id, config)
        }
      }

      // 恢复运行时状态
      if (store.states) {
        for (const [id, state] of Object.entries(store.states)) {
          this.states.set(id, state)
        }
      }

      // 为每个监测器初始化日志
      for (const id of this.monitors.keys()) {
        this.logs.set(id, [])
        if (!this.states.has(id)) {
          this.states.set(id, this.createInitialState())
        }
      }

      log('INFO', 'event_monitor_loaded', {
        monitorCount: this.monitors.size,
        file: this.storePath,
      })
    } catch (err) {
      log('WARN', 'event_monitor_load_failed', {
        error: String(err),
        file: this.storePath,
      })
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.storePath) return

    try {
      const store: EventMonitorStore = {
        version: STORE_VERSION,
        globalConfig: this.globalConfig,
        monitors: Object.fromEntries(this.monitors),
        states: Object.fromEntries(this.states),
      }

      writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'event_monitor_save_failed', { error: String(err) })
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

/** 全局事件监测服务单例 */
export const eventMonitorService = EventMonitorService.getInstance()
