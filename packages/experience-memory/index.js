'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function matches(record, filters) {
  return Object.entries(filters || {}).every(([key, value]) => value === undefined || value === null || record[key] === value)
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
}

function score(record, queryTokens) {
  const searchable = [record.title, record.summary, record.content, ...(record.tags || [])].join(' ')
  const recordTokens = tokens(searchable)
  let total = 0
  for (const token of queryTokens) if (recordTokens.has(token)) total += 1
  return total
}

class ExperienceMemory {
  constructor({ dataDir }) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a non-empty string')
    this.evidencePath = path.join(dataDir, 'evidence.jsonl')
    this.experiencesPath = path.join(dataDir, 'experiences.jsonl')
  }

  recordEvidence(input) {
    if (!input || typeof input !== 'object') throw new TypeError('evidence must be an object')
    if (typeof input.source !== 'string' || !input.source.trim()) throw new TypeError('source must be a non-empty string')
    if (typeof input.content !== 'string' || !input.content.trim()) throw new TypeError('content must be a non-empty string')
    const evidence = {
      id: input.id || createId('evd'), kind: input.kind || 'observation', createdAt: input.createdAt || new Date().toISOString(),
      source: input.source.trim(), content: input.content.trim(), project: input.project || null, agent: input.agent || null,
      tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : [], metadata: input.metadata || {},
    }
    appendJsonl(this.evidencePath, evidence)
    return evidence
  }

  recordExperience(input) {
    if (!input || typeof input !== 'object') throw new TypeError('experience must be an object')
    if (typeof input.title !== 'string' || !input.title.trim()) throw new TypeError('title must be a non-empty string')
    if (typeof input.summary !== 'string' || !input.summary.trim()) throw new TypeError('summary must be a non-empty string')
    const experience = {
      id: input.id || createId('exp'), createdAt: input.createdAt || new Date().toISOString(), title: input.title.trim(), summary: input.summary.trim(),
      project: input.project || null, agent: input.agent || null, evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds.filter((id) => typeof id === 'string') : [],
      tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : [], metadata: input.metadata || {},
    }
    appendJsonl(this.experiencesPath, experience)
    return experience
  }

  listEvidence(filters = {}) { return readJsonl(this.evidencePath).filter((record) => matches(record, filters)) }
  listExperiences(filters = {}) { return readJsonl(this.experiencesPath).filter((record) => matches(record, filters)) }

  query(query, options = {}) {
    const { limit = 10, ...filters } = options
    const queryTokens = tokens(query)
    return this.listExperiences(filters).map((record, index) => ({ record, index, score: score(record, queryTokens) }))
      .filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit).map((candidate) => candidate.record)
  }
}

module.exports = { ExperienceMemory }
