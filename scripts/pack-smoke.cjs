'use strict'

// Pack-and-install smoke for the two freshly built workspace packages (spec:
// First Publish). Two stages, neither of which publishes anything.
//
//   stage 1 (always) — pack local core + creativity tarballs, install BOTH
//     into a temp project, and probe the published export surface: subpath
//     requires work, blocked subpaths raise ERR_PACKAGE_PATH_NOT_EXPORTED,
//     and IdeaGenerator generates from templates with the LLM refused.
//   stage 2 (--registry URL) — install the REAL published
//     @akemi-mio/creativity from the registry and re-run the same probe, so
//     a tarball missing files cannot pass on stage 1 alone.
//
// Usage:
//   node scripts/pack-smoke.cjs
//   node scripts/pack-smoke.cjs --registry https://registry.npmjs.org

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function fail(message, detail) {
  console.error(`pack-smoke FAILED: ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}

// npm is npm.cmd on Windows, which Node refuses to spawn directly; reuse the
// verify-packed-runtime.js invocation rules (npm_execpath when running inside
// an npm script, shell shim otherwise).
function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args], shell: false }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: process.platform === 'win32' }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited ${result.status}`, `${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return result.stdout || ''
}

function runNpm(args, options) {
  const { command, args: fullArgs, shell } = npmInvocation(args)
  return run(command, fullArgs, { ...options, shell })
}

function assertBuildOutputs(pkgDir, pkgName) {
  // Plan deviation: the plan asserted dist/index.js, but @akemi-mio/creativity
  // has no root entry (main = ./dist/IdeaGenerator.js, no "." export). Assert
  // the package's declared main instead — same intent: fail when the build
  // never ran.
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const mainPath = path.join(pkgDir, pkg.main || 'dist/index.js')
  if (!fs.existsSync(mainPath)) {
    fail(`${pkgName}: ${mainPath} missing — run the package build first`)
  }
}

function pack(pkgName) {
  const pkgDir = path.join(root, 'packages', pkgName)
  assertBuildOutputs(pkgDir, pkgName)
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pack-smoke-tgz-'))
  const out = runNpm(['pack', '--json', '--pack-destination', dest], { cwd: pkgDir })
  let filename
  try {
    filename = JSON.parse(out)[0].filename
  } catch (_) {
    return fail(`${pkgName}: npm pack --json output was not parseable`, out)
  }
  return path.join(dest, filename)
}

const PROBE = `'use strict'
// Shared export-surface probe for both stages (cwd = the install dir).
const path = require('path')
const req = require('module').createRequire(path.join(process.cwd(), 'probe.js'))

async function main() {
  const random = req('@akemi-mio/core/utils/random')
  if (typeof random.resolveRandom !== 'function') throw new Error('core/utils/random missing resolveRandom')
  const logger = req('@akemi-mio/core/logger/Logger')
  if (typeof logger.log !== 'function') throw new Error('core/logger/Logger missing log')

  // The root export must RESOLVE, but is not executed: dist/index.js pulls in
  // electron-coupled modules (Lifecycle, ModelLoader) whose contract only
  // exists inside an Electron host.
  const coreRoot = req.resolve('@akemi-mio/core')
  if (!coreRoot.endsWith('index.js')) throw new Error('core root did not resolve to dist/index.js: ' + coreRoot)

  const { IdeaGenerator } = req('@akemi-mio/creativity/IdeaGenerator')
  const { SourceAggregator } = req('@akemi-mio/creativity/SourceAggregator')
  const { evaluateNovelty } = req('@akemi-mio/creativity/NoveltyScorer')
  if (typeof IdeaGenerator !== 'function') throw new Error('IdeaGenerator not a class')
  if (typeof SourceAggregator !== 'function') throw new Error('SourceAggregator not a class')
  if (typeof evaluateNovelty !== 'function') throw new Error('evaluateNovelty missing')
  if (evaluateNovelty({ title: 'a', idea: 'b', novelty: 50 }, [], []).shouldReject !== false) {
    throw new Error('evaluateNovelty broken on empty inputs')
  }
  req('@akemi-mio/creativity/types')

  // Offline generation: the refused LLM must never be needed — templates carry
  // the run (4-arg constructor lands with Task 7).
  const generator = new IdeaGenerator(
    async () => {
      throw new Error('offline')
    },
    0.5,
    undefined,
    0,
  )
  const sources = [
    { name: 'auth', content: 'token rotation keeps getting hand-rolled', type: 'knowledge', weight: 0.9 },
    { name: 'cache', content: 'write-through cache invalidation', type: 'knowledge', weight: 0.9 },
  ]
  const ideas = await generator.generateIdeas(sources, 1, 'stable', [])
  if (!Array.isArray(ideas) || ideas.length < 1 || !ideas[0].hypothesis || !ideas[0].hypothesis.title) {
    throw new Error('offline template generation produced no hypothesis')
  }

  for (const blocked of ['@akemi-mio/creativity', '@akemi-mio/core/db/connection']) {
    let code = null
    try {
      req(blocked)
    } catch (e) {
      code = e.code
    }
    if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new Error(blocked + ' must be blocked with ERR_PACKAGE_PATH_NOT_EXPORTED, got: ' + code)
    }
  }

  console.log('probe OK')
}

main().catch((e) => {
  console.error((e && e.stack) || String(e))
  process.exit(1)
})
`

function writeProbe(dir) {
  fs.writeFileSync(path.join(dir, 'probe.js'), PROBE, 'utf8')
}

function probe(installDir) {
  run(process.execPath, ['probe.js'], { cwd: installDir })
}

function installDirInit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pack-smoke-'))
  runNpm(['init', '-y'], { cwd: dir })
  return dir
}

;(async () => {
  const registryIndex = process.argv.indexOf('--registry')
  const registry = registryIndex !== -1 ? process.argv[registryIndex + 1] : null

  const coreTgz = pack('core')
  const creativityTgz = pack('creativity')

  // Stage 1: local tarballs. Both in ONE install command so creativity's
  // "@akemi-mio/core": "*" resolves to the local core tarball, not the
  // registry (the package may not be published yet).
  const localDir = installDirInit()
  runNpm(['install', coreTgz, creativityTgz, '--no-audit', '--no-fund', '--prefer-offline'], { cwd: localDir })
  writeProbe(localDir)
  probe(localDir)
  console.log('stage 1 (local tarballs): probe OK')

  if (registry) {
    const registryDir = installDirInit()
    runNpm(['install', '@akemi-mio/creativity@latest', '--no-audit', '--no-fund', '--registry', registry], {
      cwd: registryDir,
    })
    writeProbe(registryDir)
    probe(registryDir)
    console.log(`stage 2 (registry ${registry}): probe OK`)
    fs.rmSync(registryDir, { recursive: true, force: true })
  } else {
    console.log('stage 2 skipped (pass --registry <url> to verify the published tarball)')
  }

  fs.rmSync(localDir, { recursive: true, force: true })
  console.log('pack-smoke passed')
})().catch((e) => {
  fail((e && e.message) || String(e))
})
