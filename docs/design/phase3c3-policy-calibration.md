# Phase 3C.3 — Policy Calibration (Shadow)

**Date:** 2026-07-24
**Upstream:** Phase 3C.2 (aa94e38), Phase 3C+ (Shadow Mode)
**Downstream:** Activation Gate → Phase 3D (Enforcement Decision)

## Shadow Data Review

### Dataset

- **Shadow decisions:** 200 (v1.0.0 only)
- **Window:** 2026-07-22T07:38 ~ 2026-07-24T05:14 (~46h)
- **Policy version:** `1.0.0`

### Distribution

| Action | Count | % |
|---|---|---|
| block | 114 | 57.0% |
| skip | 76 | 38.0% |
| execute | 10 | 5.0% |

### Breakdown by Source

| Source | block | skip | execute | Observations |
|---|---|---|---|---|
| **cicd** | 111 | — | — | `severity=error`, `level_1_propose` → block |
| **feature** | — | 39 | — | `severity=info` → auto-downgrade to skip |
| **memory** | — | 31 | — | Locked level_0 |
| **test** | — | — | 10 | `severity=error`, `level_2_execute` → execute |
| **file_organizer** | — | 6 | — | `severity=info` → auto-downgrade |
| **behavior** | 3 | — | — | `severity=error`, `level_1_propose` → block |
| **agent** | — | 1 | — | Locked level_0 |

### Block Trigger Analysis

111/114 block decisions share identical reason: `source=cicd, severity=error, level=level_1_propose`. This is a high-certainty signal: CICD collector wraps `tsc --noEmit` errors, and `level_1_propose → block` is the correct response (tsc errors must be resolved before any executor can act).

3/114 block: `source=behavior, severity=error, level=level_1_propose`.

### Execute Analysis

All 10 execute decisions come from `test` source. However, there is **no executor registered for `source='test'`**. In `tryFix()`, when no matching executor is found, the problem is auto-marked fixed (success=true, "无执行器支持 test 类型，已跳过"). So `execute` for test is effectively a no-op — the policy says "go ahead" but there's nothing to run.

This means the **real execute rate is 0%** for sources that actually have executors.

## Activation Gate Critique

Current criteria:

```
execute ≥60%   ← not achievable under current mapping (only level_2 sources can execute)
skip ≤20%      ← structurally violated by info-severity + locked sources
block =0       ← contradicts cicd protection strategy
```

These criteria were designed for a homogeneous policy. They do not match a per-source tiered strategy. **Recommendation:** Recalibrate to per-source criteria:

```
Protected Source (cicd):
  block correctness: 验证 block 是否导致进化停滞
  recovery rate: level_2_execute 兜底覆盖率
  false positive: "可自动修复但被错误阻断" 的子类型比例

Record-Only Sources (evidence/memory/agent):
  skip justification: 无意外跳过
  skip 后的 source 活跃度

Execute Sources (tsc/test/lint/log/git/runtime):
  execute success rate: 执行后修复成功率
  execute false positive: 执行后问题复现率

Candidate Sources (feature/behavior/tool/tts/blog/file_organizer):
  sample diversity: 是否覆盖不同 problem 类型
  execute eligibility: 未来可开放 execute 的条件
```

## Policy v1.1.0

### Strategy Declaration

Mapping **unchanged** from v1.0.0. The only changes:

1. **`policyVersion` constructor parameter** — enables traceability
2. **Explicit strategy doc comment** — records the intent of each source's mapping
3. **Wired in AppRuntime as `new ExecutionPolicy({ mode: 'shadow', policyVersion: '1.1.0' })`**

### Strategy by Source

```
Protected Block:
  cicd:   tsc compilation errors are high-certainty failures.
          block → level_2_execute (deepseek/agent-sdk) serves as fallback.
          Not changed to execute: no value in running executor before tsc error is resolved.

Record-Only (skip):
  evidence:   external observation, no auto-fix target.
  memory:     system state, auto-execution high risk.
  agent:      agent behavior observations, manual review required.

Candidate Execute (level_1_propose pending calibration):
  feature:   code/UI/behavior changes — potential execute candidate.
             Shadow data shows all observed severity=info (auto-skip).
             Re-evaluate when feature:error samples exist.
  behavior:  same as feature.
  tool:      configuration/analytics — low-risk, future execute candidate.
  tts:       voice preference tuning — low-risk, future execute candidate.
  blog:      content generation — supervised execution path.

Execute:
  tsc/test/lint/log/git/runtime: established auto-fix paths.
```

### Verification

- Run Phase3CPipelineGate tests — 22 pass
- After restart, new events carry `policyVersion: '1.1.0'`
- Query: `SELECT action, COUNT(*) FROM evaluation_events WHERE type='evolution.policy.decision' AND json_extract(payload, '$.policyVersion')='1.1.0' GROUP BY action`

## Next Steps

1. Resume shadow collection at v1.1.0
2. Data review after ≥50 v1.1.0 decisions
3. Recalibrate activation gate criteria per-source
4. Evaluate if any candidate sources can graduate to execute
