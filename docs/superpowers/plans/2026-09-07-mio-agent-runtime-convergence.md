# Mio Agent Runtime Entry-Point Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/mio-cli` the only maintained Mio Agent Runtime implementation while keeping root-level runtime paths working as compatibility entries.

**Architecture:** The published package at `packages/mio-cli` remains canonical. Root `cli/`, root runtime adapters, and root `server/mio-intelligence-mcp/` become thin CommonJS/Node entry points that delegate to the canonical package. Runtime behavior and package tests stay in the canonical tree; compatibility tests live beside the package.

**Tech Stack:** Node.js CommonJS, Node built-in test runner, npm workspaces, PowerShell on Windows, `npm pack --dry-run`.

---

## File Map

- Create: `packages/mio-cli/__tests__/entry-point-convergence.test.js` — cross-platform smoke tests for root compatibility entries.
- Modify: `cli/mio.js` — delegate CLI execution to `packages/mio-cli/bin/mio.js`.
- Modify: `cli/package.json` — identify the root package as a private compatibility package while keeping its local `mio` bin.
- Modify: `cli/README.md` — document the canonical package and compatibility invocation.
- Modify: `adapters/codex.js` — delegate exports to the canonical Codex adapter.
- Modify: `adapters/opencode.js` — delegate exports to the canonical OpenCode adapter.
- Modify: `adapters/workbuddy.js` — delegate exports to the canonical WorkBuddy adapter.
- Modify: `server/mio-intelligence-mcp/index.js` — delegate MCP execution and exports to the canonical server.
- Modify: `server/mio-intelligence-mcp/phase0.js` — delegate Phase 0 exports to the canonical implementation.
- Modify: `server/mio-intelligence-mcp/package.json` — mark the root MCP package as a private compatibility package.
- Modify: `server/mio-intelligence-mcp/README.md` — identify it as a compatibility path and point readers to canonical documentation.
- Modify: `packages/mio-cli/README.md` — remove the repository-specific worktree path from the canonical MCP configuration example.

The following remain unchanged: `packages/mio-cli/bin/mio.js`, all canonical adapters, `packages/mio-cli/observe/observer.js`, the canonical MCP implementation, all existing canonical MCP tests, and unrelated files under `server/`.

### Task 1: Add Compatibility Contract Tests

**Files:**
- Create: `packages/mio-cli/__tests__/entry-point-convergence.test.js`

- [ ] **Step 1: Write the failing tests**

Create `packages/mio-cli/__tests__/entry-point-convergence.test.js`:

```js
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const rootCli = path.join(repoRoot, 'cli', 'mio.js')
const canonicalCli = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const rootMcp = path.join(repoRoot, 'server', 'mio-intelligence-mcp', 'index.js')
const canonicalMcp = path.join(
  repoRoot,
  'packages',
  'mio-cli',
  'server',
  'mio-intelligence-mcp',
  'index.js',
)
const rootPhase0 = path.join(repoRoot, 'server', 'mio-intelligence-mcp', 'phase0.js')
const canonicalPhase0 = path.join(
  repoRoot,
  'packages',
  'mio-cli',
  'server',
  'mio-intelligence-mcp',
  'phase0.js',
)

test('root CLI exposes the same help command as the canonical CLI', () => {
  const env = { ...process.env, MIO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-help-')) }
  const rootResult = spawnSync(process.execPath, [rootCli, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  })
  const canonicalResult = spawnSync(process.execPath, [canonicalCli, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  })

  assert.equal(rootResult.status, 0, rootResult.stderr)
  assert.equal(canonicalResult.status, 0, canonicalResult.stderr)
  assert.equal(rootResult.stdout, canonicalResult.stdout)
  assert.equal(rootResult.stderr, canonicalResult.stderr)
})

test('root MCP entry delegates to the canonical MCP module', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-entry-'))
  process.env.MIO_DATA_DIR = dataDir
  process.env.MIO_CONTEXT = JSON.stringify({
    agentId: 'compatibility-test',
    project: 'akemi-mio',
    workspace: repoRoot,
    sessionId: 'entry-point-convergence',
  })

  const rootModule = require(rootMcp)
  const canonicalModule = require(canonicalMcp)

  assert.deepEqual(Object.keys(rootModule).sort(), Object.keys(canonicalModule).sort())
  assert.strictEqual(rootModule.callTool, canonicalModule.callTool)
  assert.strictEqual(rootModule.handleMessage, canonicalModule.handleMessage)

  rootModule.rl.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('root Phase 0 entry delegates to the canonical module', () => {
  const rootModule = require(rootPhase0)
  const canonicalModule = require(canonicalPhase0)

  assert.deepEqual(Object.keys(rootModule).sort(), Object.keys(canonicalModule).sort())
  assert.strictEqual(rootModule.analyzePhase0, canonicalModule.analyzePhase0)
  assert.strictEqual(rootModule.loadPhase0, canonicalModule.loadPhase0)
})

for (const adapterName of ['codex', 'opencode', 'workbuddy']) {
  test(`root ${adapterName} adapter delegates to the canonical adapter`, () => {
    const rootAdapter = require(path.join(repoRoot, 'adapters', `${adapterName}.js`))
    const canonicalAdapter = require(
      path.join(repoRoot, 'packages', 'mio-cli', 'adapters', `${adapterName}.js`),
    )

    assert.deepEqual(Object.keys(rootAdapter).sort(), Object.keys(canonicalAdapter).sort())
    for (const key of Object.keys(canonicalAdapter)) {
      assert.strictEqual(rootAdapter[key], canonicalAdapter[key], `${adapterName}.${key}`)
    }
  })
}
```

