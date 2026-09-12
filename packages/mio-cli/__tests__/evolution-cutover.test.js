const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cliPath = path.resolve(__dirname, '..', 'bin', 'mio.js')

function runCli(args, home, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: home },
    cwd: options.cwd,
  })
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

test('evolution cutover readiness reads MIO_HOME shadow and dual-write samples', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-cutover-'))
  appendJsonl(path.join(home, 'evolution_shadow.jsonl'), {
    project: 'cli-cutover',
    matched: true,
  })
  appendJsonl(path.join(home, 'evolution_shadow.jsonl'), {
    project: 'cli-cutover',
    matched: true,
  })
  appendJsonl(path.join(home, 'evolution_dual_write.jsonl'), {
    project: 'cli-cutover',
    shadow: { matched: true },
  })

  const result = runCli([
    '--json',
    'evolution',
    'cutover',
    'readiness',
    '--project',
    'cli-cutover',
    '--min-shadow-runs',
    '2',
  ], home)

  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.project, 'cli-cutover')
  assert.equal(payload.status, 'pass')
  assert.equal(payload.shadowRuns, 2)
  assert.equal(payload.dualWriteRuns, 1)
})

test('evolution shadow and dual-write record commands persist comparison samples', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-cutover-'))

  const shadow = runCli([
    '--json',
    'evolution',
    'shadow',
    'record',
    '--project',
    'cli-cutover',
    '--label',
    'status parity',
    '--legacy',
    '{"modules":7}',
    '--modular',
    '{"modules":7}',
  ], home)

  assert.equal(shadow.status, 0, shadow.stderr)
  const shadowPayload = JSON.parse(shadow.stdout)
  assert.equal(shadowPayload.project, 'cli-cutover')
  assert.equal(shadowPayload.label, 'status parity')
  assert.equal(shadowPayload.matched, true)

  const dualWrite = runCli([
    '--json',
    'evolution',
    'dual-write',
    'record',
    '--project',
    'cli-cutover',
    '--label',
    'memory dual write',
    '--authoritative',
    'legacy',
    '--legacy-result',
    '{"id":"mem-1","ok":true}',
    '--modular-result',
    '{"id":"mem-1","ok":true}',
  ], home)

  assert.equal(dualWrite.status, 0, dualWrite.stderr)
  const dualPayload = JSON.parse(dualWrite.stdout)
  assert.equal(dualPayload.project, 'cli-cutover')
  assert.equal(dualPayload.shadow.matched, true)

  const readiness = runCli([
    '--json',
    'evolution',
    'cutover',
    'readiness',
    '--project',
    'cli-cutover',
    '--min-shadow-runs',
    '1',
  ], home)

  assert.equal(readiness.status, 0, readiness.stderr)
  assert.equal(JSON.parse(readiness.stdout).status, 'pass')
})

test('evolution cutover commands default project to the git repository name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-cutover-'))
  const nestedCwd = path.resolve(__dirname, '..')
  const result = runCli([
    '--json',
    'evolution',
    'shadow',
    'record',
    '--legacy',
    '{"modules":7}',
    '--modular',
    '{"modules":7}',
  ], home, { cwd: nestedCwd })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).project, 'akemi-mio')
})

test('evolution authority plan and cutover apply are exposed as dry-run CLI previews', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-cutover-'))
  const readiness = JSON.stringify({ status: 'pass', reasons: [] })
  const authorityResult = runCli([
    '--json',
    'evolution',
    'authority',
    'plan',
    '--readiness',
    readiness,
    '--from',
    'legacy',
    '--to',
    'modular',
  ], home)

  assert.equal(authorityResult.status, 0, authorityResult.stderr)
  const authority = JSON.parse(authorityResult.stdout)
  assert.equal(authority.approved, true)
  assert.deepEqual(authority.actions.map((action) => action.type), [
    'set_authority',
    'keep_fallback',
    'monitor_cutover',
  ])

  const applyResult = runCli([
    '--json',
    'evolution',
    'cutover',
    'apply',
    '--dry-run',
    '--project',
    'cli-cutover',
    '--plan',
    JSON.stringify(authority),
  ], home)

  assert.equal(applyResult.status, 0, applyResult.stderr)
  const applied = JSON.parse(applyResult.stdout)
  assert.equal(applied.applied, false)
  assert.equal(applied.dryRun, true)
  assert.equal(applied.project, 'cli-cutover')

  const realApply = runCli([
    '--json',
    'evolution',
    'cutover',
    'apply',
    '--plan',
    JSON.stringify(authority),
  ], home)

  assert.notEqual(realApply.status, 0)
  assert.match(realApply.stderr, /dryRun: true/)
})
