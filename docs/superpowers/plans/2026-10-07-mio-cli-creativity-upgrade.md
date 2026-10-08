# Mio CLI Creativity Upgrade (publish packages + idea.generate + auto sources + novelty sort) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@akemi-mio/core@0.1.0` and `@akemi-mio/creativity@0.1.0` to npm and ship three capabilities on `mio-agent-runtime` 0.14.0: `mio.idea.generate` (goal-driven, LLM-backed, persisted as draft with provenance), source auto-aggregation for both generate paths, and `mio creativity list --sort novelty` with the inline `evaluateNovelty` duplicate deleted.

**Architecture:** The real `packages/creativity` source becomes a first-time published package (CJS build via `tsconfig.build.json`, subpath-only `exports` whitelist); `mio-cli` consumes it through `node_modules` junctions (the same mechanism already used for `@akemi-mio/insight`). Capability modules are wired into the existing seams: `server/creativity-engine.js` (novelty scorer + list sort), a new `server/creativity-sources.js` (providers + top-up), a new `server/idea-generate.js` (one-shot pipeline shared by CLI and MCP).

**Tech Stack:** TypeScript 5.8 (node16 module emit → CJS), `node:test` for `packages/mio-cli`, vitest (root, `tests/main/**`), PowerShell 5.1 host, npm registry publish.

**Spec:** `docs/superpowers/specs/2026-10-07-mio-cli-creativity-upgrade-design.md` (approved, `daf292a`). This plan implements it verbatim; deviations are called out inline.

---

## Ground rules for this repo (read before doing anything)

1. **Shell is PowerShell 5.1 on Windows.** No `&&`, no `head`/`grep`. Chain with `; if ($?) { ... }`. `node -e "..."` misbehaves — write a temp `.js` file and run `node file.js`.
2. **Commits:** messages without BOM, via temp file:
   `[System.IO.File]::WriteAllText($p,$msg,(New-Object System.Text.UTF8Encoding($false))); git commit -F $p`
   Commit after every task. **Never push** (pending local commits exist; push needs `git -c http.proxy= -c https.proxy= push` and explicit user approval).
3. **Build before test.** Root vitest and `node:test` both resolve `@akemi-mio/creativity/*` through junctions to `dist/`. Gate order is always: build core → build creativity → link → tests.
4. **Do not run bare `npm install` at repo root** (root workspace links are broken by history; use `npm install --package-lock-only` if a lockfile update is ever required).
5. **`mio.idea.generate` budget:** `HypothesisGenerator.tryLLM` sends at most 3 combos per LLM call, so `numIdeas` is clamped 1–3. Documented everywhere as `--num N (1-3, default 3)`.
6. **Publishing (Task 17) requires explicit user approval first**, and `mio-intelligence_mio_policy_check` must be called before any `npm publish`.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/mio-cli/scripts/link-workspace.cjs` | create | Idempotent junctions: `mio-cli/node_modules/@akemi-mio/creativity` → `packages/creativity`, `packages/creativity/node_modules/@akemi-mio/core` → `packages/core`, plus root `node_modules/@akemi-mio/{creativity,core}` → `packages/*` (root vitest resolution) |
| `packages/core/tsconfig.build.json` | create | Standalone CJS build (node16), does NOT extend `tsconfig.base.json` |
| `packages/core/package.json` | modify | `build`/`prepublishOnly`, `main`/`types` → `dist`, `files:["dist"]`, `exports` whitelist `.`, `./logger/*`, `./utils/*`, `./package.json` |
| `packages/creativity/tsconfig.build.json` | create | Partial build: `files` = 4 entrypoints (tsc follows the import graph; db chain unreachable) |
| `packages/creativity/package.json` | modify | Same pattern; `exports` whitelist only `./IdeaGenerator`, `./SourceAggregator`, `./NoveltyScorer`, `./types` (no `.`); `dependencies: { "@akemi-mio/core": "^0.1.0" }` |
| `packages/creativity/src/types.ts` | modify | `CreativitySource` + `origin/originId/confidence/timestamp`; `Hypothesis` + `technique?` |
| `packages/creativity/src/CreativityPrompt.ts` | modify | `TECHNIQUE_CYCLE` + `pickTechnique()` + 5 new `METHOD_DESCRIPTIONS` keys; `buildCreativityPrompt` grouped-by-type presentation |
| `packages/creativity/src/HypothesisGenerator.ts` | modify | Thread `method` through `generate → tryLLM/tryLocalModel`; internal rotation default; tag every hypothesis with `technique` |
| `packages/creativity/src/IdeaGenerator.ts` | modify | 4th ctor param `rotationSeed`, 5th `generateIdeas` param `method`, forward both |
| `packages/mio-cli/server/creativity-sources.js` | create | `buildAutoSources`, `topUpSources`, `trendSources` + local providers (spec Capability 2) |
| `packages/mio-cli/server/idea-generate.js` | create | `runIdeaGenerate` one-shot pipeline (spec Capability 1) |
| `packages/mio-cli/server/creativity-engine.js` | modify | Delete inline scorer, require package scorer; `list({sort:'novelty'})` + `noveltyScore`; `sourcesFromInsights` gains origin fields |
| `packages/mio-cli/server/mio-intelligence-mcp/index.js` | modify | TOOLS entry + dispatch case for `mio.idea.generate`; `sort` schema on `mio.creativity.list`; auto-top-up in `generationSources`; export `generationSources` |
| `packages/mio-cli/bin/mio.js` | modify | `idea` command group (`mio idea generate`), `--sort novelty` on `creativity list`, `mio --help` line, usage texts |
| `packages/mio-cli/package.json` | modify | `pretest` link hook; later version `0.14.0` + dep `@akemi-mio/creativity` |
| `scripts/pack-smoke.cjs` | create | Two-stage package API compatibility smoke (local tarballs / registry) |
| `package.json` (root) | modify | `smoke:pack` / `smoke:pack:registry` scripts (Task 15) |
| `package-lock.json` | modify | `npm install --package-lock-only` after the dep declaration (Task 16) |
| `scripts/check-mcp-cli-coverage.cjs` | modify | `MCP_TO_CLI` += `mio.idea.generate` |
| `packages/mio-cli/README.md` | modify | command block, tool list, idea section, deps table, LLM count, workspace-only note |
| `docs/architecture.puml` | modify | Idea card holds the real tool |
| `tests/main/creativity/*.test.ts` | create | Root vitest: prompt grouping, rotation, idea flow, providers, novelty sort |
| `packages/mio-cli/__tests__/idea-generate.test.js` | create | Pipeline + CLI arg tests (fake chatJson) |
| `packages/mio-cli/__tests__/creativity-autosources.test.js` | create | Top-up seam: auto sources injected only when short (Task 10) |
| `packages/mio-cli/__tests__/creativity-list-sort.test.js` | create | Engine/CLI `--sort novelty` |
| `packages/mio-cli/server/mio-intelligence-mcp/__tests__/creativity.test.js` | modify | schema + top-up + idea.generate surface |

---

### Task 0: Execution preamble (only after this plan is approved)

**Trigger:** the user has explicitly approved this plan. Nothing below runs before that.

- [x] **taskhub:** `taskhub_get_task 781ad045` → `taskhub_claim`（**必须传 `task_id=781ad045`**）→ 对 claim 返回的每个 `kind` 调 `taskhub_read_document(task_id, kind, run_id=<claim 返回>)` 产生 ReadEvidence → 需要时 `taskhub_heartbeat(run_id)` 保活。缺 ReadEvidence 时 `taskhub_submit_result` 会 422。
- [x] **doc lifecycle:** pre-push 钩子要求 spec/api/plan 达到 `approved`。spec 已 approved；若 plan 尚未批准，先 `taskhub_set_doc_status(task_id='781ad045', kind='plan', state='approved')`。
- [x] **branch:** 开工分支命名 `task-781ad045`（若尚不存在则 `git checkout -b task-781ad045`）。

---

### Task 1: Workspace link script + pretest hook

**Files:**
- Create: `packages/mio-cli/scripts/link-workspace.cjs`
- Modify: `packages/mio-cli/package.json`

- [x] **Step 1: Create the link script**

```js
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
```

- [x] **Step 2: Wire the pretest hook**

In `packages/mio-cli/package.json`, add to `scripts` (keep every existing entry):

```json
"pretest": "node scripts/link-workspace.cjs",
```

- [x] **Step 3: Verify idempotency and resolution**

Run (PowerShell):

```powershell
node packages/mio-cli/scripts/link-workspace.cjs; node packages/mio-cli/scripts/link-workspace.cjs
```

Expected: first run prints four `linked` lines, second prints four `exists` lines, exit 0.

Then create `tmp-resolve-check.js` in the repo root:

```js
const path = require('path')
const req = require('module').createRequire(path.join(process.cwd(), 'packages', 'mio-cli', 'bin', 'mio.js'))
const rootReq = require('module').createRequire(path.join(process.cwd(), 'package.json'))
console.log(req.resolve('@akemi-mio/creativity/package.json'))
console.log(req.resolve('@akemi-mio/core/package.json'))
console.log(rootReq.resolve('@akemi-mio/creativity/package.json'))
console.log(rootReq.resolve('@akemi-mio/core/package.json'))
```

Run `node tmp-resolve-check.js` — it must print four paths under `packages\` (the root links are what let root vitest resolve `@akemi-mio/creativity/*`). Package roots resolve before any build exists; subpaths come in Tasks 2–3. Delete the temp file.

- [x] **Step 4: Commit**

```powershell
git add packages/mio-cli/scripts/link-workspace.cjs packages/mio-cli/package.json
# commit message: chore(mio-cli): link workspace creativity/core junctions + pretest hook
```

---

### Task 2: `@akemi-mio/core` first publishable build

**Files:**
- Create: `packages/core/tsconfig.build.json`
- Modify: `packages/core/package.json`

- [x] **Step 1: Create `packages/core/tsconfig.build.json`**

Standalone (NOT extending `tsconfig.base.json`, whose `moduleResolution: bundler` + `composite` cannot emit CJS for npm):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [x] **Step 2: Rewrite `packages/core/package.json`**

```json
{
  "name": "@akemi-mio/core",
  "version": "0.1.0",
  "description": "Core infrastructure: logger, EventBus, config, db, credentials, ipc",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./logger/*": {
      "types": "./dist/logger/*.d.ts",
      "require": "./dist/logger/*.js",
      "default": "./dist/logger/*.js"
    },
    "./utils/*": {
      "types": "./dist/utils/*.d.ts",
      "require": "./dist/utils/*.js",
      "default": "./dist/utils/*.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "npm run build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "engines": { "node": ">=18" },
  "license": "MIT",
  "dependencies": {},
  "devDependencies": {}
}
```

Notes: `db`/`credentials`/`ipc` subpaths are intentionally NOT exported (spec: npm consumers cannot require them). The root `.` export exists (core's index is the supported entry).

- [x] **Step 3: Build**

```powershell
npm run build --prefix packages/core
```

Expected: exit 0, `packages/core/dist/index.js`, `dist/index.d.ts`, `dist/logger/Logger.js`, `dist/utils/random.js` exist.

If `tsc` reports errors: they are real type errors the root typecheck did not cover. Fix them in `src/` with minimal, targeted changes — **do not** weaken `strict`, do not add `// @ts-nocheck`. If an error is a missing ambient module (e.g. an optional import), add a scoped `declare module` in a new `packages/core/src/types-augment.d.ts` instead of installing anything.

- [x] **Step 4: Verify subpath requires from a junction consumer**

Create `tmp-core-check.js`:

```js
const path = require('path')
const req = require('module').createRequire(path.join(process.cwd(), 'packages', 'mio-cli', 'bin', 'mio.js'))
const random = req('@akemi-mio/core/utils/random')
const logger = req('@akemi-mio/core/logger/Logger')
if (typeof random.resolveRandom !== 'function') throw new Error('utils/random missing resolveRandom')
if (typeof logger.log !== 'function') throw new Error('logger/Logger missing log')
try {
  req('@akemi-mio/core/db/connection')
  throw new Error('db subpath must NOT be exported')
} catch (e) {
  if (/must NOT/.test(e.message)) throw e
}
console.log('core exports OK')
```

Run `node tmp-core-check.js` → `core exports OK`. Delete the temp file.

- [x] **Step 5: Commit**

```powershell
git add packages/core/tsconfig.build.json packages/core/package.json packages/core/src
# commit message: feat(core): first publishable build — CJS dist, subpath exports whitelist
```

---

### Task 3: `@akemi-mio/creativity` first publishable (partial) build

**Files:**
- Create: `packages/creativity/tsconfig.build.json`
- Modify: `packages/creativity/package.json`

- [x] **Step 1: Create `packages/creativity/tsconfig.build.json`**

`files` (not `include`) pins the published surface to the four capability entrypoints; tsc follows their import graph automatically, so `db`/`capabilities`/`intelligence-*` never enter `dist`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "files": [
    "src/IdeaGenerator.ts",
    "src/SourceAggregator.ts",
    "src/NoveltyScorer.ts",
    "src/types.ts"
  ]
}
```

`moduleResolution: node16` resolves `@akemi-mio/core/*` through the Task-1 junction + Task-2 `exports` (so core MUST be built first — it is, by task order).

- [x] **Step 2: Rewrite `packages/creativity/package.json`**

```json
{
  "name": "@akemi-mio/creativity",
  "version": "0.1.0",
  "description": "Creativity layer: ideas, writing, blog, image, inspiration",
  "main": "./dist/IdeaGenerator.js",
  "types": "./dist/IdeaGenerator.d.ts",
  "exports": {
    "./IdeaGenerator": {
      "types": "./dist/IdeaGenerator.d.ts",
      "require": "./dist/IdeaGenerator.js",
      "default": "./dist/IdeaGenerator.js"
    },
    "./SourceAggregator": {
      "types": "./dist/SourceAggregator.d.ts",
      "require": "./dist/SourceAggregator.js",
      "default": "./dist/SourceAggregator.js"
    },
    "./NoveltyScorer": {
      "types": "./dist/NoveltyScorer.d.ts",
      "require": "./dist/NoveltyScorer.js",
      "default": "./dist/NoveltyScorer.js"
    },
    "./types": {
      "types": "./dist/types.d.ts",
      "require": "./dist/types.js",
      "default": "./dist/types.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "npm run build"
  },
  "engines": { "node": ">=18" },
  "license": "MIT",
  "dependencies": {
    "@akemi-mio/core": "^0.1.0"
  }
}
```

The root entry is deliberately absent from `exports` (spec: its index chain reaches db storage) — bare `require('@akemi-mio/creativity')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which is the intended contract.

- [x] **Step 3: Build**

```powershell
npm run build --prefix packages/creativity
```

Expected: exit 0; `dist/` contains `IdeaGenerator.js`, `SourceAggregator.js`, `NoveltyScorer.js`, `types.js`, `CreativityPrompt.js`, `HypothesisGenerator.js`, `ConceptMixer.js`, `ExperimentPlanner.js`, `TemplateLibrary.js`, `LocalModelService.js` + `.d.ts` — and **no** `db`/`capabilities`/`index.js`.

- [x] **Step 4: Verify subpath requires + root refusal**

Create `tmp-cre-check.js`:

```js
const path = require('path')
const req = require('module').createRequire(path.join(process.cwd(), 'packages', 'mio-cli', 'bin', 'mio.js'))
const { IdeaGenerator } = req('@akemi-mio/creativity/IdeaGenerator')
const { SourceAggregator } = req('@akemi-mio/creativity/SourceAggregator')
const { evaluateNovelty } = req('@akemi-mio/creativity/NoveltyScorer')
if (typeof IdeaGenerator !== 'function') throw new Error('IdeaGenerator not a class')
if (typeof SourceAggregator !== 'function') throw new Error('SourceAggregator not a class')
if (typeof evaluateNovelty !== 'function') throw new Error('evaluateNovelty missing')
if (evaluateNovelty({ title: 'a', idea: 'b', novelty: 50 }, [], []).shouldReject !== false) throw new Error('evaluateNovelty broken')
try {
  req('@akemi-mio/creativity')
  throw new Error('root entry must NOT be exported')
} catch (e) {
  if (/root entry/.test(e.message)) throw e
}
console.log('creativity exports OK')
```

Run → `creativity exports OK`. Delete temp file.

- [x] **Step 5: Commit**

```powershell
git add packages/creativity/tsconfig.build.json packages/creativity/package.json packages/creativity/dist 2>$null
# note: dist is git-ignored — stage only the two config files
git add packages/creativity/tsconfig.build.json packages/creativity/package.json
# commit message: feat(creativity): first publishable build — 4-entrypoint partial CJS dist, subpath exports
```

---

### Task 4: `types.ts` provenance fields + `technique`

**Files:**
- Modify: `packages/creativity/src/types.ts`
- Test: `tests/main/creativity/source-provenance.test.ts` (new)

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import type { CreativitySource, Hypothesis } from '@akemi-mio/creativity/types'

describe('creativity source provenance fields', () => {
  it('accepts origin/originId/confidence/timestamp', () => {
    const s: CreativitySource = {
      name: 'decision: use local model',
      content: '…',
      type: 'feedback',
      weight: 0.75,
      origin: 'memory:mem_1',
      originId: 'mem_1',
      confidence: 0.9,
      timestamp: '2026-10-07T00:00:00.000Z',
    }
    expect(s.origin).toBe('memory:mem_1')
  })

  it('keeps legacy sources legal without the new fields', () => {
    const s: CreativitySource = { name: 'a', content: 'b', type: 'knowledge', weight: 0.5 }
    expect(s.origin).toBeUndefined()
  })

  it('records the rotation technique on a hypothesis', () => {
    const h = { id: 'hyp_1', title: 't', idea: 'i', expectedBenefit: '', risk: '', sourceLabels: [], novelty: 50, feasibility: 50, impact: 50, status: 'draft', createdAt: 1 } as Hypothesis
    h.technique = 'SCAMPER'
    expect(h.technique).toBe('SCAMPER')
  })

  it('records idea.generate provenance on a hypothesis', () => {
    const h = { id: 'hyp_2', title: 't', idea: 'i', expectedBenefit: '', risk: '', sourceLabels: [], novelty: 50, feasibility: 50, impact: 50, status: 'draft', createdAt: 1 } as Hypothesis
    h.provenance = {
      strategy: 'stable',
      technique: 'SCAMPER',
      relatedMemoryIds: ['mem_1'],
      sources: [{ name: 'goal: lower MCP latency', type: 'knowledge', origin: 'goal', timestamp: '2026-10-07T00:00:00.000Z' }],
      generatedAt: '2026-10-07T00:00:00.000Z',
    }
    expect(h.provenance.strategy).toBe('stable')
    expect(h.provenance.technique).toBe('SCAMPER')
  })
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npx vitest run tests/main/creativity/source-provenance.test.ts
```

Expected: FAIL — `Property 'origin' does not exist on type 'CreativitySource'` (type errors surface as test file compile failure).

- [x] **Step 3: Implement — extend the interfaces in `types.ts`**

In `packages/creativity/src/types.ts`, replace the `CreativitySource` interface (currently lines 9–16) with:

```ts
export interface CreativitySource {
  name: string
  content: string
  fullContent?: string
  sourceDepth?: 'shallow' | 'medium' | 'full'
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random' | 'provocation' | 'feedback'
  weight: number
  /** Provider + record id, e.g. `memory:mem_1791…`. Required on auto-aggregated sources (spec Capability 2). */
  origin?: string
  /** Original record id for back-referencing. */
  originId?: string
  /** 0-1 credibility hint; omit when unknowable. */
  confidence?: number
  /** Source record time, ISO 8601. */
  timestamp?: string
}
```

Directly after `CreativitySource`, add:

```ts
/** Where and how an idea.generate result was produced (spec Capability 1). */
export interface HypothesisProvenance {
  /** Pairing strategy used to build source combos: explore | stable | signal. */
  strategy?: string
  /** Rotation technique used for the prompt (mirrors `Hypothesis.technique`). */
  technique?: string
  /** Memory record ids that grounded the goal (0-3, newest first). */
  relatedMemoryIds?: string[]
  /** Assembled sources that fed generation, filtered to the labels actually used. */
  sources?: Array<{ name: string; type: string; origin?: string; timestamp?: string }>
  /** When the idea was generated, ISO 8601. */
  generatedAt?: string
}
```

In the `Hypothesis` interface (line 47 block), add after `createdAt: number`:

```ts
  /** The rotation technique this hypothesis was generated with (idea.generate provenance.technique). */
  technique?: string
  /** Idea-generation provenance; `mio.idea.generate` persists this with the record. */
  provenance?: HypothesisProvenance
