import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import { buildCapabilityEvolutionShadowRun } from './CapabilityEvolutionShadowCollector'
import type { CapabilityEvolutionShadowRun } from './types'

export type CapabilityEvolutionShadowRunSource = 'stored-run' | 'live-tool-log'

export function resolveCapabilityEvolutionShadowRun(options: {
  latestStoredRun: CapabilityEvolutionShadowRun | null
  records: ToolCallRecord[]
  collectorName: string
  now?: number
}): {
  source: CapabilityEvolutionShadowRunSource
  run: CapabilityEvolutionShadowRun
} {
  const { latestStoredRun, records, collectorName } = options
  const now = options.now ?? Date.now()
  const latestRecordTimestamp = records.reduce((max, record) => Math.max(max, record.timestamp || 0), 0)

  if (latestStoredRun && latestStoredRun.generatedAt >= latestRecordTimestamp) {
    return {
      source: 'stored-run',
      run: latestStoredRun,
    }
  }

  return {
    source: 'live-tool-log',
    run: buildCapabilityEvolutionShadowRun(collectorName, records, now),
  }
}
