# ADR-017 Phase 2 — Identity / Registry Plane: As-Built Reconciliation

**Date:** 2026-10-20
**Author:** Agent (code survey)
**Status:** Reconciliation of `docs/adr-017-mio-agent-control-plane.md` §MVP Tool Surface (which lists `mio.agent.register` / `mio.agent.list` / `mio.agent.report` as **Planned / Phase 2**) against the actual code on `main`.

> Bottom line: the three tools — plus `mio.agent.evaluation` — are **already implemented, wired into the MCP server, and covered by passing tests**. The ADR label is stale. The real remaining work is *not* "implement the registry"; it is (1) making the evaluation evidence durable and (2) demonstrating the network effect with real multi-host adoption.

---

## 1. What ADR-017 said vs. what exists

| ADR-017 §MVP Tool Surface | ADR label | Actual status on `main` | Evidence |
|---|---|---|---|
| `mio.agent.register` | Planned / Phase 2 | **Implemented** | `server/agent-store.js:97` `registerAgent`; MCP def `index.js:545`; dispatch `index.js:1231` |
| `mio.agent.list` | Planned / Phase 2 | **Implemented** | `agent-store.js:27` `listAgents`; MCP def `index.js:559`; dispatch `index.js:1232` |
| `mio.agent.report` | Planned / Phase 2 (Evaluation) | **Implemented** | `agent-store.js:49` `reportAgent`; MCP def `index.js:569`; dispatch `index.js:1234` |
| `mio.agent.evaluation` | (not listed) | **Implemented** | `server/evaluation-store.js` `createEvaluationStore().evaluate`; MCP def `index.js:580`; dispatch `index.js:1236` |
| `mio.task.record_outcome` | Planned / Phase 2 | **Implemented** | MCP def `index.js:700` ("…agent registry update and auto-claim…"); dispatch `index.js:1256` |

The first validation loop ADR-017 describes in §Planned Scope is therefore **already closed in code**:

```text
agent.register  ✅ agent-store.registerAgent (upsert by agentId+project)
  -> task.route ✅ routeTask (Phase 1)
  -> execution
  -> task.record_outcome ✅ auto-updates agent registry + auto-claims reuse
  -> agent.report ✅ aggregation of task_outcomes / memory / experience_reuse
  -> agent.evaluation ✅ four ADR-017 metrics
```

---

## 2. Tool contract (as built)

All three live behind `server/agent-store.js`, a single implementation shared by the MCP server **and** the CLI (`mio agents list` / `mio agents report`), so terminal and MCP can never report divergent telemetry (by-design invariant — see file header).

### 2.1 `mio.agent.register`

Upserts an agent by `agentId + project`.

- **inputSchema.required:** `agentId`
- **params:** `agentId:string`, `hostType:string` (`mcp` | `observer` | `plugin`, default `mcp`), `capabilities:string[]`, `project:string` (defaults to current repo)
- **behavior:** new → creates record with `registeredAt`/`lastSeenAt`/`sessionCount:1`; existing → bumps `lastSeenAt`, `sessionCount += 1`, overwrites `hostType`, and overwrites `capabilities` only if non-empty.
- **errors:** throws `agent.register requires a non-empty agentId` when `agentId` blank.
- **returns:** `{ id, agentId, registered:boolean, sessionCount, hostType, capabilities }`

### 2.2 `mio.agent.list`

- **params:** `project:string` (optional filter)
- **returns:** `{ count, agents:[{ id, agentId, hostType, capabilities, registeredAt, lastSeenAt, sessionCount, taskCount, successCount, failureCount, project }] }`

### 2.3 `mio.agent.report`

Cross-references `agents.jsonl` with `traces.jsonl`, `memory.jsonl`, `experience_reuse.jsonl`.

- **params:** `agentId:string` (optional; omit = all), `project:string` (default current repo)
- **per-agent report:** `taskOutcomes{total,success,failure,successRate}`, `memories`, `experienceReuses{total,verified}`, `active` (= `lastSeenAt` within 24h).
- **"verified" definition matches ADR-017 exactly:** `confirmed && reuse && behaviorChanged && outcomeImproved`. This is the same strict filter used by the Phase-0 effective-reuse gate, so report telemetry and validation telemetry cannot diverge.

### 2.4 `mio.agent.evaluation` (bonus — beyond the ADR table)

