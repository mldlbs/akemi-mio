# 包能力复用分析（2026-09-12）

- 数据来源：`packages/` 84 包全量扫描（package.json 依赖 + src 规模）+ `docs/zero-ref-packages-inventory.md` 既有分类 + core 依赖抽样
- 核心事实：**全仓只有 1 个包有外部 npm 依赖**（updater → electron-updater），其余全部零外部依赖。复用瓶颈只有一个——对 `@akemi-mio/core`（Electron 主进程 logger/EventBus/db/ipc）的内部依赖。

---

## 一、已完成的复用（不用再动）

| 能力 | 消费方 | 状态 |
|---|---|---|
| `@akemi-mio/observer`（采集/趋势/深研/DAG/世界模型，零依赖） | mio-cli npm 依赖 | ✅ 已发布 0.1.0 |
| `@akemi-mio/insight`（自观测洞察引擎，零依赖） | mio-cli npm 依赖 | ✅ 已发布 0.1.0 |
| C 类 CJS 运行时 7 包（evolution-learning/safety/scheduler/strategy、experience-memory、runtime-contracts/foundation，1030 行） | mio-cli `runtime-modules.js` 注册表 | ✅ 已发布 0.1.0，健康检查齐全 |
| mio-cli 自身（`mio-agent-runtime`） | npm 全局安装 | ✅ 0.5.22 |

## 二、立即可复用（零内部依赖，抽出即发，改造成本 ≈ 0）

> **状态更新（2026-09-12 下午）**：`analysis` 与 `messaging` 通用层已完成独立构建配置（insight 模式），dist 构建通过、功能冒烟通过、typecheck:node 零回归——npm 面就绪。备注：`ExternalMessageGateway` 本就是 C2 设计的纯编排器（agent/renderer/outbox 全部构造注入），messaging 的 index.ts 天然只导出通用层；`ModuleScanner` 能力弱于手写的 `scan-packages.cjs`（无依赖图/规模统计），后者仍是本仓扫描的首选工具。

| 包 | 规模 | 能力 | 复用方向 |
|---|---|---|---|
| **`analysis`** | 2 文件 / 3KB | ModuleScanner 包静态扫描（依赖图/引用统计） | 正是本次手工写 `scan-packages.cjs` 干的事——已有现成实现，可并入 mio-cli 或发 npm |
| **`superpowers`** | 2 文件 / 4KB | 按目标上下文选方法论 | mio-cli 的 task.route 增强 |
| **`messaging`**（部分） | 21 文件 / 197KB | `ExternalMessageGateway` / `OutboxWorker`（通用外发消息+可靠投递队列）；telegram/radar 子树为领域特化 | 拆出 gateway+outbox 通用层，给 mio-cli 通知推送（digest 完成提醒等）复用 |
| evolution-* 零依赖采集器族（asr 81KB / radar 60KB / chapter-consistency 51KB / memory-automation 48KB / tts-automation 35KB / creativity-automation 30KB / mcp-cache 39KB） | 各 5-8 文件 | 「采集器 + 执行器」优化模式，互相独立 | 模式可复制到任意指标优化场景；单包领域较窄，按需取用 |

## 三、低成本高价值（仅依赖 core 的 logger/eventBus，注入解耦即可复用）

抽样证实 core 依赖形态：基本全是 `import { log } from '@akemi-mio/core/logger/Logger'` 与 `eventBus`，个别 `db/schema`。

| 包 | 规模 | 能力 | 解耦成本 |
|---|---|---|---|
| **`evaluation`** | 38 文件 / 237KB | GuardrailPipeline、MetricsEngine、AuditVerifier、RetentionScheduler 完整评估护栏子系统 | 把 `log`/`eventBus` 改构造注入，db/schema 换 JsonlStore（runtime-foundation 已有 JS 版）——半天级 |
| **`reasoning`** | 14 文件 / 97KB | 纯函数评分推理规划器（自称 pure functions，实际只 import log） | 2 处 log 注入，一小时级 |
| **`runtime-checkpoint`** | 18 文件 / 54KB | 检查点创建/存储/恢复/协调 | 同 evaluation 模式 |
| **`resource-control`** | 6 文件 / 34KB | 资源预算、任务运行器、调度 | 小 |
| **`agent-persona`** | 6 文件 / 59KB | 漂移控制、内容分类、用户行为分析 | 小 |

> 解耦后的归宿：mio-cli（evaluation→经验证据评分、resource-control→observer 任务预算）或独立 npm 包。**优先级建议：reasoning > resource-control > evaluation > runtime-checkpoint > agent-persona。**

## 四、不值得单独复用（领域特化 / Electron 耦合）

- **Electron 特性包**：main、updater、image（ComfyUI）、voicenote、blog、monitoring、platform（telegram/uumit）——离开主应用无意义。
- **evolution-* 领域小包 20+**（1.0.0 版本的 merge/plan/validator/goals/cicd/feedback 等内部互相引用成网）：拆散成本 > 复用收益，作为整体在主应用内使用。
- **大型母包**（evolution 128 文件 / audio 109 / capabilities 161 / intelligence 157）：是主应用的层，不是库；其中通用内核（logger/EventBus/config/JsonlStore）已有 JS 精简版 `runtime-foundation`，TS 版如需对外，走「从 core 抽 @akemi-mio/foundation-ts」路线，而不是拆母包。

## 五、结论

1. 复用的正确路径 = **看「对 core 的依赖深度」**，不看包大小。零依赖的 8 个包今天就能发；只 import logger 的 5 个中坚包（合计 ~480KB 实现）值得花一天注入化。
2. 最被低估的两个：**`analysis`（包扫描器，手写重复了它）和 `messaging` 的 gateway/outbox 通用层**。
3. 别拆母包；core 的通用部分如果要用，抽一个 TS 版 foundation，一次解决所有第三梯队。

---

## 勘误（2026-09-12 下午，解耦实测后）

动手解耦第三梯队时全量 grep 消费方（`@akemi-mio/<pkg>` 全仓、含 tests），发现**第三梯队 5 包中 3 个是零引用死包**：

| 包 | 实际消费方 | 处置 |
|---|---|---|
| `reasoning` | 仅契约测试（tests/main/reasoning，69 例，走 deep source 路径） | ✅ 已解耦（1f9ad483），npm 面就绪 |
| `resource-control` | 零引用 | ✅ 已解耦（1f9ad483）——作为独立库成立，风险为零 |
| `agent-persona` | 零引用 | ✅ 已解耦（fdf1a6c2）——能力真实可复用，npm 面就绪 |
| `runtime-checkpoint` | 零引用；**活体实现已整体复制到 `intelligence/src/runtime/`**（WorkerContract/RuntimeTaskImpl/AgentSupervisor 等平行拷贝） | ⛔ 解耦已回退，列为归档候选 |
| `evaluation` | 零引用 | ⛔ 不投入，列为归档候选（237KB 最大的死代码） |

**教训修正**：第三节的「低成本高价值」判断只看了依赖形态，没验消费方。正确顺序应是 **消费方 > 依赖深度 > 规模**——先确认有消费方或独立复用场景，再谈解耦。`evaluation`/`runtime-checkpoint` 的处置建议是**归档或删除**（需用户确认），而不是花半天解耦一个没人用的包。
