# Mio Agent Runtime Entry-Point Convergence

## Goal

Make `packages/mio-cli` the single maintained implementation of the
`mio-agent-runtime` distribution while preserving compatibility for repository
scripts and historical paths that still use the root-level runtime entries.

## Current State

The repository contains two runtime copies:

- `packages/mio-cli/` is the published `mio-agent-runtime` package at version
  `0.5.16`. It includes the CLI, four host adapters, the passive observer, and
  the full Mio MCP server.
- `cli/`, `adapters/`, and `server/mio-intelligence-mcp/` contain older copies
  or reduced entry points. They can drift from the published package and some
  documentation still points at them.

The rest of `server/` contains unrelated application services and is outside
this change.

## Architecture

`packages/mio-cli` becomes the canonical source of runtime behavior:

```text
published npm package
        |
        v
packages/mio-cli/
  bin/mio.js
  adapters/
  observe/
  server/mio-intelligence-mcp/

repository compatibility entries
        |
        v
root cli/, adapters/, server/mio-intelligence-mcp/
```

Root-level runtime files remain only where compatibility is useful. They
delegate to the package implementation and must not contain a second copy of
runtime behavior. The compatibility layer must resolve correctly when invoked
from the repository checkout on Windows and POSIX systems.

The root `server/` directory itself is not converted into a package shim. Only
the `server/mio-intelligence-mcp/` runtime subtree is in scope; unrelated
server services remain unchanged.

## Scope

### In scope

- Replace root `cli/mio.js` with a compatibility entry that invokes the
  canonical CLI.
- Replace root runtime adapter modules with compatibility exports, or remove
  them only when no compatibility consumer remains and the package entry is
  covered by tests.
- Replace root `server/mio-intelligence-mcp/index.js` and `phase0.js` with
  compatibility exports or equivalent delegating entries.
- Update runtime-specific documentation and examples to use
  `packages/mio-cli` or the published package layout.
- Add focused tests proving root and canonical entries expose equivalent
  behavior.
- Keep package `files`, `check`, and test behavior explicit and reproducible.

### Out of scope

- Changing Agent Registry, task routing, Evolution reporting, memory schema,
  observer semantics, or host configuration behavior.
- Refactoring unrelated application services under `server/`.
- Removing historical documentation that describes the original architecture;
  only stale executable paths and install instructions are updated.
- Publishing a new npm version as part of this change.

## Compatibility Contract

The following existing behaviors must remain valid:

1. `node cli/mio.js --help` starts successfully and reports the same command
   surface as `packages/mio-cli/bin/mio.js`.
2. Root MCP consumers can still load the runtime entry and access the same
   exported test/integration surface as the canonical MCP entry.
3. The canonical CLI continues to resolve its own server and adapter paths
   relative to `packages/mio-cli`, independent of the caller's working
   directory.
4. `MIO_HOME`, `MIO_DATA_DIR`, and `MIO_CONTEXT` retain their existing
   precedence and meaning.
5. No root compatibility entry imports the old implementation as its source of
   truth.

## Test Strategy

Tests will be added or adjusted before implementation:

- A root CLI smoke test invokes `--help` and compares the command surface with
  the canonical CLI.
- A compatibility module test loads root MCP and adapter entries and verifies
  they resolve to the canonical implementation.
- Existing package MCP tests remain the behavioral contract for registry,
  routing, evolution, memory, policy, and observer tools.
- `npm run check --workspace mio-agent-runtime` (or the package-equivalent
  command) validates every shipped JavaScript entry.
- A temporary-home smoke test exercises `init`, `status`, and `agents` without
  writing to the user's real home directory.
- `npm pack --dry-run` confirms the published package contains the canonical
  runtime tree and excludes server tests.

## Rollout and Failure Handling

The change is additive at the compatibility boundary. If a root compatibility
entry cannot be made reliable for a specific historical consumer, it remains
unchanged until a replacement test exists; no unrelated runtime behavior is
removed to force convergence.

The implementation must preserve useful error messages and non-zero exit codes
from the canonical CLI. A failed compatibility smoke test blocks cleanup of
the corresponding duplicate implementation.

## Acceptance Criteria

- There is one maintained runtime implementation under `packages/mio-cli`.
- Root runtime entries, where retained, delegate to that implementation.
- Runtime documentation no longer presents the old copies as independent
  implementations.
- Canonical package checks and all package MCP tests pass.
- Root compatibility smoke tests pass on the current Windows workspace.
- The working tree contains no accidental changes under unrelated services.
