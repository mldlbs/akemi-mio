# ADR-013: Session Memory Architecture — Event-Driven Memory Layer

**Status:** Draft — Phase 1 ✅ | Phase 2 ✅ Closed (sm-obs-v2) | Phase 3 🔓 Design Ready
**Date:** 2026-07-23
**Updated:** 2026-07-24 (Phase 2 Closed)
**Supersedes:** None
**Superseded by:** None
**References:**
- ADR-004 — Decision Delivery Contract (Event → Decision 范式)
- ADR-012 — Runtime Evolution Governance Gate (治理门复用)
- `src/main/memory/MemoryService.ts` — 现有 Memory Service 入口
- `src/main/agent/ChatExecutor.ts` — 当前 Session 管理代码
- `src/main/agent/context.ts` — System Prompt 构建
- `src/main/agent/WorkingMemory.ts` — AttentionSet, Scratchpad
- `src/main/memory/InteractionTracker.ts` — 当前交互环形缓冲区
- `src/main/memory/MetaController.ts` — 当前 P0→P1 沉淀

---

## Context

当前 Mio 的记忆架构存在一个根本性缺陷：**跨会话记忆丢失**。

### 现状

```
Chat 30min+ gap
      ↓
新 Session（resolveSessionId）
      ↓
只加载当前 session 的 messages 到 context
      ↓
旧 session 的交互、事实、决策全部不可见
      ↓
用户："你怎么不记得了？"
```

当前恢复手段只有：

1. **`MemoryService.getFormattedContext()`** — 从 `entries[]` 取 `user_fact` + VectorMemory 语义召回 + SummaryMemory 摘要
2. **Session 历史 message 回放** — 只回放当前 session

这两个手段都不可靠：

- `user_fact` 需要用户显式说"记住"或经过缓慢的置信度晋升
- `SummaryMemory` 的摘要生成在没有 LLM 时只是截断文本
- VectorMemory 需要 embedding，且依赖 `lastUserText` 触发语义检索
- **没有任何机制在 session 切换时主动恢复旧会话的上下文**

### 根因分析

| 问题 | 根因 |
|------|------|
| Cross-session 无记忆 | ChatExecutor 只按 session_id 加载历史，不查询其他 session |
| 事实提取不可靠 | 依赖 `remember_fact` 工具或 `InteractionTracker` 被动检测，无独立 FactExtractor |
| 决策丢失 | `digest` 是自然语言文本，`decisions[]` 没有被结构化存储 |
| 摘要质量差 | 无 `summaryLLM` 时退化为截断原文 |
| 注入方式危险 | 直接拼入 system prompt，长期会导致 context 爆炸 |

---

## Decision

### 决策 1：Session 是生命周期单位，不是记忆边界

Session 切分规则保持不变：

```typescript
// ChatExecutor.resolveSessionId() — 保留现有逻辑
const THIRTY_MIN = 30 * 60 * 1000
const MAX_MESSAGES = 50       // 新增：消息数阈值
const EXPLICIT_RESET = /^(重置|reset|新会话|new session)/i
```

但 Session 不再是记忆的边界。语义关联可以跨 session：

```
Session A (上午：讨论 Evaluation 架构)
  ↓
Session B (下午：继续 Evaluation 架构)  ← 语义未断
  ↓
Session C (三天后：开始 Memory 层)     ← 话题转移但 retention 需要保留
```

每个 Session 独立编译为结构化产物，Retrieval Layer 按 relevance 跨 session 检索。

### 决策 2：Session Compaction 输出结构化产物，而非自然语言摘要

每个 Session 触发 compaction 的时机为 ChatExecutor 回复完成后。无独立 timer 轮询。

```typescript
// ChatExecutor.reply() 完成后
afterReply:
  const shouldCompact =
    messages >= MAX_MESSAGES ||
    estimatedTokens >= TOKEN_THRESHOLD ||
    idleSinceLastActivity > IDLE_THRESHOLD

  if (shouldCompact) sessionMemory.compact(currentSessionId)
```

Timer 仅用于兜底清理：长期未活动的 session cleanup，不负责主要 compaction 触发。

Compaction Worker 写出：

```typescript
interface SessionCompaction {
  id: string
  sessionId: string
  source: 'electron' | 'telegram'

  // 自然语言摘要（供 LLM 阅读）
  digest: string

  // 结构化字段（供检索使用）
  topics: string[]
  entities: Array<{ name: string; type: string; salience: number }>

  // 事实变更追踪
  facts: FactChange[]
  decisions: DecisionRecord[]
  unresolved: string[]          // 未解决的问题/待办

  // 元数据
  importanceScore: number
  messageCount: number
  tokenCount: number
  sessionStartAt: number
  sessionEndAt: number
  createdAt: number
}

interface FactChange {
  subject: string
  type: 'new' | 'changed' | 'invalidated'
  oldValue?: string
  newValue: string
  confidence: number
}

interface DecisionRecord {
  subject: string
  decision: string
  alternatives?: string[]
  rationale?: string
  confidence: number
}
```

