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

const { EVIDENCE_KINDS } = requireWorkspacePackage(
  '@akemi-mio/runtime-contracts',
  path.resolve(__dirname, '..', 'runtime-contracts'),
)
const { EventBus, createLogger } = requireWorkspacePackage(
  '@akemi-mio/runtime-foundation',
  path.resolve(__dirname, '..', 'runtime-foundation'),
)

const SCHEMA_VERSION = 1
const MODULE_NAME = '@akemi-mio/evolution-learning'
const MODULE_VERSION = '0.1.0'

function clampScore(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
}

function evaluatePlanQuality(planSteps, planCreated) {
  if (!planCreated) return 50
  if (!Array.isArray(planSteps) || planSteps.length === 0) return 30
  const fileRefPattern = /[\w-]+\.(ts|tsx|js|jsx|json|yaml|css|html|md)\b|[\w-]+\/[\w\-.\\/]+\.\w+/g
  let refs = 0
  for (const step of planSteps) {
    const matches = String(step || '').match(fileRefPattern)
    refs += matches ? matches.length : 0
  }
  if (refs === 0) return 30
  if (refs >= planSteps.length) return 95
  return clampScore(60 + (refs / planSteps.length) * 35)
}

function evaluateDiversity(summary, recentHistory) {
  const current = tokenize(summary)
  if (current.size === 0 || !Array.isArray(recentHistory) || recentHistory.length === 0) return 70
  let maxOverlap = 0
  for (const entry of recentHistory) {
    const historical = tokenize(entry)
    const intersection = new Set([...current].filter((token) => historical.has(token)))
    const union = new Set([...current, ...historical])
    const overlap = union.size > 0 ? intersection.size / union.size : 0
    maxOverlap = Math.max(maxOverlap, overlap)
  }
  if (maxOverlap < 0.3) return 100
  if (maxOverlap < 0.5) return 60
  if (maxOverlap < 0.7) return 30
  return 10
}

function evaluateStrategyCompliance(strategyName, promptMode, analysisSummary) {
  const expectedPromptMode = {
    full: 'full',
    balanced: 'full',
    quick: 'minimal',
    review: 'minimal',
  }
  if (expectedPromptMode[strategyName] && promptMode !== expectedPromptMode[strategyName]) return 60
  if (strategyName === 'review' && /write_file|edit_file|execute/.test(String(analysisSummary || ''))) return 30
  return 95
}

function evaluateSubstantiveLength(summary) {
  const length = String(summary || '').length
  if (length < 50) return 10
  if (length < 200) return 40
  if (length < 500) return 70
  if (length < 1000) return 85
  return 95
}

function evaluateAnalysis(input) {
  if (!input || typeof input !== 'object') throw new TypeError('analysis input must be an object')
  const strategyName = String(input.strategyName || 'balanced')
  const promptMode = String(input.promptMode || 'full')
  const analysisMode = String(input.analysisMode || 'analysis')
  const analysisSummary = String(input.analysisSummary || '')

  const dimensions = {
    planQuality: evaluatePlanQuality(input.planSteps, Boolean(input.planCreated)),
    analysisDiversity: evaluateDiversity(analysisSummary, input.recentHistory),
    strategyCompliance: evaluateStrategyCompliance(strategyName, promptMode, analysisSummary),
    substantiveLength: evaluateSubstantiveLength(analysisSummary),
  }
  const score = clampScore(
    dimensions.planQuality * 0.3 +
      dimensions.analysisDiversity * 0.25 +
      dimensions.strategyCompliance * 0.25 +
      dimensions.substantiveLength * 0.2,
  )
  const feedback = []
  if (dimensions.planQuality < 50 && input.planCreated) feedback.push('plan steps need concrete file references')
  if (dimensions.analysisDiversity < 70) feedback.push('analysis overlaps recent history; explore a new angle')
  if (dimensions.strategyCompliance < 70) feedback.push('strategy and prompt mode are mismatched')
  if (dimensions.substantiveLength < 30) feedback.push('analysis summary is too short')

  return {
    schemaVersion: SCHEMA_VERSION,
    score,
    createdAt: new Date().toISOString(),
    strategyName,
    analysisMode,
    dimensions,
    feedback,
  }
}