```

- [x] **Step 4: Run and see it pass**

```powershell
npx vitest run tests/main/creativity/source-provenance.test.ts
npm run typecheck:node
```

Expected: PASS + typecheck exit 0 (interface additions are additive; nothing else references them yet).

- [x] **Step 5: Commit**

```powershell
git add packages/creativity/src/types.ts tests/main/creativity/source-provenance.test.ts
# commit message: feat(creativity): provenance fields on sources, technique on hypotheses
```

---

### Task 5: Technique rotation + grouped prompt presentation (`CreativityPrompt.ts`)

**Files:**
- Modify: `packages/creativity/src/CreativityPrompt.ts`
- Test: `tests/main/creativity/creativity-prompt.test.ts` (new)

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { buildCreativityPrompt, buildSystemPrompt, pickTechnique, TECHNIQUE_CYCLE } from '@akemi-mio/creativity/CreativityPrompt'

describe('technique rotation', () => {
  it('cycles the five 0.5.2 techniques', () => {
    expect(TECHNIQUE_CYCLE).toEqual(['SCAMPER', 'Analogy', 'First-Principles', 'Random-Stimulus', 'Constraint-Inversion'])
    expect(pickTechnique(0)).toBe('SCAMPER')
    expect(pickTechnique(1)).toBe('Analogy')
    expect(pickTechnique(5)).toBe('SCAMPER')
    expect(pickTechnique(-1)).toBe('Constraint-Inversion')
  })

  it('every technique has a description in the system prompt', () => {
    for (const technique of TECHNIQUE_CYCLE) {
      const prompt = buildSystemPrompt(technique)
      expect(prompt).toContain(`【本轮创新技法：${technique}】`)
      expect(prompt.length).toBeGreaterThan(500)
    }
    expect(buildSystemPrompt()).not.toContain('【本轮创新技法')
  })
})

describe('grouped source presentation', () => {
  const sources = [
    { name: 'decision: use local model', content: '内容A', type: 'knowledge' as const, weight: 0.8, origin: 'memory:mem_1' },
    { name: 'trace: error in collect', content: '内容B', type: 'failure' as const, weight: 0.7, origin: 'trace:t_1', timestamp: '2026-10-07T00:00:00.000Z' },
    { name: 'insight: LLM latency', content: '内容C', type: 'insight' as const, weight: 0.7, origin: 'insight:i_1' },
    { name: 'decision: adopt X', content: '内容D', type: 'knowledge' as const, weight: 0.75, origin: 'memory:mem_2' },
  ]

  it('groups sources under evidence-class headers, prefixed per line', () => {
    const prompt = buildCreativityPrompt(sources, [{ sources: ['decision: use local model', 'trace: error in collect'], description: 'x' }])
    expect(prompt).toContain('【fact · knowledge】')
    expect(prompt).toContain('【failure · failure】')
    expect(prompt).toContain('【observation · insight】')
    expect(prompt).toContain('- [fact] decision: use local model (memory:mem_1): 内容A')
    expect(prompt).toContain('- [failure] trace: error in collect (trace:t_1 @2026-10-07T00:00:00.000Z): 内容B')
    // failure group must not leak knowledge sources
    const failureGroup = prompt.split('【failure · failure】')[1]?.split('【')[0] ?? ''
    expect(failureGroup).not.toContain('decision: adopt X')
    // stable order: fact group comes before failure group
    expect(prompt.indexOf('【fact · knowledge】')).toBeLessThan(prompt.indexOf('【failure · failure】'))
  })

  it('keeps the combo block intact', () => {
    const prompt = buildCreativityPrompt(sources, [{ sources: ['decision: use local model', 'trace: error in collect'], description: '协同机制' }])
    expect(prompt).toContain('【推荐配对组合】')
    expect(prompt).toContain('decision: use local model × trace: error in collect — 协同机制')
  })
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npx vitest run tests/main/creativity/creativity-prompt.test.ts
```

Expected: FAIL — `TECHNIQUE_CYCLE`/`pickTechnique` not exported; grouped headers absent.

- [x] **Step 3: Implement**

In `packages/creativity/src/CreativityPrompt.ts`:

(a) Replace the source-lines part of `buildCreativityPrompt` (line 123):

```ts
  const sourceLines = sources.map((s) => `  [${s.type}] ${s.name}: ${clip(s.content, 600)}`).join('\n')
  sections.push(`【可用概念来源】\n${sourceLines}`)
```

with:

```ts
  sections.push(`【可用概念来源 — 按证据类型分组】\n${buildSourceBlock(sources)}`)
```

(b) Add the helpers above `buildCreativityPrompt`:

```ts
/** Evidence-class label shown to the LLM (spec Capability 2 presentation contract). */
const TYPE_LABELS: Record<string, string> = {
  knowledge: 'fact',
  behavior: 'trace',
  insight: 'observation',
  failure: 'failure',
  feedback: 'experience',
  random: 'random',
  provocation: 'provocation',
}

/** Stable group order — facts first, provocations last. */
const TYPE_ORDER = ['knowledge', 'behavior', 'feedback', 'insight', 'failure', 'provocation', 'random']

/** Group sources by `type`, prefix every line with its evidence label and append provenance metadata. */
function buildSourceBlock(sources: CreativitySource[]): string {
  const byType = new Map<string, CreativitySource[]>()
  for (const s of sources) {
    const list = byType.get(s.type) ?? []
    list.push(s)
    byType.set(s.type, list)
  }
  const groups: string[] = []
  for (const type of TYPE_ORDER) {
    const list = byType.get(type)
    if (!list || list.length === 0) continue
    const label = TYPE_LABELS[type] || type
    const lines = list.map((s) => {
      const meta = [s.origin, s.timestamp].filter(Boolean).join(' @')
      return `  - [${label}] ${s.name}${meta ? ` (${meta})` : ''}: ${clip(s.content, 600)}`
    })
    groups.push(`【${label} · ${type}】\n${lines.join('\n')}`)
  }
  return groups.join('\n\n')
}
```

(c) After the existing `METHOD_DESCRIPTIONS` object (line 97–105 block), append the five-technique rotation (spec: from the 0.5.2 table; the seven SCAMPER sub-keys above stay untouched for backward compatibility):

```ts
/** The five techniques mio.idea.generate rotates through (0.5.2 table). */
export const TECHNIQUE_CYCLE = [
  'SCAMPER',
  'Analogy',
  'First-Principles',
  'Random-Stimulus',
  'Constraint-Inversion',
] as const

Object.assign(METHOD_DESCRIPTIONS, {
  SCAMPER: '综合使用 SCAMPER 七问（替代/组合/适应/修改/另作他用/消除/重排）逐项审视两个来源，挑出最有产出的一问作为方案主轴。',
  Analogy: '类比迁移：找出两个来源之外、结构上同构的成熟系统/自然机制，把它的解法迁移到当前组合上，并说明结构对应关系。',
  'First-Principles': '第一性原理：剥掉两个来源的既有实现假设，回到最底层的事实与约束重新推导方案，明确哪些步骤是被传统做法掩盖的。',
  'Random-Stimulus': '随机刺激：引入一个与两来源无关的外部概念（随便挑一个真实存在的产品/生物机制），强制建立连接并解释其合理性。',
  'Constraint-Inversion': '约束反转：把当前方案默认成立的约束（预算/延迟/顺序）反过来假设成立，构造在反转约束下依然成立的方案。',
})

/** Deterministic rotation: seed with the stored-hypothesis count so CLI and MCP cycles agree across processes. */
export function pickTechnique(seed: number): string {
  const idx = Math.abs(Math.floor(seed)) % TECHNIQUE_CYCLE.length
  return TECHNIQUE_CYCLE[idx]
}
```

> **Deviation (executed):** the snippet above contradicts this task's own test (`pickTechnique(-1)` must be `Constraint-Inversion`, but `Math.abs(-1)%5 === 1` → `Analogy`). Implemented wrap-around modulo `((Math.floor(seed) % len) + len) % len` instead, which satisfies every test case (0→SCAMPER, 1→Analogy, 5→SCAMPER, -1→Constraint-Inversion).

- [x] **Step 4: Run and see it pass**

```powershell
npx vitest run tests/main/creativity/creativity-prompt.test.ts
npm run typecheck:node
```

Expected: PASS, typecheck 0.

- [x] **Step 5: Commit**

```powershell
git add packages/creativity/src/CreativityPrompt.ts tests/main/creativity/creativity-prompt.test.ts
# commit message: feat(creativity): five-technique rotation + evidence-class grouped prompt
```

---

### Task 6: `HypothesisGenerator` method threading + technique tagging

**Files:**
- Modify: `packages/creativity/src/HypothesisGenerator.ts`
- Test: `tests/main/creativity/hypothesis-method.test.ts` (new)

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { HypothesisGenerator } from '@akemi-mio/creativity/HypothesisGenerator'

