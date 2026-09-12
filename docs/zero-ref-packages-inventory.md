# 零引用包处置清单

- 生成日期：2026-09-11
- 最近更新：2026-09-11（第二轮执行后 —— 修正 B 类误判、登记 A 类执行结果）
- 数据来源：`packages/**/*.ts` 全量正则扫描 + 逐包 `package.json` 名称读取 + `index.js` 逐行审阅
- 口径：以 `@akemi-mio/<name>` 标识符在 TS 源码中的出现次数计，**0 次即零引用**

> **重要修正**：初版把 `evolution-learning` 等 5 个包判为「空壳骨架」是**误判**。
> 误判源于只统计文件数量（3 个文件 = index.js + package.json + test）而没有读内容。
> 实际它们是 `mio-cli` 的运行时模块，`index.js` 里有 82–379 行真实实现。
> 详见下方 C 类。已按实际形态重新归类。

---

## 一、总览

| 指标 | 初版 | 当前 |
|---|---|---|
| `packages/` 下包总数 | 89 | **84**（A 类 5 个已归档移除） |
| 零引用包 | 34（38%） | 29（35%） |
| 参与 TS 构建的包（有 `src/`） | 76 | **76** |

> 「参与 TS 构建」与 `tsconfig.node.json` 的 `include`
> （`packages/*/src/**/*.ts`）严格同构 —— 无 `src/` 的包贡献 0 个文件。

---

## 二、分类与建议

### A 类 · 与母包重复的音频子包 — ✅ 已执行移除

**状态：2026-09-11 已归档移除，构建与类型检查均通过。**

归档位置：`.tmp/removed-audio-subpackages-20260911/`（含 `MANIFEST.txt`，
逐文件记录了相对路径、字节数、MD5，可完整恢复）。

移除前的三重安全校验全部通过：

| 校验项 | 结果 |
|---|---|
| 子包是否有母包没有的独有文件 | **0 个**（52 个 TS 全部在 `packages/audio/src` 有对应文件） |
| 差异文件的差异性质 | 34 组内容不同，其中 27 组**仅 import 路径改写**；另 7 组为 5 个 `index.ts` 的 barrel 导出清单 + 2 个文件的悬空 `} from '...'` 行 |
| 包外引用 | **0**（唯一跨包引用是 `tts-core → piper-tts`，落在死岛内部，而 `tts-core` 自身零引用） |

| 包 | 文件数 | TS 数 | 引用次数 | 归档状态 |
|---|---|---|---|---|
| `asr` | 12 | 11 | 0 | 已归档 |
| `tts-core` | 14 | 13 | 0 | 已归档 |
| `voice-analytics` | 9 | 8 | 0 | 已归档 |
| `piper-tts` | 10 | 9 | 0（原记为 1，实为死岛内部引用） | 已归档 |
| `audio-tools` | 10 | 9 | 0 | 已归档 |

**验证结果**：删除后 `tsc -p tsconfig.node.json --noEmit` → `EXITCODE=0`；
`electron-vite build` → `EXITCODE=0`，且 `out/main/index.js` 大小与删除前
**逐字节相同（4,842.01 kB）** —— 反向证明这 5 个包从未进入构建图。

> 这 5 个包 git **未被跟踪**（`git ls-files` 返回 0），所以无法用 git 恢复，
> 归档是唯一可逆手段。若决定恢复：把目录移回 `packages/` 并还原
> `tsconfig.node.json` 中对应的 10 条 `paths`。

### B 类 · ~~空壳骨架~~ — ❌ 误判，已并入 C 类

初版列为「仅有 `index.js` + `package.json` + 测试，无实现」的 5 个包，
经逐行审阅确认**全部含真实实现**，属于 C 类独立运行时模块。见下。

### C 类 · 独立运行时模块 / 独立项目 — 保留，不参与主构建

这 7 个包构成一个自洽的 **CJS 运行时模块生态**，由 `mio-cli` 消费：

| 包 | `index.js` 行数 | 主要导出 | 说明 |
|---|---|---|---|
| `evolution-scheduler` | **379** | `createSchedulerModule`, `createSchedulePlan` | 调度器模块 |
| `evolution-learning` | **213** | `createLearningModule`, `evaluateAnalysis`, `buildReflectionSummary` | 学习/评估模块（含质量、多样性、策略合规、实质长度四个维度打分） |
| `evolution-safety` | **150** | `createSafetyModule`, `validateProposal` | 安全校验模块 |
| `evolution-strategy` | **118** | `createStrategyModule`, `buildProposal` | 策略模块 |
| `experience-memory` | **82** | `ExperienceMemory` | 经验记忆 |
| `runtime-contracts` | **73** | `createRuntimeEvent`, `EVIDENCE_KINDS` | 契约与事件定义 |
| `runtime-foundation` | **15** | `EventBus`, `JsonlStore`, `createLogger` | 基础设施 |
| 合计 | **1030 行** | | |