- [ ] **Step 2: Run the tests and verify the expected red failure**

Run:

```powershell
node --test packages/mio-cli/__tests__/entry-point-convergence.test.js
```

Expected: the test runner fails because the root CLI help output is from the old reduced implementation and the root MCP/adapter entries are not yet delegating to `packages/mio-cli`.

- [ ] **Step 3: Commit the red tests**

```powershell
git add packages/mio-cli/__tests__/entry-point-convergence.test.js
git commit -m "test: define mio runtime entry compatibility"
```

### Task 2: Replace Root Runtime Copies With Delegating Entries

**Files:**
- Modify: `cli/mio.js`
- Modify: `adapters/codex.js`
- Modify: `adapters/opencode.js`
- Modify: `adapters/workbuddy.js`
- Modify: `server/mio-intelligence-mcp/index.js`
- Modify: `server/mio-intelligence-mcp/phase0.js`

- [ ] **Step 1: Replace the root CLI with a canonical delegate**

Set `cli/mio.js` to:

```js
#!/usr/bin/env node
'use strict'

require('../packages/mio-cli/bin/mio.js')
```

- [ ] **Step 2: Replace the root adapter implementations with delegates**

Set the three files to the corresponding single-line modules:

`adapters/codex.js`

```js
'use strict'

module.exports = require('../packages/mio-cli/adapters/codex.js')
```

`adapters/opencode.js`

```js
'use strict'

module.exports = require('../packages/mio-cli/adapters/opencode.js')
```

`adapters/workbuddy.js`

```js
'use strict'

module.exports = require('../packages/mio-cli/adapters/workbuddy.js')
```

- [ ] **Step 3: Replace the root MCP entries with delegates**

Set `server/mio-intelligence-mcp/index.js` to:

```js
#!/usr/bin/env node
'use strict'

module.exports = require('../../packages/mio-cli/server/mio-intelligence-mcp/index.js')
```

Set `server/mio-intelligence-mcp/phase0.js` to:

```js
'use strict'

module.exports = require('../../packages/mio-cli/server/mio-intelligence-mcp/phase0.js')
```

- [ ] **Step 4: Run the compatibility tests and verify green**

Run:

```powershell
node --test packages/mio-cli/__tests__/entry-point-convergence.test.js
```

Expected: all compatibility tests pass, including identical CLI help output and strict function identity for delegated modules.

- [ ] **Step 5: Commit the runtime delegates**

```powershell
git add cli/mio.js adapters/codex.js adapters/opencode.js adapters/workbuddy.js server/mio-intelligence-mcp/index.js server/mio-intelligence-mcp/phase0.js
git commit -m "refactor: delegate root mio runtime entries"
```

### Task 3: Mark Compatibility Metadata and Update Documentation

**Files:**
- Modify: `cli/package.json`
- Modify: `cli/README.md`
- Modify: `server/mio-intelligence-mcp/package.json`
- Modify: `server/mio-intelligence-mcp/README.md`
- Modify: `packages/mio-cli/README.md`

- [ ] **Step 1: Mark the root CLI package as compatibility-only**

Update `cli/package.json` to:

```json
{
  "name": "@akemi-mio/cli-compat",
  "version": "0.4.0",
  "private": true,
  "description": "Repository compatibility entry for mio-agent-runtime",
  "type": "commonjs",
  "bin": {
    "mio": "mio.js"
  },
  "scripts": {
    "check": "node --check mio.js"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Mark the root MCP package as compatibility-only**

Keep the existing name and version in `server/mio-intelligence-mcp/package.json`, add `"private": true`, and change the description to:

```json
"description": "Repository compatibility entry for mio-agent-runtime MCP"
```

- [ ] **Step 3: Replace the root CLI README with compatibility guidance**

Set `cli/README.md` to:

```markdown
# Mio Runtime Compatibility Entry

The published Mio Agent Runtime lives in `packages/mio-cli`.
This directory remains only for repository scripts that still invoke
`node cli/mio.js`.