**决策依据：**

- `digest` 适合 LLM 阅读（注入 context）
- `topics/entities` 适合检索匹配
- `facts` 和 `decisions` 支持冲突检测、事实更新、Evolution 分析
- `unresolved` 防止待办丢失

### 决策 3：Fact 提取独立为 FactExtractor 层

当前 `user_fact` 的提取途径是：

```
remember_fact 工具调用（显式）
InteractionTracker.detectExplicitRemember()（规则匹配）
    ↓
MemoryService.addEntry('user_fact', ...)
    ↓
getFormattedContext() 输出
```

升级为：

```
Session Event Stream
      ↓
FactExtractor
      |
   +-- new facts      → MemoryService.addEntry('user_fact', ...)
   +-- changed facts  → MemoryService.updateEntry(...) + 记录变更历史
   +-- invalidated    → MemoryService.demoteEntry(...) + 保留归档
```

FactExtractor 的输入不是文本，是 events：

```typescript
interface ConversationEvent {
  type: 'USER_MESSAGE' | 'ASSISTANT_REPLY' | 'TOOL_CALL' | 'DECISION' | 'FACT_CHANGE'
  payload: any
  timestamp: number
  sessionId: string
}
```

这与 Evaluation 系统的 `EvaluationEvent` 同源。

### 决策 4：Memory 通过独立的 Context Layer 注入，不嵌入 System Prompt

当前注入方式：

```
System Prompt
  ├── PropmtIdentity
  ├── PROMPT_TTS
  ├── PROMPT_CORE
  ├── [长期记忆]          ← 拼入 system prompt
  ├── [行为偏好]
  └── ...
```

目标注入方式：

```
LLM Request
  │
  ├── System Prompt (角色、能力、约束)
  │     └── 不含动态记忆内容
  │
  ├── Memory Context (独立 block)
  │     ├── 相关会话摘要 (digest)
  │     ├── 活跃事实 (facts)
  │     ├── 近期决策 (decisions)
  │     └── 当前关注话题 (topics)
  │
  └── User Message
```

Memory Context Provider 负责：

- 从 Retrieval Layer 获取相关条目
- 按 token budget 裁剪
- 按 `score = 0.4*recency + 0.3*attention + 0.2*frequency + 0.1*importance` 排序
- 输出为格式化文本，但不是 system prompt 的一部分

长期收益：

- token budget 可控（不是无限制拼接）
- priority 可调度（高优事实始终出现）
- provenance 可追踪（每个条目可追溯到源 session）

### 决策 5：Compaction 从 Event Store 读取，不从文本读取

Compaction Worker 不解析聊天文本，而是消费 ConversationEvent 流：

```
InteractionTracker / messages DB
      ↓
Event Adapter（将 messages 转为 ConversationEvent）
      ↓
Compaction Worker（消费事件流，产出 SessionCompaction）
      ↓
SessionCompaction DB（持久化）
```

这使 Memory 与 Evaluation 复用同一基础设施。未来走向：

```
Event Store
   ├── EvaluationEvent  →  GuardrailPipeline / Metric
   └── ConversationEvent →  Compaction Worker → Memory
```

### 决策 6：Retrieval Layer 是统一入口，取代 getFormattedContext()

当前：

```typescript
// MemoryService.ts — 拼接所有来源，一次性返回
getFormattedContext(): string {
  // permanent facts + semi/ephemeral + vector recall + summaries + interactions + kg + ...
}
```

目标：

```typescript
interface MemoryRetrievalLayer {
  query(spec: RetrievalSpec): Promise<MemoryContextBlock>

  // 同步短路版（无 LLM 依赖）
  querySync(spec: RetrievalSpec): MemoryContextBlock
}

interface RetrievalSpec {
  userText?: string
  sessionId?: string
  activeTopics?: string[]
  attentionEntities?: AttentionEntity[]
  maxTokens?: number
  includeTypes?: Array<'digest' | 'fact' | 'decision' | 'entity'>
}

interface MemoryContextBlock {
  digests: string[]
  facts: string[]
  decisions: string[]
  entities: string[]
  totalTokens: number
  sourceSessions: string[]      // 来源追踪
}
```

现有 `UnifiedMemoryQuery` 是雏形，升级即可。

### 决策 7：Scoring 公式 — Attention 为增强信号，缺失时走 deterministic fallback

每条 Compacted Memory 的检索得分分两种情况：

**AttentionSet 存在时：**

```
MemoryScore = 0.4 * RecencyScore
            + 0.3 * AttentionMatch
            + 0.2 * FrequencyScore
            + 0.1 * ImportanceScore
```

**AttentionSet 不存在或为空时（如新 session 启动初期）：**

```
MemoryScore = normalize(
                0.55 * RecencyScore
              + 0.25 * FrequencyScore
              + 0.2  * ImportanceScore
            )
```