const idea = {
  title: '想法标题长度正常',
  idea: '完整因果链条描述：前提 -> 机制 -> 结果，长度超过二十个字符以通过门禁',
  expectedBenefit: '收益',
  risk: '风险',
  novelty: 70,
  feasibility: 60,
  impact: 65,
  relevance: '两个来源通过缓存失效机制协同',
  sourceLabels: ['goal', 'auto'],
}

function capturingChat() {
  const calls: Array<{ system?: string; user: string }> = []
  const chatJson = async (userText: string, opts?: { system?: string }) => {
    calls.push({ system: opts?.system, user: userText })
    return { data: [idea] }
  }
  return { chatJson, calls }
}

const sources = () => [
  { name: 'goal', content: 'g', type: 'knowledge' as const, weight: 0.95, origin: 'goal' },
  { name: 'auto', content: 'a', type: 'feedback' as const, weight: 0.75, origin: 'memory:m1' },
]
const combos = () => [{ id: 'c1', sources: ['goal', 'auto'] as [string, string], description: 'd', createdAt: 1 }]

describe('HypothesisGenerator method threading', () => {
  it('defaults to the rotation technique and tags the hypothesis', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    const out = await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('【本轮创新技法：SCAMPER】')
    expect(out[0].technique).toBe('SCAMPER')
    expect(out[0].status).toBe('draft')
  })

  it('honours rotationSeed so a later seed rotates', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 1)
    await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('【本轮创新技法：Analogy】')
  })

  it('an explicit method wins over the rotation', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    const out = await gen.generate(combos(), sources(), false, [], 'Constraint-Inversion')
    expect(calls[0].system).toContain('【本轮创新技法：Constraint-Inversion】')
    expect(out[0].technique).toBe('Constraint-Inversion')
  })

  it('repeated calls advance the rotation within one instance', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    await gen.generate(combos(), sources())
    await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('SCAMPER')
    expect(calls[1].system).toContain('Analogy')
  })
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npx vitest run tests/main/creativity/hypothesis-method.test.ts
```

Expected: FAIL — `generate` takes 4 arguments / constructor takes 2 / `technique` not set.

- [x] **Step 3: Implement**

In `packages/creativity/src/HypothesisGenerator.ts`:

(a) Import `buildSystemPrompt` and `pickTechnique` — line 2 becomes:

```ts
import { CREATIVITY_SYSTEM_PROMPT, buildCreativityPrompt, buildSystemPrompt, pickTechnique } from './CreativityPrompt'
```

(b) Class state + constructor (lines 14–35): add `private rotationSeed = 0`, `private callCount = 0`; constructor gains a third parameter:

```ts
  constructor(
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string; maxTokens?: number },
    ) => Promise<{ data?: any; error?: string }>,
    seed?: number,
    rotationSeed = 0,
  ) {
    this.chatJson = chatJson
    this.rng = resolveRandom(seed)
    this.templateLib = new TemplateLibrary(seed)
    this.localModel = new LocalModelService()
    this.rotationSeed = rotationSeed
  }
