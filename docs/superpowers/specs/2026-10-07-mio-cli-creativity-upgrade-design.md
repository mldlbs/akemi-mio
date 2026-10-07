# Mio CLI Creativity Upgrade: publish @akemi-mio/creativity, idea.generate, source aggregation, novelty ranking

## Goal

Give `mio-agent-runtime` three new creativity capabilities backed by the real
`packages/creativity` source instead of inline copies:

1. `mio.idea.generate` — goal-driven idea generation (reinstated MCP tool),
   LLM-backed, persisted as draft hypotheses with provenance.
2. Source auto-aggregation — providers that collect creativity sources from
   local `MIO_HOME` data (optionally insight/observer) so callers no longer
   have to hand-pick `--source` pairs.
3. Novelty ranking — `mio creativity list --sort novelty` plus removal of the
   inline `evaluateNovelty` re-implementation in `creativity-engine.js`.

Supporting decision: publish `@akemi-mio/core` and `@akemi-mio/creativity` to
npm for the first time, superseding the README claim that both remain
workspace-only.

## Current State

- `@akemi-mio/creativity` has never been published (npm 404). Its package.json
  points `main`/`types` at `./src/index.ts`, has no build, no `files`, and
  depends on `@akemi-mio/core` with version `"*"`.
- `@akemi-mio/core` is also unpublished (npm 404), zero npm dependencies,
  `main` at `./src/index.ts`, 151 source files.
- The three capability modules have a light dependency surface:
  - `NoveltyScorer` — zero imports.
  - `SourceAggregator` — only `@akemi-mio/core/logger/Logger`.
  - `IdeaGenerator` chain — only `@akemi-mio/core/utils/random` plus the
    logger through `HypothesisGenerator`.
- `mio-cli/server/creativity-engine.js` carries an inline copy of
  `evaluateNovelty` (line 196) used by its generate gate — a drift-prone
  duplicate of the package implementation.
- `mio.idea.generate` shipped in `mio-agent-runtime@0.5.2` (2026-08-28) but the
  implementation was lost in a repository rebuild; on 2026-10-05 it was removed
  from `docs/architecture.mmd` as a dead tool. The published 0.5.2 tarball
  shows the old contract and two flaws: `description` was assembled from a
  template with **no LLM call**, and results were never persisted, so
  `list`/`ferment`/`adopt` could not act on them.
- Decision record `mem_1787836358534` (2026-08-27) defines the intended
  contract: internal strategy selection, no automatic Memory writes, structured
  provenance, agent-decided adoption.

## Decisions (confirmed with user)

1. `mio.idea.generate` and `mio creativity generate` **coexist**: the former is
   goal-driven (agent semantic trigger), the latter stays combination-driven
   with explicit `--source` inputs.
