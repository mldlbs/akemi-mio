# 治理/审计作为产品：Policy + Evaluation 面板 Demo（设计草案）

> TaskHub: `9ec502e6` · 阶段：brainstorming → 设计草案（**未实现**，待评审）
> 关联：ADR-017 Policy/Governance 平面；TaskHub `9ac4a8f8`（Phase 0 演示，已 done，提供面板演示范式）；`07e7ed52`（可复现基准，部分重叠）

## 0. 目标与动机

ADR-017 的 Policy/Governance 平面已有真实命令，但分散在多个子命令里，外部看不到"治理态势"的整体样子。`9ec502e6` 要把它做成**可演示的产品**：一张聚合面板 + 一条可审计日志，让人一眼看到"什么被门禁拦了、策略健康度如何、演化建议是否闭环"。

## 1. 现状（as-built，已核实）

- `mio policy check "<action>" [--project X]` → `cliPolicyStore().policyCheck({action, project})`，打印单个动作的门禁结论（`packages/mio-cli/bin/mio.js` `policyCommand` 约 1296 行；`packages/mio-cli/server/policy-store.js` `createPolicyStore`）。
- `mio agents evaluation [--project X] [--since Y]` → `cliEvaluationStore().evaluate(...)`，只读输出 ADR-017 四指标：路由采纳率 / 行为改变率 / 召回质量 / 数据卫生（`packages/mio-cli/server/evaluation-store.js` `createEvaluationStore`）。
- `mio phase0 report` → Phase 0 四闸门（`phase0Command` 约 3236 行）。
- Evolution 建议状态机已落地（`evolution-suggestions.js`，PR2/PR4），建议可查询/回写路由。
- **缺口**：没有"一次看全"的聚合视图；`policy check` 的结论不落盘，无法事后审计"某次发布为什么被拦 / 谁拦的"。

## 2. 设计

### 2.1 聚合快照命令 `mio governance report`

新增只读命令，把多源汇成一张态势表：

```
mio governance report [--project X] [--json]
```

输出字段：
- **policy posture**：近 N 次 `policy check` 的 gated / total 计数、最近一次 gated 动作。
- **evaluation 4 metrics**：路由采纳率 / 行为改变率 / 召回质量 / 数据卫生（直接复用 `evaluate`）。
- **phase0 gates**：四闸门是否全绿。
- **evolution**：open / applied / expired 建议数（复用 suggestionStore 列表）。
- **data hygiene**：未采纳/过期偏好、孤立 traces 的健康度。

### 2.2 静态面板导出 `mio governance export`

```
mio governance export --out report.html [--project X]
```

生成**自包含**静态 HTML（内联 CSS/JS，无需服务器），渲染 2.1 的快照为可视化面板（卡片 + 状态色）。可直接截图/分享，构成 demo 的"产品截图"。样式复用仓库既有 `site/` 约定（若有）。

### 2.3 可审计日志 `governance_audit.jsonl`

把每次 `mio policy check` 的结论**追加**写入 `MIO_HOME/governance_audit.jsonl`（append-only，含 `action / decision / policyVersion / agentId / timestamp / reason`）。这是"审计作为产品"的核心：治理不再是一次性判断，而是一条可回溯的时间线。查询可用 `mio governance audit [--since Y]` 回放。

### 2.4 Demo 脚本

沿用 `9ac4a8f8` 的 `scripts/demo-phase0-loop.sh` 范式，新增 `scripts/demo-governance.sh`：临时 `MIO_HOME` 下 seed 若干次 `policy check`（含一次故意 gated）+ 跑 `evaluation` + `governance report` + `governance export`，证明面板端到端可用。

## 3. 安全与兼容

- `governance report` / `export` 全为**只读聚合**，不写任何业务数据。
- 审计日志 append-only；写前不必备份（追加不破坏既有记录）。
- 不改变 `mio policy check` 现有语义与退出码；审计写入对其是**附加**副作用。
- 面板 HTML 自包含、无外部请求，避免泄露本地数据到网络。

## 4. 验收标准

- `mio governance report` 至少聚合 4 个数据源且 `--json` 可机读。
- `mio governance export` 产出合法、可离线打开的 HTML，含四指标 + 门禁状态。
- 每次 `mio policy check` 后 `governance_audit.jsonl` 多一条记录；`governance audit` 可回放。
- 不回归现有 `mio policy check` / `mio agents evaluation` / `mio phase0 report` 行为（既有测试仍绿）。

## 5. 范围外 / 需协调

- 实现会新增 `bin/mio.js` 命令分支与可能的新文件 `governance-store.js`（新文件，安全）；但 `bin/mio.js` 当前被并发会话持有（`index.js` 相关 hunk 未提交）。**实现须排在并发会话落地之后**，避免冲突。
- 不引入实时 Web 服务；面板是静态导出，契合"可演示"而非"在线仪表盘"。
- 本轮仅交付设计草案，不写实现代码。

## 6. 建议拆分

- **PR-A**：`mio governance report` 聚合命令（复用 evaluation/policy/phase0/suggestion 现有读取）。
- **PR-B**：`mio governance export --out report.html` 静态面板。
- **PR-C**：`governance_audit.jsonl` 审计日志 + `governance audit` 回放。
- **PR-D**：`scripts/demo-governance.sh` 演示脚本。