function buildReflectionSummary(input) {
  if (!input || typeof input !== 'object') throw new TypeError('reflection input must be an object')
  const toolResults = Array.isArray(input.toolResults) ? input.toolResults : []
  if (toolResults.length === 0) return 'No tool calls to reflect on.'
  const successCount = toolResults.filter((result) => result && result.success === true).length
  const failCount = toolResults.length - successCount
  const parts = [`${toolResults.length} tool calls: ${successCount} succeeded, ${failCount} failed.`]
  for (const result of toolResults) {
    if (!result || result.success === true) continue
    const name = result.name || 'tool'
    const error = String(result.error || 'unknown error').slice(0, 160)
    parts.push(`${name}: ${error}`)
  }
  for (const result of toolResults) {
    if (result && result.latencyMs > 5000) parts.push(`${result.name || 'tool'} was slow (${result.latencyMs}ms).`)
  }
  return parts.join('\n')
}

function createLearningModule(dependencies = {}) {
  const memory = dependencies.memory || null
  const llm = dependencies.llm || null
  const eventBus = dependencies.eventBus || new EventBus()
  const logger = dependencies.logger || createLogger('mio-learning')
  const clock = typeof dependencies.clock === 'function' ? dependencies.clock : Date.now

  return {
    name: MODULE_NAME,
    version: MODULE_VERSION,
    evaluateAnalysis,
    buildReflectionSummary,

    async reflect(input) {
      if (input && input.useLlm && llm && typeof llm.complete === 'function') {
        const prompt = [
          'Reflect on this runtime learning task.',
          `Task: ${input.task || ''}`,
          buildReflectionSummary(input),
        ].join('\n')
        const summary = await llm.complete(prompt)
        return { source: 'llm', summary: String(summary || '') }
      }
      return { source: 'deterministic', summary: buildReflectionSummary(input || {}) }
    },

    learnFromEvaluation(input) {
      if (!memory || typeof memory.recordEvidence !== 'function' || typeof memory.recordExperience !== 'function') {
        throw new TypeError('memory with recordEvidence and recordExperience is required')
      }
      if (!input || typeof input !== 'object') throw new TypeError('learning input must be an object')
      const evaluation = input.evaluation || evaluateAnalysis(input)
      const project = typeof input.project === 'string' ? input.project : null
      const agent = typeof input.agent === 'string' ? input.agent : null
      const task = String(input.task || 'runtime learning')
      const evidence = memory.recordEvidence({
        kind: EVIDENCE_KINDS.EVALUATION,
        source: MODULE_NAME,
        content: `score=${evaluation.score}; task=${task}; feedback=${(evaluation.feedback || []).join('; ')}`,
        project,
        agent,
        tags: ['evolution-learning', 'evaluation'],
        metadata: { evaluation, recordedAt: clock() },
      })
      const experience = memory.recordExperience({
        title: `Learning evaluation: ${task}`,
        summary: `Score ${evaluation.score}/100 for ${evaluation.strategyName || 'unknown'} in ${evaluation.analysisMode || 'analysis'} mode.`,
        project,
        agent,
        evidenceIds: [evidence.id],
        tags: ['evolution-learning', 'runtime'],
        metadata: { score: evaluation.score, dimensions: evaluation.dimensions },
      })
      try {
        eventBus.emit('learning.evaluation_recorded', { project, agent, task, score: evaluation.score, evidenceId: evidence.id, experienceId: experience.id })
      } catch (error) {
        logger.warn('failed to emit learning event', { error: error && error.message ? error.message : String(error) })
      }
      return { evaluation, evidence, experience }
    },
  }
}

module.exports = {
  SCHEMA_VERSION,
  MODULE_NAME,
  MODULE_VERSION,
  evaluateAnalysis,
  buildReflectionSummary,
  createLearningModule,
}
