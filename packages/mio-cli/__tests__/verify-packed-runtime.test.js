const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createVerifyPackedRuntimeOptions,
  createPackedRuntimeInstallPlan,
  packageArtifactEvidence,
  npmInvocation,
  npmCommand,
  parseVerifyPackedRuntimeArgs,
  runtimePackageNames,
  summarizeInstalledSmoke,
  writeVerificationReport,
} = require('../scripts/verify-packed-runtime.js')

function installedStatusWithModules(overrides = {}) {
  return {
    runtime: 'mio-agent-runtime',
    version: '0.5.16',
    modules: runtimePackageNames()
      .filter((name) => name.startsWith('@akemi-mio/'))
      .map((name) => ({ name, loaded: true, healthy: true, ...(overrides[name] || {}) })),
  }
}

test('packed runtime install plan includes all runtime modules before the composition package', () => {
  assert.deepEqual(runtimePackageNames(), [
    '@akemi-mio/runtime-contracts',
    '@akemi-mio/runtime-foundation',
    '@akemi-mio/experience-memory',
    '@akemi-mio/evolution-learning',
    '@akemi-mio/evolution-strategy',
    '@akemi-mio/evolution-safety',
    '@akemi-mio/evolution-scheduler',
    'mio-agent-runtime',
  ])
})

test('npm command resolves to npm.cmd on Windows', () => {
  assert.equal(npmCommand('win32'), 'npm.cmd')
  assert.equal(npmCommand('linux'), 'npm')
})

test('npm invocation prefers npm_execpath to avoid Windows cmd shims', () => {
  assert.deepEqual(
    npmInvocation(['pack'], { npm_execpath: 'C:/node/npm-cli.js' }, 'win32', 'C:/node/node.exe'),
    { command: 'C:/node/node.exe', args: ['C:/node/npm-cli.js', 'pack'] },
  )
  assert.deepEqual(
    npmInvocation(['pack'], {}, 'win32', 'C:/node/node.exe'),
    { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'pack'] },
  )
  assert.deepEqual(
    npmInvocation(['pack'], {}, 'linux', '/usr/bin/node'),
    { command: 'npm', args: ['pack'] },
  )
})

test('verify packed runtime argument parser accepts deterministic directories', () => {
  assert.deepEqual(
    parseVerifyPackedRuntimeArgs([
      '--workspace-root',
      'D:/work/code/akemi-mio',
      '--artifact-dir',
      'D:/tmp/artifacts',
      '--install-dir',
      'D:/tmp/install',
      '--report-path',
      'D:/tmp/report.json',
    ]),
    {
      workspaceRoot: 'D:/work/code/akemi-mio',
      artifactDir: 'D:/tmp/artifacts',
      installDir: 'D:/tmp/install',
      reportPath: 'D:/tmp/report.json',
      help: false,
    },
  )
})

test('verify packed runtime argument parser rejects missing values and unknown options', () => {
  assert.throws(
    () => parseVerifyPackedRuntimeArgs(['--artifact-dir']),
    /Missing value for --artifact-dir/,
  )
  assert.throws(
    () => parseVerifyPackedRuntimeArgs(['--unknown']),
    /Unknown option: --unknown/,
  )
})

test('verify packed runtime argument parser supports help', () => {
  assert.deepEqual(parseVerifyPackedRuntimeArgs(['--help']), { help: true })
})

test('verify packed runtime options read deterministic directories from environment', () => {
  assert.deepEqual(
    createVerifyPackedRuntimeOptions([], {
      MIO_PACK_WORKSPACE_ROOT: 'D:/repo',
      MIO_PACK_ARTIFACT_DIR: 'D:/artifacts',
      MIO_PACK_INSTALL_DIR: 'D:/install',
      MIO_PACK_REPORT_PATH: 'D:/report.json',
    }),
    {
      workspaceRoot: 'D:/repo',
      artifactDir: 'D:/artifacts',
      installDir: 'D:/install',
      reportPath: 'D:/report.json',
      help: false,
    },
  )
})

test('verify packed runtime command line directories override environment defaults', () => {
  assert.deepEqual(
    createVerifyPackedRuntimeOptions(['--artifact-dir', 'D:/cli-artifacts'], {
      MIO_PACK_ARTIFACT_DIR: 'D:/env-artifacts',
      MIO_PACK_INSTALL_DIR: 'D:/env-install',
      MIO_PACK_REPORT_PATH: 'D:/env-report.json',
    }),
    {
      artifactDir: 'D:/cli-artifacts',
      installDir: 'D:/env-install',
      reportPath: 'D:/env-report.json',
      help: false,
    },
  )
})

