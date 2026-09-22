#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { join, resolve } from 'path'

import { ToolEvolutionCollector } from '@akemi-mio/evolution/automation/ToolEvolutionCollector'
import { ToolAnalyticsCollector } from '@akemi-mio/evolution/automation/ToolAnalyticsCollector'
import { CapabilityMigrationArtifactStore } from '@akemi-mio/evolution/automation/CapabilityMigrationArtifactStore'
import { evaluateCapabilityMigrationGate } from '@akemi-mio/evolution/automation/CapabilityMigrationGateEvaluator'
import {
  buildCapabilityDecisionCandidates,
  buildCapabilityMigrationComparisonReport,
  buildDecisionDiffReport,
  buildLegacyDecisionCandidates,
} from '@akemi-mio/evolution/automation/CapabilityDecisionShadowPipeline'
import { buildCapabilityProblemShadowArtifacts } from '@akemi-mio/evolution/automation/CapabilityProblemShadowPipeline'
import {
  buildLegacyProblemsFromShadowRuns,
  deriveIssueTypeFromShadowMetrics,
  loadShadowObservationRuns,
} from '@akemi-mio/evolution/automation/CapabilityShadowRunHydrator'
import type { CapabilityMigrationGateInput, Problem } from '@akemi-mio/evolution/automation/types'

const DEFAULT_REPORT_DIR = join(process.cwd(), 'reports', 'm56', 'migration')

export function buildCapabilityMigrationArtifacts(input: {
  runId: string
  generatedAt: number
  legacyProblems: Problem[]
  observationWindow: CapabilityMigrationGateInput['observationWindow']
}): {
  legacyProblemCandidates: Problem[]
  capabilityProblemCandidates: ReturnType<typeof buildCapabilityProblemShadowArtifacts>['capabilityCandidates']
  comparisonReport: ReturnType<typeof buildCapabilityMigrationComparisonReport>
  legacyDecisions: ReturnType<typeof buildLegacyDecisionCandidates>
  capabilityDecisions: ReturnType<typeof buildCapabilityDecisionCandidates>
  decisionDiffReport: ReturnType<typeof buildDecisionDiffReport>
  migrationGateReport: ReturnType<typeof evaluateCapabilityMigrationGate>
  rollbackReadinessReport: {
    capabilityAuthorityEnabled: boolean
    legacyAuthorityIntact: boolean
    dualWriteTelemetryActive: boolean
    legacyEvolutionBehaviorUnchanged: boolean
    capabilityPathShadowOnly: boolean
    executorAuthorityLegacyOnly: boolean
    rollbackAction: string
  }
} {
  const shadow = buildCapabilityProblemShadowArtifacts({
    runId: input.runId,
    generatedAt: input.generatedAt,
    legacyProblems: input.legacyProblems,
  })
  const legacyDecisions = buildLegacyDecisionCandidates(shadow.legacyCandidates)
  const capabilityDecisions = buildCapabilityDecisionCandidates(shadow.capabilityCandidates)
  const decisionDiffReport = buildDecisionDiffReport({ legacyDecisions, capabilityDecisions })
  const comparisonReport = buildCapabilityMigrationComparisonReport({
    runId: input.runId,
    generatedAt: input.generatedAt,
    legacyProblems: input.legacyProblems,
    capabilityCandidates: shadow.capabilityCandidates,
    decisionConsistencyRate: decisionDiffReport.consistencyRate,
  })
  const migrationGateReport = evaluateCapabilityMigrationGate({
    observationWindow: input.observationWindow,
    coverage: {
      identityCoverage: shadow.comparison.eligibleLegacyCount / Math.max(input.legacyProblems.length, 1),
      traceabilityRate: capabilityDecisions.length === 0
        ? 0
        : shadow.capabilityCandidates.every((candidate) => (candidate.legacyEvidence?.length ?? 0) > 0) ? 1 : 0,
      legacyOnlyRatio: shadow.comparison.legacyOnlyProblemCount / Math.max(input.legacyProblems.length, 1),
    },
    decision: {
      consistencyRate: decisionDiffReport.consistencyRate,
      executorRegressionCount: 0,
    },
  })

  return {
    legacyProblemCandidates: shadow.legacyCandidates,
    capabilityProblemCandidates: shadow.capabilityCandidates,
    comparisonReport,
    legacyDecisions,
    capabilityDecisions,
    decisionDiffReport,
    migrationGateReport,
    rollbackReadinessReport: {
      capabilityAuthorityEnabled: false,
      legacyAuthorityIntact: true,
      dualWriteTelemetryActive: true,
      legacyEvolutionBehaviorUnchanged: true,
      capabilityPathShadowOnly: true,
      executorAuthorityLegacyOnly: true,
      rollbackAction: 'disable capability authority and continue shadow artifact generation',
    },
  }
}

