#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const RUNTIME_PACKAGE_NAMES = [
  '@akemi-mio/runtime-contracts',
  '@akemi-mio/runtime-foundation',
  '@akemi-mio/experience-memory',
  '@akemi-mio/evolution-learning',
  '@akemi-mio/evolution-strategy',
  '@akemi-mio/evolution-safety',
  '@akemi-mio/evolution-scheduler',
  'mio-agent-runtime',
]

function runtimePackageNames() {
  return [...RUNTIME_PACKAGE_NAMES]
}

function usage() {
  return [
    'Usage: node scripts/verify-packed-runtime.js [options]',
    '',
    'Options:',
    '  --workspace-root <path>  Workspace root that contains packages/',
    '  --artifact-dir <path>    Directory where npm pack writes tarballs',
    '  --install-dir <path>     Clean temporary npm project directory',
    '  --report-path <path>     Optional JSON evidence report path; must not exist',
    '  --help                   Show this help message',
  ].join('\n')
}

function parseVerifyPackedRuntimeArgs(argv) {
  const options = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help' || option === '-h') return { help: true }
    if (!['--workspace-root', '--artifact-dir', '--install-dir', '--report-path'].includes(option)) {
      throw new Error(`Unknown option: ${option}`)
    }

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}`)
    }

    if (option === '--workspace-root') options.workspaceRoot = value
    if (option === '--artifact-dir') options.artifactDir = value
    if (option === '--install-dir') options.installDir = value
    if (option === '--report-path') options.reportPath = value
    index += 1
  }
  return options
}

function createVerifyPackedRuntimeOptions(argv, env = process.env) {
  const envOptions = {}
  if (env.MIO_PACK_WORKSPACE_ROOT) envOptions.workspaceRoot = env.MIO_PACK_WORKSPACE_ROOT
  if (env.MIO_PACK_ARTIFACT_DIR) envOptions.artifactDir = env.MIO_PACK_ARTIFACT_DIR
  if (env.MIO_PACK_INSTALL_DIR) envOptions.installDir = env.MIO_PACK_INSTALL_DIR
  if (env.MIO_PACK_REPORT_PATH) envOptions.reportPath = env.MIO_PACK_REPORT_PATH

  const cliOptions = parseVerifyPackedRuntimeArgs(argv)
  if (cliOptions.help) return { help: true }
  return { ...envOptions, ...cliOptions, help: false }
}

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmInvocation(args, env = process.env, platform = process.platform, node = process.execPath) {
  if (env.npm_execpath) {
    return { command: node, args: [env.npm_execpath, ...args] }
  }
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
  }
  return { command: npmCommand(platform), args }
}

function packageDirName(name) {
  if (name === 'mio-agent-runtime') return 'mio-cli'
  return name.replace('@akemi-mio/', '')
}

function tarballFileName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

function readPackageJson(workspaceRoot, name) {
  const packageDir = path.join(workspaceRoot, 'packages', packageDirName(name))
  return {
    packageDir,
    manifest: JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')),
  }
}

function createPackedRuntimeInstallPlan(input = {}) {
  const workspaceRoot = path.resolve(input.workspaceRoot || path.join(__dirname, '..', '..', '..'))
  const artifactDir = path.resolve(input.artifactDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pack-artifacts-')))
  const installDir = path.resolve(input.installDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pack-install-')))
  const cli = path.join(installDir, 'node_modules', 'mio-agent-runtime', 'bin', 'mio.js')
  const packages = RUNTIME_PACKAGE_NAMES.map((name) => {
    const { packageDir, manifest } = readPackageJson(workspaceRoot, name)
    return {
      name,
      version: manifest.version,
      packageDir,
      tarball: path.join(artifactDir, tarballFileName(name, manifest.version)),
    }
  })

  return {
    workspaceRoot,
    artifactDir,
    installDir,
    packages,
    install: {
      cwd: installDir,
      args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map((pkg) => pkg.tarball)],
    },
    smoke: {
      cwd: installDir,
      args: [cli, '--json', 'evolution', 'status'],
      status: {
        cwd: installDir,
        args: [cli, '--json', 'evolution', 'status'],
      },
      cutover: [
        {
          cwd: installDir,
          args: [
            cli,
            '--json',
            'evolution',
            'shadow',
            'record',
            '--project',
            'pack-install-smoke',
            '--label',
            'installed status parity',
            '--legacy',
            '{"modules":7}',
            '--modular',
            '{"modules":7}',
          ],
        },
        {
          cwd: installDir,
          args: [
            cli,
            '--json',
            'evolution',
            'dual-write',
            'record',
            '--project',
            'pack-install-smoke',
            '--label',
            'installed memory parity',
            '--authoritative',
            'legacy',
            '--legacy-result',
            '{"id":"sample","ok":true}',
            '--modular-result',
            '{"id":"sample","ok":true}',
          ],
        },
        {
          cwd: installDir,
          args: [
            cli,
            '--json',
            'evolution',
            'cutover',
            'readiness',
            '--project',
            'pack-install-smoke',
            '--min-shadow-runs',
            '1',
          ],
        },
        {
          cwd: installDir,
          args: [
            cli,
            '--json',
            'evolution',
            'cutover',
            'apply',
            '--dry-run',
            '--project',
            'pack-install-smoke',
            '--plan',
            '{"approved":true,"from":"legacy","to":"modular","actions":[{"type":"set_authority","from":"legacy","to":"modular"}]}',
          ],
        },
      ],
    },
  }
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  })
  return output ? output.trim() : ''
}

function packageArtifactEvidence(pkg) {
  if (!fs.existsSync(pkg.tarball)) {
    throw new Error(`Expected tarball was not created: ${pkg.tarball}`)
  }

  const content = fs.readFileSync(pkg.tarball)
  return {
    name: pkg.name,
    version: pkg.version,
    tarball: pkg.tarball,
    sizeBytes: fs.statSync(pkg.tarball).size,
    sha512: crypto.createHash('sha512').update(content).digest('hex'),
  }
}

function writeVerificationReport(result, reportPath) {
  const resolvedReportPath = path.resolve(reportPath)
  if (fs.existsSync(resolvedReportPath)) {
    throw new Error(`Verification report already exists: ${resolvedReportPath}`)
  }

  fs.mkdirSync(path.dirname(resolvedReportPath), { recursive: true })
  fs.writeFileSync(resolvedReportPath, `${JSON.stringify(result, null, 2)}\n`)
  return resolvedReportPath
}

function summarizeInstalledSmoke(status, cutover) {
  const modules = Array.isArray(status.modules) ? status.modules : []
  const moduleNames = new Set(modules.map((module) => module.name))
  const expectedModules = RUNTIME_PACKAGE_NAMES.filter((name) => name.startsWith('@akemi-mio/'))
  const missingModules = expectedModules.filter((name) => !moduleNames.has(name))
  if (missingModules.length > 0) {
    throw new Error(`Installed runtime status is missing modules: ${missingModules.join(', ')}`)
  }

  const failedModules = modules.filter((module) => module.loaded !== true || module.healthy !== true)
  if (failedModules.length > 0) {
    throw new Error(
      `Installed runtime modules failed health check: ${failedModules.map((module) => module.name).join(', ')}`,
    )
  }

  const shadow = cutover[0]
  const dualWrite = cutover[1]
  const readiness = cutover.find((entry) => entry && entry.status === 'pass')
  const apply = cutover.find((entry) => entry && entry.dryRun === true)

  if (!shadow || shadow.matched !== true) throw new Error('Installed shadow smoke did not match')
  if (!dualWrite || !dualWrite.shadow || dualWrite.shadow.matched !== true) {
    throw new Error('Installed dual-write smoke did not match')
  }
  if (!readiness) throw new Error('Installed cutover readiness smoke did not pass')
  if (!apply || apply.applied !== false) throw new Error('Installed cutover apply smoke did not stay dry-run')

  return {
    runtime: status.runtime,
    version: status.version,
    modules: modules.map((module) => ({
      name: module.name,
      loaded: module.loaded,
      healthy: module.healthy,
    })),
    cutover: {
      shadowMatched: shadow.matched === true,
      dualWriteMatched: dualWrite.shadow.matched === true,
      readiness: readiness.status,
      applied: apply.applied,
    },
  }
}

function verifyPackedRuntimeInstall(input = {}) {
  const plan = createPackedRuntimeInstallPlan(input)
  fs.mkdirSync(plan.artifactDir, { recursive: true })
  fs.mkdirSync(plan.installDir, { recursive: true })

  for (const pkg of plan.packages) {
    const pack = npmInvocation(['pack', '--pack-destination', plan.artifactDir])
    run(pack.command, pack.args, {
      cwd: pkg.packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    packageArtifactEvidence(pkg)
  }

  const init = npmInvocation(['init', '-y'])
  run(init.command, init.args, { cwd: plan.installDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const install = npmInvocation(plan.install.args)
  run(install.command, install.args, { cwd: plan.install.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const smokeEnv = {
    ...process.env,
    MIO_HOME: path.join(plan.installDir, '.mio-home'),
  }
  const smokeStdout = run(process.execPath, plan.smoke.status.args, {
    cwd: plan.smoke.status.cwd,
    env: smokeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cutover = plan.smoke.cutover.map((command) => {
    const stdout = run(process.execPath, command.args, {
      cwd: command.cwd,
      env: smokeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(stdout)
  })
  const status = JSON.parse(smokeStdout)
  const smoke = summarizeInstalledSmoke(status, cutover)
  return {
    ok: true,
    artifactDir: plan.artifactDir,
    installDir: plan.installDir,
    packages: plan.packages.map(packageArtifactEvidence),
    smoke,
  }
}

function main() {
  const options = createVerifyPackedRuntimeOptions(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const result = verifyPackedRuntimeInstall(options)
  if (options.reportPath) {
    result.reportPath = path.resolve(options.reportPath)
    writeVerificationReport(result, result.reportPath)
  }
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

module.exports = {
  createVerifyPackedRuntimeOptions,
  createPackedRuntimeInstallPlan,
  packageArtifactEvidence,
  npmInvocation,
  npmCommand,
  parseVerifyPackedRuntimeArgs,
  runtimePackageNames,
  summarizeInstalledSmoke,
  usage,
  verifyPackedRuntimeInstall,
  writeVerificationReport,
}
