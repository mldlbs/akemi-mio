const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('evolution status reports composed runtime modules', () => {
  const cliPath = path.resolve(__dirname, '..', 'bin', 'mio.js')
  const result = spawnSync(process.execPath, [cliPath, '--json', 'evolution', 'status'], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: path.resolve(__dirname, '.mio-test-home') },
  })

  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.runtime, 'mio-agent-runtime')
  assert.equal(payload.modules.length, 7)
  assert.deepEqual(payload.modules.map((module) => module.name), [
    '@akemi-mio/runtime-contracts',
    '@akemi-mio/runtime-foundation',
    '@akemi-mio/experience-memory',
    '@akemi-mio/evolution-learning',
    '@akemi-mio/evolution-strategy',
    '@akemi-mio/evolution-safety',
    '@akemi-mio/evolution-scheduler',
  ])
  assert.ok(payload.modules.every((module) => module.healthy === true))
})
