# Phase 0 验证闭环：评估检查表（ADR-017）

> 配套 TaskHub `9ac4a8f8`：「安装一次，所有 Agent 自动接入」可演示录屏 + 评估检查表。
> 可复现演示脚本见 [`../../scripts/demo-phase0-loop.sh`](../../scripts/demo-phase0-loop.sh)。

本检查表覆盖 ADR-017 的 **4 个评估指标** 与 Phase 0 的 **4 道闸门**，全部可由命令行采集，
无需 GUI。所有命令共用一个 `MIO_HOME` 数据目录；演示时在两台宿主（如 codex + opencode）上
各自 `mio install <host>` 即达成「安装一次、所有 Agent 自动接入」。

---

## 0. 采集入口（两条命令）

| 命令 | 产出 |
|---|---|
| `mio agents evaluation --project <P> [--since ISO]` | ADR-017 四指标（只读、不写） |
| `mio phase0 report --project <P>` | Phase 0 四闸门 + 复用漏斗（只读、不写） |

其余命令用于演示闭环链路：`mio init` → `mio install <host>` → `mio task route` →
`mio experience confirm` → `mio evolution report`。

---

## 1. ADR-017 四指标（`mio agents evaluation`）

| # | 指标 | 定义 | 采集字段 | 通过阈值 |
|---|---|---|---|---|
| 1 | **路由采纳率** route adoption rate | 命中且被采纳的路由 / 路由命中总数 | `route_events.jsonl`（由 MCP 侧 `mio.task.route` 落盘，耐久） | 有 ≥1 次路由采纳即 >0%；目标：采纳率随真实使用持续 >0 |
| 2 | **行为改变率** behaviour change rate | 已确认且 `behaviorChanged` 的复用 / 复用总数 | `experience_reuse.jsonl`（需 `mio experience confirm` 才会标 `behaviorChanged`） | `verified ≥ 5`（基线 2026-08-17 为 6，需 ≥5）；目标：跨 Agent 复用被确认后趋近 100% |
| 3 | **召回质量** recall quality | 产生复用的查询 / 有结果的查询 | `route_events.jsonl` + `experience_reuse.jsonl` 关联 | `empty queries` 占比低（目标 0%）；有结果查询应导向复用 |
| 4 | **数据卫生** data hygiene | 待确认自动复用 / 复用总数 | `experience_reuse.jsonl`（`status: pending`） | `pending` 占比应尽量低；任务结局成功率趋势健康 |

### 实测样例（脚本 seed 的最小数据集，`--project acme`）

```
ADR-017 evaluation (project=acme)
   sample: queries=1 routeHits=1 reuses=1 traces=2 agents=0
   1. route adoption rate     adoption: 100% (1/1 experience hits)
   2. behaviour change rate   changed: 100% (1/1 reuses)   verified: 1   baseline 2026-08-17: 6 (required 5)
   3. recall quality          yield: 100% (1/1 queries)    empty queries: 0 (0%)
   4. data hygiene            pending: 0% (0/1 reuses)      task outcomes: 2 total, 2 success, 0 failure
```

> 注：`agents=0` 仅因示例未把 agent 注册进 `agents.jsonl`；真实多宿主演示中，`mio install`
> 会把宿主接进来，agent 数会随真实 `task_outcome` 自动累积。指标 1/3 读 `route_events.jsonl`——
> 若显示 "no data" 表示尚无路由决策落盘，而非路由未启用。生产中这些事件由 MCP 侧 `mio.task.route`
> 调用写入；演示脚本直接 seed 以证明指标**可采集**。

---

## 2. Phase 0 四闸门（`mio phase0 report`）

| 闸门 | 口径 | 通过 |
|---|---|---|
| 不同宿主数 Distinct agent hosts | 独立 Agent 宿主种类 | **2/2** |
| 任务结局 Task outcomes | 累计 `task_outcome` 条数 | **≥20** |
| 已验证跨 Agent 复用 Verified cross-agent reuses | `reuse && behaviorChanged && outcomeImproved && cross-agent` | **≥5** |
| 改善结局的复用 Reuse events with improved outcome | 上述复用的 `outcomeImproved` 子集 | **≥1** |

实测样例：

```
## Gate Status
- ✅ Distinct agent hosts: 2/2
- ❌ Task outcomes: 2/20
- ❌ Verified cross-agent reuses: 1/5
- ✅ Reuse events with improved outcome: 1/1
```

脚本仅 seed 了最小数据，故后两道闸门未达标——这是**数据量**门槛，不是能力缺口。
真实演示中用两台宿主跑若干真实任务即可填满（≥20 结局、≥5 跨 Agent 复用）。

---

## 3. 接受标准映射（TaskHub `9ac4a8f8`）

| 接受标准 | 本交付如何满足 |
|---|---|
| 可复现 demo 脚本/录屏 | `scripts/demo-phase0-loop.sh` 一键复现（MIO_HOME 指向临时目录，安全可重跑）；屏幕录屏为人工后续步骤（需真实双宿主 GUI 环境，本仓自动化不覆盖） |
| 检查表 4 指标可采集 | 上述 §1 四条均可由 `mio agents evaluation` 采集，脚本已证明其输出可解析 |
| 至少 2 宿主复用至少 1 次经验的可复现 demo | `mio install codex` + `mio install opencode` 达成「安装一次、所有 Agent 接入」；seed 数据中经验 `m1` 经 codex→opencode 跨 Agent 复用，并被 `mio task route` 命中 |

---

## 4. 演示运行（快速验证）

```bash
# 安全：MIO_HOME 指向临时目录，不污染真实数据；install 默认跳过（会改写宿主配置）
bash scripts/demo-phase0-loop.sh

# 真实录屏演示（会改写 codex/opencode 等宿主配置，需演示者确认）：
RUN_INSTALL=1 bash scripts/demo-phase0-loop.sh
```

运行后逐项核对该检查表的 §1 四指标与 §2 闸门；最小数据集下指标可采集、两道数据量闸门待真实使用填满。
