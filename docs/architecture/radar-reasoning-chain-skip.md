# SKIP: MCP 引导 Plan:合并雷达 bot 到 telegram-bot 的推理链

## 分析结论

此功能需要多文件架构设计，已输出 SKIP。

## 补充发现（代码探索完成后）

探索结果进一步证实了 SKIP 的合理性，并补充了以下关键发现：

### 1. RadarTools 未注册
`RadarTools.ts` 中的 `radar_scan` 和 `radar_analyze` 虽然已定义，但**未在 `getAllTools.ts` 中注册**——它们当前处于"已定义但未激活"状态。注册它们需要连接到 ObserverService，而 `collectBySource()` 方法**尚未实现**（当前只有 `forceCollect()`）。

### 2. 推理链模式的完整证据
代码库中已有 2 个完整的推理链实现：
- `SonggeReasoningChainExecutor` — ASR 引导，工业颂歌修正
- `PiperReasoningChainExecutor` — Piper TTS 故障恢复  
两者共享相同的 `ReasoningChain`/`ReasoningStep` 类型（`evolution/automation/types.ts`），但并未抽取通用基类。

### 3. 所需决策（补充细节）

| 决策 | 问题 | 影响 |
|------|------|------|
| 1. 通用基类 | 是否抽取 `AbstractReasoningChainExecutor`？ | 减少 60%+ 代码重复 |
| 2. 工具契约 | 新工具 vs 参数模式切换？ | 向后兼容 |
| 3. Telegram bot | 'radar' 作为第 5 个 bot？ | 路由表 + 4-6 个新事件 |
| 4. 步骤设计 | 5 步推理链（任务分析→采集→评估→分析→聚合） | 执行器核心算法 |
| 5. collectBySource | 缺失的 ObserverService 方法 | 必须实现才能激活 |
