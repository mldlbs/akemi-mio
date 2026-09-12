'use strict'

const path = require('path')

function requireWorkspacePackage(name, fallbackPath) {
  try {
    return require(name)
  } catch (error) {
    if (!error || error.code !== 'MODULE_NOT_FOUND') throw error
    return require(fallbackPath)
  }
}

const {
  assessCutoverReadiness,
  createAuthoritySwitchDryRun,
  createAuthoritySwitchPlan,
  createDualWriteRunner,
  createStateMigrationPlan,
  runShadowComparison,
} = requireWorkspacePackage(
  '@akemi-mio/evolution-scheduler',
  path.resolve(__dirname, '..', '..', 'evolution-scheduler'),
)

function createEvolutionCutoverTools({ dataDir, appendJsonl, readJsonl, projectName }) {
  const shadowPath = path.join(dataDir, 'evolution_shadow.jsonl')
  const dualWritePath = path.join(dataDir, 'evolution_dual_write.jsonl')

  function projectFromArgs(args) {
    return args.project || projectName()
  }

  async function recordShadowComparison(args = {}) {
    const project = projectFromArgs(args)
    const comparison = await runShadowComparison({
      input: args.input || {},
      legacy: { run: () => args.legacy },
      modular: { run: () => args.modular },
    })
    const record = {
      id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      project,
      label: String(args.label || 'shadow comparison'),
      ...comparison,
    }
    appendJsonl(shadowPath, record)
    return record
  }

  async function recordDualWrite(args = {}) {
    const project = projectFromArgs(args)
    const runner = createDualWriteRunner({
      authoritative: args.authoritative,
      legacyWriter: { write: () => args.legacyResult },
      modularWriter: { write: () => args.modularResult },
    })
    const result = await runner.write(args.record || {})
    const stored = {
      id: `dual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      project,
      label: String(args.label || 'dual write'),
      ...result,
    }
    appendJsonl(dualWritePath, stored)
    return stored
  }

  function cutoverReadiness(args = {}) {
    const project = projectFromArgs(args)
    const shadowRuns = readJsonl(shadowPath).filter((record) => record.project === project)
    const dualWriteRuns = readJsonl(dualWritePath).filter((record) => record.project === project)
    return {
      project,
      ...assessCutoverReadiness({
        shadowRuns,
        dualWriteRuns,
        minShadowRuns: Number.isFinite(args.minShadowRuns) ? args.minShadowRuns : undefined,
        maxMismatchRate: Number.isFinite(args.maxMismatchRate) ? args.maxMismatchRate : undefined,
      }),
    }
  }

  function migrationPlan(args = {}) {
    return createStateMigrationPlan({
      legacyRecords: args.legacyRecords,
      modularRecords: args.modularRecords,
    })
  }

  function authorityPlan(args = {}) {
    return createAuthoritySwitchPlan({
      readiness: args.readiness,
      from: args.from,
      to: args.to,
    })
  }

  function applyCutover(args = {}) {
    return createAuthoritySwitchDryRun({
      dryRun: args.dryRun,
      project: projectFromArgs(args),
      plan: args.plan || args.authorityPlan,
    })
  }

  return {
    recordShadowComparison,
    recordDualWrite,
    cutoverReadiness,
    migrationPlan,
    authorityPlan,
    applyCutover,
  }
}

module.exports = { createEvolutionCutoverTools }
