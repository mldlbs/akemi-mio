import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

import type { CapabilityDecisionCandidate, CapabilityMigrationComparisonReport, CapabilityProblemCandidate, Problem } from './types'

export class CapabilityMigrationArtifactStore {
  private readonly resolvedRootDir: string

  constructor(private readonly rootDir: string) {
    this.resolvedRootDir = resolve(rootDir)
  }

  saveRunArtifacts(input: {
    runId: string
    generatedAt: number
    legacyProblemCandidates: Problem[]
    capabilityProblemCandidates: CapabilityProblemCandidate[]
    comparisonReport: CapabilityMigrationComparisonReport
    legacyDecisions: CapabilityDecisionCandidate[]
    capabilityDecisions: CapabilityDecisionCandidate[]
    decisionDiffReport: Record<string, unknown>
    migrationGateReport: Record<string, unknown>
    rollbackReadinessReport: Record<string, unknown>
  }): void {
    const runDir = this.resolveWithinRoot(input.runId)
    const latestDir = this.resolveWithinRoot('latest')
    const targets = [runDir, latestDir]
    const artifacts = {
      'legacy_problem_candidates.json': input.legacyProblemCandidates,
      'capability_problem_candidates.json': input.capabilityProblemCandidates,
      'comparison_report.json': input.comparisonReport,
      'legacy_decisions.json': input.legacyDecisions,
      'capability_decisions.json': input.capabilityDecisions,
      'decision_diff_report.json': input.decisionDiffReport,
      'migration_gate_report.json': input.migrationGateReport,
      'rollback_readiness_report.json': input.rollbackReadinessReport,
    }

    for (const targetDir of targets) {
      for (const [fileName, value] of Object.entries(artifacts)) {
        this.writeJson(resolve(targetDir, fileName), value)
      }
    }
  }

  readJson(relativePath: string): unknown {
    const filePath = this.resolveWithinRoot(relativePath)
    if (!existsSync(filePath)) {
      return null
    }

    return JSON.parse(readFileSync(filePath, 'utf-8'))
  }

  private writeJson(filePath: string, value: unknown): void {
    const directory = dirname(filePath)
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }

    writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
  }

  private resolveWithinRoot(...segments: string[]): string {
    const candidatePath = resolve(this.resolvedRootDir, ...segments)
    const relativePath = relative(this.resolvedRootDir, candidatePath)

    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Artifact path resolves outside rootDir: ${candidatePath}`)
    }

    return candidatePath
  }
}