```

(c) `generate` signature (line 46) gains the 5th param and resolves the technique once:

```ts
  async generate(
    combos: ConceptCombo[],
    sources: CreativitySource[],
    /** 梦境模式使用更高温度 */
    dreamMode = false,
    /** 外部信号 — 不参与配对，作为审视视角注入 LLM */
    externalSignals: ExternalSignal[] = [],
    /** 显式技法；缺省走五技法轮换（rotationSeed + 调用次数） */
    method?: string,
  ): Promise<Hypothesis[]> {
    if (combos.length === 0) return []
    const technique = method ?? pickTechnique(this.rotationSeed + this.callCount)
    this.callCount += 1
```

(d) Forward `technique` to the first two levels — line 57 becomes
`const llmResults = await this.tryLLM(sources, combos, dreamMode, externalSignals, technique)`
and line 78 becomes
`const localResults = await this.tryLocalModel(sources, combos, dreamMode, technique)`.

(e) Tag every return path. Add a private helper next to `hasRelevanceJustification`:

```ts
  /** 记录本轮使用的轮换技法（idea.generate 的 provenance.technique 字段写它）。 */
  private tag(hypotheses: Hypothesis[], technique: string): Hypothesis[] {
    return hypotheses.map((h) => ({ ...h, technique }))
  }
```

and wrap the four return sites of `generate`:

- LLM path (line 58): `return this.tag(llmResults.map((r) => ({ ... })), technique)`
- local path (line 80): `return this.tag(localResults.map((r) => ({ ... })), technique)`
- template path (line 106): `return this.tag(tplResults, technique)`
- legacy fallback (line 112): `return this.tag(combos.map((combo) => this.templateFallback(combo)), technique)`

(f) `tryLLM` signature (line 118) gains `technique: string` as last param; line 146–155 becomes:

```ts
    const prompt = buildCreativityPrompt(sources, comboInfo, externalSignals)

    try {
      const result = await this.chatJson(prompt, {
        system: buildSystemPrompt(technique),
        temperature: dreamMode ? 1.0 : 0.8,
        timeoutMs: 60000,
        maxTokens: 1200,
      })
```

(g) `tryLocalModel` (line 181) gains `technique: string` as last param; line 207 becomes `system: buildSystemPrompt(technique)`.

(`CREATIVITY_SYSTEM_PROMPT` stays imported: it is a public export of `CreativityPrompt` and other consumers may hold it.)

- [x] **Step 4: Run and see it pass**

```powershell
npx vitest run tests/main/creativity/hypothesis-method.test.ts tests/main/creativity/creativity-prompt.test.ts
npm run typecheck:node
```

Expected: PASS, typecheck 0.

- [x] **Step 5: Commit**

```powershell
git add packages/creativity/src/HypothesisGenerator.ts tests/main/creativity/hypothesis-method.test.ts
# commit message: feat(creativity): thread prompt method through generation, tag technique on hypotheses
```

---

### Task 7: `IdeaGenerator` goal-flow (rotation seed + method forward)

**Files:**
- Modify: `packages/creativity/src/IdeaGenerator.ts`
- Test: `tests/main/creativity/idea-generator.test.ts` (new)

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { IdeaGenerator } from '@akemi-mio/creativity/IdeaGenerator'

const idea = {
  title: '把 grounding 记忆接入生成回路',
  idea: '前提：记忆库已有相似决策；机制：作为约束注入配对；结果：避免重复踩坑，链条完整超过二十字符',
  expectedBenefit: '复用历史决策',
  risk: '记忆过时',
  novelty: 72,
  feasibility: 61,
  impact: 66,
  relevance: 'goal 与历史决策通过约束注入机制协同',
  sourceLabels: ['goal', 'decision: use local model'],
}

function stubChat() {
  const calls: Array<{ system?: string }> = []
  const chatJson = async (_u: string, opts?: { system?: string }) => {
    calls.push({ system: opts?.system })
    return { data: [idea] }
  }
  return { chatJson, calls }
}

const goalSources = () => [
  { name: 'goal', content: 'reduce MCP latency', type: 'knowledge' as const, weight: 0.95, origin: 'goal' },
  { name: 'decision: use local model', content: '本地模型推理', type: 'feedback' as const, weight: 0.75, origin: 'memory:m1', timestamp: '2026-10-07T00:00:00.000Z' },
]

describe('IdeaGenerator goal-driven flow', () => {
  it('returns gated ideas with experiment + technique, from a stub LLM', async () => {
    const { chatJson, calls } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas(goalSources(), 3, 'explore', [])
    expect(ideas.length).toBe(1)
    expect(ideas[0].hypothesis.status).toBe('draft')
    expect(ideas[0].hypothesis.technique).toBe('SCAMPER')
    expect(ideas[0].experiment).toBeTruthy()
    expect(ideas[0].experiment!.steps.length).toBeGreaterThan(0)
    expect(calls[0].system).toContain('【本轮创新技法：SCAMPER】')
  })

  it('rotationSeed propagates from the IdeaGenerator constructor', async () => {
    const { chatJson, calls } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 3)
    await gen.generateIdeas(goalSources(), 3, 'explore', [])
    expect(calls[0].system).toContain('【本轮创新技法：Random-Stimulus】')
  })

  it('needs at least two sources', async () => {
    const { chatJson } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas([goalSources()[0]], 3, 'explore', [])
    expect(ideas).toEqual([])
  })

  it('drops ideas below the novelty/feasibility gates', async () => {
    const { chatJson } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas(goalSources(), 3, 'explore', [])
    // stub novelty 72 / feasibility 61 clear both gates
    expect(ideas.length).toBeGreaterThan(0)
    const weak = await new IdeaGenerator(async () => ({ data: [{ ...idea, feasibility: 10 }] }), 0.5, undefined, 0)
      .generateIdeas(goalSources(), 3, 'explore', [])
    expect(weak).toEqual([])
  })
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npx vitest run tests/main/creativity/idea-generator.test.ts
```

Expected: FAIL — constructor rejects the 4th argument (`Expected 1-3 arguments`) / `technique` undefined.

- [x] **Step 3: Implement**

In `packages/creativity/src/IdeaGenerator.ts`:

(a) Constructor (lines 28–41) gains a 4th parameter and forwards it:

```ts
  constructor(
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>,
    temperature = 0.3,
    seed?: number,
    rotationSeed = 0,
  ) {
    this.rng = resolveRandom(seed)
    this.mixer = new ConceptMixer(seed)
    this.hypothesisGen = new HypothesisGenerator(chatJson, seed, rotationSeed)
    this.experimentPlanner = new ExperimentPlanner(seed)
    this.temperature = temperature
  }
```

(b) `generateIdeas` (line 47) gains a 5th parameter and forwards it at line 65:

```ts
  async generateIdeas(
    sources: CreativitySource[],
    maxIdeas = 5,
    strategy: Strategy = 'explore',
    externalSignals: ExternalSignal[] = [],
    method?: string,
  ): Promise<CreativeIdea[]> {
```

line 65 becomes:

```ts
    const hypotheses = await this.hypothesisGen.generate(combos, activeSources, false, externalSignals, method)
```

- [x] **Step 4: Run and see it pass**

```powershell
npx vitest run tests/main/creativity/
npm run typecheck:node
```

Expected: all `tests/main/creativity/*` PASS, typecheck 0.

- [x] **Step 5: Commit**

```powershell
git add packages/creativity/src/IdeaGenerator.ts tests/main/creativity/idea-generator.test.ts
# commit message: feat(creativity): IdeaGenerator accepts rotationSeed + explicit method
```

---

### Task 8: `server/creativity-sources.js` — providers + top-up seam

**Files:**
- Create: `packages/mio-cli/server/creativity-sources.js`
- Modify: `packages/mio-cli/server/creativity-engine.js` (small: export `isoOf`, origin fields on `sourcesFromInsights`, weight 0.78)
- Test: `tests/main/creativity/creativity-sources.test.ts` (new)

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildAutoSources, topUpSources, trendSources } = require('../../../packages/mio-cli/server/creativity-sources.js')
const { sourcesFromInsights } = require('../../../packages/mio-cli/server/creativity-engine.js')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mio-auto-src-'))
  writeFileSync(join(dataDir, 'memory.jsonl'), [
    JSON.stringify({ id: 'mem_d1', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定用本地模型兜底', project: 'p', scope: 'project' }),
    JSON.stringify({ id: 'mem_n1', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '一条普通笔记' }),
    JSON.stringify({ id: 'mem_a1', timestamp: '2026-10-06T03:00:00.000Z', kind: 'decision', content: '已归档决策', archived: true }),
    JSON.stringify({ id: 'mem_t1', timestamp: '2026-10-06T04:00:00.000Z', kind: 'trivia', content: '不是 decision/note' }),
  ].join('\n') + '\n')
  writeFileSync(join(dataDir, 'traces.jsonl'), [
    JSON.stringify({ trace_id: 't1', event_type: 'task_outcome', outcome: 'success', payload: { summary: '任务完成' }, timestamp: '2026-10-06T05:00:00.000Z' }),
    JSON.stringify({ trace_id: 't2', event_type: 'error', payload: { message: 'boom' }, timestamp: '2026-10-06T06:00:00.000Z' }),
  ].join('\n') + '\n')
  mkdirSync(join(dataDir, 'creativity'), { recursive: true })
  writeFileSync(join(dataDir, 'creativity', 'creativity-hypotheses.jsonl'), [
    JSON.stringify({ id: 'hyp_a', title: '旧假设A', idea: '旧想法内容', risk: 'r', status: 'active', createdAt: Date.now() }),
    JSON.stringify({ id: 'hyp_r', title: '被拒假设R', idea: '被拒想法', risk: 'r', status: 'rejected', createdAt: Date.now() }),
    JSON.stringify({ id: 'hyp_d', title: '草稿不该出现', idea: 'd', risk: 'r', status: 'draft', createdAt: Date.now() }),
  ].join('\n') + '\n')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('buildAutoSources', () => {
  it('collects local domains with required provenance fields', () => {
    const sources = buildAutoSources({ dataDir })
    const byOrigin = new Map(sources.map((s: any) => [s.origin, s]))
    expect(byOrigin.get('memory:mem_d1').type).toBe('feedback')
    expect(byOrigin.get('memory:mem_d1').timestamp).toBe('2026-10-06T01:00:00.000Z')
    expect(byOrigin.has('memory:mem_a1')).toBe(false)   // archived skipped
    expect(byOrigin.has('memory:mem_t1')).toBe(false)   // wrong kind skipped
    expect(byOrigin.get('trace:t1').type).toBe('behavior')
    expect(byOrigin.get('trace:t2').type).toBe('failure')
    expect(byOrigin.get('hypothesis:hyp_a').type).toBe('knowledge')
    expect(byOrigin.get('hypothesis:hyp_r').type).toBe('failure')
    expect(byOrigin.has('hypothesis:hyp_d')).toBe(false) // drafts not offered as evidence
    for (const s of sources) expect(s.weight).toBeGreaterThan(0.7) // IdeaGenerator temp contract
  })

  it('returns an empty list for an empty store', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mio-auto-empty-'))
    try {
      expect(buildAutoSources({ dataDir: empty })).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('merges insight and trend sources when the caller passes them', () => {
    const sources = buildAutoSources({
      dataDir,
      insights: [{ id: 'ins_1', title: 'LLM 延迟偏高', description: '近三天 p95 上升', score: 80, createdAt: '2026-10-05T00:00:00.000Z' }],
      trends: [{ date: '2026-10-06', summary: '本地推理趋势上升' }],
    })
    const byOrigin = new Map(sources.map((s: any) => [s.origin, s]))
    expect(byOrigin.get('insight:ins_1').type).toBe('insight')
    expect(byOrigin.get('observer-trends:2026-10-06').type).toBe('provocation')
  })
})

describe('topUpSources', () => {
  it('keeps explicit sources untouched when there are already two', () => {
    const explicit = [{ name: 'a', content: '1' }, { name: 'b', content: '2' }]
    expect(topUpSources(explicit, [{ name: 'c', content: '3' }])).toEqual(explicit)
  })

  it('tops a single explicit source up to two, explicit first', () => {
    const out = topUpSources([{ name: 'only', content: 'x' }], [{ name: 'auto1', content: 'y' }, { name: 'auto2', content: 'z' }])
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0].name).toBe('only')
  })

  it('never injects an auto source that duplicates an explicit name', () => {
    const out = topUpSources([{ name: 'same' }], [{ name: 'same' }, { name: 'other' }])
    expect(out.map((s: any) => s.name)).toEqual(['same', 'other'])
  })

  it('tolerates undefined inputs', () => {
    expect(topUpSources(undefined, undefined)).toEqual([])
  })
})

describe('trendSources', () => {
  it('maps trend reports to provocation sources', () => {
    const out = trendSources([{ date: '2026-10-06', summary: 's' }, { title: 'T', themes: ['a', 'b'] }])
    expect(out[0]).toMatchObject({ type: 'provocation', origin: 'observer-trends:2026-10-06' })
    expect(out[1].content).toContain('a; b')
  })
})

describe('sourcesFromInsights origin fields', () => {
  it('carries origin/originId/timestamp', () => {
    const [s] = sourcesFromInsights([{ id: 'ins_9', title: 't', description: 'd', score: 10, createdAt: '2026-10-05T00:00:00.000Z' }])
    expect(s.origin).toBe('insight:ins_9')
    expect(s.originId).toBe('ins_9')
    expect(s.timestamp).toBe('2026-10-05T00:00:00.000Z')
    expect(s.weight).toBeGreaterThan(0.7)
  })
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npx vitest run tests/main/creativity/creativity-sources.test.ts
```

Expected: FAIL — cannot find `packages/mio-cli/server/creativity-sources.js` / `origin` undefined.

- [x] **Step 3: Engine pre-edits (`creativity-engine.js`)**

(a) Add `isoOf` next to `clamp100` (after line 28):

```js
// ISO timestamp for provenance: accepts epoch ms or date strings, returns
// undefined when the value is missing or unparsable.
function isoOf(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '')
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}
```

(b) Replace the `sourcesFromInsights` mapping (lines 230–238) so provenance fields flow through (additive — the `--from-insights` path keeps working unchanged):

```js
    .map(i => ({
      name: String(i.title || i.id || 'insight').replace(/\s+/g, ' ').slice(0, 60),
      content: [
        i.description || i.content || i.title || '',
        Array.isArray(i.evidence) && i.evidence.length > 0 ? `Evidence: ${i.evidence.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      type: 'insight',
      // > 0.7: IdeaGenerator.applyTemperature keeps any weight>0.7 source unconditionally.
      weight: 0.78,
      origin: `insight:${i.id || i.title || 'unknown'}`,
      ...(i.id ? { originId: i.id } : {}),
      ...(isoOf(i.createdAt) ? { timestamp: isoOf(i.createdAt) } : {}),
    }))
```

(c) Extend the exports (line 573):

```js
module.exports = { CreativityEngine, CreativityStore, sourcesFromInsights, isoOf }
```

- [x] **Step 4: Create `packages/mio-cli/server/creativity-sources.js`**

```js
'use strict'

// Source auto-aggregation for the creativity engine (spec Capability 2).
//
// Default providers read ONLY local MIO_HOME data — zero network. Insight and
// observer sources arrive as plain arrays from the caller, because only the
// entry point knows which store is authoritative (MIO_HOME for the CLI, the
// MCP server's MIO_DATA_DIR) and whether its optional package resolves.
// SourceAggregator already tolerates a throwing provider (per-provider
// try/catch with a WARN log), so providers here do not need extra guards.

const fs = require('fs')
const path = require('path')
const { SourceAggregator } = require('@akemi-mio/creativity/SourceAggregator')
const { sourcesFromInsights, isoOf } = require('./creativity-engine.js')

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch (_) {
    return []
  }
}

// Every weight is > 0.7 on purpose: IdeaGenerator.applyTemperature keeps any
// source with weight > 0.7 unconditionally (temperature 0.5 middle branch), so
// the assembled set reaches the prompt intact — deterministic, no RNG survival.
const WEIGHTS = {
  memory: 0.75,
  traceOk: 0.74,
  traceFail: 0.73,
  hypothesisActive: 0.72,
  hypothesisRejected: 0.72,
  trend: 0.76,
}

function memoryProvider(dataDir) {
  return {
    domain: 'feedback',
    name: 'memory',
    collect() {
      return readJsonl(path.join(dataDir, 'memory.jsonl'))
        .filter((r) => r && r.archived !== true && (r.kind === 'decision' || r.kind === 'note'))
        .slice(-6)
        .map((r) => ({
          name: `${r.kind}: ${String(r.content || '').slice(0, 40)}`,
          content: String(r.content || ''),
          type: 'feedback',
          weight: WEIGHTS.memory,
          origin: `memory:${r.id}`,
          originId: r.id,
          timestamp: isoOf(r.timestamp),
        }))
    },
  }
}

function traceProviders(dataDir) {
  const events = () => readJsonl(path.join(dataDir, 'traces.jsonl')).slice(-40)
  const fmt = (r) => `${r.event_type}${r.outcome ? `/${r.outcome}` : ''}: ${JSON.stringify(r.payload || {}).slice(0, 300)}`
  const stamp = (r) => isoOf(r.timestamp ?? r.ts)
  return [
    {
      domain: 'behavior',
      name: 'traces-success',
      collect() {
        return events()
          .filter((r) => r.event_type === 'task_outcome' && r.outcome === 'success')
          .slice(-3)
          .map((r) => ({
            name: `success: ${String((r.payload && (r.payload.task || r.payload.summary)) || r.trace_id || 'task').slice(0, 40)}`,
            content: fmt(r),
            type: 'behavior',
            weight: WEIGHTS.traceOk,
            origin: `trace:${r.trace_id}`,
            originId: r.trace_id,
            timestamp: stamp(r),
          }))
      },
    },
    {
      domain: 'failure',
      name: 'traces-failure',
      collect() {
        return events()
          .filter(
            (r) =>
              (r.event_type === 'error' || r.event_type === 'retry') ||
              (r.event_type === 'task_outcome' && (r.outcome === 'failure' || r.outcome === 'error' || r.outcome === 'aborted')),
          )
          .slice(-3)
          .map((r) => ({
            name: `failure: ${String(r.event_type)}${r.trace_id ? ` ${String(r.trace_id).slice(0, 12)}` : ''}`,
            content: fmt(r),
            type: 'failure',
            weight: WEIGHTS.traceFail,
            origin: `trace:${r.trace_id || 'unknown'}`,
            originId: r.trace_id,
            timestamp: stamp(r),
          }))
      },
    },
  ]
}

function hypothesesProvider(dataDir) {
  return {
    domain: 'module',
    name: 'hypotheses',
    collect() {
      return readJsonl(path.join(dataDir, 'creativity', 'creativity-hypotheses.jsonl'))
        .filter((h) => h && (h.status === 'active' || h.status === 'rejected'))
        .slice(-6)
        .map((h) => ({
          name: String(h.title || h.id).slice(0, 60),
          content: `idea: ${h.idea}\nrisk: ${h.risk || '-'}`,
          type: h.status === 'rejected' ? 'failure' : 'knowledge',
          weight: h.status === 'rejected' ? WEIGHTS.hypothesisRejected : WEIGHTS.hypothesisActive,
          origin: `hypothesis:${h.id}`,
          originId: h.id,
          timestamp: isoOf(h.createdAt),
        }))
    },
  }
}

// Observer trend reports → provocation sources. The report schema has drifted
// across observer versions, so fields are read defensively with fallbacks.
function trendSources(trends) {
  return (Array.isArray(trends) ? trends : []).slice(0, 4).map((t, i) => {
    const title = (t && (t.title || t.name || t.date)) || `trend-${i}`
    const body =
      (t && t.summary) ||
      (Array.isArray(t && t.themes) ? t.themes.join('; ') : '') ||
      JSON.stringify(t || {}).slice(0, 400)
    const key = (t && (t.date || t.id)) || String(i)
    const stamp = isoOf(t && (t.generatedAt || t.date))
    return {
      name: String(title).slice(0, 60),
      content: String(body),
      type: 'provocation',
      weight: WEIGHTS.trend,
      origin: `observer-trends:${key}`,
      ...(t && t.id ? { originId: t.id } : {}),
      ...(stamp ? { timestamp: stamp } : {}),
    }
  })
}

// Assemble every local (+ optionally insight/observer) domain through the
// package SourceAggregator so dedup, per-domain caps and failure tolerance
// behave identically for idea.generate and the generate top-up.
function buildAutoSources({ dataDir, insights = [], trends = [] }) {
  const aggregator = new SourceAggregator(4, 1)
  aggregator.addProvider(memoryProvider(dataDir))
  for (const provider of traceProviders(dataDir)) aggregator.addProvider(provider)
  aggregator.addProvider(hypothesesProvider(dataDir))
  if (Array.isArray(insights) && insights.length > 0) {
    aggregator.addProvider({ domain: 'observation', name: 'insight', collect: () => sourcesFromInsights(insights) })
  }
  const trendList = Array.isArray(trends) ? trends : []
  if (trendList.length > 0) {
    aggregator.addProvider({ domain: 'external', name: 'observer-trends', collect: () => trendSources(trendList) })
  }
  return aggregator.build()
}

// Explicit --source entries always win: auto sources only top a set up to the
// two entries the concept mixer needs; they never replace or reorder explicit
// ones (spec Capability 2, injection point 2).
function topUpSources(explicit, auto) {
  const list = Array.isArray(explicit) ? explicit.filter(Boolean) : []
  if (list.length >= 2) return list
  const seen = new Set(list.map((s) => s.name))
  const extra = (Array.isArray(auto) ? auto : []).filter((s) => s && !seen.has(s.name))
  return [...list, ...extra]
}

module.exports = { buildAutoSources, topUpSources, trendSources, memoryProvider, traceProviders, hypothesesProvider }
```

- [x] **Step 5: Run and see it pass**

```powershell
npx vitest run tests/main/creativity/creativity-sources.test.ts
npm run check --prefix packages/mio-cli
```

Expected: PASS + syntax check 0.

- [x] **Step 6: Commit**

```powershell
git add packages/mio-cli/server/creativity-sources.js packages/mio-cli/server/creativity-engine.js tests/main/creativity/creativity-sources.test.ts
# commit message: feat(mio-cli): local-first creativity source providers + top-up seam
```

---

### Task 9: Engine uses the package scorer + `list --sort novelty`

**Files:**
- Modify: `packages/mio-cli/server/creativity-engine.js`
- Modify: `packages/mio-cli/bin/mio.js` (`creativity list --sort`, usage, printer)
- Modify: `packages/mio-cli/server/mio-intelligence-mcp/index.js` (list schema `sort`)
- Test: `packages/mio-cli/__tests__/creativity-list-sort.test.js` (new), `tests/main/creativity/novelty-sort.test.ts` (new)

- [x] **Step 1: Write the failing node:test file**

```js
'use strict'

// `mio creativity list --sort novelty` — relative novelty ranking (spec
// Capability 3). noveltyScore is a DEDUP/RANKING signal, never a quality score.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { CreativityEngine } = require('../server/creativity-engine.js')

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-sort-'))
  const dir = path.join(mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  return { mioHome, file: path.join(dir, 'creativity-hypotheses.jsonl') }
}

function seed(ws, records) {
  fs.writeFileSync(ws.file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function engine(ws) {
  return new CreativityEngine(path.join(ws.mioHome, 'creativity'), async () => ({ data: [] }))
}

const h = (id, title, idea, novelty, status = 'active') => ({
  id, title, idea, expectedBenefit: 'b', risk: 'r',
  novelty, feasibility: 50, impact: 50, sourceLabels: ['A', 'B'],
  status, createdAt: 1000 + Number(id.replace(/\D/g, '')),
})

test('sort novelty ranks by noveltyScore desc and exposes the field', () => {
  const ws = workspace()
  // unique texts so pairwise similarity stays low; noveltyScore ~= stored novelty
  seed(ws, [
    h('h1', 'Idea about token rotation', 'rotate tokens through cache layer daily', 30),
    h('h2', 'Idea about schema migrations', 'batch schema migrations with dual writes', 80),
    h('h3', 'Idea about trace sampling', 'sample traces by outcome rather than rate', 55),
  ])
  const rows = engine(ws).list({ sort: 'novelty' })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.id), ['h2', 'h3', 'h1'])
  for (const row of rows) {
    assert.equal(typeof row.noveltyScore, 'number')
    assert.notEqual(row.noveltyScore, row.score, 'noveltyScore must stay distinct from the quality sum `score`')
  }
})

test('sort novelty respects status filter and limit', () => {
  const ws = workspace()
  seed(ws, [
    h('h1', 'Alpha idea one', 'completely different subject matter entirely', 90),
    h('h2', 'Beta idea two', 'another unrelated topic with words', 40, 'rejected'),
    h('h3', 'Gamma idea three', 'third distinct proposition here now', 60),
  ])
  const rows = engine(ws).list({ sort: 'novelty', status: 'active', limit: 1 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'h1')
})

test('sort novelty caps the O(n²) candidate set at the newest 200', () => {
  const ws = workspace()
  const records = []
  for (let i = 0; i < 230; i++) records.push(h(`h${i}`, `Unique title ${i}`, `unique body number ${i} says nothing alike`, 10 + (i % 80)))
  seed(ws, records)
  const rows = engine(ws).list({ sort: 'novelty', limit: 0 })
  assert.equal(rows.length, 200)
})

test('CLI rejects an unknown --sort and accepts novelty', () => {
  const ws = workspace()
  seed(ws, [h('h1', 'Solo idea', 'just one stored hypothesis body', 50)])
  const bad = spawnSync(process.execPath, [CLI, 'creativity', 'list', '--sort', 'value'], {
    encoding: 'utf8', env: { ...process.env, MIO_HOME: ws.mioHome },
  })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown --sort "value"/)
  const good = spawnSync(process.execPath, [CLI, 'creativity', 'list', '--sort', 'novelty', '--json'], {
    encoding: 'utf8', env: { ...process.env, MIO_HOME: ws.mioHome },
  })
  assert.equal(good.status, 0)
  const rows = JSON.parse(good.stdout)
  assert.equal(typeof rows[0].noveltyScore, 'number')
})
```

- [x] **Step 2: Run and see it fail**

```powershell
npm test --prefix packages/mio-cli -- creativity-list-sort
```

Expected: FAIL — rows lack `noveltyScore`, order wrong (insertion order), CLI: `unknown option` or ignored `--sort`.

- [x] **Step 3: Write the failing root vitest twin (spec: root vitest covers sort order + field)**

`tests/main/creativity/novelty-sort.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { CreativityEngine } = require('../../../packages/mio-cli/server/creativity-engine.js')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mio-sort-vitest-'))
  const dir = join(dataDir, 'creativity')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'creativity-hypotheses.jsonl'), [
    JSON.stringify({ id: 'h1', title: 'Low novelty idea', idea: 'boring distinct text one', novelty: 20, feasibility: 50, impact: 50, status: 'active', createdAt: 1 }),
    JSON.stringify({ id: 'h2', title: 'High novelty idea', idea: 'exciting unrelated text two', novelty: 90, feasibility: 50, impact: 50, status: 'active', createdAt: 2 }),
  ].join('\n') + '\n')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('creativity list sort=novelty', () => {
  it('orders by noveltyScore descending and keeps it distinct from score', async () => {
    const engine = new CreativityEngine(join(dataDir, 'creativity'), async () => ({ data: [] }))
    const rows = engine.list({ sort: 'novelty' })
    expect(rows.map((r: any) => r.id)).toEqual(['h2', 'h1'])
    expect(typeof rows[0].noveltyScore).toBe('number')
    expect(rows[0].noveltyScore).not.toBe(rows[0].score)
  })

  it('default listing is unchanged (newest 20, no noveltyScore)', async () => {
    const engine = new CreativityEngine(join(dataDir, 'creativity'), async () => ({ data: [] }))
    const rows = engine.list({})
    expect(rows.length).toBe(2)
    expect(rows[0].noveltyScore).toBeUndefined()
    // plan typo (executed note): comment math 20 + 50 + 50 = 120, and the
    // legacy quality sum really is 120 — original text said toBe(160).
    expect(rows[0].score).toBe(120) // 20 + 50 + 50 — legacy quality sum untouched
  })
})
```

Run `npx vitest run tests/main/creativity/novelty-sort.test.ts` → FAIL (same reasons).

> **Deviation (executed):** the embedded assertion above originally read `toBe(160)`, contradicting its own comment (`20 + 50 + 50`) and the engine's legacy `score: novelty + feasibility + impact` (verified actual = 120). Fixed to `toBe(120)`.

- [x] **Step 4: Implement the engine changes**

In `packages/mio-cli/server/creativity-engine.js`:

(a) After the requires (line 5), add:

```js
const { evaluateNovelty } = require('@akemi-mio/creativity/NoveltyScorer')
```

(b) Delete the inline duplicate: the `bigramSet`, `jaccard` and `evaluateNovelty` functions plus their section header comment (lines 176–211). The call site at line 335 (`const verdict = evaluateNovelty(h, recent, rejected)`) is signature-compatible with the package version and stays as-is.

(c) Extract a row mapper (place above `class CreativityEngine`) and rewrite `list` (line 507):

```js
// One row shape for every list variant — the fields JSON/CLI consumers already
// depend on. `noveltyScore` is added only by sort=novelty (relative ranking),
// never confused with the quality sum `score`.
function listRow(h) {
  return {
    id: h.id,
    title: h.title,
    idea: h.idea,
    status: h.status,
    novelty: h.novelty,
    feasibility: h.feasibility,
    impact: h.impact,
    ...(h.logic !== undefined ? { logic: h.logic } : {}),
    score: h.novelty + h.feasibility + h.impact,
    sourceLabels: h.sourceLabels,
    createdAt: h.createdAt,
    fermentedAt: h.fermentedAt,
    fermentCount: h.fermentCount,
    ...(h.mergedInto !== undefined ? { mergedInto: h.mergedInto } : {}),
  }
}
```

```js
  list(opts = {}) {
    const limit = opts.limit === undefined ? 20 : opts.limit
    if (opts.sort === 'novelty') {
      // Relative novelty ranking (read-only, nothing written back). Pairwise
      // Jaccard is O(n²) — bound candidates to the newest 200 (spec Risk 3).
      const candidates = this.store.getHypotheses({ status: opts.status }).slice(-200)
      const rows = candidates.map((h) => {
        const others = candidates.filter((x) => x.id !== h.id)
        const verdict = evaluateNovelty(h, others, [])
        return { ...listRow(h), noveltyScore: verdict.adjustedNovelty }
      })
      rows.sort((a, b) => b.noveltyScore - a.noveltyScore || (b.createdAt || 0) - (a.createdAt || 0))
      return limit === 0 ? rows : rows.slice(0, limit)
    }
    return this.store.getHypotheses({ status: opts.status, limit }).map(listRow)
  }
```

- [x] **Step 5: CLI changes (`bin/mio.js`)**

(a) In `creativityCommand` list branch (line 2292), replace the `engine.list({...})` call with:

```js
      const sort = optionValue(flags, '--sort')
      if (sort !== undefined && sort !== 'novelty') {
        console.error(`mio creativity list: unknown --sort "${sort}" (supported: novelty)`)
        process.exitCode = 1
        return
      }
      result = engine.list({
        status: optionValue(flags, '--status'),
        limit: parseNumberOption(flags, '--limit'),
        sort,
      })
```

(b) In `printCreativityList` (line 2117), append the ranking signal when present:

```js
    const ns = h.noveltyScore !== undefined ? ` noveltyScore=${h.noveltyScore}` : ''
    console.log(`${index + 1}. [${h.status}] ${h.title}  (N=${h.novelty} F=${h.feasibility} I=${h.impact} score=${h.score}${ns})`)
```

(c) `creativityUsage` — line 2068 becomes
`  mio creativity list                List hypotheses (--status active|validated|rejected|draft, --sort novelty, --limit N)`
line 2075 gains `--sort novelty     Rank list by relative noveltyScore (a dedup signal, not a quality score)` after the `--limit` line, and the examples block gains
`  mio creativity list --sort novelty` after line 2083.

(d) `mio --help` text (line 3372) becomes:
`  mio creativity list          List creativity hypotheses (--status active|validated|rejected|draft, --sort novelty, --limit N)`

- [x] **Step 6: MCP schema change (`server/mio-intelligence-mcp/index.js`)**

In the `mio.creativity.list` inputSchema properties (after line 697):

```js
        sort: { type: 'string', description: "Sort order: 'novelty' ranks stored hypotheses by relative noveltyScore (a dedup signal, NOT a quality score), newest 200 candidates capped. Default: newest." },
```

(Dispatch already passes `args` through: `case 'mio.creativity.list': return creativityEngine.list(args)` — no change needed.)

- [x] **Step 7: Run all affected tests**

```powershell
npm test --prefix packages/mio-cli -- creativity
npx vitest run tests/main/creativity/
```

Expected: PASS. **Known behavioural migration** (intended, spec Decision 4): the package scorer no longer auto-rejects on *recent* similarity (it down-scores 15 when Jaccard > 0.5) and no longer adds the inline `+5` clean bonus; Chinese reject reasons replace the English ones. If an existing assertion in `creativity-generate.test.js` depended on the old inline behaviour, update the fixture: duplicate a **rejected** hypothesis's title+idea text to trigger a reject (threshold 0.6), or assert the down-scored `novelty` value instead of the bonus. No test currently greps for `too similar to recent`/`adjustedNovelty` (verified 2026-10-07). If an assertion still fails, migrate it per this note — never re-add an inline scorer to the engine.

- [x] **Step 8: Commit**

```powershell
git add packages/mio-cli/server/creativity-engine.js packages/mio-cli/bin/mio.js packages/mio-cli/server/mio-intelligence-mcp/index.js packages/mio-cli/__tests__/creativity-list-sort.test.js tests/main/creativity/novelty-sort.test.ts
# commit message: feat(mio-cli): package scorer + creativity list --sort novelty
```
---

### Task 10: `creativity generate` tops up short source lists

**Files:**
- Modify: `packages/mio-cli/bin/mio.js` (require, `cliAutoSources()`, top-up seam)
- Test: `packages/mio-cli/__tests__/creativity-autosources.test.js` (new)

- [ ] **Step 1: Write the failing node:test file**

```js
'use strict'

// Spec Capability 2, injection point 2: explicit --source entries win; when
// fewer than two survive, local memory/traces/stored hypotheses top the list
// up. Empty local data keeps the original "at least two --source" contract.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function workspace(seedMemory) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-topup-'))
  if (seedMemory) {
    fs.writeFileSync(
      path.join(mioHome, 'memory.jsonl'),
      [
        JSON.stringify({ id: 'mem_d1', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定把 MCP 调用延迟优先优化', project: 'p', scope: 'project' }),
        JSON.stringify({ id: 'mem_n1', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '延迟优化的周报记录' }),
      ].join('\n') + '\n'
    )
  }
  return { mioHome }
}

// cwd is the temp home so the observer trends provider reads an empty
// <cwd>/.local/observer instead of this checkout's real data; the endpoint is
// refused instantly, so a topped-up run reaches the engine, fails the pair,
// prints the failure, and exits 0 without touching the network.
function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws.mioHome,
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: ws.mioHome, LLM_API_URL: 'http://127.0.0.1:9/v1/chat/completions' },
  })
}

test('zero --source tops up from local memory and runs', () => {
  const ws = workspace(true)
  const out = run(ws, ['creativity', 'generate'])
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stderr, /at least two --source/)
  assert.match(out.stdout, /Generated 0 hypothesis/)
  assert.match(out.stdout, /pair\(s\) failed/)
})

test('a single --source tops up too', () => {
  const ws = workspace(true)
  const out = run(ws, ['creativity', 'generate', '--source', 'auth|token rotation'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Generated 0 hypothesis/)
})

test('empty local data keeps the original two-source contract', () => {
  const ws = workspace(false)
  const out = run(ws, ['creativity', 'generate'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /at least two --source/)
})

test('two explicit sources still run without needing local data', () => {
  const ws = workspace(false)
  const out = run(ws, ['creativity', 'generate', '--source', 'auth|token rotation', '--source', 'cache|write-through'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Generated 0 hypothesis/)
})
```

- [ ] **Step 2: Run and see it fail**

```powershell
node --test packages/mio-cli/__tests__/creativity-autosources.test.js
```

Expected: FAIL — the first two tests exit 1 with `at least two --source` (no top-up seam yet); the last two already pass.

- [ ] **Step 3: Implement**

(a) After the `creativity-engine.js` require in `bin/mio.js` (line 26), add:

```js
const { buildAutoSources, topUpSources } = require('../server/creativity-sources.js')
```

(b) Directly above `function creativityGenerateCommand`, add:

```js
// Auto sources for generate's top-up: the same local providers the MCP server
// uses, assembled from the CLI's global MIO_HOME (spec Capability 2). Every
// layer degrades to [] — a missing optional package or an unreadable store
// must never fail `mio creativity generate`.
function cliAutoSources() {
  let insights = []
  let trends = []
  try {
    if (isInsightAvailable()) insights = cliInsightStore().list({}) || []
  } catch (_) {}
  try {
    if (isObserverAvailable()) trends = cliObserverStore().trends({ limit: 3 }) || []
  } catch (_) {}
  try {
    return buildAutoSources({ dataDir: MIO_HOME, insights, trends })
  } catch (_) {
    return []
  }
}
```

(c) In `creativityGenerateCommand`, between the end of the `--from-insights` block (`sources = sources.concat(seeds)`) and `if (sources.length < 2) {`, insert:

```js
  // Auto top-up (spec Capability 2, injection point 2): explicit --source
  // entries win; when fewer than two remain, local memory/traces/stored
  // hypotheses (plus insight/observer observations) fill the gap. If the
  // topped-up set is still short, the errors below keep their old wording.
  if (sources.length < 2) {
    const topped = topUpSources(sources, cliAutoSources())
    if (topped.length >= 2) sources = topped
  }
```

- [ ] **Step 4: Run and see it pass**

```powershell
node --test packages/mio-cli/__tests__/creativity-autosources.test.js
npm test --prefix packages/mio-cli -- creativity
```

Expected: PASS — including the existing `creativity-generate.test.js` argument-validation tests: their temp homes hold no local data, so top-up is a no-op there and their exit-1 contracts are untouched.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/bin/mio.js packages/mio-cli/__tests__/creativity-autosources.test.js
# commit message: feat(mio-cli): generate tops up short source lists from local data
```

---

### Task 11: `server/idea-generate.js` — the goal-driven pipeline

**Files:**
- Create: `packages/mio-cli/server/idea-generate.js`
- Test: `packages/mio-cli/__tests__/idea-generate.test.js` (new, in-process only — CLI spawn tests arrive with Task 13, the MCP surface with Task 12)

- [ ] **Step 1: Write the failing node:test file**

```js
'use strict'

// `mio.idea.generate` core (spec Capability 1): goal-driven, grounded on Mio
// memory, local sources auto-assembled, novelty-gated against stored
// hypotheses, every candidate persisted with provenance — all offline here
// (the LLM stub refuses, so templates carry the run).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runIdeaGenerate, groundingFrom } = require('../server/idea-generate.js')
const { CreativityStore } = require('../server/creativity-engine.js')

const LLM_DOWN = async () => {
  throw new Error('ECONNREFUSED 127.0.0.1:9')
}

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-idea-'))
  const dir = path.join(mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  return { mioHome, dir, store: new CreativityStore(dir), file: path.join(dir, 'creativity-hypotheses.jsonl') }
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

test('returns the spec response shape and persists drafts with provenance', async () => {
  const ws = workspace()
  const res = await runIdeaGenerate({
    goal: '降低 MCP 调用延迟',
    context: '观察到近三天 p95 上升',
    constraints: ['不引入新依赖'],
    chatJson: LLM_DOWN,
    store: ws.store,
  })
  assert.ok(res.ideas.length >= 1)
  assert.equal(typeof res.generatedAt, 'string')
  assert.equal(res.groundedWith, 0)
  assert.equal(res.persistedIds.length, res.ideas.length)

  const idea = res.ideas[0]
  assert.ok(idea.title.length > 0)
  assert.equal(typeof idea.novelty, 'number')
  assert.equal(idea.hypothesis.id, res.persistedIds[0])
  assert.equal(idea.hypothesis.status, 'draft')
  assert.ok(idea.experiment.steps.length > 0)
  // every source is knowledge here → stable fallback pairing, never a silent
  // explore run that mixes zero cross-type combos
  assert.equal(idea.provenance.strategy, 'stable')
  assert.equal(idea.provenance.technique, idea.hypothesis.technique)
  const labels = new Set(idea.hypothesis.sourceLabels)
  for (const s of idea.provenance.sources) assert.ok(labels.has(s.name))

  const rows = readRows(ws.file)
  assert.equal(rows.length, res.persistedIds.length)
  assert.equal(rows[0].provenance.generatedAt, res.generatedAt)
  // spec: drafts live in CreativityStore, never in Mio memory
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'memory.jsonl')), false)
})

test('grounding memory flows into sources, ids, groundedWith and strategy', async () => {
  const ws = workspace()
  const grounding = groundingFrom({
    count: 2,
    results: [
      { id: 'mem_a', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定把 MCP 调用延迟优先优化', project: 'p', scope: 'project' },
      { id: 'mem_b', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '延迟优化周报：本周无回归' },
    ],
  })
  assert.deepEqual(grounding.relatedMemoryIds, ['mem_a', 'mem_b'])
  assert.equal(grounding.groundedWith, 2)

  const res = await runIdeaGenerate({
    goal: '降低 MCP 调用延迟',
    chatJson: LLM_DOWN,
    store: ws.store,
    groundingSources: grounding.sources,
    relatedMemoryIds: grounding.relatedMemoryIds,
  })
  assert.equal(res.groundedWith, 2)
  assert.ok(res.ideas.length >= 1)
  assert.deepEqual(res.ideas[0].provenance.relatedMemoryIds, ['mem_a', 'mem_b'])
  // knowledge goal + feedback memory → cross-type pairs exist → explore
  assert.equal(res.ideas[0].provenance.strategy, 'explore')
  assert.ok(res.ideas[0].provenance.sources.some((s) => s.origin === 'memory:mem_a'))
})

test('numIdeas clamps to 1..3 whatever the caller asks for', async () => {
  const ws = workspace()
  const auto = [
    { name: 'extra-a', content: '第一份本地补充材料，内容足够长以通过门禁', type: 'knowledge', weight: 0.8 },
    { name: 'extra-b', content: '第二份本地补充材料，内容同样足够长以通过门禁', type: 'knowledge', weight: 0.8 },
  ]
  const many = await runIdeaGenerate({
    goal: '扩大命令覆盖',
    context: 'README 命令块与 help 保持一致',
    numIdeas: 99,
    chatJson: LLM_DOWN,
    store: ws.store,
    autoSources: auto,
  })
  assert.ok(many.ideas.length >= 1)
  assert.ok(many.ideas.length <= 3, 'clamped even when the caller asks for 99')

  const one = await runIdeaGenerate({
    goal: '扩大命令覆盖',
    context: 'README 命令块与 help 保持一致',
    numIdeas: 1,
    chatJson: LLM_DOWN,
    store: ws.store,
    autoSources: auto,
  })
  assert.equal(one.ideas.length, 1)
})

test('near-duplicates of a rejected hypothesis are rejected with a reason', async () => {
  const ws = workspace()
  const fixed = {
    title: '固定标题用于重复检测',
    idea: '这段想法文本足够长，用来验证与已拒绝假设之间的近似重复门禁确实生效。',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 70,
    feasibility: 60,
    impact: 70,
    relevance: 'goal 与 context 通过约束注入机制协同',
    sourceLabels: [],
  }
  const stub = async () => ({ data: [fixed] })

  const first = await runIdeaGenerate({ goal: 'x', context: 'y', chatJson: stub, store: ws.store })
  assert.equal(first.ideas[0].hypothesis.status, 'draft')

  const rows = readRows(ws.file)
  rows[0].status = 'rejected'
  fs.writeFileSync(ws.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const store2 = new CreativityStore(ws.dir)
  const second = await runIdeaGenerate({ goal: 'x', context: 'y', chatJson: stub, store: store2 })
  const hit = second.ideas.find((i) => i.title === fixed.title)
  assert.equal(hit.hypothesis.status, 'rejected')
  assert.match(hit.hypothesis.rejectionReason, /已拒绝假设/)
  assert.ok(second.persistedIds.includes(hit.hypothesis.id), 'rejects are persisted too — they feed later dedup')
})

test('answers with a reason instead of throwing when there is only one source', async () => {
  const ws = workspace()
  const res = await runIdeaGenerate({ goal: 'lonely', chatJson: LLM_DOWN, store: ws.store })
  assert.equal(res.ideas, undefined)
  assert.match(res.reason, /at least 2/)
  assert.equal(fs.existsSync(ws.file), false)
})
```

- [ ] **Step 2: Run and see it fail**

```powershell
node --test packages/mio-cli/__tests__/idea-generate.test.js
```

Expected: FAIL — cannot find `../server/idea-generate.js`.

- [ ] **Step 3: Create `packages/mio-cli/server/idea-generate.js`**

```js
'use strict'

// `mio.idea.generate` — one-shot goal-driven idea pipeline (spec Capability 1).
// Shared by the CLI (`mio idea generate`) and the MCP server (tool
// `mio.idea.generate`): each entry point only assembles entry-specific inputs
// (which store is authoritative, where local data lives) and renders the
// response this module returns.
//
// Contract:
//   - source order: goal → context → constraints → grounding → local auto,
//     deduplicated by `origin` (fallback name), first occurrence wins — so a
//     memory that arrives both as a grounding hit and through the local
//     provider contributes exactly once, the grounding copy first;
//   - pairing strategy: cross-type `explore` only when two types exist, else
//     the `stable` fallback (an all-knowledge set explores into ZERO combos);
//   - every candidate passes evaluateNovelty against stored hypotheses: a
//     near-duplicate of a REJECTED one is persisted as rejected with a reason,
//     a merely-similar recent one is down-scored; drafts AND rejects both land
//     in the store so later runs can dedup against them;
//   - ideas are never written to Mio memory — CreativityStore only.

const { IdeaGenerator } = require('@akemi-mio/creativity/IdeaGenerator')
const { evaluateNovelty } = require('@akemi-mio/creativity/NoveltyScorer')

// All > 0.7: IdeaGenerator.applyTemperature keeps such sources unconditionally
// (temperature 0.5 middle branch) — deterministic prompt, no RNG survival.
const WEIGHTS = { goal: 0.95, context: 0.9, constraint: 0.88, grounding: 0.75 }

// `queryMemory` result → grounding sources + ids. Tolerates null/empty
// (a thrown query is the caller's problem to catch; a miss is not).
function groundingFrom(queryResult) {
  const results = Array.isArray(queryResult && queryResult.results) ? queryResult.results : []
  const sources = results.map((r) => ({
    name: `${r.kind || 'memory'}: ${String(r.content || '').slice(0, 40)}`,
    content: String(r.content || ''),
    type: 'feedback',
    weight: WEIGHTS.grounding,
    origin: `memory:${r.id}`,
    originId: r.id,
    ...(r.timestamp ? { timestamp: r.timestamp } : {}),
  }))
  return { sources, relatedMemoryIds: results.map((r) => r.id), groundedWith: results.length }
}

function namedSource(role, text, origin, weight) {
  const body = String(text).trim()
  return {
    name: `${role}: ${body.slice(0, 40)}`,
    content: body,
    type: 'knowledge',
    weight,
    origin,
  }
}

async function runIdeaGenerate(options) {
  const {
    goal,
    context = '',
    constraints = [],
    numIdeas,
    chatJson,
    store,
    groundingSources = [],
    relatedMemoryIds = [],
    autoSources = [],
  } = options || {}

  const ordered = []
  if (typeof goal === 'string' && goal.trim()) ordered.push(namedSource('goal', goal, 'goal', WEIGHTS.goal))
  if (typeof context === 'string' && context.trim()) ordered.push(namedSource('context', context, 'context', WEIGHTS.context))
  if (Array.isArray(constraints)) {
    constraints.forEach((c, i) => {
      if (typeof c === 'string' && c.trim()) ordered.push(namedSource('constraint', c, `constraint:${i}`, WEIGHTS.constraint))
    })
  }
  for (const s of [...groundingSources, ...autoSources]) {
    if (s && typeof s === 'object' && s.name) ordered.push(s)
  }

  const seen = new Set()
  const sources = []
  for (const s of ordered) {
    const key = s.origin || s.name
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(s)
  }

  if (sources.length < 2) {
    return { reason: 'need at least 2 sources — add --context/--constraints, or run `mio remember` first' }
  }

  const pairingStrategy = new Set(sources.map((s) => s.type)).size >= 2 ? 'explore' : 'stable'
  const requested = Number(numIdeas)
  const maxIdeas = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 3) : 3

  const rotationSeed = store.getHypotheses().length
  const generator = new IdeaGenerator(chatJson, 0.5, undefined, rotationSeed)
  // method left undefined: HypothesisGenerator rotates techniques internally
  // from rotationSeed; the chosen one comes back on hypothesis.technique.
  const creativeIdeas = await generator.generateIdeas(sources, maxIdeas, pairingStrategy, [])

  const generatedAt = new Date().toISOString()
  const recent = store.getHypotheses().slice(-30)
  const rejected = store.getHypotheses({ status: 'rejected' }).slice(-50)

  const ideas = []
  const persistedIds = []
  for (const { hypothesis: h, experiment } of creativeIdeas) {
    const verdict = evaluateNovelty(h, recent, rejected)
    if (verdict.shouldReject) {
      h.status = 'rejected'
      h.rejectionReason = verdict.rejectReason
    } else {
      h.novelty = verdict.adjustedNovelty
    }
    const labels = new Set(Array.isArray(h.sourceLabels) ? h.sourceLabels : [])
    h.provenance = {
      strategy: pairingStrategy,
      technique: h.technique,
      relatedMemoryIds: [...relatedMemoryIds],
      sources: sources
        .filter((s) => labels.has(s.name))
        .map((s) => ({ name: s.name, type: s.type, origin: s.origin, timestamp: s.timestamp })),
      generatedAt,
    }
    store.addHypothesis(h)
    persistedIds.push(h.id)
    ideas.push({ title: h.title, hypothesis: h, experiment, novelty: h.novelty, provenance: h.provenance })
  }

  return { ideas, generatedAt, groundedWith: groundingSources.length, persistedIds }
}

module.exports = { runIdeaGenerate, groundingFrom }
```

- [ ] **Step 4: Run and see it pass**

```powershell
node --test packages/mio-cli/__tests__/idea-generate.test.js
npm run check --prefix packages/mio-cli
```

Expected: PASS + syntax check 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/server/idea-generate.js packages/mio-cli/__tests__/idea-generate.test.js
# commit message: feat(mio-cli): goal-driven idea.generate pipeline with grounding + provenance
```

---

### Task 12: MCP tool `mio.idea.generate` + generate top-up

**Files:**
- Modify: `packages/mio-cli/server/mio-intelligence-mcp/index.js` (requires, `groundingMemoryStore`, `autoSources()`, `generationSources` top-up, TOOLS entry, dispatch case)
- Modify: `packages/mio-cli/server/mio-intelligence-mcp/__tests__/creativity.test.js` (env pin, fromInsights rewrite, four new tests)

- [ ] **Step 1: Edit the test file**

(a) After `process.env.MIO_DATA_DIR = dataDir` add:

```js
// The generate top-up and idea.generate both reach the engine's chatJson:
// pin the endpoint to a refused address so no test can ever touch a real LLM.
process.env.LLM_API_URL = 'http://127.0.0.1:9/v1/chat/completions'
```

(b) Replace the body of `mio.creativity.generate fromInsights hands the seed to the engine` (the comment and the two assertions after `seedInsights([...])`) with:

```js
  // One insight seed alone is still one concept — but the local auto sources
  // top it up (the active hypothesis below), so the engine clears the
  // two-source gate, attempts its pair(s), and fails each one against the
  // refused LLM endpoint. That combination proves the seed became a concept
  // without ever touching the network.
  seedHypotheses([hypothesis('b', 'active')])
  const result = await callTool('mio.creativity.generate', { fromInsights: true })
  assert.equal(result.reason, undefined, 'top-up pushed the seed past the two-source gate')
  assert.ok(result.pairsAttempted >= 1)
  assert.deepEqual(result.ideas, [], 'the engine has no template path — refused LLM means no ideas')
  assert.equal(result.errors.length, result.pairsAttempted, 'every attempted pair reports its failure')
```

(c) Before the final `after(...)` block, append:

```js
test('mio.creativity.generate tops a single explicit source up from local data', async () => {
  seedHypotheses([hypothesis('b', 'active')])
  const result = await callTool('mio.creativity.generate', {
    sources: [{ name: 'auth', content: 'token rotation keeps getting hand-rolled' }],
  })
  assert.equal(result.reason, undefined, 'one explicit source + a stored hypothesis clears the gate')
  assert.ok(result.pairsAttempted >= 1)
  assert.deepEqual(result.ideas, [], 'LLM refused in tests; only the gate behaviour is under test')
  assert.equal(result.errors.length, result.pairsAttempted)
})

test('mio.idea.generate registers the goal schema', () => {
  const tool = TOOLS.find((t) => t.name === 'mio.idea.generate')
  assert.ok(tool, 'the tool is registered')
  assert.deepEqual(tool.inputSchema.required, ['goal'])
  assert.ok(tool.inputSchema.properties.goal)
  assert.ok(tool.inputSchema.properties.numIdeas)
})

test('mio.idea.generate without goal names the missing field', async () => {
  await assert.rejects(() => callTool('mio.idea.generate'), /requires goal/)
  await assert.rejects(() => callTool('mio.idea.generate', { context: 'x' }), /requires goal/)
})

test('mio.idea.generate grounds on memory and persists drafts with provenance', async () => {
  seedHypotheses([])
  fs.writeFileSync(
    path.join(dataDir, 'memory.jsonl'),
    JSON.stringify({
      id: 'g1',
      timestamp: '2026-10-06T01:00:00.000Z',
      kind: 'decision',
      content: '延迟优化的决定：优先降低 MCP 调用延迟',
      scope: 'global',
    }) + '\n',
    'utf8'
  )

  const result = await callTool('mio.idea.generate', { goal: '降低 MCP 调用延迟' })
  assert.ok(result.ideas.length >= 1)
  assert.ok(result.groundedWith >= 1, 'the global decision matched the goal query')
  assert.deepEqual(result.ideas[0].provenance.relatedMemoryIds, ['g1'])
  assert.equal(result.ideas[0].hypothesis.status, 'draft')
  assert.equal(typeof result.persistedIds[0], 'string')
})
```

- [ ] **Step 2: Run and see it fail**

```powershell
npm test --prefix packages/mio-cli -- creativity
```

Expected: FAIL — `mio.idea.generate` unknown tool; the rewritten fromInsights test still sees `reason: 'need at least 2 sources'` (no top-up seam).

- [ ] **Step 3: Implement in `server/mio-intelligence-mcp/index.js`**

(a) After the `creativity-engine.js` require (line 23):

```js
const { buildAutoSources, topUpSources } = require('../creativity-sources.js')
const { runIdeaGenerate, groundingFrom } = require('../idea-generate.js')
```

(b) After the `memoryStore` declaration, add:

```js
// Second memory-store instance WITHOUT the shared queryLog: idea.generate's
// grounding recall is tool-side context gathering, not a user query — it must
// not append to queries.jsonl (that log exists for recall-style queries).
const groundingMemoryStore = createMemoryStore({
  dataDir,
  projectName,
  agentId: runtimeAgentId,
  verifiedFilter: REUSE_STATUS_FILTERS.verified,
})
```

(c) Directly above `generationSources`, add:

```js
// Local auto sources shared by generate's top-up and idea.generate — the same
// providers the CLI assembles (spec Capability 2). Every layer degrades to []
// so a missing optional package or an unreadable store never fails a tool call.
function autoSources() {
  let insights = []
  let trends = []
  try {
    if (isInsightAvailable()) insights = insightStore.list({}) || []
  } catch (_) {}
  try {
    trends = observerStore.trends({ limit: 3 }) || []
  } catch (_) {}
  try {
    return buildAutoSources({ dataDir, insights, trends })
  } catch (_) {
    return []
  }
}
```

(d) Replace `generationSources` (lines 976–987) with:

```js
function generationSources(args) {
  const supplied = args.sources
  // Nothing to top up and no fromInsights: return as-is so the engine keeps
  // throwing its documented "requires sources" error for empty calls.
  if (!args.fromInsights && !(Array.isArray(supplied) && supplied.length)) return supplied
  let base = supplied
  if (args.fromInsights) {
    if (!isInsightAvailable()) {
      throw new Error('mio.creativity.generate fromInsights requires the optional package @akemi-mio/insight')
    }
    const seeds = sourcesFromInsights(insightStore.list({}))
    if (seeds.length === 0) {
      throw new Error('mio.creativity.generate fromInsights: no stored insights yet (run `mio insight generate` first)')
    }
    base = Array.isArray(supplied) ? supplied.concat(seeds) : seeds
  }
  // Explicit sources always win; local memory/traces/stored hypotheses only
  // top a short list up to the two entries the mixer needs (spec Capability 2,
  // injection point 2 — the MCP twin of `mio creativity generate`).
  return topUpSources(Array.isArray(base) ? base : [], autoSources())
}
```

(e) In TOOLS, after the `mio.creativity.ferment` entry, insert:

```js
  {
    name: 'mio.idea.generate',
    description:
      'Generate up to 3 concrete, experiment-backed hypotheses from one goal. Sources are assembled locally (goal, context/constraints, Mio memory grounding, local memory/traces/stored hypotheses) and every idea is persisted to the CreativityStore with provenance — Mio memory is never written. Returns { ideas, generatedAt, groundedWith, persistedIds }, or { reason } when fewer than two sources are available.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The one-line goal the ideas should pursue (required).' },
        context: { type: 'string', description: 'Optional free-form background.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional hard constraints.' },
        numIdeas: { type: 'number', description: 'How many ideas to return; clamped to 1..3, default 3.' },
      },
      required: ['goal'],
    },
  },
```

(f) In `callTool`, after the `mio.creativity.ferment` case, insert:

```js
    case 'mio.idea.generate': {
      const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
      if (!goal) throw new Error('mio.idea.generate requires goal: a non-empty string')
      let grounding = { sources: [], relatedMemoryIds: [], groundedWith: 0 }
      try {
        const qr = await groundingMemoryStore.queryMemory({ query: goal, limit: 3, scope: 'all' })
        grounding = groundingFrom(qr)
      } catch (_) {}
      return runIdeaGenerate({
        goal,
        context: typeof args.context === 'string' ? args.context : '',
        constraints: Array.isArray(args.constraints) ? args.constraints.filter((c) => typeof c === 'string') : [],
        numIdeas: args.numIdeas,
        chatJson,
        store: creativityEngine.store,
        groundingSources: grounding.sources,
        relatedMemoryIds: grounding.relatedMemoryIds,
        autoSources: autoSources(),
      })
    }
```

(`scope: 'all'` — idea grounding wants global + project knowledge, and project inference can be ambiguous for tool callers.)

- [ ] **Step 4: Run and see it pass**

```powershell
npm test --prefix packages/mio-cli -- creativity
npm run check --prefix packages/mio-cli
```

Expected: PASS + syntax 0. The file's earlier tests are untouched: `MIO_DATA_DIR` keeps all state in a temp dir, and their temp homes hold no memory/traces, so top-up is a no-op for them.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/server/mio-intelligence-mcp/index.js packages/mio-cli/server/mio-intelligence-mcp/__tests__/creativity.test.js
# commit message: feat(mcp): mio.idea.generate tool + generate local source top-up
```

---

### Task 13: CLI `mio idea generate` + spawn tests

**Files:**
- Modify: `packages/mio-cli/bin/mio.js` (require, `ideaUsage`/`ideaGenerateCommand`/`ideaCommand`, help line, dispatch)
- Modify: `packages/mio-cli/__tests__/idea-generate.test.js` (append spawn tests)

- [ ] **Step 1: Append the failing spawn tests to `idea-generate.test.js`**

```js
// ─── CLI surface (spawn) ────────────────────────────────────────────────

const { spawnSync } = require('node:child_process')

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'mio.js')

function runCli(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws.mioHome,
    encoding: 'utf8',
    env: {
      ...process.env,
      MIO_HOME: ws.mioHome,
      LLM_API_URL: 'http://127.0.0.1:9/v1/chat/completions',
    },
  })
}

function seedCliMemory(ws) {
  fs.writeFileSync(
    path.join(ws.mioHome, 'memory.jsonl'),
    JSON.stringify({
      id: 'g1',
      timestamp: '2026-10-06T01:00:00.000Z',
      kind: 'decision',
      content: '延迟优化的决定：优先降低 MCP 调用延迟',
      scope: 'global',
    }) + '\n',
    'utf8'
  )
}

test('CLI: missing --goal fails with usage', () => {
  const ws = workspace()
  const out = runCli(ws, ['idea', 'generate'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /requires --goal/)
  assert.match(out.stderr, /usage: mio idea generate/)
})

test('CLI: --num must be a number', () => {
  const ws = workspace()
  const out = runCli(ws, ['idea', 'generate', '--goal', 'x', '--num', 'abc'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /--num must be a number/)
})

test('CLI: goal alone answers with a reason instead of an error', () => {
  const ws = workspace()
  const out = runCli(ws, ['idea', 'generate', '--goal', 'lonely goal'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /No ideas generated: need at least 2 sources/)
})

test('CLI: grounded end-to-end run persists drafts with provenance', () => {
  const ws = workspace()
  seedCliMemory(ws)
  const out = runCli(ws, ['idea', 'generate', '--goal', '降低 MCP 调用延迟', '--json'])
  assert.equal(out.status, 0, out.stderr)

  const payload = JSON.parse(out.stdout)
  assert.ok(payload.ideas.length >= 1)
  assert.equal(payload.groundedWith, 1)
  assert.deepEqual(payload.ideas[0].provenance.relatedMemoryIds, ['g1'])
  assert.equal(payload.ideas[0].hypothesis.status, 'draft')
  assert.equal(payload.persistedIds.length, payload.ideas.length)

  const rows = readRows(ws.file)
  assert.ok(rows.some((r) => r.id === payload.persistedIds[0] && r.provenance))
})
```

- [ ] **Step 2: Run and see it fail**

```powershell
node --test packages/mio-cli/__tests__/idea-generate.test.js
```

Expected: FAIL — `Unknown command: idea` (exit 1, stderr without `requires --goal`).

- [ ] **Step 3: Implement in `bin/mio.js`**

(a) After the `creativity-sources.js` require (added in Task 10):

```js
const { runIdeaGenerate, groundingFrom } = require('../server/idea-generate.js')
```

(b) Directly after `creativityFermentCommand`, add:

```js
function ideaUsage() {
  console.error('usage: mio idea generate --goal "one line" [--context "..."] [--constraint "..."] [--num N] [--json]')
}

async function ideaGenerateCommand(args, useJson) {
  const flags = args.slice(2)
  const goal = (optionValue(flags, '--goal') || '').trim()
  if (!goal) {
    console.error('mio idea generate requires --goal "..."')
    ideaUsage()
    process.exitCode = 1
    return
  }
  const context = optionValue(flags, '--context') || ''
  const constraints = optionValues(flags, '--constraint')
  let numIdeas
  try {
    numIdeas = parseNumberOption(flags, '--num')
  } catch (error) {
    console.error(error.message || error)
    ideaUsage()
    process.exitCode = 1
    return
  }

  // Grounding from the CLI's global MIO_HOME. A failed query degrades to "no
  // grounding" — never a hard error (spec Capability 1: local-first, tolerant).
  let grounding = { sources: [], relatedMemoryIds: [], groundedWith: 0 }
  try {
    const qr = await cliMemoryStore().queryMemory({ query: goal, limit: 3, scope: 'all' })
    grounding = groundingFrom(qr)
  } catch (_) {}

  if (!useJson) warnIfLlmUnconfigured()

  let result
  try {
    result = await runIdeaGenerate({
      goal,
      context,
      constraints,
      numIdeas,
      chatJson,
      store: cliCreativityEngine().store,
      groundingSources: grounding.sources,
      relatedMemoryIds: grounding.relatedMemoryIds,
      autoSources: cliAutoSources(),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  if (result.reason) {
    console.log(`No ideas generated: ${result.reason}`)
    return
  }
  console.log(`Generated ${result.ideas.length} idea(s) (grounded with ${result.groundedWith} memories)`)
  result.ideas.forEach((idea) => {
    console.log(`- [${idea.hypothesis.status}] ${idea.title}`)
    console.log(`  novelty=${idea.hypothesis.novelty} feasibility=${idea.hypothesis.feasibility} impact=${idea.hypothesis.impact} | ${idea.hypothesis.id}`)
    if (idea.provenance && idea.provenance.technique) console.log(`  technique=${idea.provenance.technique}`)
    if (idea.hypothesis.rejectionReason) console.log(`  rejected: ${idea.hypothesis.rejectionReason}`)
  })
  console.log(`Persisted ${result.persistedIds.length} idea(s)`)
}

function ideaCommand(args, useJson) {
  const sub = args[1]
  if (sub === 'generate') return ideaGenerateCommand(args, useJson)
  ideaUsage()
  process.exitCode = 1
}
```

(c) In `help()`, after the `mio creativity ferment` line, add:

```text
  mio idea generate --goal "..."   Grounded idea pipeline: auto sources, novelty gate, persisted (calls an LLM)
```

(d) In `main()`'s switch, after `case 'creativity': return creativityCommand(args, useJson)`, add:

```js
    case 'idea':
      return ideaCommand(args, useJson)
```

- [ ] **Step 4: Run and see it pass**

```powershell
node --test packages/mio-cli/__tests__/idea-generate.test.js
npm test --prefix packages/mio-cli
npm run check --prefix packages/mio-cli
```

Expected: PASS — all in-process + spawn tests, full mio-cli suite, syntax 0.

Notes on determinism: every spawn sets `MIO_HOME` to the test's temp dir and `cwd` there too (so the observer trends provider reads an empty `<cwd>/.local/observer`), and pins `LLM_API_URL` to a refused address. `--json` output is pure JSON (`jsonOrText`), so `JSON.parse(out.stdout)` is safe.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/bin/mio.js packages/mio-cli/__tests__/idea-generate.test.js
# commit message: feat(mio-cli): mio idea generate command with memory grounding
```

---

### Task 14: Docs & coverage gates — README, architecture.puml, MCP_TO_CLI

**Files:**
- Modify: `packages/mio-cli/README.md`
- Modify: `docs/architecture.puml`
- Modify: `scripts/check-mcp-cli-coverage.cjs`

- [ ] **Step 1: README edits**

(a) Command block — after the `mio creativity ferment` line, insert:

```text
mio idea generate --goal "..."   Grounded idea pipeline: auto sources + novelty gate, persisted (calls an LLM)
```

(b) Tool count — `MCP 服务端在 5 大域共暴露 50 个工具：` → `51`.

(c) Creativity group:

```markdown
### 创意引擎（5）
`mio.creativity.generate` · `mio.creativity.ferment` · `mio.creativity.list` · `mio.creativity.status` · `mio.idea.generate`
```

(d) Package count: `**9** 个包` → `**10** 个包`, and add a row after the `@akemi-mio/insight` row of the dependency table:

```markdown
| `@akemi-mio/creativity` | IdeaGenerator / NoveltyScorer / SourceAggregator —— `mio idea generate` 与创意引擎的生成算法（依赖 `@akemi-mio/core`） |
```

(e) Replace the whole `### 与宿主耦合的包（不发布）` section (its `workspace:*` / 「不发布 / 安装会失败」 text is now wrong — Task 17 publishes both) with:

````markdown
### 曾经不发布的两个包（现已发布）

`@akemi-mio/core` 与 `@akemi-mio/creativity` 自 `mio-agent-runtime@0.14.0` 起发布到 npm（`0.1.0`）。`@akemi-mio/creativity` 是本 CLI 的直接依赖，`@akemi-mio/core` 经由它传递引入；其它 Node 项目可直接安装这两个包。
````

(f) In the `生成与发酵` bullet list, extend the first `--source "名称|内容"` bullet — keep its existing three lines, append after `need at least 2 sources`）：

```markdown
显式来源不足 2 个时，本地自动来源（memory / traces / 已存假设；MCP 侧还含 insight 与 observer 趋势）会先把列表补齐到 2——显式 `--source` 永远排在前面且不被替换；补齐后仍不足 2 个才报上面的错。
```

(g) Insert a new subsection **before** `#### LLM 配置` (i.e. after the `失败的 LLM 调用会出现在结果里` bullet):

````markdown
### 目标驱动的 idea 流水线（`mio idea generate`）

一个 goal 直接产出可实验的假设（MCP 面为 `mio.idea.generate`），来源全程本地优先组装：

```bash
mio idea generate --goal "降低 MCP 调用延迟" --context "近三天 p95 上升" --constraint "不引入新依赖"
mio idea generate --goal "扩大命令覆盖" --json
```

- **来源顺序**：goal → context → constraints → 记忆 grounding（取前 3 条，`scope: all`）→ 本地自动来源（memory / traces / 已存假设，MCP 侧还含 insight 与 observer 趋势），按 `origin` 去重；凑不足 2 个时返回 `reason` 文案而不是报错。
- **每条 idea 都持久化**到 `<MIO_HOME>/creativity/creativity-hypotheses.jsonl`（`draft`，带 `provenance`：strategy / technique / relatedMemoryIds / 命中来源 / generatedAt），**绝不写入 Mio memory**。
- **novelty 门禁**：与已 `rejected` 假设近似重复的候选落盘为 `rejected` 并带 `rejectionReason`；与近期假设相似的只降分。拒绝的假设同样入库，供后续去重。
- `--num` 钳制在 1..3（默认 3）；`--json` 返回完整结构 `{ ideas, generatedAt, groundedWith, persistedIds }`。
````

(h) LLM 配置 paragraph — `只有 4 条命令会调用大模型：` list becomes:

```markdown
只有 5 条命令会调用大模型：`mio creativity generate` / `ferment`、
`mio idea generate`、`mio insight generate`、`mio observer ferment`。
```

- [ ] **Step 2: `docs/architecture.puml`**

Replace inside the `Idea & Evolution` card:

```plantuml
  card "Idea & Evolution (6)" as TOOLS_EVO {
    [idea.generate] as T_EVO_1
```

(The old `idea.list` never shipped; `Creativity (4)` at line 244 stays 4 — `mio.idea.generate` is counted in the EVO card, not the CREATIVITY card.)

- [ ] **Step 3: `scripts/check-mcp-cli-coverage.cjs`**

In `MCP_TO_CLI`, after the `mio.host.capabilities` line (keeps the table alphabetical: host < idea < insight):

```js
  'mio.idea.generate': ['idea', 'generate'],
```

- [ ] **Step 4: Run the doc gates**

```powershell
npm run check:coverage
npm run check:cli-docs
```

Expected:

- `MCP tools: 51 | with a CLI entry: 51 | documented: 51` + `every MCP tool is reachable from the CLI and documented`
- `README commands: 56 | probed: 56 | skipped: 0` + `all README commands resolve`

Why `mio idea generate` passes the docs probe even though it exits 1: the gate only fails on `Unknown ...` output or a `crashMarker` (opaque TypeError etc.); a usage error that names the missing flag is the contract. Baselines verified in this checkout: 50 tools / 55 README commands before this task.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/README.md docs/architecture.puml scripts/check-mcp-cli-coverage.cjs
# commit message: docs(mio-cli): document idea.generate + register its CLI mapping
```

---

### Task 15: `scripts/pack-smoke.cjs` — pack + install + export-surface probes

**Files:**
- Create: `scripts/pack-smoke.cjs`
- Modify: root `package.json` (two scripts)

- [ ] **Step 1: Add the root scripts**

In `package.json` `scripts`, after `check:mcp-live`:

```json
"smoke:pack": "node scripts/pack-smoke.cjs",
"smoke:pack:registry": "node scripts/pack-smoke.cjs --registry https://registry.npmjs.org"
```

- [ ] **Step 2: Create `scripts/pack-smoke.cjs`**

```js
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
  const dist = path.join(pkgDir, 'dist')
  if (!fs.existsSync(path.join(dist, 'index.js'))) {
    fail(`${pkgName}: ${path.join(dist, 'index.js')} missing — run the package build first`)
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
```

- [ ] **Step 3: Run it (stage 1) — after Tasks 2/3/7 have built `dist/`**

```powershell
node scripts/pack-smoke.cjs
```

Expected:

```
stage 1 (local tarballs): probe OK
stage 2 skipped (pass --registry <url> to verify the published tarball)
pack-smoke passed
```

Failure modes this is designed to catch: a missing `dist` file that `files: ["dist"]` silently drops, an exports map typo (`ERR_PACKAGE_PATH_NOT_EXPORTED` on a path that should work), a root import that starts executing electron-coupled code, and `IdeaGenerator` losing its offline template path.

Notes: temp dirs are removed only on success (a failure keeps them for inspection); paths are asserted space-free implicitly — `os.tmpdir()` and the repo path contain no spaces here, which matters because the npm fallback uses `shell: true`.

- [ ] **Step 4: Commit**

```powershell
git add scripts/pack-smoke.cjs package.json
# commit message: ci: pack-smoke gate for @akemi-mio/core + @akemi-mio/creativity
```

---

### Task 16: Version bump, dep declaration, full gate sequence

**Files:**
- Modify: `packages/mio-cli/package.json` (version + dependency)
- Modify: `package-lock.json` (via `npm install --package-lock-only` — never a bare `npm install`)

- [ ] **Step 1: Bump and declare**

In `packages/mio-cli/package.json`:

1. `"version": "0.13.5"` → `"0.14.0"` (minor: three new capabilities).
2. In `dependencies`, after `"@akemi-mio/insight": "^0.1.1"`, add:

```json
"@akemi-mio/creativity": "^0.1.0"
```

(don't forget the comma on the previous line; `@akemi-mio/core` comes in transitively via creativity and is never a direct dependency — mio-cli source does not import it).

- [ ] **Step 2: Refresh the lockfile only**

```powershell
npm install --package-lock-only
```

Expected: exit 0, `package-lock.json` gains the `packages/mio-cli` → `@akemi-mio/creativity` edge. On disk, resolution keeps working through the Task 1 junctions (root + package-level), which is why the lock refresh must not become a full `npm install`.

- [ ] **Step 3: Fresh builds + link**

```powershell
npm run build --prefix packages/core
npm run build --prefix packages/creativity
node packages/mio-cli/scripts/link-workspace.cjs
node packages/mio-cli/bin/mio.js --version
```

Expected: both builds exit 0; link prints `exists` lines (junctions from Task 1 still present); version prints `0.14.0`.

- [ ] **Step 4: Full gate sequence, in this order**

```powershell
npm test
npm run typecheck
npm test --prefix packages/mio-cli
npm run check --prefix packages/mio-cli
npm run check:cli-docs
npm run check:mcp-live
npm run check:coverage
node scripts/pack-smoke.cjs
npm run lint:scripts
npm run format:check
```

Expected, gate by gate:

| gate | expected |
|---|---|
| `npm test` | root vitest green (the new `tests/main/creativity/*` files from Tasks 8–9 run here — this is why Task 1 added the root junctions) |
| `npm run typecheck` | both tsconfigs clean |
| `mio-cli npm test` | node:test green incl. idea-generate + creativity-autosources + rewritten MCP creativity tests |
| `mio-cli npm run check` | syntax check 0 |
| `check:cli-docs` | `README commands: 56 | probed: 56 | skipped: 0` + `all README commands resolve` |
| `check:mcp-live` | `defined: 51 | dispatched: 51 | live: 51 | ... | crashed: 0 | unanswered: 0 | survived: true` — `mio.idea.generate` with `{}` must reject with its named-requirement message, not a crash marker, and without needing a SAFE_ARGS entry |
| `check:coverage` | `MCP tools: 51 | with a CLI entry: 51 | documented: 51` |
| `pack-smoke` | `stage 1 (local tarballs): probe OK` … `pack-smoke passed` |
| `lint:scripts` | 0 errors, ≤ 23 warnings |
| `format:check` | clean (`.prettierrc`: no semicolons, single quotes, width 140) |

Renderer/preload vitest configs and `check:renderer-entries` are CI's job and untouched by this work — do not block on them locally.

- [ ] **Step 5: Commit**

```powershell
git add packages/mio-cli/package.json package-lock.json
# chore(mio-cli): 0.14.0 — declare @akemi-mio/creativity dependency
```

---

### Task 17: Publish core → creativity → runtime (HARD GATE: user approval)

**No files change.** This task performs irreversible registry operations.

- [ ] **Step 1: Preconditions (all must hold before anything is published)**

```powershell
npm whoami --registry https://registry.npmjs.org
git status --porcelain
```

- `npm whoami` prints the publishing account (not a login error).
- `git status` is clean — Tasks 0–16 are committed; publish exactly what was gated.
- Task 16's gate sequence was green on this exact tree.

- [ ] **Step 2: Policy check + explicit user approval (HARD STOP)**

Call `mio-intelligence_mio_policy_check` with action
`publish npm packages @akemi-mio/core@0.1.0, @akemi-mio/creativity@0.1.0, mio-agent-runtime@0.14.0 from local commits`
and follow its suggestion. Then **ask the user for explicit approval** (the `question` tool, one choice: publish / abort). Do not proceed without an affirmative answer — spec Non-goals also pin "publishing any package besides core/creativity/mio-cli", so exactly three `npm publish` calls follow, never more.

- [ ] **Step 3: Publish core, wait for propagation**

```powershell
npm publish --workspace @akemi-mio/core --access public --registry https://registry.npmjs.org
```

`prepublishOnly` runs the build (Task 2). Poll until the registry serves it (propagation lags ~seconds to minutes):

```powershell
$v = ''
for ($i = 0; $i -lt 30; $i++) {
  $v = (npm view @akemi-mio/core version --registry https://registry.npmjs.org 2>$null | Out-String).Trim()
  if ($v -eq '0.1.0') { break }
  Start-Sleep -Seconds 10
}
if ($v -ne '0.1.0') { throw "core@0.1.0 not visible after 5 minutes (got '$v')" }
```

- [ ] **Step 4: Publish creativity, wait, then verify the REAL published artifact**

```powershell
npm publish --workspace @akemi-mio/creativity --access public --registry https://registry.npmjs.org
# then poll npm view @akemi-mio/creativity version until 0.1.0 (same loop, other name)
node scripts/pack-smoke.cjs --registry https://registry.npmjs.org
```

Expected: `stage 1 (local tarballs): probe OK`, `stage 2 (registry https://registry.npmjs.org): probe OK`, `pack-smoke passed` — this is acceptance criterion 7 (clean registry install with real subpath runs) and it must run BEFORE the runtime publish, because runtime's `@akemi-mio/creativity@^0.1.0` has to resolve from the registry.

- [ ] **Step 5: Publish the runtime**

```powershell
npm publish --workspace mio-agent-runtime --registry https://registry.npmjs.org
npm view mio-agent-runtime version --registry https://registry.npmjs.org   # → 0.14.0
```

(`mio-agent-runtime` is unscoped — public by default; `prepack` runs `npm run check`.)

---

### Task 18: Acceptance walkthrough, close-out

**Files:** none (plus one Mio memory record).

- [ ] **Step 1: Walk the spec's 8 acceptance criteria with evidence**

Re-read `docs/superpowers/specs/2026-10-07-mio-cli-creativity-upgrade-design.md` §Acceptance Criteria, and confirm each row (re-run the cited command if in doubt):

| # | Criterion | Evidence |
|---|---|---|
| 1 | `mio idea generate --goal ...` returns ideas with provenance, persists `draft`, writes no Mio Memory | `idea-generate.test.js`: `returns the spec response shape and persists drafts with provenance` (+ its `memory.jsonl` non-existence assert), `CLI: grounded end-to-end run persists drafts with provenance` |
| 2 | `list --sort novelty` orders by adjusted novelty, visible `noveltyScore`, documented as signal not grade | `creativity-list-sort.test.js` + `novelty-sort.test.ts`; help line `a dedup signal, not a quality score`; MCP sort schema description |
| 3 | every `idea.generate` idea carries `provenance.sources` `{name,type,origin,timestamp}`; prompts type-prefix sources | test1's sourceLabels⊆provenance.sources loop; `source-provenance.test.ts` (Task 5); `hypothesis-method.test.ts` + `creativity-prompt.test.ts` (Task 6) |
| 4 | `creativity-engine.js` has no inline `evaluateNovelty` | run: `Select-String -Path packages\mio-cli\server\creativity-engine.js -Pattern 'function evaluateNovelty'` → no matches; the require of `@akemi-mio/creativity/NoveltyScorer` present |
| 5 | `mio.idea.generate` in tool list; docs/counts agree (cli-docs / mcp-live green) | re-run `npm run check:cli-docs` (56) and `npm run check:mcp-live` (51, crashed 0) |
| 6 | core/creativity visible on npm; runtime@0.14.0 installs globally with creativity resolved; `mio --help` smoke | `npm view` for all three (Task 17 Steps 3–5) + the global-prefix install (Step 2 below) |
| 7 | both pack-smoke stages pass | Task 16 (stage 1) + Task 17 Step 4 (stage 2) outputs |
| 8 | all gates green: root vitest, typecheck, mio-cli test + check | Task 16 Step 4 table |

- [ ] **Step 2: Global install smoke (temp prefix — do NOT touch the user's real global mio)**

```powershell
$prefix = Join-Path $env:TEMP 'mio-global-smoke'
if (Test-Path $prefix) { Remove-Item $prefix -Recurse -Force }
npm install -g --prefix $prefix mio-agent-runtime@0.14.0 --registry https://registry.npmjs.org --no-audit --no-fund
$help = node (Join-Path $prefix 'node_modules\mio-agent-runtime\bin\mio.js') --help
if ($LASTEXITCODE -ne 0) { throw 'mio --help failed' }
if (-not ($help -match 'mio idea generate')) { throw 'help does not list idea generate' }
$cre = Get-Content -Raw (Join-Path $prefix 'node_modules\@akemi-mio\creativity\package.json') | ConvertFrom-Json
if ($cre.version -ne '0.1.0') { throw "creativity resolved to $($cre.version)" }
'global install smoke OK'
```

The user's own global install can be upgraded later with a plain `npm i -g mio-agent-runtime@0.14.0` — out of scope here.

- [ ] **Step 3: Record the durable decision**

Call `mio-intelligence_mio_memory_record`:
`kind` = `decision`, `tags` = `["release", "npm", "creativity", "idea-generate"]`, content (one paragraph): first publish of `@akemi-mio/core@0.1.0` + `@akemi-mio/creativity@0.1.0`; `mio-agent-runtime@0.14.0` declares `@akemi-mio/creativity@^0.1.0`; future core/creativity changes publish independently with the exports whitelist intact (creativity has no `.` export; core root resolves but is electron-coupled — resolve-only outside a host); idea.generate writes drafts + provenance to CreativityStore only; `--sort novelty` is a dedup signal, never a quality score.

- [ ] **Step 4: Close the task**

1. `git status --porcelain` → must be empty (everything through Task 18's docs is committed; Task 17/18 changed no tracked files beyond what earlier tasks committed).
2. `mio-taskhub_taskhub_submit_result(run_id, success: true, result: <short summary citing gates + npm versions>)` — ReadEvidence from Task 0 satisfies the gate; if it 422s on stale docs, re-run `taskhub_read_document` for the stale kinds first.
3. `mio-taskhub_taskhub_get_task 781ad045` → if the stage is still executing, `taskhub_advance_stage(target_stage: 'done', review_result: 'All 8 acceptance criteria verified; gates green; core/creativity/runtime published')`.
4. Report to the user in one sentence (success + versions), and list the standing follow-ups: **15+ local commits still unpushed** (push needs approval + `git -c http.proxy= -c https.proxy= push`), the `a53cb50` BOM amend and `CLAUDE.md.bak-mio-*` decision remain theirs, and the idea `b19bada4` (spec adopt-闭环) is intentionally left open.
