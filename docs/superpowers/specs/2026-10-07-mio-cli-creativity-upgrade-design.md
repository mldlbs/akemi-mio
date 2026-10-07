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

Injection points:

- `idea.generate`: fully automatic.
- `creativity generate`: explicit `--source` entries win; when fewer than two
  sources remain, auto-aggregation tops up instead of returning `[]`.

Failures inside providers are already tolerated by `SourceAggregator`
(per-provider try/catch with WARN logs).

### Capability 3 — novelty ranking

- `mio creativity list --sort novelty`: score every stored hypothesis with
  `evaluateNovelty(candidate, recent, rejected)`, sort by `adjustedNovelty`
  descending, expose a `score` field. Read-only; nothing is written back.
  Bound the O(n²) pair comparison (cap ~200 stored hypotheses considered).
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
  `creativity-sources` providers against a temporary `MIO_HOME` fixture;
  novelty sorting order and score field.
- `mio-cli` node:test: `__tests__/idea-generate.test.js` covering both the CLI
  command and the MCP tool following the existing fake-`chatJson` pattern;
  `list --sort novelty`; regression of `creativity generate` after auto-top-up
  changes its less-than-two-sources behavior; engine tests after the inline
  scorer removal.
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
- Publishing any package besides core/creativity/mio-cli.
- Changing observer/insight behavior, Memory schema, or Evolution tooling.
- Amending the pushed-history BOM commit `a53cb50` or deciding the CLAUDE.md
  backup file.

## Acceptance Criteria

- `mio idea generate --goal ...` returns LLM-generated ideas with provenance,
  persists them as `draft`, and writes no Mio Memory records.
- `mio creativity list --sort novelty` orders stored hypotheses by adjusted
  novelty with a visible score.
- `creativity-engine.js` contains no inline `evaluateNovelty`.
- `mio.idea.generate` exists in the MCP tool list; docs and tool counts agree
  (cli-docs / mcp-live checks green).
- `@akemi-mio/core@0.1.0` and `@akemi-mio/creativity@0.1.0` are visible on the
  npm registry; `mio-agent-runtime@0.14.0` installs globally with the
  creativity dependency resolved; `mio --help` smoke passes.
- All gates green: root vitest, typecheck, mio-cli test + check.