Use the canonical package during development:

```powershell
node packages/mio-cli/bin/mio.js --help
npm run check --workspace mio-agent-runtime
npm pack --dry-run --workspace mio-agent-runtime
```

The compatibility invocation is still supported:

```powershell
node cli/mio.js --help
```

Do not add runtime behavior to this directory. Changes belong under
`packages/mio-cli`.
```

- [ ] **Step 4: Replace the root MCP README with a compatibility note**

Set `server/mio-intelligence-mcp/README.md` to:

```markdown
# Mio MCP Compatibility Entry

The maintained MCP implementation and full documentation live in
`packages/mio-cli/server/mio-intelligence-mcp`.

This directory is retained for repository consumers that still launch:

```text
node server/mio-intelligence-mcp/index.js
```

The entry delegates to the canonical `mio-agent-runtime` implementation.
Do not add MCP behavior here.
```

- [ ] **Step 5: Remove the repository-specific worktree path from canonical docs**

In `packages/mio-cli/README.md`, change the JSON example's `args` value from the historical worktree path:

```json
"D:/work/code/akemi-mio/.worktrees/mio-agent-enhancement-layer/server/mio-intelligence-mcp/index.js"
```

to a package-relative installation example:

```json
"/absolute/path/to/mio-agent-runtime/server/mio-intelligence-mcp/index.js"
```

Leave the surrounding environment variable and context example unchanged.

- [ ] **Step 6: Run focused documentation and syntax checks**

Run:

```powershell
node --check cli/mio.js
node --check adapters/codex.js
node --check adapters/opencode.js
node --check adapters/workbuddy.js
node --check server/mio-intelligence-mcp/index.js
node --check server/mio-intelligence-mcp/phase0.js
```

Expected: all commands exit with code 0 and print no syntax errors.

- [ ] **Step 7: Commit metadata and documentation**

```powershell
git add cli/package.json cli/README.md server/mio-intelligence-mcp/package.json server/mio-intelligence-mcp/README.md packages/mio-cli/README.md
git commit -m "docs: identify mio runtime compatibility entries"
```

### Task 4: Run Full Runtime Verification

**Files:**
- No source changes expected. Only verification output is inspected.

- [ ] **Step 1: Run the package JavaScript syntax check**

Run:

```powershell
npm run check --workspace mio-agent-runtime
```

Expected: exit code 0 with all canonical CLI, adapter, MCP, Phase 0, and observer files accepted by `node --check`.

- [ ] **Step 2: Run all canonical MCP tests**

Run:

```powershell
node --test packages/mio-cli/server/mio-intelligence-mcp/__tests__
```

Expected: all existing MCP tests pass with zero failures.

- [ ] **Step 3: Run the compatibility tests again**

Run:

```powershell
node --test packages/mio-cli/__tests__/entry-point-convergence.test.js
```

Expected: all root-to-canonical compatibility tests pass.

- [ ] **Step 4: Exercise the CLI with an isolated home**

Run:

```powershell
$tempHome = Join-Path ([System.IO.Path]::GetTempPath()) ("mio-runtime-smoke-" + [guid]::NewGuid().ToString("N"))
$env:MIO_HOME = $tempHome
node packages/mio-cli/bin/mio.js init
node packages/mio-cli/bin/mio.js --json status
node cli/mio.js --json agents
Remove-Item -LiteralPath $tempHome -Recurse -Force
Remove-Item Env:MIO_HOME
```

Expected: `init` creates the isolated home, `status` reports an existing canonical MCP server path, and the root compatibility CLI returns valid JSON for `agents`. The commands must not write to the user's default home.

- [ ] **Step 5: Inspect the package contents without publishing**

Run:

```powershell
npm pack --dry-run --workspace mio-agent-runtime
```

Expected: the output includes `bin/mio.js`, `adapters/`, `observe/`, and `server/`, excludes `server/mio-intelligence-mcp/__tests__/`, and does not include root `cli/`, root `adapters/`, or unrelated root `server/` files.

- [ ] **Step 6: Confirm the final working tree**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors, no generated smoke-test files, and only the intended committed changes are present.

- [ ] **Step 7: Commit any verification-only correction**

If a verification command exposes an implementation defect, add a focused
failing test in `packages/mio-cli/__tests__/entry-point-convergence.test.js`,
fix the smallest implementation surface listed in the File Map, rerun the
affected command, and commit the exact changed paths:

```powershell
git add packages/mio-cli/__tests__/entry-point-convergence.test.js cli/mio.js adapters/codex.js adapters/opencode.js adapters/workbuddy.js server/mio-intelligence-mcp/index.js server/mio-intelligence-mcp/phase0.js
git commit -m "fix: complete mio runtime convergence verification"
```
