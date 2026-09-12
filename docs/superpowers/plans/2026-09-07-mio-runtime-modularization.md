# Mio Runtime Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mio-agent-runtime` a composition package that depends on independently maintained evolution modules instead of copying their implementations.

**Architecture:** Public contracts and small runtime infrastructure are separate workspace packages. Evolution capabilities are split by responsibility and expose dependency-injected APIs. `mio-agent-runtime` wires those packages into its CLI/MCP entry points; host-specific functionality remains in adapters/plugins.

**Tech Stack:** Node.js CommonJS, npm workspaces, pnpm workspace linking, Node built-in test runner, JSONL persistence.

---

## Package map

```text
packages/runtime-contracts       Public event/evidence/proposal contracts
packages/runtime-foundation      Event bus, JSONL store, IDs, errors
packages/experience-memory       Evidence and experience persistence/query
packages/evolution-learning      Evaluation/reflection/learning
packages/evolution-strategy      Strategy/proposal generation
packages/evolution-safety        Validation/checkpoint/rollback
packages/evolution-scheduler     Pipeline/scheduler/budget
packages/mio-cli                 npm composition package and CLI/MCP entry
```

## Task 1: Establish contracts and foundation packages

- [x] Implemented `@akemi-mio/runtime-contracts` and `@akemi-mio/runtime-foundation` with node:test coverage.

Create `packages/runtime-contracts` and `packages/runtime-foundation` as independent CommonJS packages with node:test coverage. Contracts must have no runtime dependencies. Foundation may depend only on contracts and Node built-ins.

## Task 2: Establish experience-memory package

- [x] Implemented `@akemi-mio/experience-memory` with injected JSONL persistence and deterministic query ranking.

Create `packages/experience-memory` with an injected data directory, JSONL stores for evidence and learned experiences, deterministic filtering, and ranking. It must work without Electron, SQLite, Drizzle, or an LLM.

## Task 3: Convert mio-agent-runtime into a composition package

- [x] Added semver dependencies, module registry, and `mio evolution status` CLI output.

Add the three packages as semver dependencies, add a runtime module registry, and expose module health through `mio evolution status`. Do not move or duplicate existing MCP implementation in this task.

## Task 4: Extract learning module

- [x] Implemented `@akemi-mio/evolution-learning` with deterministic evaluation, reflection summaries, injected LLM reflection, and injected memory learning records. Existing desktop TypeScript implementations remain in place as compatibility consumers until later host rewiring and shadow comparison tasks.

Move generic evaluation/reflection/learning behavior from `packages/evolution` and `packages/intelligence` into `packages/evolution-learning`. Inject LLM and memory capabilities; retain the current desktop implementations as compatibility consumers until parity tests pass.

## Task 5: Extract strategy and safety modules

- [x] Implemented `@akemi-mio/evolution-strategy` for deterministic proposal construction/ranking with optional injected LLM proposal summaries, and `@akemi-mio/evolution-safety` for deterministic policy validation, regression detection, checkpoint records, and host-capability rollback plans.

Move proposal generation, validation, regression detection, checkpoints, and rollback protocols into `packages/evolution-strategy` and `packages/evolution-safety`. Host mutations remain capability calls.

## Task 6: Extract scheduler and pipeline module

- [x] Implemented `@akemi-mio/evolution-scheduler` with budget/cooldown scheduling, replay cursor planning, and injected collector/executor pipeline orchestration. Desktop collectors/executors remain outside the portable package.

Move generic scheduling, cooldown, budget, replay, collector, and executor orchestration into `packages/evolution-scheduler`. Desktop collectors/executors become plugins.

## Task 7: Rewire MCP and desktop host

- [x] Added a canonical `mio-agent-runtime` module registry shared by CLI and MCP, exposed `mio.evolution.status` through MCP, and added a read-only `mio.host.capabilities` tool describing desktop adapter capability boundaries. Desktop business rewiring remains compatibility-preserving; shadow/dual-write cutover is deferred to Task 8.

Make MCP call the module APIs, add desktop host capabilities/plugins, and keep root compatibility entries delegating to the canonical runtime.

## Task 8: Shadow, dual-write, and cut over

- [ ] Shadow/dual-write observation and planning foundation implemented: `@akemi-mio/evolution-scheduler` now exposes shadow comparison, dual-write result comparison, migration diff planning, authority switch planning, dry-run-only switch application, and cutover readiness gates; MCP can record `mio.evolution.shadow.record`, `mio.evolution.dual_write.record`, assess `mio.evolution.cutover.readiness`, preview `mio.evolution.migration.plan` / `mio.evolution.authority.plan`, and dry-run `mio.evolution.cutover.apply` with `applied: false`. CLI also exposes JSON/text commands for shadow sample recording, dual-write sample recording, cutover readiness, migration plan, authority plan, and dry-run apply. Actual state migration, authoritative cutover, and compatibility-shim reduction remain intentionally gated.

Run old and modular paths in shadow/dual modes, compare outcomes, migrate state, then make the modular packages authoritative and reduce old code to compatibility shims.

## Task 9: Publish and verify

- [ ] Added and passed `npm run verify:pack-install --workspace mio-agent-runtime`: it packs all seven `@akemi-mio/*` runtime modules plus `mio-agent-runtime`, installs the local tarballs into a clean temporary npm project, and runs installed CLI smoke checks for `mio --json evolution status`, shadow sample recording, dual-write sample recording, cutover readiness, and dry-run cutover apply. The verification gate now fails closed on missing/unhealthy modules, shadow mismatch, dual-write mismatch, readiness failure, or non-dry-run cutover apply behavior, emits packed tarball size/SHA-512 evidence, can write the JSON evidence to a non-overwriting report path, and supports deterministic `MIO_PACK_WORKSPACE_ROOT`, `MIO_PACK_ARTIFACT_DIR`, `MIO_PACK_INSTALL_DIR`, and `MIO_PACK_REPORT_PATH` paths for npm/CI release evidence plus direct `--workspace-root`, `--artifact-dir`, `--install-dir`, and `--report-path` flags for node script invocation. Actual publication remains intentionally out of scope until release authorization.

Run package-level tests, workspace checks, isolated-home CLI smoke tests, `npm pack --dry-run`, and install the packed artifact in a clean temporary project before publishing.
