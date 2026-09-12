# akemi-mio monorepo 模块拆分评估报告

- 评估日期：2026-09-11
- 评估方式：实跑 `tsc`、文件哈希逐对比对、正则统计全仓 import 引用
- 结论一句话：**main 侧迁移已完成，但音频模块的拆分是「复制式拆分」——新包建了、没接线、还反向依赖母包，产生了 34 个零引用包和 79 个类型错误。**

---

## 1. 实测基线（与既有认知不符）

| 项目 | 实测值 | 备注 |
|---|---|---|
| `packages/` 下包数 | **89** | 旧记录「8 包骨架」已过期 |
| TS/TSX 文件总数 | **1448** | 仅 `packages/` |
| 根 `src/` 剩余 | **155 个 TS** | 只剩 `preload` + `renderer` |
| main 侧迁移 | **已完成** | 构建入口已指向 `packages/main/src/index.ts` |
| 零引用包 | **34 / 89（38%）** | 从未被任何代码 import |
| 类型检查 | **79 errors** | 100% 为 `TS2305` |

引用热度（前 6）：`core` 1309 · `capabilities` 303 · `intelligence` 259 · `audio` 206 · `intelligence-memory` 145 · `evolution` 135。

---

## 2. 类型检查：79 个错误，单一根因

**现象**：79 个错误全部是 `TS2305 Module has no exported member`，分布在 22 个文件，全部属音频链路
（voice-analytics 33 · tts-core 13 · piper-tts 9 · asr 7 · audio-tools 6）。

**根因**：`packages/audio/src/index.ts` 只导出了 10 个 Speech Plugin 类型，
而 `packages/audio/src/types.ts` 里定义的约 **120 个类型**（`AudioFeatures` / `VoiceEmotion` / `DayPeriod` /
`EmotionTtsParams` / `QoSEvaluatorConfig` …）**没有 re-export**。

**为什么生产链路没报错**：`main` 走的是深层路径导入，绕过 barrel：

```ts
import { AsrService } from '@akemi-mio/audio/AsrService'   // 绕过 index.ts，正常
import type { DayPeriod } from '@akemi-mio/audio'           // 走 barrel，报错
```

最后一行是 `packages/tts-core/src/ModelScheduler.ts:51` —— 79 个错误的最小复现。

---

## 3. 结构性问题（比错误本身严重）

### 3.1 复制式拆分：audio 母包与 5 个子包

`audio` 与 `asr` / `tts-core` / `voice-analytics` / `piper-tts` / `audio-tools` 之间存在
**50 组重名文件**，其中 34 组内容不同、16 组完全相同。差异抽样证实**仅为 import 路径改写**：

| 文件 | 母包 audio | 子包 |
|---|---|---|
| `AsrAcousticEnvironmentClassifier.ts` | `from './types'` | `from '@akemi-mio/audio'` |
| `PiperOrchestrator.ts` | `from './TtsService'` | `from '@akemi-mio/audio/TtsService'` |

即：**物理复制 + 逻辑未解耦**。子包内共 **43 处** `import '@akemi-mio/audio'`，形成**反向依赖**。

### 3.2 五个音频子包全是孤儿

`asr` / `tts-core` / `voice-analytics` / `audio-tools` 引用数 = **0**，`piper-tts` = **1**。
生产代码（main / intelligence / capabilities）**全部仍指向 `audio` 母包**。

### 3.3 配置漂移

- `@akemi-mio/asr` 在 `electron.vite.config.ts` 指向 `packages/audio/src`，
  在 `tsconfig.node.json` 指向 `packages/asr/src` —— **构建与类型解析指向不同目录**。
- `tsconfig.node.json` 有 3 组重复 key：`evolution-asr`、`intelligence-plugin`、`intelligence-insight`。
- `@akemi-mio/evolution-capability-shadow` 映射悬空（`packages/` 下无此目录，且无任何引用）。

### 3.4 其他

- **entry 双 root**：main 在 `packages/`，preload/renderer 仍在根 `src/`。
- **数据安全**：`packages/runtime-contracts/telegram-bot/.env` 混入包目录（同目录还有 `bot.log`）。
- **编码损坏**：`packages/audio/src/types.ts` 自第 1692 行起约 130 行中文注释退化为 `?`
  （`// QoS / ???? / ???? / ?? / ????? ??`），疑似 GBK/UTF-8 转换丢失。
- **空壳包 5 个**：`evolution-learning` / `evolution-safety` / `evolution-scheduler` /
  `evolution-strategy` / `experience-memory` —— 仅有 `index.js` + `package.json` + 一个测试，无 `src`。
- `mio-cli`（48 个 JS）是独立 CLI，**不是**拆分残留，应排除在清理范围外。

---

## 4. 处置清单与优先级

> 关键依赖：**P1 的方向决定 P0 是否有必要**。若删除音频子包，79 个错误自动归零。

| 优先级 | 任务 | 风险 | 说明 |
|---|---|---|---|
| **P1** | 决策：5 个音频子包「接线上位」还是「删除回滚」 | 决策项 | 当前状态最差：双份代码 + 反向依赖 |
| **P0** | 补 `packages/audio/src/index.ts` barrel 导出 | 极低 | 让 tsc 立刻归零，保留后续选择权 |
| **P2** | 统一 vite alias 与 tsconfig paths；清 3 组重复 key；删悬空映射 | 低 | 消除构建/类型不一致 |
| **P3** | 34 个零引用包分类处置（真删 / 留骨架 / 独立包） | 中 | 建议先出清单再动手 |
| **P4** | 移出 `.env`；修复 `types.ts` 编码损坏 | 低 | `.env` 建议优先处理 |

**推荐路径 A（不阻塞）**：先做 P0 灭火（一个文件、几行代码、可回退），让 `tsc` 归零，
再从容决定子包去留。理由是：无论最终选删还是选接线，红灯都不该挂着。

**备选路径 B（激进）**：直接决定删除 5 个子包，79 个错误自然消失，跳过 P0。

---

## 5. 复现命令

```powershell
# 类型检查
.\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit

# 错误码分布
tsc-now.txt 内正则 'error (TS\d+)' 做 histogram

# 重名文件比对（audio vs 子包）
Get-FileHash <file> -Algorithm MD5

# 包引用次数统计（排除 node_modules）
正则 '@akemi-mio/([A-Za-z0-9\-]+)' 跨 packages/**/*.ts|tsx
```

> 环境备注：本机 Bash 工具环境损坏（`dirname: command not found`，coreutils 不可用）；
> PowerShell 可执行但 stdout 不回传，需 `Set-Content` 落盘后用 Read 读取。
> Glob 工具在此仓库会因 `node_modules` / `dist-electron` 超时，改用 PowerShell 列目录。
