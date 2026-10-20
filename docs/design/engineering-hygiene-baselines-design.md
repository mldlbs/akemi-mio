# 工程卫生与可复现基准（设计草案）

> TaskHub: `07e7ed52` · 阶段：brainstorming → 设计草案（**未实现**，待评审）
> 关联：TaskHub `9ac4a8f8`（Phase 0 演示，已用 `scripts/demo-phase0-loop.sh` 给出可复现范式）；PR2/PR4（Evolution 闭环已实现，需补基准）；`m56-pilot-gate-check.ts`（试点门禁已存在）

## 0. 目标与动机

任务原文："关键模块补第二人评审/文档；PFL/Evolution 配可复现基准与公开演示。" 拆成两块：

1. **评审/文档覆盖**：关键模块（renderer 多形态、Evolution 状态机、机制注册表、MCP 工具面）补第二人评审记录与最小文档，降低"只有一人懂"的风险。
2. **可复现基准 + 公开演示**：PFL（试点能力）与 Evolution 这类"会自己变"的子系统，必须有**固定输入→固定输出**的基准，否则演示/回归都不可信；且应能打包成外人可一键复跑的公开 demo。

## 1. 现状（as-built，已核实）

- 仓库已有丰富的门禁脚本 `scripts/check-*.cjs`：`check-form-registry`（renderer 三处同步）、`check-idle-gpu`、`check-mcp-cli-coverage`、`check-mcp-tools-live`、`check-observation`、`m56-pilot-gate-check.ts` 等。
- 测试需 Windows EBUSY 修复 shim（`node --require <shim>`）才不出现假红——这是"可复现"的已知坑（见项目记忆）。
- Evolution 闭环（PR1–PR4）已实现：`evolution.report` → `suggestion` → `apply`（人审门禁）→ `task.route` 提升。但它目前靠实时数据，没有"固定基准集"。
- Phase 0 演示已给出可复现范式：`scripts/demo-phase0-loop.sh` 用临时 `MIO_HOME` + seed 数据跑通。

## 2. 设计

### 2.1 关键模块评审/文档清单

新增 `docs/reviews/` 目录，每个关键模块一份 `*.review.md`，含：模块职责、关键不变量、已知坑、评审结论（评审人/日期/遗留项）。首批覆盖：

- `packages/mio-cli/server/evolution-suggestions.js`（建议状态机 + 人审门禁）
- `packages/mio-cli/server/mechanism-registry.js`（机制注册/晋升）
- `packages/main`（Electron 主进程 / renderer 生命周期）
- `packages/mio-cli/server/mio-intelligence-mcp/index.js`（MCP 工具面，49 工具）

评审结论以"通过 / 有条件通过 / 阻塞"三态记录，阻塞项进 TaskHub。

### 2.2 可复现基准 harness

新增 `scripts/baseline-evolution.cjs`（PFL 同理 `scripts/baseline-pfl.cjs`）：

- **固定种子数据集**：把 PR4 e2e 用的 seed（跨 Agent outcome + traces + route_events）固化为 `tests/fixtures/evolution-baseline/` 下的版本化 jsonl。
- **基准断言**：在固定种子上跑 `evolution.report` → `suggestion.propose` → `apply` → `task.route`，断言 (a) 生成的建议 `preferAgent`/`baselineAgent` 稳定；(b) `task.route` 命中偏好后的权重提升值**精确相等**（避免"每次跑数字略变"导致 demo 不可信）。
- 接入现有 `npm test` 或独立 `npm run baseline`，作为回归闸门。

### 2.3 公开演示打包

复用 `9ac4a8f8` 的范式，新增 `scripts/demo-evolution.sh` + `scripts/demo-pfl.sh`：临时 `MIO_HOME` + 固定 fixture，输出**确定性**的成功/提升证据。打包为 `dist/demo-<feature>.zip`（含脚本 + fixture + 一段 README），外人解压即跑，构成"公开演示"。

### 2.4 门禁健康自检

针对项目记忆里"0 文件匹配 = 门禁已死"的风险，给每个 `check-*.cjs` 加一条**自检分支**：若 glob 命中 0 文件，显式报错而非静默通过（已有 `check-form-registry` 等部分实现，统一推广）。

## 3. 安全与兼容

- 基准 fixture 是只读种子，不写业务数据；放在 `tests/fixtures/` 受 git 跟踪，避免"本地有、CI 无"。
- 演示脚本沿用临时 `MIO_HOME`，不污染真实数据；`mio install <host>` 默认跳过（同 9ac4a8f8）。
- 评审文档不改动代码语义；仅补充 `docs/reviews/`。

## 4. 验收标准

- `docs/reviews/` 至少覆盖 4 个关键模块，且均有评审结论三态。
- `scripts/baseline-evolution.cjs` 在固定 fixture 上断言建议与权重提升**确定性相等**（多次运行结果一致）。
- `scripts/demo-evolution.sh` 在干净环境一键跑通并产出确定性证据；可打包为 zip。
- 所有 `check-*.cjs` 对"0 命中"显式报错（无静默通过）。

## 5. 范围外 / 需协调

- 评审涉及 `mechanism-registry.js` / `index.js`，当前由**并发会话**持有未提交改动；评审文档可先写，但"修订代码以消除评审遗留项"须排在并发会话落地后。
- PFL 的具体符号未在本仓 `mio-cli` 直接命中，落地时需先定位其真实入口（建议在 PR 启动时 `grep` 确认），本草案按"试点能力子系统"泛化。
- 本轮仅交付设计草案，不写实现代码。

## 6. 建议拆分

- **PR-A**：`docs/reviews/` 评审模板 + 首批 4 模块评审文档。
- **PR-B**：`tests/fixtures/evolution-baseline/` 固定数据集 + `scripts/baseline-evolution.cjs`。
- **PR-C**：`scripts/demo-evolution.sh` + `dist/demo-evolution.zip` 公开演示打包。
- **PR-D**：`check-*.cjs` 统一"0 命中即报错"自检。
