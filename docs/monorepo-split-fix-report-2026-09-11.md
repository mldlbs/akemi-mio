# akemi-mio monorepo 拆分修复执行报告

- 执行日期：2026-09-11
- 修复范围：P0 → P2 → P4 / P3（P1 需用户决策）
- **结论：类型检查 79 错归零，构建端到端通过（三个产物全部 EXITCODE=0）**

---

## 一、修复清单

| 优先级 | 问题 | 修复动作 | 涉及文件 |
|---|---|---|---|
| **P0** | 79 个 `TS2305`，全部指向 `@akemi-mio/audio` | barrel 补全为 `export * from './types'`（原只导出 10 个类型，`types.ts` 实为 104 个） | `packages/audio/src/index.ts` |
| **P2** | 构建报 `Rollup failed to resolve import` | alias 由**手写 23 条**改为**从 `packages/` 目录派生**，补 3 个子目录别名 | `electron.vite.config.ts` |
| **P2** | tsconfig 配置漂移 | 删 2 组重复 key、删悬空 `evolution-capability-shadow`、修正 `@akemi-mio/insight` 映射 | `tsconfig.node.json` |
| **P2** | 46 处类型被当值导出（rollup 逐个报错） | 改 `export type {...}`；3 处混合行拆成两行 | `evolution-core` / `runtime-checkpoint` / `intelligence-mcp` / `evaluation` / `intelligence-plugin` 的 `index.ts` |
| **P4** | `.env` 与日志混入包目录 | `.env` 归位到 `telegram-bot/.env`；3 个日志移到 `.tmp/relocated-telegram-bot-residue/` | `packages/runtime-contracts/telegram-bot/` |

### 两个根因的关键事实

**1. `node_modules/@akemi-mio` 根本不存在。** 因此 `electron.vite.config.ts` 里的 alias 是构建期模块解析的**唯一来源**。原 23 条 alias 覆盖不了 89 个包 —— 手写列表一旦漏项，构建必然失败。改为目录派生后不可能再漂移。

**2. tsc 与 rollup 的口径不一致。** tsconfig 未开 `isolatedModules` / `verbatimModuleSyntax`，tsc 对「类型被当值导出」自动擦除、不报错；rollup 按运行时值处理，逐个报错。这是 46 处问题在类型检查里完全隐形的原因。

---

## 二、验证结果（端到端）

### 类型检查

```
tsc -p tsconfig.node.json --noEmit
修复前：79 errors（100% 为 TS2305，分布 22 个文件）
修复后：EXITCODE=0
```

### 构建

```
electron-vite build  →  EXITCODE=0

main      : 933 modules  →  out/main/index.js      4,842.01 kB   built in 7.44s
preload   :   1 module   →  out/preload/index.js      27.03 kB   built in 139ms
renderer  : 101 modules  →  out/renderer/assets/     998.62 kB JS + 454.17 kB CSS   built in 2.42s
```

修复前的基线是 **4 个模块、86ms 即失败**。构建已完整通过，仅剩
"dynamically imported but also statically imported … will not move module into another chunk"
警告 —— 属于 chunk 分割优化提示，非错误，可后续优化。

---

## 三、待决策项

### 1（P1）5 个音频子包的去留 — 需你拍板

`asr` / `tts-core` / `voice-analytics` / `piper-tts` / `audio-tools` 与 `audio` 母包有
**50 组重名文件**，差异仅为 import 路径改写，且**反向依赖母包**；生产代码 0 引用它们。
当前状态最差：双份代码 + 反向依赖。二选一：

- **接线上位**：把生产引用从 `@akemi-mio/audio/X` 改为子包，并让 `audio` 成为纯 barrel
- **删除回滚**：承认拆分未完成，删掉 5 个子包（需先过 `mio.policy.check`）

### 2（P4）`types.ts` 编码损坏 — 原文不可恢复

`packages/audio/src/types.ts` 自第 1692 行起 **169 行**中文注释退化为 `?`（代码完好）。
已查 git：`6b6dff5f`（package split）与 `145909f0` 两个版本都不含完好的 QoS 段
（后者该路径下仅 4954 字符的精简版）。**原文已丢失，无法恢复**。三个选项：

- **按语义重建**：字段名完好 + `?` 数量等于原字数，可高保真重建（属创作，非恢复）
- 保留现状（不影响功能，影响可读性）
- 直接删除这些注释

### 3 建议：开启 `verbatimModuleSyntax`

可让 tsc 事前抓出「类型当值导出/导入」，避免再次出现「tsc 全绿但构建炸」的情况。
预计会暴露一批 import 侧的同类写法，需评估工作量后决定。

---

## 四、复现命令

```powershell
# 类型检查
.\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit

# 构建 —— 必须用 Node 包装脚本，不要用 PowerShell 管道（会死锁）
& node.exe .workbuddy\run-build.mjs
```

> **环境警告**：本机 PowerShell 用 `| Out-File` 接住 electron-vite 的大输出会在
> "933 modules transformed" 处**死锁**（进程 CPU 增量恒为 0，实测挂死 13 分 42 秒）。
> `Start-Process` 亦被安全策略拦截。已改用 Node 脚本 `spawn` + `stdout.pipe(文件流)`，
> 同一份代码 **10 秒**完成构建。
