#!/usr/bin/env node
'use strict'

// Creates the node_modules junctions mio-cli needs to require the workspace
// packages it depends on at runtime (@akemi-mio/insight etc. already exist as
// junctions in a normal checkout; a fresh clone has none). Idempotent: an
// existing link (or directory) is left alone. Windows junctions, because this
// checkout lives on NTFS and junctions need no admin rights.

const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const links = [
  {
    at: path.join(REPO, 'packages', 'mio-cli', 'node_modules', '@akemi-mio', 'creativity'),
    target: path.join(REPO, 'packages', 'creativity'),
  },
  {
    at: path.join(REPO, 'packages', 'creativity', 'node_modules', '@akemi-mio', 'core'),
    target: path.join(REPO, 'packages', 'core'),
  },
  // Root-level links: the new tests under tests/main/creativity/ import
  // '@akemi-mio/creativity/*' from the repo root, and the lockfile's
  // link:true entries are not materialized on disk (ground rule 4 forbids
  // the `npm install` that would create them).
  {
    at: path.join(REPO, 'node_modules', '@akemi-mio', 'creativity'),
    target: path.join(REPO, 'packages', 'creativity'),
  },
  {
    at: path.join(REPO, 'node_modules', '@akemi-mio', 'core'),
    target: path.join(REPO, 'packages', 'core'),
  },
]

for (const { at, target } of links) {
  let exists = false
  try {
    fs.lstatSync(at)
    exists = true
  } catch (_) {
    exists = false
  }
  if (exists) {
    console.log(`exists  ${at}`)
    continue
  }
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at, 'junction')
  console.log(`linked  ${at} -> ${target}`)
}
