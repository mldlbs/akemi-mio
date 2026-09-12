'use strict'

const path = require('node:path')

function requireWorkspacePackage(name, fallbackPath) {
  try {
    return require(name)
  } catch (error) {
    if (!error || error.code !== 'MODULE_NOT_FOUND') throw error
    return require(fallbackPath)
  }
}

const { EventBus, createId, createLogger } = requireWorkspacePackage(
  '@akemi-mio/runtime-foundation',
  path.resolve(__dirname, '..', 'runtime-foundation'),
)

const SCHEMA_VERSION = 1
const MODULE_NAME = '@akemi-mio/evolution-strategy'
const MODULE_VERSION = '0.1.0'
const RISK_WEIGHT = { low: 0, medium: 10, high: 25 }

function asStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
}

function inferRiskLevel(input) {
  const text = [
    input.task,
    input.context,
    ...asStringList(input.constraints),
    ...asStringList(input.steps),
  ].join(' ').toLowerCase()
  if (/\b(delete|credential|production|publish|rollback|migration)\b/.test(text)) return 'high'
  if (/\b(host|mutation|mutate|checkpoint|dependency|runtime)\b/.test(text)) return 'medium'
  return 'low'
}

function buildProposal(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('proposal input must be an object')
  const task = String(input.task || 'runtime evolution')
  const constraints = asStringList(input.constraints)
  const steps = asStringList(input.steps)
  const summary = String(input.summary || `Propose a focused runtime evolution for ${task}.`)
  const proposalSteps = steps.length > 0 ? steps : [
    `Inspect current behavior for ${task}`,
    'Apply the smallest module-level change',
    'Run focused verification before handoff',
  ]
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id || createId('prop'),
    createdAt: input.createdAt || new Date().toISOString(),
    project: typeof input.project === 'string' ? input.project : null,
    agent: typeof input.agent === 'string' ? input.agent : null,
    title: String(input.title || task),
    summary,
    steps: proposalSteps,
    constraints,
    riskLevel: input.riskLevel || inferRiskLevel({ ...input, steps: proposalSteps }),
    expectedImpact: Number.isFinite(input.expectedImpact) ? input.expectedImpact : Math.min(100, 50 + constraints.length * 5 + proposalSteps.length * 5),
    evidenceIds: asStringList(input.evidenceIds),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  }
}

function rankProposals(proposals) {
  return [...(Array.isArray(proposals) ? proposals : [])].sort((left, right) => {
    const leftImpact = Number.isFinite(left.expectedImpact) ? left.expectedImpact : 0
    const rightImpact = Number.isFinite(right.expectedImpact) ? right.expectedImpact : 0
    const impactDelta = rightImpact - leftImpact
    if (impactDelta !== 0) return impactDelta
    return (RISK_WEIGHT[left.riskLevel] ?? 50) - (RISK_WEIGHT[right.riskLevel] ?? 50)
  })
}

function createStrategyModule(dependencies = {}) {
  const llm = dependencies.llm || null
  const eventBus = dependencies.eventBus || new EventBus()
  const logger = dependencies.logger || createLogger('mio-strategy')
  const idFactory = typeof dependencies.idFactory === 'function' ? dependencies.idFactory : () => createId('prop')

  return {
    name: MODULE_NAME,
    version: MODULE_VERSION,
    buildProposal,
    rankProposals,

    async generateProposal(input = {}) {
      let summary = input.summary
      if (input.useLlm && llm && typeof llm.complete === 'function') {
        const prompt = [
          'Generate a concise Mio runtime evolution proposal.',
          `Task: ${input.task || ''}`,
          `Context: ${input.context || ''}`,
        ].join('\n')
        summary = await llm.complete(prompt)
      }
      const proposal = buildProposal({ ...input, id: input.id || idFactory(), summary })
      try {
        eventBus.emit('strategy.proposal_created', { proposalId: proposal.id, project: proposal.project, riskLevel: proposal.riskLevel })
      } catch (error) {
        logger.warn('failed to emit strategy event', { error: error && error.message ? error.message : String(error) })
      }
      return proposal
    },
  }
}

module.exports = {
  SCHEMA_VERSION,
  MODULE_NAME,
  MODULE_VERSION,
  buildProposal,
  rankProposals,
  createStrategyModule,
}