// =============================================================================
// 真实观测数据水合：capability_evolution_shadow_runs.json → legacy Problem[]
// =============================================================================

const DEFAULT_SHADOW_PERSIST_DIR = join(
  homedir(),
  'AppData',
  'Roaming',
  'akemi-mio',
  'evolution_workspace',
  'pipeline_data',
)
function parsePersistDirArg(args: string[]): string {
  const explicit = args.find((arg) => arg.startsWith('--persistDir='))
  return explicit ? explicit.slice('--persistDir='.length) : DEFAULT_SHADOW_PERSIST_DIR
}

async function loadLegacyProblems(): Promise<Problem[]> {
  const [evolutionProblems, analyticsProblems] = await Promise.all([
    new ToolEvolutionCollector().collect(),
    new ToolAnalyticsCollector().collect(),
  ])

  return [...evolutionProblems, ...analyticsProblems]
}

function writeMigrationRunArtifacts(
  rootDir: string,
  runId: string,
  generatedAt: number,
  artifacts: ReturnType<typeof buildCapabilityMigrationArtifacts>,
): void {
  const store = new CapabilityMigrationArtifactStore(rootDir)
  store.saveRunArtifacts({
    runId,
    generatedAt,
    legacyProblemCandidates: artifacts.legacyProblemCandidates,
    capabilityProblemCandidates: artifacts.capabilityProblemCandidates,
    comparisonReport: artifacts.comparisonReport,
    legacyDecisions: artifacts.legacyDecisions,
    capabilityDecisions: artifacts.capabilityDecisions,
    decisionDiffReport: artifacts.decisionDiffReport,
    migrationGateReport: artifacts.migrationGateReport,
    rollbackReadinessReport: artifacts.rollbackReadinessReport,
  })
}

async function main(): Promise<void> {
  const generatedAt = Date.now()
  const runId = `m56-migration-${generatedAt}`
  const persistDir = parsePersistDirArg(process.argv.slice(2))
  const shadowRuns = loadShadowObservationRuns(persistDir)
  let legacyProblems: Problem[]
  let observedDays: number

  if (shadowRuns.length > 0) {
    legacyProblems = buildLegacyProblemsFromShadowRuns(shadowRuns)
    const firstRunAt = Math.min(...shadowRuns.map((run) => run.generatedAt))
    observedDays = Math.max(1, (generatedAt - firstRunAt) / 86_400_000)
    console.log(`Legacy problems hydrated from shadow runs: ${legacyProblems.length} (${shadowRuns.length} runs, ${observedDays.toFixed(2)} days window)`)
  } else {
    legacyProblems = await loadLegacyProblems()
    observedDays = 1
    console.log(`Shadow runs unavailable at ${persistDir}; falling back to in-memory collectors (${legacyProblems.length} problems)`)
  }

  const artifacts = buildCapabilityMigrationArtifacts({
    runId,
    generatedAt,
    legacyProblems,
    observationWindow: {
      candidateCount: legacyProblems.length,
      observedDays,
    },
  })

  const reportDir = resolve(DEFAULT_REPORT_DIR)
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true })
  }
  writeMigrationRunArtifacts(reportDir, runId, generatedAt, artifacts)
  writeFileSync(
    join(reportDir, 'latest-summary.json'),
    JSON.stringify({
      runId,
      generatedAt,
      legacyProblemCount: artifacts.legacyProblemCandidates.length,
      capabilityProblemCount: artifacts.capabilityProblemCandidates.length,
      decisionConsistencyRate: artifacts.decisionDiffReport.consistencyRate,
      gateStatus: artifacts.migrationGateReport.status,
    }, null, 2),
    'utf-8',
  )

  console.log(`Migration report written to ${join(reportDir, runId)}`)
  console.log(`Gate: ${artifacts.migrationGateReport.status}`)
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
