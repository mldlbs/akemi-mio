# Analysis Assets Manifest

Observation v1.2 分析资产清单。所有脚本离线读取 Evaluation DB，无副作用，可重复运行。

## Level 1: Core Analysis（正式分析器）

| Script | 输入 | 输出 | 用途 |
|--------|------|------|------|
| `scripts/analysis/observation-v1.2-report.ts` | Evaluation DB (`akemi-mio.db`) | Observation Report | Guardrail 统计：Trigger Rate、Coverage、Survival Curve、Context Inflation |
| `scripts/analysis/progress-density.ts` | Evaluation DB | Density Report | Progress Density 对比：Healthy Long Trace vs Triggered Trace |

运行方式：
```
npx tsx scripts/analysis/observation-v1.2-report.ts
npx tsx scripts/analysis/progress-density.ts
```

## Level 2: Forensics（异常 Trace 调查工具）

| Script | 输入 | 输出 | 用途 |
|--------|------|------|------|
| `scripts/forensics/trace-forensics.ts` | Trace ID | 逐轮 Turn Timeline | 根因分析：逐轮重建事件流、Progress Signal、Guardrail 执行状态 |

运行方式：
```
npx tsx scripts/forensics/trace-forensics.ts
```
（当前硬编码为 `req_173894_42`，修改 `TARGET_TRACE` 常量以分析其他 Trace。）

## Level 3: Experiments（临时验证脚本，不纳入正式流程）

位于 `scripts/experiments/`。

## 版本记录

| 版本 | 日期 | 备注 |
|------|------|------|
| v1.2 | 2026-07-07 | 初始版本：Guardrail MVP 验证 + Coverage Domain 发现 |
| v1.2-fix | 2026-07-07 | Bug 发现：throttle 跨 Trace 残留导致 215+ 条 Trace 漏检。`ChatExecutor.ts:469` 修复 |

## 原则

- **Event 不可修改** —— 分析器只读 Evaluation DB，不写回任何事件。
- **结论可重现** —— 同一 DB 输入应产生相同 Report。
- **版本间可比** —— 不同 Observation 阶段的报告应基于同一套分析器（参数可追加，逻辑不改）。
