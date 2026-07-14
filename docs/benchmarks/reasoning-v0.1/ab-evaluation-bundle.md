# Evaluation Bundle v0.1 — PromptBuilder A/B Test

## Usage

1. Run against v1 (translateV1) — fill response_v1
2. Run against v2 (translate) — fill response_v2
3. Blind review — fill blind_review without peeking at version
4. Repeat for full set, then count B > A / A > B / tie

---

## Sample 1: A-Q04

**input:** 为什么用 Rust 写系统软件比 C 更安全？
**expected_capability:** [compare_options, explain_causality, analyze_tradeoff]

**prompt_v1:** 【推理框架】分析因果关系：先明确前因后果链，再给出结论。按因果顺序叙述，说明每一步推导的依据。
**prompt_v2:** 【推理框架】按因果分析结构组织回复：先给出分析对象或现象定义，然后分解影响因素，再梳理因果关系链，最后得出结论。按因果顺序叙述，说明每一步推导的依据。

**response_v1:**
**response_v2:**

**blind_review:**
  better: (A / B / tie)
  reason:
  templated: (yes / no)
  prompt_adherence:
    - defines_object: (yes / no)
    - decomposes_factors: (yes / no)
    - causal_chain: (yes / no)
    - conclusion: (yes / no)

---

## Sample 2: A-Q06

**input:** Guardrail Coverage 为什么会这么低？
**expected_capability:** [analyze_data, identify_root_cause, provide_inference]

**prompt_v1:** 【推理框架】分析因果关系：先明确前因后果链，再给出结论。按因果顺序叙述，说明每一步推导的依据。
**prompt_v2:** 【推理框架】按因果分析结构组织回复：先给出分析对象或现象定义，然后分解影响因素，再梳理因果关系链，最后得出结论。按因果顺序叙述，说明每一步推导的依据。

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - defines_subject: (yes / no)
    - decomposes_factors: (yes / no)
    - causal_chain: (yes / no)
    - conclusion: (yes / no)

---

## Sample 3: A-Q08

**input:** 这个性能瓶颈在什么条件下会出现？
**expected_capability:** [analyze_conditions, identify_triggers, explain_factors]

**prompt_v1:** 【推理框架】分析因果关系：先明确前因后果链，再给出结论。按因果顺序叙述，说明每一步推导的依据。
**prompt_v2:** 【推理框架】按因果分析结构组织回复：先给出分析对象或现象定义，然后分解影响因素，再梳理因果关系链，最后得出结论。按因果顺序叙述，说明每一步推导的依据。

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - defines_object: (yes / no)
    - decomposes_factors: (yes / no)
    - causal_chain: (yes / no)
    - conclusion: (yes / no)

---

## Sample 4: D-D01

**input:** PostgreSQL 还是 SQLite？
**expected_capability:** [compare_options, analyze_tradeoff, justify_recommendation]

**prompt_v1:** 【推理框架】在约束下比较各选项：明确评估标准 → 逐项对比 → 给出推荐。结构化对比，让差异一目了然。在明确的标准下比较
**prompt_v2:** 【推理框架】按决策分析结构组织回复：明确决策目标和评估标准，列出候选方案，逐项对比权衡利弊，最后给出推荐和适用条件。结构化对比，让差异一目了然。在明确的标准下比较

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - clarifies_goal: (yes / no)
    - lists_criteria: (yes / no)
    - compares_candidates: (yes / no)
    - states_applicability: (yes / no)

---

## Sample 5: D-D05

**input:** 用微服务还是单体架构？
**expected_capability:** [compare_options, analyze_constraints, justify_recommendation]

**prompt_v1:** 【推理框架】在约束下比较各选项：明确评估标准 → 逐项对比 → 给出推荐。结构化对比，让差异一目了然。在明确的标准下比较
**prompt_v2:** 【推理框架】按决策分析结构组织回复：明确决策目标和评估标准，列出候选方案，逐项对比权衡利弊，最后给出推荐和适用条件。结构化对比，让差异一目了然。在明确的标准下比较

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - clarifies_goal: (yes / no)
    - lists_criteria: (yes / no)
    - compares_candidates: (yes / no)
    - states_applicability: (yes / no)

---

## Sample 6: D-D08

**input:** 你觉得我们应该重构这部分代码吗？
**expected_capability:** [evaluate_option, analyze_risk, provide_recommendation]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)

---

## Sample 7: P-P01

**input:** 怎么实现这个功能？
**expected_capability:** [decompose_steps, plan_process, identify_key_difficulties]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)

---

## Sample 8: P-P02

**input:** 如何从单体迁移到微服务？
**expected_capability:** [plan_process, list_stages, identify_risks]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)

---

## Sample 9: P-P10

**input:** 如何保证这次上线不出问题？
**expected_capability:** [plan_process, list_checklist, propose_rollback]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)

---

## Sample 10: C-C03

**input:** 这个 API 的 README 应该怎么写？
**expected_capability:** [organize_content, plan_structure, list_key_points]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)

---

## Sample 11: C-C07

**input:** 画一个架构图来描述这个系统
**expected_capability:** [plan_structure, list_components, describe_relationships]

**prompt_v1:** (none — no pattern detected)
**prompt_v2:** (none — no pattern detected)

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence: (N/A — no prompt injected)

---

## Sample 12: C-C09

**input:** 给这个模块写一个测试计划
**expected_capability:** [plan_test_scope, list_cases, describe_strategy]

**prompt_v1:** 【推理框架】按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。先给出结论，再展开分析过程。先明确目标和约束再分析方案
**prompt_v2:** 【推理框架】按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。先给出结论，再展开分析过程。先明确目标和约束再分析方案

**response_v1:**
**response_v2:**

**blind_review:**
  better:
  reason:
  templated:
  prompt_adherence:
    - identifies_constraints: (yes / no)
    - lists_options: (yes / no)
    - analyzes_risk: (yes / no)
    - justifies_recommendation: (yes / no)
