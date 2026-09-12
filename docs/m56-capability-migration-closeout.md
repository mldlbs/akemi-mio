# M5.6.4 Capability Migration Closeout - 2026-08-10

**Status:** Implementation Complete + Migration Gate PASS (real observation data)
**M5.6.5:** Cutover Review executed 2026-08-10 -> HOLD (C1 73.4%), re-review after coverage remediation -> PASS (C1 100%)
**Authority:** No capability-first execution authority granted (bounded capability-led pilot authorized; no executor authority change)
**M5.6.5 pilot:** activated 2026-08-11 (CapabilityPilotDecisionGate wired into PipelineOrchestrator Phase 1.6; records under reports/m56/pilot/). Exit monitor added 2026-08-11 (CapabilityPilotHealthMonitor + scripts/m56-pilot-health-check.ts)
**Next:** M5.6.6+ full cutover after pilot exit criteria

## Summary

M5.6.4 shadow migration infrastructure is closed out with a real-data gate pass. The migration report CLI now hydrates legacy problem candidates from the runtime shadow observation store instead of empty in-memory collectors, and the migration gate evaluates real observation data for the first time.

## Real Observation Result

| Metric | Target | Actual | Result |
|---|---:|---:|---|
| Observation Window | >= 1000 candidates or >= 7 days | 250 candidates / 7.01 days | PASS |
| Identity Coverage | >= 90% | 100% | PASS |
| Capability Traceability | 100% | 100% | PASS |
| Legacy-only Ratio | < 10% | 0% | PASS |
| Decision Consistency | >= 95% | 100% | PASS |
| Executor Regression | 0 | 0 | PASS |

Data source: 50 `capability-evolution-shadow-collector` runs (2026-08-03 12:27Z - 2026-08-10 12:37Z) persisted under `%APPDATA%/akemi-mio/evolution_workspace/pipeline_data/capability_evolution_shadow_runs.json`.

## Migration Artifacts

- `legacy_problem_candidates`: 250 (one per observed tool identity per run, with capability metadata)
- `capability_problem_candidates`: 4
  - `browser.automation|mixed|general` -> `browser_navigate`
  - `file.management|read|error_rate` -> `list_files`, `read_file` (aggregation of 2 tools)
  - `search.retrieval|query|general` -> `grep`
  - `system.execution|run|error_rate` -> `run_command`
- `comparison_report`: fragmentation reduction 246 (98.4%)
- `decision_diff_report`: 4 matched keys, 0 legacy-only, 0 capability-only, consistency 1.0
- `migration_gate_report`: pass
- `rollback_readiness_report`: capability authority disabled, legacy authority intact, dual-write active

Artifacts are written under `reports/m56/migration/<runId>/` and mirrored to `reports/m56/migration/latest/` (repo-local, gitignored).

## Engineering Change

- `scripts/m56-capability-migration-report.ts` (gitignored local tool): added real-data hydration from the shadow run store; gate input now uses the observed run span for `observedDays` and real candidates for `candidateCount`; falls back to in-memory collectors when the store is unavailable.
- `src/main/evolution/automation/__tests__/CapabilityMigrationReport.test.ts`: added coverage for issue-type derivation, shadow-run-to-problem conversion, and store loading.

## Guardrails Held

- `ProblemQueue`, `ToolEvolutionExecutor`, `ToolConfigOptimizationExecutor` unchanged
- `PipelineOrchestrator.runOnce()` authority flow unchanged; scheduler cadence unchanged
- No capability-first execution authority enabled
- `toolName`, provider, and affected-tool evidence preserved in all legacy paths

## Notes

- `ProblemErrorType.test.ts` timeout classification was fixed in the M5.6.5 change set (TIMEOUT rule now matches before TRANSIENT).
- M5.6.5 Cutover Review should consume the `migration_gate_report` + `rollback_readiness_report` before any capability-priority decision authority discussion.