test('verification report writer creates parent directories and refuses overwrite', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-verify-report-'))
  const reportPath = path.join(tempDir, 'nested', 'release-evidence.json')
  const result = {
    ok: true,
    packages: [{ name: '@akemi-mio/runtime-contracts', sha512: 'digest' }],
  }

  assert.equal(writeVerificationReport(result, reportPath), path.resolve(reportPath))
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), result)
  assert.throws(
    () => writeVerificationReport(result, reportPath),
    /Verification report already exists:/,
  )
})

test('package artifact evidence includes file size and sha512 digest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-package-evidence-'))
  const tarball = path.join(tempDir, 'sample.tgz')
  fs.writeFileSync(tarball, 'mio artifact')

  const evidence = packageArtifactEvidence({
    name: '@akemi-mio/runtime-contracts',
    version: '0.1.0',
    tarball,
  })

  assert.deepEqual(evidence, {
    name: '@akemi-mio/runtime-contracts',
    version: '0.1.0',
    tarball,
    sizeBytes: 12,
    sha512: crypto.createHash('sha512').update('mio artifact').digest('hex'),
  })
})

test('package artifact evidence rejects missing tarballs', () => {
  assert.throws(
    () => packageArtifactEvidence({
      name: '@akemi-mio/runtime-contracts',
      version: '0.1.0',
      tarball: path.join(os.tmpdir(), 'missing-mio-runtime-contracts.tgz'),
    }),
    /Expected tarball was not created:/,
  )
})

test('packed runtime install plan installs local tarballs and runs evolution status smoke', () => {
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..')
  const plan = createPackedRuntimeInstallPlan({
    workspaceRoot,
    artifactDir: path.join(workspaceRoot, '.mio-pack-artifacts'),
    installDir: path.join(workspaceRoot, '.mio-pack-install'),
  })

  assert.equal(plan.packages.length, 8)
  assert.equal(plan.packages.at(-1).name, 'mio-agent-runtime')
  assert.ok(plan.packages.every((pkg) => pkg.tarball.endsWith('.tgz')))
  assert.deepEqual(plan.install.args.slice(0, 4), [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ])
  assert.equal(plan.install.args.length, 12)
  assert.deepEqual(plan.smoke.args.slice(-3), ['--json', 'evolution', 'status'])
})

test('packed runtime install plan runs installed cutover CLI smoke commands', () => {
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..')
  const plan = createPackedRuntimeInstallPlan({
    workspaceRoot,
    artifactDir: path.join(workspaceRoot, '.mio-pack-artifacts'),
    installDir: path.join(workspaceRoot, '.mio-pack-install'),
  })

  assert.deepEqual(plan.smoke.status.args.slice(-3), ['--json', 'evolution', 'status'])
  assert.deepEqual(
    plan.smoke.cutover.map((command) => command.args.slice(2, 5).join(' ')),
    [
      'evolution shadow record',
      'evolution dual-write record',
      'evolution cutover readiness',
      'evolution cutover apply',
    ],
  )
})

test('mio-agent-runtime package ships release verification script referenced by check', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
  )

  assert.ok(manifest.files.includes('scripts/'))
  assert.match(manifest.scripts.check, /scripts\/verify-packed-runtime\.js/)
})

test('installed smoke summary rejects unloaded or unhealthy runtime modules', () => {
  const status = installedStatusWithModules({
    '@akemi-mio/evolution-scheduler': { loaded: false, healthy: false },
  })
  const cutover = [
    { matched: true },
    { shadow: { matched: true } },
    { status: 'pass' },
    { dryRun: true, applied: false },
  ]

  assert.throws(
    () => summarizeInstalledSmoke(status, cutover),
    /Installed runtime modules failed health check: @akemi-mio\/evolution-scheduler/,
  )
})

test('installed smoke summary rejects missing runtime modules', () => {
  const status = {
    runtime: 'mio-agent-runtime',
    version: '0.5.16',
    modules: [
      { name: '@akemi-mio/runtime-contracts', loaded: true, healthy: true },
    ],
  }
  const cutover = [
    { matched: true },
    { shadow: { matched: true } },
    { status: 'pass' },
    { dryRun: true, applied: false },
  ]

  assert.throws(
    () => summarizeInstalledSmoke(status, cutover),
    /Installed runtime status is missing modules: @akemi-mio\/runtime-foundation/,
  )
})

test('installed smoke summary rejects shadow and dual-write mismatches', () => {
  const status = installedStatusWithModules()

  assert.throws(
    () => summarizeInstalledSmoke(status, [
      { matched: false },
      { shadow: { matched: true } },
      { status: 'pass' },
      { dryRun: true, applied: false },
    ]),
    /Installed shadow smoke did not match/,
  )

  assert.throws(
    () => summarizeInstalledSmoke(status, [
      { matched: true },
      { shadow: { matched: false } },
      { status: 'pass' },
      { dryRun: true, applied: false },
    ]),
    /Installed dual-write smoke did not match/,
  )
})
