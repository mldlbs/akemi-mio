# 实现计划：来源配额抽样（4f0efeb8）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · P4 实现步骤 |
| 任务 | 4f0efeb8（run a543e6ea，分支 task-4f0efeb8 ← task-e3d81bf8 @1b022fe） |
| 关联 | spec：docs/taskhub/4f0efeb8/spec.md |
| 状态 | approved |

## 步骤

1. 新增 `packages/observer/src/sourceQuota.ts`：`sourceFamily` + `sampleBySourceQuota`（算法见 spec，纯函数无 IO）。
2. 改 `packages/observer/src/ObserverService.ts` L159：抽样 + map + `research_obs_sampled` INFO 日志（total/sampled/families）。
3. 新增 `tests/main/observer/__tests__/SourceQuotaSampling.test.ts`（8 组，见 spec）。
4. 镜像同步：`sourceQuota.ts` 整文件复制（预期 0 diff）；`ObserverService.ts` 两文件各自局部编辑同一 oldString（镜像注释措辞不同禁覆盖），diff 复核应保持既有差异模式。
5. 门禁：定向 vitest → `npm test` → `npm run typecheck` → `npm run format:check` → `npm run coverage`（≥22/22/17/21）。
6. 交付：spec/plan approved + doc_paths + ReadEvidence → commit（不含 CLAUDE.md/issue6.md）→ gitref → submit → memory/observer 落档。

## 风险

- Phase B 比例分配的整数边界：`remaining < totalPool` 由快路径保证（obs.length > limit 才走到抽样），最大余数 +1 不越 `pool_i`——测试 4 覆盖家族多/池不均场景。
- 单源等价性若被 Phase A/B 破坏（输出非 slice(0,30)）：测试 2 逐条断言，保护既有行为。
- RSS feedUrl 当作独立 source 的历史语义：`sourceFamily` 只影响**抽样分组**，不改落库 source 字段——避免波及 TrendEngine/去重指纹。
- 镜像 ObserverService 注释差异 153 行：编辑只锚 L159 相同行，避免误伤。
- `log` 已在 ObserverService L1 导入，无新增 import（`sampleBySourceQuota` 需加 import 行）。