Computes the four ADR-017 evaluation-period metrics, each reporting its **own denominator** (so `null` means "no data", never a confident `0%`):

1. **routeAdoption** — experience route-hits later linked to a reuse, over experience route-hits.
2. **behaviorChange** — `confirmed && behaviorChanged` over all reuse records.
3. **recallQuality** — queries with results linked to reuse, over queries with results; plus `emptyQueryRate`.
4. **dataHygiene** — pending auto-claims over all reuse records.

It also returns the `PHASE0_BASELINE` (`2026-08-17: hosts 3/2, tasks 176/20, verified 6/5, improved 30/1`) verbatim so numbers are read against the reference point the ADR asks for.

---

## 3. Data model

`agents.jsonl` (one JSON object per line) — single source of truth for the Identity/Registry plane:

```jsonc
{
  "id": "agent_<id>",
  "agentId": "codex",
  "hostType": "mcp",
  "capabilities": ["code", "analysis"],
  "registeredAt": "ISO8601",
  "lastSeenAt": "ISO8601",
  "sessionCount": 1,
  "project": "akemi-mio"
  // taskCount / successCount / failureCount populated by task.record_outcome
}
```

Source identity (`MIO_CONTEXT.agentId`) is injected into `memory.record.source` and `observer.ingest.agent` per ADR-017 §Agent Identity — registration does not re-derive identity, it records it.

---

## 4. Genuine remaining gaps (the real Phase-2 work)

The registry itself is done. What is *not* done — and what the original "Planned" label should have pointed at:

### 4.1 Evaluation evidence is not durable (P1)
`evaluation-store.js` is honest about this: metrics **1 (route adoption)** and **3 (recall quality)** are derived from `queries.jsonl`, which is the auto-claim correlation **buffer**, capped at 200 entries and pruned on a 1-hour `expiresAt` window (see `retention.js` / `query-log.js`). Measured 2026-09-20 it was **0 bytes** while `traces.jsonl` held 764 outcomes and `experience_reuse.jsonl` held 21 records. So in practice these two headline metrics read "no data" almost always — **not** because routing is unused, but because its evidence deliberately does not survive.

→ *Real task:* persist route-hit / adoption events to a **durable** log (separate from the 1-hour correlation buffer) so the control plane can actually measure its own adoption-rate success metric. This is the substance behind the original `task.route` adoption-tracking task.

### 4.2 Network effect is unproven in production (P0 moat)
The code supports N agents sharing one Mio server, but the ADR-017 moat ("more agents → more shared memory → value rises exponentially") is only *demonstrated* in the 2026-08-17 Phase-0 spike (2 hosts, 5 verified reuses). It is **not yet a standing, observable property** of real daily usage. The `agent.list` / `agent.report` / `agent.evaluation` tooling now makes that observable — but someone has to actually run ≥3 hosts for a sustained period and capture the metrics.

### 4.3 ADR-017 doc drift
The ADR still lists these as "Planned". It should carry an "Implemented (date)" note and point readers to this document, so the strategy doc stops understating the asset.

---

## 5. Recommended follow-ups (ordered)

1. **Close the doc drift** — annotate ADR-017 §MVP Tool Surface: `agent.register/list/report` = Implemented (this doc); `agent.evaluation` = Implemented (bonus). *(Trivial, low-risk, do first.)*
2. **Durable route-adopt evidence** — add a durable append-only log written by `task.route` + `task.record_outcome`, repoint `evaluation-store.js` metrics 1 & 3 at it. *(This is the actual remaining half of the "task.route adoption tracking" task.)*
3. **Sustained multi-host demo** — run codex + opencode + workbuddy + hermes against one Mio server; capture `agent.evaluation` over ≥2 weeks; publish the adoption-rate number. *(Proves the moat; feeds the TaskHub demo task.)*

---

## 6. Test coverage (already present)

`server/mio-intelligence-mcp/__tests__/agent-registry.test.js` (9 cases) covers: create / upsert / requires-agentId / separate-record / list-all / list-by-project / list-unknown-project / report-specific / report-all / report-by-project. `agent-command.test.js` covers the CLI dual (`mio agents list` / `report`) and the "preview must not write agents.jsonl" invariant. `evaluation-store.js` is exercised by `evaluation` tool tests. **No new tests are required to call T3 done.**
