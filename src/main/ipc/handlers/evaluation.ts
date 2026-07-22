import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import type { HandlerContext } from './context'

function emptyMetricsSummary() {
  return { totalChecked: 0, totalWarning: 0, totalTerminated: 0, totalContinue: 0, totalSignalsHealthy: 0, totalSignalsDegrading: 0, totalSignalsStalled: 0, windowCount: 0 }
}

export function registerEvaluationHandlers({ decisionQueryRef, metricsQueryRef, organizerRef }: HandlerContext): void {
  if (decisionQueryRef) {
    ipcMain.handle('evaluation:getDecision', async (_event, decisionId: string) => {
      const svc = decisionQueryRef.current
      if (!svc) return { state: 'UNAVAILABLE' }
      return svc.getDecision(decisionId)
    })
    ipcMain.handle('evaluation:listByTrace', async (_event, traceId: string) => {
      const svc = decisionQueryRef.current
      if (!svc) return []
      return svc.listByTrace(traceId)
    })
  }

  if (metricsQueryRef) {
    ipcMain.handle('guardrail:metrics:summary', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return emptyMetricsSummary()
      return svc.getSummary()
    })
    ipcMain.handle('guardrail:metrics:query', async (_event, since: number, until: number) => {
      const svc = metricsQueryRef.current
      if (!svc) return { windows: [], totalWindows: 0, queryRangeMs: until - since }
      const windows = await svc.queryTimeRange(since, until)
      return { windows, totalWindows: windows.length, queryRangeMs: until - since }
    })
    ipcMain.handle('guardrail:metrics:latest', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return null
      return svc.getLatest()
    })
    ipcMain.handle('guardrail:metrics:state', async () => {
      const svc = metricsQueryRef.current
      if (!svc) return { status: 'UNAVAILABLE', reason: 'GuardrailMetricsQueryService not initialized' }
      return svc.getProjectionState()
    })
  }

  if (organizerRef) {
    ipcMain.handle('organizer:pause', async () => { const s = organizerRef.current; if (!s) return { success: false }; s.pause(); return { success: true } })
    ipcMain.handle('organizer:resume', async () => { const s = organizerRef.current; if (!s) return { success: false }; s.resume(); return { success: true } })
    ipcMain.handle('organizer:skip', async () => { const s = organizerRef.current; if (!s) return { success: false }; s.skipCurrent(); return { success: true } })
  }
}