2. `idea.generate` output **is persisted** to CreativityStore as `status=draft`
   with provenance; Mio Memory writes remain forbidden (adoption is the
   agent's call, recorded via `memory.record` afterwards).
3. Source aggregation is **local-first**: default providers read `MIO_HOME`
   (memory, traces, stored hypotheses); insight and observer trends register
   only when their optional packages are available (observer needs network).
4. Novelty ranking ships as `list --sort novelty` **and** replaces the inline
   `evaluateNovelty` with the package implementation.
5. Implementation path: **publish the real packages** (Option A). Publishing
   decision for core/creativity supersedes the README workspace-only note.

## Frozen boundaries (from spec review)

1. **`idea.generate` is a one-shot stateless pipeline**, five independent
   steps: memory grounding → source aggregation → generation → novelty gate →
   persistence. No adoption, experiment tracking, or learning logic may be
   added to it later. The `experiment` field in its response is the
   pre-existing `ExperimentPlanner` output of `IdeaGenerator` (2026-08-12),
   not a new responsibility.
2. **CreativityStore vs Memory**: CreativityStore holds candidate hypotheses
   (`draft`/`active`/.../`validated`); Memory holds adopted, long-term
   experience. Generation writes only CreativityStore; a Memory write happens
   only after an agent decides to adopt, via its own `memory.record`.
3. **Source semantics must stay distinguishable**: facts, experiences,
   hypotheses, observations, and external information may not collapse into
   anonymous `{domain, content}` blobs (see Capability 2 for required fields
   and prompt presentation).
4. **Novelty is not quality**: it serves two distinct purposes — a dedup gate
   during generation and a relative ranking signal for display — and must not
   be presented or named as an idea quality score.

### Status machine (verified current behavior)

`creativity generate` persists hypotheses with `status: 'active'` after its
refined-score gate; a failed novelty check stores `rejected` directly.
`ferment` can `promote → validated` (score gate: novelty + feasibility +
impact > 200 and logic ≥ 60) or `reject`/`merge`. Both `draft` and `active`
are fermentable, so `draft` is a real initial state, not a cold storage.
There is **no `adopted` state and no adopt command** — the
`validated → adoption → Memory` leg is unverified and tracked as follow-up
work (Out of scope here).

## Architecture

### Package changes

`@akemi-mio/core@0.1.0` (first publish)

- Add `build: tsc` (outDir `dist`), `prepublishOnly`, switch `main`/`types` to
  `dist` — same pattern as the already published `@akemi-mio/insight`.
- `files: ["dist"]` plus an `exports` whitelist: `.`, `./logger/*`,
  `./utils/*`. db/credentials/ipc subpaths are intentionally absent so npm
  consumers cannot require them.
- Workspace consumers are unaffected: `tsconfig.node.json` paths, electron-vite
  aliases, and vitest aliases all resolve directly to `src` and take
  precedence over `exports`.

`@akemi-mio/creativity@0.1.0` (first publish)

- Same build/prepublishOnly/`main→dist` pattern, `files: ["dist"]`.
- Minimal `exports` whitelist: `./IdeaGenerator`, `./SourceAggregator`,
  `./NoveltyScorer`, `./types`. The root entry is not exported (its index
  chain reaches db storage); npm consumers must use subpaths, documented.
- `dependencies`: `@akemi-mio/core@^0.1.0`.

`mio-agent-runtime` `0.13.5 → 0.14.0` (minor)

- `@akemi-mio/creativity` joins **regular** `dependencies` (pure computation,
  no network), unlike the optional insight/observer packages, so the inline
  duplicate can be deleted outright.
- Publishing order: core → creativity → poll registry until visible →
  mio-cli, matching the observer/insight rollout performed on 2026-10-07.

### Capability 1 — `mio.idea.generate`

Input (kept from 0.5.2 / 8-27 record):

```json
{ "goal": "string (required)", "context": "string?", "constraints": ["string"]?, "numIdeas": 3 }
```

Flow:

1. Memory grounding: `queryMemory({ query: goal, limit: 3 })` →
   `relatedMemoryIds` plus grounding lines (v2 feature, kept).
2. Source assembly: goal/context as primary sources, grounding lines, and
   auto-aggregated local domains through `SourceAggregator`.
3. Real LLM generation: `IdeaGenerator.generateIdeas` → `HypothesisGenerator`
   → injected `chatJson`. The five-technique rotation (SCAMPER, Analogy,
   First-Principles, Random-Stimulus, Constraint-Inversion, from the 0.5.2
   table) is injected internally as the prompt method and never exposed in the
   input schema.
4. Novelty gate: `evaluateNovelty` against stored hypotheses (dedup/reject).
5. Persist each accepted idea to CreativityStore with `status=draft` and
   `provenance: { strategy, relatedMemoryIds, sources, generatedAt }`.
6. No Mio Memory writes (8-27 decision).

Response: `{ ideas: [{ title, hypothesis, experiment, novelty, provenance }],
generatedAt, groundedWith, persistedIds }`, where `groundedWith` is the number
of related memories matched (0 when grounding found nothing). The CLI flag
`--num` maps directly to the `numIdeas` input.

### Capability 2 — source auto-aggregation

New module `packages/mio-cli/server/creativity-sources.js` with providers
(default: zero network, all data under `MIO_HOME`):

| provider | domain | data |
|---|---|---|
| memory | feedback | recent decision/note entries |
| traces | behavior / failure | task_outcome success patterns + failure/error events |
| hypotheses | module / failure | stored active/rejected hypotheses |
| insight | observation | gated by `isInsightAvailable` |
| observer-trends | external | gated by `isObserverAvailable` (network) |

**Required source metadata** — `CreativitySource` already carries `type`
(knowledge/behavior/insight/failure/random/provocation/feedback) and `weight`;
the following fields are added so evidence stays distinguishable:

| field | meaning | who fills it |
|---|---|---|
| `origin` | provider + record id, e.g. `memory:mem_1791...` | provider (required) |
| `originId` | original record id for back-referencing | provider when available |
| `confidence` | 0-1 credibility hint; omit when unknowable | provider (optional) |
| `timestamp` | source record time (ISO) | provider when available |

Presentation contract: `HypothesisGenerator`'s prompt must group and prefix
sources by `type` (e.g. `[fact/trace] ...`, `[experience/memory] ...`,
`[hypothesis] ...`, `[observation] ...`, `[external] ...`) so the LLM cannot
conflate evidence classes; adding fields without prompt presentation would be
inert. Persisted `provenance.sources` on each stored idea is a per-source
summary of `{name, type, origin, timestamp}` so a reviewer can tell what
evidence an idea was based on.

Injection points:

- `idea.generate`: fully automatic.
- `creativity generate`: explicit `--source` entries win; when fewer than two
  sources remain, auto-aggregation tops up instead of returning `[]`.

Failures inside providers are already tolerated by `SourceAggregator`
(per-provider try/catch with WARN logs).

### Capability 3 — novelty ranking

One scorer, two explicitly separated roles:

- **Generation dedup gate** (absolute): inside `idea.generate`, `evaluateNovelty`
  rejects near-duplicates of rejected hypotheses and down-scores near-
  duplicates of recent ones. Its only job is preventing the same idea from
  being generated twice.
- **Ranking signal** (relative): `mio creativity list --sort novelty` scores
  every stored hypothesis against the rest, sorts by `adjustedNovelty`
  descending, and exposes the value as **`noveltyScore`** (not `score`, to
  avoid reading it as a general grade). Read-only; nothing written back.
  Bound the O(n²) pair comparison (cap ~200 stored hypotheses considered).

Explicit non-goal: `noveltyScore` is **not** an idea quality score and must
not be documented, labeled, or aggregated as one. Ranking by value/feasibility
is out of scope for this change.

- Delete the inline `evaluateNovelty` in `creativity-engine.js:196` and
  require `@akemi-mio/creativity/NoveltyScorer` directly.

## Command and MCP surface

- New CLI group: `mio idea generate --goal "..." [--context "..."]
  [--constraint ...] [--num N] [--json]` (`--constraint` repeatable).
- Extended: `mio creativity list --sort novelty`.
- New MCP tool `mio.idea.generate` (tool count 50 → 51);
  `mio.creativity.list` gains `sort?: string`.
- Documentation sync: `README.md` command/tool tables (checked by
  `check:cli-docs`), `docs/architecture.mmd`/`.puml` regain an Idea group with
  the real tool, and the 8-27 semantic-trigger guidance ("needs a new
  direction", "multiple candidates", "exploring the unknown") is documented in
  the README. Whether to add the same line to the global AGENTS.md is left to
  the user.

## Test Strategy

- Root vitest: IdeaGenerator goal-driven flow with a mocked `chatJson`;
  `creativity-sources` providers against a temporary `MIO_HOME` fixture
  (including required `origin` fields and type-prefixed prompt output);
  novelty sorting order and `noveltyScore` field.
- `mio-cli` node:test: `__tests__/idea-generate.test.js` covering both the CLI
  command and the MCP tool following the existing fake-`chatJson` pattern;
  `list --sort novelty`; regression of `creativity generate` after auto-top-up
  changes its less-than-two-sources behavior; engine tests after the inline
  scorer removal.
- **Package API compatibility smoke (two stages)**:
  1. Local: `npm pack` core and creativity, install both tarballs into a clean
     temp project, `require` each exported subpath, and actually run
     `IdeaGenerator` (stub chatJson), `SourceAggregator` (stub provider), and
     `NoveltyScorer.evaluateNovelty`.
  2. After publish: install `@akemi-mio/creativity` from the registry into a
     clean temp project (core resolves transitively) and repeat the subpath
     runs — this is the "green locally, broken after publish" guard.
- Gate run before completion: root vitest (3080 + new), typecheck:node/web,
  `mio-cli` `npm test` + `npm run check` (cli-docs, mcp-live, coverage,
  syntax).

## Risks (to verify during implementation)

1. `HypothesisGenerator` may not forward a `method` into
   `CreativityPrompt.buildSystemPrompt(method)`; if missing, add an optional
   parameter (backward compatible).
2. `chatJson` signature mismatch between `IdeaGenerator`'s expectation and
   `mio-cli`'s llm-client — a thin adapter is acceptable.
3. `list --sort novelty` pairwise Jaccard is O(n²) — cap the candidate set.
4. First `tsc` build of core/creativity must be validated (outDir layout,
   `.d.ts` emission) before publishing.

## Out of scope

- Replacing the remaining ~23 KB of `creativity-engine.js` orchestration with
  package implementations (tracked separately).
- **The `validated → adoption → Memory` lifecycle loop**: there is no adopt
  command/state today and no enforced link between a stored hypothesis and a
  later `memory.record`. Designing that contract (adopt event + required
  `hypothesis:<id>` reference in recorded Memory) is a separate follow-up task,
  not folded into `idea.generate`.
- Ranking by quality/value/impact or synthesizing a combined idea score.
- Publishing any package besides core/creativity/mio-cli.
- Changing observer/insight behavior, Memory schema, or Evolution tooling.
- Amending the pushed-history BOM commit `a53cb50` or deciding the CLAUDE.md
  backup file.

## Acceptance Criteria

- `mio idea generate --goal ...` returns LLM-generated ideas with provenance,
  persists them as `draft`, and writes no Mio Memory records.
- `mio creativity list --sort novelty` orders stored hypotheses by adjusted
  novelty with a visible `noveltyScore`, documented as a novelty signal and
  not a quality grade.
- Every stored idea from `idea.generate` carries `provenance.sources` entries
  with `{name, type, origin, timestamp}` and generation prompts show sources
  type-prefixed (evidence classes remain distinguishable end to end).
- `creativity-engine.js` contains no inline `evaluateNovelty`.
- `mio.idea.generate` exists in the MCP tool list; docs and tool counts agree
  (cli-docs / mcp-live checks green).
- `@akemi-mio/core@0.1.0` and `@akemi-mio/creativity@0.1.0` are visible on the
  npm registry; `mio-agent-runtime@0.14.0` installs globally with the
  creativity dependency resolved; `mio --help` smoke passes.
- Both package API compatibility smoke stages pass (local tarball install and
  clean registry install with real subpath runs).
- All gates green: root vitest, typecheck, mio-cli test + check.
