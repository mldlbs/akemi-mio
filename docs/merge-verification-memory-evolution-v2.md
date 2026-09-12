# Merge Verification Note: Memory Evolution v2

> Branch: `feat/evaluation-bridge`
> Merge commit: `1518b3f`
> Date: 2026-07-21

---

## Merge Info

| Source | Target | Strategy |
|--------|--------|----------|
| `feat/memory-evolution-v2` (`6d6c121`) | `feat/evaluation-bridge` (`b25ab7e`) | `--no-ff` |

### Files changed (auto-merged)

| File | v2 change | Conflict | Resolution |
|------|-----------|----------|------------|
| `SelfEvolutionService.ts` | +83 lines: event-driven trigger, memory priorities, onMemoryChangeEvent | Auto-merged | Both branches' changes preserved |
| `MemoryEvolutionBridge.ts` | 130→650 lines: v2 deep integration | None | Clean apply |
| `memory/types.ts` | `MemoryEntry.type` + 2 values | Auto-merged | Union extended with both sides |
| `evolution/index.ts` | re-export new types | Auto-merged | Re-exports extended |

---

## Test Baseline (post-merge)

### Runtime Resume (contract tests) — 62/62 ✅

| Suite | Result | Note |
|-------|--------|------|
| `WorkflowScheduler.resume.test.ts` | 9/9 | ✅ |
| `WorkflowRuntimeCheckpointableComponent.test.ts` | 26/26 | ✅ |
| `CheckpointRestoreCoordinator.test.ts` | 12/12 | ✅ |
| `ComponentRegistry.test.ts` | 10/10 | ✅ |
| `E2ERestoreValidation.test.ts` | 5/5 | ✅ |

### Memory / Evolution (non-SQLite) — 161/164 ⚠️

| Failure | Cause | Classification |
|---------|-------|---------------|
| `冷却时间过后应自动恢复` | `EvolutionCheckpointManager` requires git+SQLite | **Pre-existing** — not merge-introduced |
| Other 2 (seen in earlier run) | `git rev-parse` in test env | **Pre-existing** — requires git CWD |

### SQLite-dependent — all fail

All SQLite tests fail with **better-sqlite3 ABI mismatch** (`NODE_MODULE_VERSION 146 vs 127`). Pre-existing, not merge-introduced.

### Fix applied during verification

**`SelfEvolutionService.setPipeline()`** — added immediate `lastPipelineMetrics` read at line 201. Without this, `setPipeline` + immediate `healthCheck()` returns `pipelineQueueSize: 0` instead of the mock's configured value. This is a real initialization gap caught by the 2 2 2 2 healthCheck test (pre-existing before merge, but surfaced here).

---

## Architecture Boundary Audit

| Contract | Status | Evidence |
|----------|--------|----------|
| Runtime state → Evolution dependency | ❌ Not introduced | Evolution reads MemoryService + file system only |
| Runtime restore ↔ Evolution state | Separate | Evolution uses `evolution_state.json`, not checkpoint store |
| Memory type extension | ✅ Compatible | `evolution_insight`/`evolution_cycle` use existing `memories` table |
| Event-driven trigger (v2) | ✅ Adds no new recovery state | Subscriptions re-established on `setMemoryBridge()` |

### Dependency graph (post-merge)

```
Runtime  ──  Workflow
  │               │
  │               ▼
  │         Evidence
  │               │
  ▼               ▼
SelfEvolution ←── MemoryService ←── SQLite
  │                                    │
  └── evolution_state.json (file)      └── memories table
```

No cycles. Runtime → Evidence → Evolution is a directed acyclic graph.

---

## Files changed in this session

| File | Change |
|------|--------|
| `docs/checkpoint-component-inventory.md` | **[NEW]** Phase 1 inventory, 11 components |
| `docs/memory-evolution-v2-merge-audit.md` | **[NEW]** Merge boundary audit (A/B/C) |
| `src/main/evolution/SelfEvolutionService.ts` | Fixed `setPipeline` → read initial metrics |