Attention 是增强信号，不是必需信号。缺失时走 deterministic fallback，不引入时间状态切换。

```
MemoryScore = 0.4 * RecencyScore
            + 0.3 * AttentionMatch
            + 0.2 * FrequencyScore
            + 0.1 * ImportanceScore
```

| 因子 | 来源 | 计算方式 | Attention 缺失时替代 |
|------|------|----------|---------------------|
| RecencyScore | sessionEndAt | `Math.min(1, (now - t) / 7d)` 线性衰减，7天降为0 | 权重升至 0.55 |
| AttentionMatch | WorkingMemory.AttentionSet | 实体的 attention weight 与 compaction entities 的余弦相似度 | 跳过，权重分配给 Recency/Frequency |
| FrequencyScore | InteractionTracker | 该话题在最近 N 次交互中的出现比例 | 权重升至 0.25 |
| ImportanceScore | compaction.importanceScore | 由 FactExtractor 评估的事实重要度 | 权重升至 0.20 |

### 决策 8：Telegram 复用同一 Memory Core

不创建独立的 Telegram Memory：

```
               MemoryService
                    |
         MemoryRetrievalLayer
             /             \
   DesktopSession      TelegramSession
             \             /
          CompactionPipeline
                    |
            SessionCompactionDB
```

差异只在 Adapter 层：

- Desktop messages → ConversationEvent 转换
- Telegram messages → ConversationEvent 转换
- Compaction pipeline、Retrieval、Scoring 共用

### 决策 9：增量 Compaction，冷启动不回填

首次部署本 ADR 时，只对新产生的 session 运行 Compaction。

旧 session 的恢复依赖现有机制：

- VectorMemory 语义召回（有 embedding）
- InteractionTracker 记录（全量加载最近 32 条）
- SummaryMemory 摘要（如存在）
- `user_fact` 实体（已晋升的）

如果旧 session 被再次访问（用户问"我们之前聊过的 XX 事"），此时触发该 session 的按需 Compaction。

## Consequences

### 正面

1. **跨会话连续记忆** — 新 session 启动时 Retrieval Layer 自动注入相关旧 session 内容
2. **可观察** — Compaction → Retrieval → Injection 每一步都有日志和结构化产物
3. **与 Evaluation 共用范式** — Event → Compaction → Storage → Retrieval，两系统可共用事件基础设施
4. **Token budget 可控** — 独立 context block 可以裁剪，不污染 system prompt
5. **Telegram 零成本接入** — Session Adapter 替换即可
6. **向下兼容** — 现有 `getFormattedContext()` 保留，Retrieval Layer 包装旧接口

### 负面

1. **首次部署无旧数据** — 旧 session 在用户主动提及前不产生 compaction
2. **Compaction Worker 是新增常驻进程** — 消耗少量内存和 CPU（idle 检测触发）
3. **FactExtractor 初期规则简单** — 无 LLM 时精度有限，用户体验改善有上限

### 依赖项

| # | 依赖 | 状态 |
|---|------|------|
| 1 | SessionCompaction DB 表 | 新增 |
| 2 | ConversationEvent 定义 | 新增（与 EvaluationEvent 同级） |
| 3 | FactExtractor | 新增 |
| 4 | MemoryRetrievalLayer | 升级 UnifiedMemoryQuery |
| 5 | Compaction Worker | 新增 |
| 6 | Memory Context Provider | 新增（替换 system prompt 注入） |

### 架构迁移路径

Phase 1 中 Retrieval 即可用，但只作为 passive observation，不参与模型行为决策。

```
Phase 1：基础设施 + Passive Consumption (P0)          ✅
  - SessionCompaction DB schema
  - ConversationEvent 定义 + Adapter（从 messages DB 转换）
  - Compaction Worker（无 LLM 规则版，reply 后触发）
  - Retrieval API 就绪
  - ChatExecutor 读取 previousSessionDigest
  - 记录 observation event: session.digest.retrieved
  - ∵ 不参与决策，不改变 prompt priority

Phase 2：Retrieval Ranking + Metric (P1)              ✅ CLOSED
  - Scoring 公式实现（含 Attention fallback）
  - AttentionMatch 接入 WorkingMemory
  - 观察 retrieval hit rate / useless context rate / token reduction
  - ∵ 仍不注入 context，只做度量评估
  - Exit: sm-obs-v2 (2026-07-24), attention_gap deferred to Phase 3

Phase 3：Context Injection (P1)                       🔓 READY
  - Memory Context Provider
  - ChatExecutor 注入路径切换（system prompt → 独立 block）
  - 旧 getFormattedContext() 包装为 fallback
  - ∵ 至此才影响模型行为

Phase 4：FactExtractor (P2)
  - FactExtractor 实现
  - 事实变更追踪 + 冲突检测
  - decisions[] 结构化输出

Phase 5：Telegram 适配 (P2)
  - Telegram Session Adapter
  - 端到端验证跨渠道一致性
```