判定为独立生态的证据：

1. **入口在包根 `index.js`，没有 `src/`** —— 所以对 TS 构建贡献 0 个文件，
   在 TS 源码里"零引用"是正常状态，不代表死代码。
2. **`mio-cli/server/runtime-modules.js` 维护一份带健康检查的模块注册表**，
   逐个断言导出存在，例如
   `typeof module.createLearningModule === 'function' && typeof module.evaluateAnalysis === 'function'`。
3. **依赖声明用 semver 版本范围**（`"@akemi-mio/runtime-contracts": "^0.1.0"`），
   不是 workspace 协议 —— 设计上可独立发布。
4. **自带无软链兜底**：`requireWorkspacePackage(name, fallbackPath)` 先试
   `require('@akemi-mio/x')`，失败则回退到相对路径 `require('../x')` ——
   这正是为了在 `node_modules/@akemi-mio` 不存在时仍能工作。
5. 消费方齐全：`runtime-modules.js`、`evolution-cutover.js`、
   `verify-packed-runtime.js`、`__tests__/evolution-status.test.js`。

其余独立项：

| 包 | 文件数 | 包名 | 说明 |
|---|---|---|---|
| `mio-cli` | 48 | `mio-agent-runtime` | 独立 CLI，**包名不在 `@akemi-mio/*` 命名空间**，已在构建 alias 中排除 |
| `insight` | 47 | `@akemi-mio/insight` | 有 `dist/` 产物的独立发布包，被 `mio-cli` 以 npm 依赖消费 |

### D 类 · 已实现但未接线 — 保留，标记为待接线

代码完整、有实质实现，只是当前没有任何代码引用它们。**不建议删除**，应评估是否接入主流程。

| 包 | TS 数 | 内容规模判断 |
|---|---|---|
| `evaluation` | 38 | 完整评估/护栏子系统（GuardrailPipeline、MetricsEngine、AuditVerifier 等） |
| `runtime-checkpoint` | 18 | 检查点与恢复体系（Manager/Storage/RestoreCoordinator/Adapter） |
| `learning` | 15 | 学习模块 |
| `evolution-merge` | 11 | 合并流程 |
| `evolution-plan` | 8 | 计划体系 |
| `evolution-validator` | 5 | 校验器 |
| `evolution-writing` | 5 | 写作演进 |
| `evolution-chapter-consistency` | 5 | 章节一致性 |
| `evolution-failure-learning` | 5 | 失败学习 |
| `evolution-creativity-automation` | 6 | 创意自动化 |
| `evolution-mcp-cache` | 5 | MCP 缓存 |
| `evolution-memory-automation` | 6 | 记忆自动化 |
| `evolution-radar` | 6 | 雷达 |
| `evolution-plan-startup-radar` | 4 | 启动雷达 |
| `resource-control` | 6 | 资源控制 |
| `identity` | 4 | 身份模块 |
| `mcp-memory-observation` | 6 | MCP 记忆观测 |
| `anti-mcp` | 4 | 反 MCP 改写 |
| `analysis` | 2 | 分析 |
| `audit` | 2 | 审计 |
| `agent-persona` | 6 | 智能体人格 |
| `superpowers` | 2 | 技能包 |

---

## 三、执行状态

| 顺序 | 动作 | 风险 | 状态 |
|---|---|---|---|
| 1 | 与用户确认 A 类去留 | 决策项 | ✅ 已决策：删除回滚 |
| 2 | ~~删除 B 类空壳包（5 个）~~ | ~~低~~ | ❌ 撤销 —— B 类是误判，已重归 C 类保留 |
| 3 | 执行 A 类归档移除 | 中 | ✅ 已完成并验证 |
| 4 | 清理 `runtime-contracts/telegram-bot/.env` 误放 | 低 | ✅ 已归位（日志移入 `.tmp`） |
| 5 | D 类逐个评估是否接线，形成接线清单 | 低（仅评估） | ⬜ 待办 |

> C 类保留项中，`mio-cli` 与 `insight` 属于独立生态，不应纳入主仓清理范围。
> 「进化运行时」7 个 CJS 模块同理 —— 它们的引用关系在 `mio-cli` 内部，
> 用主应用的引用统计去衡量会得出错误的"零引用"结论。
