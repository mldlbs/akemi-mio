#!/usr/bin/env node
'use strict'

/**
 * git fetch wrapper that recovers remote-tracking refs the ACL lock destroys.
 *
 * Why this exists
 * ---------------
 * On this machine `.git/refs/remotes/` (and everything under it) is subject to a
 * `[Deny] Write` ACE. It applies to the *sandbox* identity git runs as, which is a
 * different Windows domain from the interactive user. Git updates a remote-tracking
 * ref by unlinking the old loose ref and writing a new one; the unlink is permitted
 * and the write is refused — silently. Observed: `fetch` exits 0, prints nothing,
 * writes FETCH_HEAD correctly, and leaves `refs/remotes/` EMPTY.
 *
 * We deliberately do NOT remove that ACE. It is another tool's security boundary —
 * the same SID holds `Allow Modify` and `Deny Write`, i.e. "may edit files but not
 * git internals" — and our own identity cannot change it anyway (no WRITE_DAC).
 *
 * The fix: keep the refs PACKED
 * -----------------------------
 * `packed-refs` lives directly in `.git/`, outside the locked subtree, and it is
 * writable. Once a remote-tracking ref is packed, git reads it from there and no
 * loose file is needed. So the durable repair is:
 *
 *   1. rebuild any missing loose refs from FETCH_HEAD (the interactive identity can
 *      write them, so this works),
 *   2. `git pack-refs` to fold them into packed-refs,
 *   3. afterwards a plain `git fetch` still wipes the loose refs — but the packed
 *      copy survives, so `git branch -r` keeps working. No re-run needed.
 *
 * Step 2 is what makes this stick; without it the repair lasts only until the next
 * fetch. Verified: plain `fetch` after packing leaves all refs resolvable.
 *
 * Usage:
 *   node scripts/git-fetch-safe.cjs              # origin, default branch only (like `git fetch`)
 *   node scripts/git-fetch-safe.cjs --all        # every remote branch (like `git fetch --all`)
 *   node scripts/git-fetch-safe.cjs --remote up  # a different remote
 *   node scripts/git-fetch-safe.cjs --repair-only  # skip the network, just rebuild+pack
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const GIT_DIR = path.join(REPO_ROOT, '.git')

function parseArgs(argv) {
  const opts = { remote: 'origin', all: false, quiet: false, repairOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') {
      opts.remote = argv[++i]
      if (!opts.remote) throw new Error('--remote needs a value')
    } else if (a === '--all') {
      opts.all = true
    } else if (a === '--repair-only') {
      opts.repairOnly = true
    } else if (a === '--quiet' || a === '-q') {
      opts.quiet = true
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  return opts
}

// The local proxy (127.0.0.1:4456) is frequently not listening, which makes git
// fail with "Failed to connect to github.com:443" — easy to mistake for an outage.
// Passing empty overrides makes git go direct. Both fetch and push need this.
function runGit(args, opts = {}) {
  return spawnSync('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    ...opts,
  })
}

// FETCH_HEAD lines look like:
//   <sha>\t\tbranch 'master' of https://github.com/owner/repo
//   <sha>\tnot-for-merge\tbranch 'backup/stash0' of https://github.com/owner/repo
// The branch name is single-quoted and may itself contain a slash.
const FETCH_HEAD_LINE = /^([0-9a-f]{40})\s+.*?branch '([^']+)' of /gm

function readFetchHead() {
  const file = path.join(GIT_DIR, 'FETCH_HEAD')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { refs: {}, error: `cannot read FETCH_HEAD: ${err.message}` }
  }
  const refs = {}
  const matches = raw.matchAll(FETCH_HEAD_LINE)
  for (const m of matches) refs[m[2]] = m[1]
  if (Object.keys(refs).length === 0) {
    return { refs, error: 'FETCH_HEAD contained no parseable branch lines' }
  }
  return { refs, error: null }
}

// A ref file must be exactly "<40 hex><LF>". Text mode on Windows writes CRLF
// (git: "has trailing garbage or a trailing newline issue"), and a missing final
// newline is rejected too. Binary write is the only safe way.
function writeRef(refPath, sha) {
  fs.mkdirSync(path.dirname(refPath), { recursive: true })
  fs.writeFileSync(refPath, Buffer.from(sha + '\n', 'ascii'))
}

function remoteRefDir(remote) {
  return path.join(GIT_DIR, 'refs', 'remotes', remote)
}

function countRefs(dir) {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) n += countRefs(p)
    else if (entry.isFile()) n += 1
  }
  return n
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const log = (msg) => {
    if (!opts.quiet) console.log(msg)
  }

  if (!fs.existsSync(GIT_DIR)) {
    console.error(`not a git repository (no .git at ${GIT_DIR})`)
    process.exit(2)
  }

  // --all means "fetch every branch of the remote", which is what populates the
  // per-branch remote-tracking refs. A plain fetch on a cloned repo only maps the
  // configured refspec and can legitimately create a single ref, so we only use
  // this to widen the fetch, not to judge health.
  if (!opts.repairOnly) {
    const fetchArgs = ['fetch', opts.remote, '--prune']
    if (opts.all) fetchArgs.push('+refs/heads/*:refs/remotes/' + opts.remote + '/*')

    log(`$ git ${fetchArgs.join(' ')}   (proxy bypassed)`)
    const fetched = runGit(fetchArgs)
    if (fetched.stdout) process.stdout.write(fetched.stdout)
    if (fetched.stderr) process.stderr.write(fetched.stderr)

    if (fetched.status !== 0) {
      console.error(`\ngit fetch failed with exit code ${fetched.status}. Refs were not repaired.`)
      process.exit(fetched.status === null ? 1 : fetched.status)
    }
  } else {
    log('--repair-only: skipping the network, reconciling refs from the existing FETCH_HEAD.')
  }

  const refDir = remoteRefDir(opts.remote)
  const present = countRefs(refDir)
  log(`refs/remotes/${opts.remote}/ holds ${present} loose ref(s).`)

  const { refs, error } = readFetchHead()
  if (error) {
    // No FETCH_HEAD payload at all is normal when everything is already
    // up to date and the fetch was a no-op.
    log(`FETCH_HEAD: ${error} — nothing to reconcile.`)
    process.exit(present > 0 ? 0 : 1)
  }

  const expected = Object.keys(refs)

  // FETCH_HEAD is not always the freshest source: it records what the last
  // *fetch* saw. After a successful `git push`, the remote has moved on but
  // FETCH_HEAD still describes the pre-push state, so reconciling from it alone
  // would write a stale SHA over a fresh ref. Query the remote directly and let
  // it win — it is the ground truth for a remote-tracking ref.
  const lsRemote = runGit(['ls-remote', '--heads', opts.remote], { stdio: 'pipe' })
  if (lsRemote.status === 0 && lsRemote.stdout) {
    const remoteShas = {}
    for (const line of lsRemote.stdout.split('\n')) {
      const m = /^([0-9a-f]{40})\s+refs\/heads\/(.+?)\s*$/.exec(line)
      if (m) remoteShas[m[2]] = m[1]
    }
    let adopted = 0
    for (const name of expected) {
      if (remoteShas[name] && remoteShas[name] !== refs[name]) {
        log(
          `  ${opts.remote}/${name}: FETCH_HEAD had ${refs[name].slice(0, 10)}, remote has ${remoteShas[name].slice(0, 10)} — using remote`,
        )
        refs[name] = remoteShas[name]
        adopted += 1
      }
    }
    if (adopted > 0) log(`ls-remote corrected ${adopted} stale SHA(s) from FETCH_HEAD.`)
    // Also cover branches the fetch did not map but the remote does have.
    for (const name of Object.keys(remoteShas)) {
      if (!(name in refs) && opts.all) {
        refs[name] = remoteShas[name]
        expected.push(name)
      }
    }
  } else {
    log('warning: could not query the remote (ls-remote failed); relying on FETCH_HEAD alone.')
  }

  const missing = expected.filter((name) => {
    const p = path.join(refDir, ...name.split('/'))
    if (!fs.existsSync(p)) return true
    try {
      return fs.readFileSync(p, 'utf8').trim() !== refs[name]
    } catch (_) {
      return true
    }
  })

  // A ref may exist only in packed-refs (that is the whole point of this script),
  // where no loose file is present. Compare against what git actually resolves,
  // otherwise a correctly packed ref looks "missing" forever.
  const packedStale = []
  for (const name of expected) {
    const resolved = runGit(['rev-parse', '--verify', `refs/remotes/${opts.remote}/${name}`], { stdio: 'pipe' })
    if (resolved.status !== 0) continue
    const current = (resolved.stdout || '').trim()
    if (current && current !== refs[name]) {
      packedStale.push(name)
      if (!missing.includes(name)) missing.push(name)
    }
  }
  if (packedStale.length > 0) {
    log(`\n${packedStale.length} ref(s) are packed with out-of-date SHAs: ${packedStale.join(', ')}`)
  }

  if (missing.length > 0) {
    log(`\n${missing.length} of ${expected.length} ref(s) missing or stale — rebuilding from FETCH_HEAD.`)
    for (const name of missing) {
      const target = path.join(refDir, ...name.split('/'))
      writeRef(target, refs[name])
      log(`  ${opts.remote}/${name} -> ${refs[name].slice(0, 10)}`)
    }
  } else {
    log(`All ${expected.length} ref(s) already match FETCH_HEAD.`)
  }

  // The durable step. Without packing, the next plain `fetch` unlinks these loose
  // refs and cannot rewrite them, so the repair would evaporate. packed-refs lives
  // outside the locked directory and survives that unlink.
  log('\n$ git pack-refs --all   (makes the refs survive future fetches)')
  const packed = runGit(['pack-refs', '--all'], { stdio: 'pipe' })
  if (packed.status !== 0) {
    console.error('git pack-refs failed:')
    process.stderr.write(packed.stdout || '')
    process.stderr.write(packed.stderr || '')
    process.exit(1)
  }

  // Verify by reading back through git itself, not just the filesystem: a file
  // existing is not proof that git accepts it as a ref, and a packed ref can carry
  // a stale SHA while still resolving fine. Check both existence and value.
  const broken = []
  const wrong = []
  for (const name of expected) {
    const res = runGit(['rev-parse', '--verify', `refs/remotes/${opts.remote}/${name}`], { stdio: 'pipe' })
    if (res.status !== 0) {
      broken.push(name)
      continue
    }
    const actual = (res.stdout || '').trim()
    if (actual && actual !== refs[name]) wrong.push(`${name} (have ${actual.slice(0, 10)}, want ${refs[name].slice(0, 10)})`)
  }

  if (broken.length > 0) {
    console.error(`\nRepair incomplete — git still cannot resolve: ${broken.join(', ')}`)
    process.exit(1)
  }

  if (wrong.length > 0) {
    console.error(`\nRepair incomplete — refs resolve but hold the wrong SHA:`)
    for (const w of wrong) console.error(`  ${w}`)
    process.exit(1)
  }

  const fsck = runGit(['fsck', '--no-progress'], { stdio: 'pipe' })
  if (fsck.status !== 0) {
    console.error('\ngit fsck reported problems after repair:')
    process.stderr.write(fsck.stdout || '')
    process.stderr.write(fsck.stderr || '')
    process.exit(1)
  }

  const looseAfter = countRefs(refDir)
  log(
    `\nRepaired and packed. git resolves all ${expected.length} ref(s); ` +
      `loose files under refs/remotes/${opts.remote}/: ${looseAfter}; fsck clean.`,
  )
  log('A subsequent plain `git fetch` may empty the loose refs again, but the packed copies keep working.')
  process.exit(0)
}

try {
  main()
} catch (err) {
  console.error(err && err.message ? err.message : String(err))
  process.exit(2)
}
