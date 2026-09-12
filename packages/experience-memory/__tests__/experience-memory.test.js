const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ExperienceMemory } = require('../index.js')

test('records and filters evidence and experiences without external services', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memory-'))
  const memory = new ExperienceMemory({ dataDir })
  const evidence = memory.recordEvidence({
    source: 'test', content: 'Use deterministic tests for runtime changes',
    project: 'akemi-mio', agent: 'codex', tags: ['testing'],
  })
  memory.recordExperience({
    title: 'Runtime modularization', summary: 'Keep runtime as an aggregation package',
    project: 'akemi-mio', agent: 'codex', evidenceIds: [evidence.id],
  })
  memory.recordExperience({
    title: 'Other project', summary: 'Unrelated note', project: 'other', agent: 'codex',
  })

  assert.equal(memory.listEvidence({ project: 'akemi-mio' }).length, 1)
  assert.equal(memory.listExperiences({ project: 'akemi-mio' }).length, 1)
  const results = memory.query('runtime aggregation', { project: 'akemi-mio', limit: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].title, 'Runtime modularization')
  assert.deepEqual(results[0].evidenceIds, [evidence.id])
})

test('reloads persisted memory and applies limit deterministically', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memory-reload-'))
  const first = new ExperienceMemory({ dataDir })
  first.recordExperience({ title: 'Alpha', summary: 'runtime event', project: 'p', agent: 'a' })
  first.recordExperience({ title: 'Beta', summary: 'runtime event', project: 'p', agent: 'a' })
  const second = new ExperienceMemory({ dataDir })
  const results = second.query('runtime event', { project: 'p', agent: 'a', limit: 1 })
  assert.equal(results.length, 1)
  assert.equal(results[0].title, 'Alpha')
})
