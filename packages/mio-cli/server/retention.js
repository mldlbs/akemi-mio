'use strict'

// Retention for MIO_HOME append-only stores. traces.jsonl, queries.jsonl and
// experience_reuse.jsonl grow without bound; observe.log accumulates one line
// per observer cycle. prune() rewrites each file in place keeping only records
// newer than the cutoff, after copying the original to a .bak-prune-<ts> file.
// memory.jsonl is precious, so it is only touched when explicitly included.

const fs = require('fs')
const path = require('path')

// Age-based JSONL stores (records carry an ISO `timestamp` field).
const AGE_BASED_FILES = ['traces.jsonl', 'experience_reuse.jsonl']
// Expiry-based stores (records carry an epoch-ms `expiresAt` field).
const EXPIRY_BASED_FILES = ['queries.jsonl']
// Log lines look like "[<ISO>]<message>".
const LOG_FILES = ['logs/observe.log']

function createRetention(options = {}) {
  const home = options.home
  const now = options.now || (() => Date.now())

  function readJsonl(file) {
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch (_) {
          return null
        }
      })
  }

  function backupFile(file) {
    const backup = `${file}.bak-prune-${now()}`
    fs.copyFileSync(file, backup)
    return backup
  }

  function writeJsonl(file, values) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      values.length > 0 ? values.map((value) => JSON.stringify(value)).join('\n') + '\n' : '',
      'utf8'
    )
  }

  function planAgeBased(name, cutoff) {
    const file = path.join(home, name)
    const records = readJsonl(file)
    let removed = 0
    const kept = []
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        removed += 1
        continue
      }
      const ts = Date.parse(record.timestamp || '')
      if (Number.isFinite(ts) && ts < cutoff) removed += 1
      else kept.push(record)
    }
    return { file: name, total: records.length, kept: kept.length, removed, records: kept }
  }

  function planExpiryBased(name, atTime) {
    const file = path.join(home, name)
    const records = readJsonl(file)
    let removed = 0
    const kept = []
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        removed += 1
        continue
      }
      const expiresAt = Number(record.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt <= atTime) removed += 1
      else kept.push(record)
    }
    return { file: name, total: records.length, kept: kept.length, removed, records: kept }
  }

  function planLog(name, cutoff) {
    const file = path.join(home, name)
    if (!fs.existsSync(file)) {
      return { file: name, total: 0, kept: 0, removed: 0, lines: [] }
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    let removed = 0
    const kept = []
    for (const line of lines) {
      const match = line.match(/^\[([^\]]+)\]/)
      const ts = match ? Date.parse(match[1]) : NaN
      if (Number.isFinite(ts) && ts < cutoff) removed += 1
      else kept.push(line)
    }
    return { file: name, total: lines.length, kept: kept.length, removed, lines: kept }
  }

  function planPrune({ days, includeMemory }) {
    const cutoff = now() - Math.max(1, Number(days) || 30) * 86400000
    const plans = []
    for (const name of AGE_BASED_FILES) plans.push(planAgeBased(name, cutoff))
    for (const name of EXPIRY_BASED_FILES) plans.push(planExpiryBased(name, now()))
    plans.push(planLog(LOG_FILES[0], cutoff))
    if (includeMemory) plans.push(planAgeBased('memory.jsonl', cutoff))
    return { cutoff: new Date(cutoff).toISOString(), plans }
  }

  function prune({ days, includeMemory, dryRun }) {
    const { cutoff, plans } = planPrune({ days, includeMemory })
    const results = []
    if (!dryRun) {
      for (const plan of plans) {
        if (plan.removed === 0) continue
        const target = path.join(home, plan.file)
        if (!fs.existsSync(target)) continue
        backupFile(target)
        if (plan.lines) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, plan.lines.length > 0 ? plan.lines.join('\n') + '\n' : '', 'utf8')
        } else {
          writeJsonl(target, plan.records)
        }
      }
    }
    for (const plan of plans) {
      results.push({
        file: plan.file,
        total: plan.total,
        kept: plan.kept,
        removed: plan.removed,
      })
    }
    return {
      cutoff,
      dryRun: Boolean(dryRun),
      files: results,
      totalRemoved: results.reduce((sum, item) => sum + item.removed, 0),
    }
  }

  return { planPrune, prune }
}

module.exports = { createRetention, AGE_BASED_FILES, EXPIRY_BASED_FILES }
