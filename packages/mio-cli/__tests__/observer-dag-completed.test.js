'use strict'

// D5: the pipeline actually succeeded but the CLI exited 1.
//
// The producer published the insight while the DAG still said STORED and only
// then transitioned to COMPLETED (ObserverService.ts). publishInsight copies
// `dag.state` straight into `envelope.dagState`, so every envelope claimed
// STORED, and observer-store.js answered `completed: envelope.dagState.state
// === 'COMPLETED'` -> false -> CLI "unknown reason" -> exit 1, while the dag
// file, the insight and the self-evo update had all landed.
//
// The fix is the ordering itself: COMPLETED must be reached before publish, in
// both producer copies (@akemi-mio/observer and the app's bundled mirror).
// Asserted on the shipped dist too -- `dist` is gitignored and only exists once
// built (CI builds all workspaces before this suite runs), and that file is
// what an npm install actually loads.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PRODUCERS = [
  ['observer src', path.resolve(__dirname, '..', '..', 'observer', 'src', 'ObserverService.ts')],
  ['observer dist (what npm installs)', path.resolve(__dirname, '..', '..', 'observer', 'dist', 'ObserverService.js')],
  ['intelligence-observer src (app bundle)', path.resolve(__dirname, '..', '..', 'intelligence-observer', 'src', 'ObserverService.ts')],
]

const PUBLISH = 'publishInsight(insight, dag'
const COMPLETED = "transition(dag, 'COMPLETED')"

for (const [label, file] of PRODUCERS) {
  test(`D5 ${label}: dag reaches COMPLETED before the insight is published`, () => {
    if (!fs.existsSync(file)) {
      assert.fail(`missing ${file} -- build it first: npx tsc -p packages/observer/tsconfig.json`)
    }
    const source = fs.readFileSync(file, 'utf8')
    const publishAt = source.indexOf(PUBLISH)
    const completedAt = source.indexOf(COMPLETED)

    assert.notEqual(publishAt, -1, `${label}: publishInsight(insight, dag) call not found`)
    assert.notEqual(completedAt, -1, `${label}: COMPLETED transition not found`)
    assert.ok(
      completedAt < publishAt,
      `${label}: transition(COMPLETED) must come before publishInsight -- publishInsight snapshots ` +
        `dag.state into the envelope, so publishing first ships an envelope that says STORED and the ` +
        `consumer reports completed:false for a run that succeeded (D5)`,
    )
  })
}

test('D5 CLI failure path reports the reason and what the run produced', () => {
  const cli = fs.readFileSync(path.resolve(__dirname, '..', 'bin', 'mio.js'), 'utf8')
  const branch = cli.slice(cli.indexOf('if (!result.completed)'), cli.indexOf('if (!result.completed)') + 400)

  assert.match(branch, /result\.reason/, 'the failure line must print result.reason')
  assert.match(branch, /sections=/, 'the failure line must show what the run produced')
  assert.match(branch, /process\.exitCode = 1/, 'a non-completed run still has to fail')
})
