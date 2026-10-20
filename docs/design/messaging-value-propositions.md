# 方法论黑话 → 价值句翻译（对外文案草案）

> TaskHub: `48154ab8` · 阶段：brainstorming → 文案草案（**未接站点/未替换 README**，待评审）
> 关联：TaskHub `0b0303bf`（战略定位：让 Mio = Agent Control Plane，README 已带该叙事）；TaskHub `9ec502e6`（治理/审计产品化）

## 0. 目的

ADR-017 内部用六平面（Identity/Registry、Memory、Observation/Evaluation、Routing/Scheduling、Policy/Governance、Evolution）描述架构。对外文档/站点若直接搬运这些词，读者（开发者/决策者）看不出"对我有什么用"。本草案把每个能力翻译成**用户视角的价值句**，供站点首页、README 顶部、演示脚本旁白复用。

## 1. 能力 → 价值句映射

| 内部术语 | 对外价值句（草稿） |
|---|---|
| Agent Control Plane | 一层宿主无关的智能体控制平面：记忆、观察、策略、演化一次安装，被你所有的 Agent 共享。 |
| Identity / Registry | 每个 Agent 一次登记，全局可识别——不再为每个工具重复配一遍接入。 |
| Memory（跨 Agent 记忆） | 一个 Agent 学到的，其他 Agent 下次直接用——经验不再锁在单个会话里。 |
| Observation / Evaluation | 看得见"哪条路由真被采纳、哪个 Agent 更靠谱"——决策有据，不再是玄学调参。 |
| Routing / Scheduling | 任务自动分到最合适的 Agent，并按真实表现持续优化权重。 |
| Policy / Governance | 发布/敏感操作前自动过门禁，且每一次拦截都可审计、可追溯。 |
| Evolution（自动建议 + 门禁发布） | 系统自己发现"换 A 比 B 好"，经人审后灰度切换——能力随使用自进化。 |
| 安装一次、所有 Agent 接入 | 装一次，codex / opencode / workbuddy / claude 全部自动连上，零逐个配置。 |

## 2. 一句话定位（站点/Hero 候选）

> **Mio 是你的 Agent 控制平面。** 记忆、观察、策略、演化一次安装，被你团队里所有的 Agent（codex、opencode、workbuddy、claude）共享——它不取代任何宿主，而是统一管理它们的行为与成长。

## 3. 三档叙述（按受众）

- **开发者（技术）**：列出六平面的工具名与 `mio` CLI 子命令（`mio task route` / `mio agents evaluation` / `mio policy check` / `mio evolution report`），用命令说话。
- **团队负责人（管理）**：强调"统一治理 + 可审计 + 跨 Agent 复用经验"，降低多 Agent 协作的混乱与风险。
- **决策者（商业）**：强调"一次接入、持续自进化、可控可审计"，把 Agent 投资变成可度量、可治理的资产。

## 4. 使用约定

- 价值句一律从**用户收益**出发，不出现"平面/调度/观测"等内部词。
- 出现内部术语时，紧跟一句括号解释或链接到对应能力页。
- 本草案是素材库，最终由站点/README 文案统一消费；不与并发会话正在改的 README 内容硬冲突（仅作参考源）。

## 5. 待办

- [ ] 站点 `site/` 首页套用 §2 Hero + §1 价值句。
- [ ] README 顶部"为什么用它"段落改用价值句改写（不与并发会话的 README 编辑冲突前提下）。
- [ ] 演示脚本旁白复用 §3 三档叙述。
