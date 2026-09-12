# Stash 重放评估（2026-09-12）

背景：git 对象库损坏重建后，原 3 个 stash 已抢救为 `refs/recovered/stash0|1|2`（对象已入 pack）+ 干净补丁 `.tmp/git-recovery-20260912/stash{0,1,2}-v3.patch`。本报告回答"这些 WIP 还有没有价值"。

## 结论速览

| Stash | 内容 | 与新代码关系 | 建议 |
|---|---|---|---|
| stash0 (+1939 行) | TTS/ASR/语音画像/记忆/渲染层 WIP（feat/evaluation-bridge） | **~90% 未被吸收进 packages/** | **值得移植**（人工对照） |
| stash1 (+1555 行) | evolution executors + 稳定性评分 | SystemStabilityScore 已完全一致；其余待核 | 大概率已被吸收，可弃 |
| stash2 (+801/-15652 行) | workflow slot UI + checkpoint 快照副产物 | master 版本已演进出更多（1022L vs 426L） | 过时，可弃 |

## stash0 逐文件吸收率（WIP 增量 vs master 现内容）

| 文件 | 新家 | WIP 增量行 | 已吸收 |
|---|---|---|---|
| src/main/tts/TtsService.ts | packages/audio/src/TtsService.ts | 110 | 15% |
| src/main/tts/UserSpeechProfileTracker.ts | packages/audio/src/UserSpeechProfileTracker.ts | 138 | **4%** |
| src/main/tts/types.ts | packages/audio/src/types.ts | 46 | 52% |
| src/main/asr/AsrService.ts | packages/audio/src/AsrService.ts | 5 | **0%** |
| src/main/memory/MemoryService.ts | packages/intelligence-memory/src/MemoryService.ts | 17 | **0%** |
| src/renderer/src/hooks/useAIOutput.ts | （原位） | 89 | 10% |
| src/renderer/src/components/PeriodicPredictionToast.tsx | （原位） | 16 | 6% |

判定方法：`git diff <stash>^1 <stash> -- <file>` 取新增行（>25 字符的有效行），在 master 新家文件内容中做包含匹配。父提交 f593e46 树完整，结果可信。

## 移植注意

- 旧路径 → 新包的映射：`src/main/tts|asr → packages/audio/src`；`src/main/memory → packages/intelligence-memory/src`；`src/main/agent → packages/intelligence/src/agent`；`src/main/workflow → packages/capabilities/src/workflow`。
- stash0 的 4 个 PRESENT 文件（preload/index.ts、PeriodicPredictionToast.tsx、useAIOutput.ts、wallpaper.css）可直接在现位尝试 3-way apply。
- 其余 18 个 GONE 文件需按上述映射人工移植（补丁文件在 `.tmp/git-recovery-20260912/stash0-v3.patch`）。

## 附带发现：checkpoint 机制是 git 写操作风险源

`packages/evolution-core/src/EvolutionCheckpointManager.ts` 的 `saveGitState()` 会在每个 evolution cycle 对仓库执行 `git stash push`（15s 超时但子进程不会真正终止）→ `git add -A` + snapshot commit → `git stash pop`。两个挂死 12 小时的 `git stash push` 进程即来源于此；上午 staged 改动"凭空消失"即 checkpoint 的 `stash pop` 恢复工作区所致。已杀掉挂死进程。**应用运行期间做 git 操作需注意该机制**；对象库初始损坏的最可能来源也是 checkpoint 周期撞上仓库高负载。

## 恢复资产清单

- `refs/recovered/stash0|1|2` —— 三个 stash 提交（含完整树），对象在 pack 内
- `.tmp/git-recovery-20260912/stash{0,1,2}-v3.patch` —— UTF-8 干净补丁
- `.tmp/git-recovery-20260912/master-baseline.bundle` —— master 基线 23.8MB 离线备份
- `.git-broken-20260912/` —— 旧损坏库全量备份（含 4 个旧 pack）
- 评估脚本：`.workbuddy/replay-report{,2,3,4}.cjs`
