import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { PipelineOrchestrator } from '@akemi-mio/evolution/automation/PipelineOrchestrator'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { CapabilityEvolutionShadowRun, ShadowCollectorExecutionEvent, ShadowObservationCollector } from '@akemi-mio/evolution/automation/types'

class FakeShadowCollector implements ShadowObservationCollector {
  readonly name = 'fake-shadow'
  shouldRun(): boolean {
    return true
  }
  async collect(): Promise<CapabilityEvolutionShadowRun> {
    return {
      runId: 'shadow_run_1',
      collectorName: this.name,
      generatedAt: Date.now(),
      observations: [
        {
          legacyIdentity: { tools: ['write_file'] },
          capabilityIdentity: { capability: 'file.management', operation: 'write', provider: '@builtin/core' },
          metrics: { count: 1, successRate: 1, errorRate: 0, avgLatencyMs: 10 },
          legacyMetrics: { count: 1, successRate: 1, errorRate: 0, avgLatencyMs: 10 },
        },
      ],
      summary: {
        totalToolEvents: 1,
        capabilityEvents: 1,
        coverageRate: 1,
        legacyBucketCount: 1,
        capabilityBucketCount: 1,
        aggregationGain: 0,
        aggregationGainRate: 0,
        trendSampleCount: 1,
        trendCorrelation: null,
      },
    }
  }
}

describe('PipelineOrchestrator shadow collectors', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm56-shadow-pipeline-'))
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs shadow collectors without pushing observations into ProblemQueue', async () => {
    const pipeline = new PipelineOrchestrator({
      projectRoot: tmpDir,
      persistDir: join(tmpDir, 'pipeline_data'),
      maxFixesPerCycle: 1,
    })
    const shadowEvents: ShadowCollectorExecutionEvent[] = []
    const unsub = eventBus.on('pipeline.shadow_collector.executed', (event: any) => {
      shadowEvents.push(event)
    })

    pipeline.addShadowCollector(new FakeShadowCollector())
    const metrics = await pipeline.runOnce()

    expect(metrics.totalCollected).toBe(0)
    expect(pipeline['queue'].size).toBe(0)
    expect(shadowEvents).toHaveLength(1)
    expect(shadowEvents[0].collectorName).toBe('fake-shadow')
    expect(shadowEvents[0].observationCount).toBe(1)

    unsub()
  })
})
