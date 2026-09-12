import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { LLM_API_URL, LLM_CODE_API_URL, LLM_TEXT_API_URL, LLM_VISION_API_URL } from '@akemi-mio/core/config'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { engineProvider } from '@akemi-mio/engine'
import type { IEngineQueryable } from '@akemi-mio/engine'
import type { HandlerContext } from './context'

export function registerHealthHandlers({ agentService, stateManager, metricsCollector }: HandlerContext): void {
  ipcMain.handle('health:check', async () => {
    const mem = process.memoryUsage()
    const state = stateManager.get()
    const mcpServers = agentService
      .getMcpManager()
      .listServers()
      .map((s) => ({ name: s.name, initialized: s.initialized }))
    let eventLoopLag = -1
    try {
      const t0 = Date.now()
      await new Promise((resolve) => setImmediate(resolve))
      eventLoopLag = Date.now() - t0
    } catch {}

    // ── 统一引擎状态报告（通过 IEngineQueryable 接口，不感知具体实现） ──
    const engines = engineProvider.getAll().map((e: IEngineQueryable) => {
      const status = e.getStatus()
      const metrics = e.getMetrics()
      return {
        name: e.name,
        status: {
          state: status.state,
          busy: status.busy,
          queueSize: status.queueSize,
          processing: status.processing,
          activeModel: status.activeModel || undefined,
          error: status.error || undefined,
        },
        metrics: {
          totalRequests: metrics.totalRequests,
          successCount: metrics.successCount,
          failureCount: metrics.failureCount,
          avgLatencyMs: metrics.avgLatencyMs,
          reliability: metrics.reliability,
        },
        info: e.getInfo(),
      }
    })

    return {
      status: 'ok',
      uptime: process.uptime(),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      asr: state.asr || 'unknown',
      llm: {
        keyConfigured: !!(process.env.LLM_KEY || credentialsManager.get('llm_key')),
        chatUrl: LLM_API_URL,
        chatModel: process.env.LLM_CHAT_MODEL,
        codeUrl: LLM_CODE_API_URL,
        codeModel: process.env.LLM_CODE_MODEL,
        textUrl: LLM_TEXT_API_URL,
        textModel: process.env.LLM_TEXT_MODEL,
        visionUrl: LLM_VISION_API_URL,
        visionModel: process.env.LLM_VISION_MODEL,
      },
      mcp: { serverCount: mcpServers.length, servers: mcpServers },
      engines, // 统一引擎状态数组（Agent + PiperTTS 等，通过 IEngineQueryable 接口获取）
      eventLoopLagMs: eventLoopLag,
      metrics: metricsCollector?.getSnapshot() ?? null,
      timestamp: Date.now(),
    }
  })

  ipcMain.handle('health:metrics', async () => {
    const mem = process.memoryUsage()
    return {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      uptime: Math.round(process.uptime()),
      timestamp: Date.now(),
    }
  })
}
