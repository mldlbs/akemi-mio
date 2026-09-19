'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cliPath = path.resolve(__dirname, '..', 'bin', 'mio.js')
const manifest = require(path.resolve(__dirname, '..', 'package.json'))

function run(args) {
  const env = { ...process.env, MIO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ver-')) }
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env })
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

test('--version prints the version from the manifest', () => {
  assert.equal(run(['--version']), manifest.version)
})

test('-V prints the same version', () => {
  assert.equal(run(['-V']), manifest.version)
})

test('--version is a real command, not an unknown one', () => {
  // The gap this file closes: `mio --version` used to fall through to the
  // default branch and print "Unknown command".
  const out = run(['--version'])
  assert.doesNotMatch(out, /Unknown command/)
  assert.match(out, /^\d+\.\d+\.\d+/)
})

test('--version --json reports name and version', () => {
  const parsed = JSON.parse(run(['--version', '--json']))
  assert.equal(parsed.name, manifest.name)
  assert.equal(parsed.version, manifest.version)
})

test('the version comes from the manifest, not a hardcoded string', () => {
  // Guard against a copy that drifts on the next release.
  const src = fs.readFileSync(cliPath, 'utf8')
  assert.match(src, /require\('\.\.\/package\.json'\)/)
})

test('help lists --version', () => {
  assert.match(run(['--help']), /--version/)
})
