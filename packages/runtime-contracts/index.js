'use strict'

const crypto = require('node:crypto')

const SCHEMA_VERSION = 1
const EVENT_TYPES = Object.freeze({
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  EXPERIENCE_RECORDED: 'experience.recorded',
  PROPOSAL_CREATED: 'proposal.created',
})
const EVIDENCE_KINDS = Object.freeze({
  OBSERVATION: 'observation',
  OUTCOME: 'outcome',
  EVALUATION: 'evaluation',
})

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeRuntimeEvent(value) {
  if (!value || typeof value !== 'object') throw new TypeError('event must be an object')
  const type = requireNonEmptyString(value.type, 'type')
  if (!Object.values(EVENT_TYPES).includes(type)) throw new TypeError(`unsupported event type: ${type}`)
  return {
    schemaVersion: SCHEMA_VERSION,
    id: value.id || createId('evt'),
    type,
    occurredAt: value.occurredAt || new Date().toISOString(),
    project: typeof value.project === 'string' ? value.project : null,
    agent: typeof value.agent === 'string' ? value.agent : null,
    payload: value.payload && typeof value.payload === 'object' ? value.payload : {},
  }
}

function createRuntimeEvent(value) {
  return normalizeRuntimeEvent(value)
}

function createEvidence(value) {
  if (!value || typeof value !== 'object') throw new TypeError('evidence must be an object')
  const kind = value.kind || EVIDENCE_KINDS.OBSERVATION
  if (!Object.values(EVIDENCE_KINDS).includes(kind)) throw new TypeError(`unsupported evidence kind: ${kind}`)
  return {
    schemaVersion: SCHEMA_VERSION,
    id: value.id || createId('evd'),
    kind,
    createdAt: value.createdAt || new Date().toISOString(),
    source: requireNonEmptyString(value.source, 'source'),
    content: requireNonEmptyString(value.content, 'content'),
    project: typeof value.project === 'string' ? value.project : null,
    agent: typeof value.agent === 'string' ? value.agent : null,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string') : [],
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
  }
}

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  EVIDENCE_KINDS,
  createRuntimeEvent,
  normalizeRuntimeEvent,
  createEvidence,
}
