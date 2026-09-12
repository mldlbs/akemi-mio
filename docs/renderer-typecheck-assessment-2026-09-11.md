# renderer 类型门禁评估与修复报告

日期：2026-09-11（同日晚续修至清零）
范围：`tsconfig.web.json`（Electron renderer 侧）
状态：**已完成。错误 311 → 0；门禁已接线（node + web 双配置）；挖出并修复 5 个真缺陷 / 1 处死功能归档**

> 本文前七节记录**评估与首轮修复**（311 → 91），保留原始排查过程以免丢失证据链；
> 第八节起的「91 个错误分类」已被**第十二节：清零实录**取代，阅读结论请直接跳到第十二节。

---

## 一、起因

上一轮把 `verbatimModuleSyntax` 在 `tsconfig.node.json` 打开后，遗留项记为「`tsconfig.web.json`（renderer 侧）尚未开 verbatimModuleSyntax」。

本轮先做探针，结论是**该项本身没有价值，但顺着它发现了一个真问题**。

---

## 二、结论 1：verbatim 在 renderer 侧是零影响（已启用）

方法：不新建探针配置文件，直接用 `run-tsc.mjs` 的 `TSC_ARGS` 传 CLI 开关，保证与基线同口径。

| 运行 | 配置 | 错误数 |
|---|---|---|
| 基线 | `tsconfig.web.json` | 311 |
| 探针 | `tsconfig.web.json` + `--verbatimModuleSyntax` | 311 |

逐条对比（按 `文件\|行\|列\|错误码\|消息` 归一）：**新增 0、消失 0、完全一致**，其中 **TS1484（类型被当值导入）= 0**。

即 renderer 代码本就规范使用 `import type` / 内联 `type`。故该开关在 web 配置上属**纯对齐、零风险**，已启用（附注释说明）。

---

## 三、结论 2：`tsconfig.web.json` 从未纳入门禁，带着 311 个错误

- `package.json`: `typecheck = tsc -p tsconfig.node.json --noEmit` —— **只查 node 侧**。
- `tsconfig.json`（solution 式）虽然 `references` 了两个配置，但仓库里没有任何脚本跑 `tsc -b`。
- 后果：`tsconfig.web.json` 的 311 个错误长期无人观察。renderer 由 vite/esbuild 出品，
  **转译即擦除类型、不做检查**，所以这些错误一直在静默出厂。

错误分布极不均衡：`mockIPC.ts` 一个文件占 220 个（71%）。

---

## 四、根因定位：vitest 主版本 API 漂移

实测 `vitest = 4.1.11`。

vitest 自 2.0 起把 `Mock` 的泛型签名从
`Mock<TArgs extends any[], TReturn>` 改为 `Mock<T extends Procedure>`。
而 renderer 测试代码写的是老式**双泛型**：

```ts
// 旧（vitest 1.x）
type MockedElectronAPI = { [K in keyof ElectronAPI]:
  ElectronAPI[K] extends (...args: infer A) => infer R ? Mock<R, A> : ElectronAPI[K] }
transcribe: vi.fn<[ArrayBuffer], Promise<{ text: string }>>()
```

在 vitest 4 下 `Mock<R, A>` 直接报 `TS2707 Generic type 'Mock' requires between 0 and 1 type arguments`，
`vi.fn<[..], R>()` 报 `TS2558 Expected 0-1 type arguments, but got 2`。
更关键的是：**这两个错误让 `MockedElectronAPI` 整体塌成错误类型**，
于是对象字面量的每个字段检查（TS2740「缺少 94 个属性」）以及
`.mockResolvedValue(...)` 的参数检查（TS2345「不能赋给 never」）全部级联失败——
**220 个错误里约 95% 是这一个根因的级联产物**。

---

## 五、修复 1：vitest 泛型形态迁移（codemod，消除 237 个错误）

工具：`.workbuddy/vitest-mock-migrate.mjs`（新增，可复用）

```
vi.fn<[A, B], R>()  ->  vi.fn<(...args: [A, B]) => R>()
Mock<R, A>          ->  Mock<(...args: A) => R>
```

- **纯类型注解改写，不触碰任何运行时代码。**
- 元组→参数用 `(...args: [A, B]) => R` 而非展开成命名参数：无需臆造参数名，且语义等价（可变元组为 TS 4.0+ 原生支持）。
- 角度括号按**深度配对**，并跳过 `=>` 的 `>` 与字符串字面量；
  顶层逗号切分同样带括号深度与字符串状态。任一处理点无法确定即**整文件跳过**，绝不半应用。

**踩到的坑（已修）**：首版按字面量 `vi.fn<` 匹配，漏掉了被换行拆开的调用链
`vi\n  .fn<[], R>()`，造成**半应用**（78 处改写、多行处漏改）。
改为匹配 `.fn<` 并向左跳过空白**回溯校验调用者为 `vi`** 后，命中 110 + 6 处，0 跳过。

| 文件 | 改写处数 |
|---|---|
| `src/renderer/src/__tests__/mockIPC.ts` | 110 |
| `src/renderer/src/hooks/__tests__/useIPCEvent.test.ts` | 6 |

备份：`.tmp/codemod-backup-20260911/`（应用前整文件副本）。

**结果 311 → 96**（消除 237、新增 22）。

新增的 22 个**不是回归**：`MockedElectronAPI` 映射类型修好后不再塌陷，
于是暴露出 `mockIPC.ts` 手写返回类型**本身就与实际契约不符**，
例如 `getActions()` 声明返回 `{ success, actions: any[] }` 而契约要求
`{ success, actions: {...}[], timestamp, error? }`——原先被坏泛型整体掩盖。
这类属测试 mock 保真度问题，**尚未处理**（见第八节）。

---

## 六、修复 2：补 vitest 全局类型（消除 2 个）

`tsconfig.web.json` 原本 `"types": ["react"]`，导致 `setup.ts` 与 `useAIOutput.test.ts`
报 `TS2304 Cannot find name 'beforeEach' / 'afterEach'`。补 `"vitest/globals"` 后归零。

**96 → 94**（此时已含 verbatim，增量 0，与第二节探针一致）。

---

## 七、意外发现并修复：一个真运行时缺陷（`setActiveRuns`）

`WorkflowEditor.tsx` 报 `TS2552 Cannot find name 'setActiveRuns'`。核查后确认**不是类型瑕疵，是活缺陷**：

```ts
// 修复前（handleRun，点击「运行工作流」的成功分支）
const result = await window.electronAPI.startWorkflow(initial.id)
setRunning(false)
if (result.success) {
  setActiveRuns((prev) => { ... })   // ← 全 renderer 仅此一处出现，从未定义
  setShowRunPanel(true)              // ← 因此永不执行
}
```

- 全仓检索：`setActiveRuns` 只出现在第 666 行；同文件第 393 行用的是**派生值** `storeActiveRuns`。
- 后果：`startWorkflow` 返回成功时抛 `ReferenceError`，运行面板打不开，异步回调的 rejection 无人接管。
- 为何长期隐形：renderer 没有类型门禁，而这个标识符是「未定义变量」——esbuild 不做检查，只在运行时炸。

修复：改走 store 的正规入口（`workflowStore` 的 `workflow.created` 分支本就做同样的事，
且会经 `createRun()` → `transitionToRunning()` 产出带 `startedAt` 的 `running` 态）：

```ts
if (result.success && result.runId) {
  wfStore.addWorkflowEvent({
    type: 'workflow.created',
    runId: result.runId,
    workflowDefId: initial.id,
    workflowName: name,
    steps: steps.map((s) => ({ status: 'pending' as const, stepId: s.id })),
    timestamp: Date.now(),
  })
  setShowRunPanel(true)
} else {
  setError(result.error ?? '启动失败：未返回 runId')
}
```

顺带修掉一个被掩盖的类型漏洞：`startWorkflow` 返回的 `runId` 是**可选**的，
原代码直接把它当 `string` 用（同样被坏泛型掩盖），故补 `&& result.runId` 守卫。

**94 → 92 → 91**（`WorkflowEditor.tsx` 25 → 22）。

---

## 八、首轮达成时的错误快照（91 个 —— 历史，处理结果见第十二节）

> ⚠️ 本节是**首轮修复结束时的中间快照**，其中的分类与优先级已被后续执行覆盖。
> 保留它是为了留下「根因如何分桶」的推理过程。

### 测试范围（25 个，不影响出厂包）

| 文件 | 数量 | 性质 |
|---|---|---|
| `__tests__/mockIPC.ts` | 22 | mock 手写返回类型与 `ElectronAPI` 契约不符；事件订阅类 mock 的返回类型写成 `() => void` 而契约要求 `() => IpcRenderer` |
| `components/__tests__/VoiceInput.test.tsx` | 3 | `expect(el.disabled)` —— 直接读 DOM 属性，应改用 `@testing-library/jest-dom` 的匹配器 |

### 出厂代码（66 个，**有真实风险**）

| 文件 | 数量 |
|---|---|
| `components/WorkflowEditor.tsx` | 22 |
| `components/WorkflowSlot.tsx` | 5 |
| `settings/SettingsMemoryTab.tsx` | 5 |
| `widgets/plugins/narrative/SceneRenderer.ts` | 4 |
| `widgets/plugins/WorkflowStatusWidget.tsx` | 4 |
| `components/BlogEditor.tsx` | 3 |
| `hooks/useSessions.ts` | 3 |
| `hooks/useWorkflowDefinitions.ts` | 3 |
| `widgets/plugins/narrative/useNarrativeWallpaper.ts` | 3 |
| `components/BlogReview.tsx` | 2 |
| `components/DesktopToolbar.tsx` | 2 |
| 其余 11 个文件各 1 | 11 |

按根因归类：

**A. preload 契约过期（7 个，最实）** —— renderer 调用了 `ElectronAPI` 类型里根本不存在的成员：
`getToolOptimizerSummary` / `getToolOptimizerConfig` / `setToolOptimizerConfig` /
`clearToolCallHistory` / `clearToolOptimizer`（`SettingsMemoryTab.tsx`）、
`onNarrativeAsrText`（`useNarrativeWallpaper.ts`）。
需核对 `src/preload/index.ts` 与对应 IPC handler：是**类型漏声明**还是**功能确实没接线**。

**B. IPC / 事件 payload 类型字段过窄（约 17 个）** —— 声明的类型比实际投递的字段少：
`agentResult` 缺失（`WorkflowEditor` 3 + `WorkflowSlot` 3 + `useWorkflowDefinitions` 1）、
`error` 缺失（`useWorkflowDefinitions` 2）、
`entry.id` 缺失（`BlogEditor` / `BlogReview`）、
`message` 缺失（`DesktopToolbar` 2、`main.tsx` 1）。
属主进程 ↔ 渲染进程契约不同步。

**C. 字面量联合类型过窄（6 个）** —— 数据层给 `string`，前端声明了窄联合：
`source: "electron" | "telegram"`（`useSessions` 3 + `historyViewStore` 1）、
`status` 联合（`FileOrganizerProgressWidget`、`OrchestrationProgressWidget`）。
需在边界处收窄，或把联合放宽——**属于设计取舍，不宜机械改**。

**D. `WorkflowEditor.tsx` 局部缺陷（22 个）** ——
字段类型联合缺 `'array-editor' | 'kv-editor' | 'multi-select-steps'`（6）、
`TS7053` 用 `string` 索引一个无索引签名的对象（5）、
`TS2554 Expected 1 arguments, but got 0`（4）、
`indeterminate` 不是合法 input prop（1）、
`WorkflowState[]` 不能赋给 `ActiveRun[]`（`WorkflowPending` 缺 `startedAt`，1）等。

**E. 空值安全（约 7 个）** —— `'el' is possibly 'null'`、`string | null` 传参、
`config.maxCount/rate` 可能为 `undefined`。

### 建议优先级

1. **A 类（7 个）** —— 可能是功能没接线，先核对 preload，性价比最高。
2. **C 类（6 个）** —— 涉及数据边界，可能对应真实的字段漂移。
3. **B 类（17 个）** —— 批量更新契约类型即可，机械但需逐条核对字段。
4. **D 类（22 个）** —— 集中在单文件，逐个清理。
5. **E 类（7 个）** —— 补空值守卫。
6. **测试范围（25 个）** —— 最后处理；也可考虑给测试单独建 `tsconfig.web.test.json`，
   让 `tsconfig.web.json` 只描述「会出厂的代码」。

**门禁接线前置条件**：`typecheck:budget` 目前是 `--budget 0`。
在 web 侧错误清零前接入会直接失败，故本轮**只做配置对齐、未接入门禁**。

为让这笔债务可**一条命令复现**（且不阻塞主门禁），新增了非阻塞脚本：

```
npm run typecheck:web     # tsc -p tsconfig.web.json --noEmit
```

主门禁 `npm run typecheck` 与 `typecheck:budget` **维持只查 node 侧、`--budget 0` 不变**。

---

## 九、首轮验证结果（91 错时点 —— 历史）

> ⚠️ 本节记录的**不是终态**。终态见第十三节（web 侧 0 错、门禁已接线）。

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.node.json --noEmit` | **EXITCODE=0**（输出 0 字节） |
| `tsc -p tsconfig.web.json --noEmit` | 311 → **91**（消除 237，新增 22 均属被掩盖的既有问题） |
| `electron-vite build` | **EXITCODE=0**（main 933 modules / 4,842,014 B；preload 27,028 B；renderer 101 modules） |
| renderer 出厂包变化 | `main-Dxv2HNy8.js` 998.62 kB → **`main-Gdaodab0.js` 998.44 kB**（唯一来自 `setActiveRuns` + `runId` 守卫修复） |
| codemod 对出厂包影响 | 无（测试文件不在构建图中；main 逐字节一致 4,842,014 B） |

---

## 十、本轮环境坑

1. **`electron-vite build` 在 `933 modules transformed` 之后偶发挂起。**
   三次运行结果：成功（9.2s）→ 挂死 → 成功（1.3s）→ 挂死 → 成功。
   挂死时日志固定停在 279 字节（4 行）、无 `EXITCODE` 行。
   - 已排除：孤儿进程占 `out/`（`Get-CimInstance` 查无）、内存不足（可用 17.5 GB / 32 GB）。
   - 观察到相关性：挂死均发生在**同时/紧邻跑了其他重型 node 进程**（并发的第二次构建、
     或紧接两次 tsc）之后。故**一次只跑一个**，失败直接重试。
2. **`run-build.mjs` 曾与 `run-tsc.mjs` 共用同一个硬编码日志路径**，
   并发运行会互相覆盖。已改为 `BUILD_LOG` 可覆盖、默认 `build-<pid>.log`。
3. PowerShell 工具**持续吞掉 stdout**（`Write-Output` 无回传），
   全部结论均通过「落盘 → Read」取得；Bash 工具仍不可用（coreutils 缺失）。

---

## 十一、可复用资产

| 路径 | 作用 |
|---|---|
| `.workbuddy/analyze-tsc-log.mjs` | 新增。按错误码/文件聚合 tsc 日志，并支持两份日志的**新增/消失逐条对比**（带稳定 key 归一），本轮所有量化结论都由它产出 |
| `.workbuddy/vitest-mock-migrate.mjs` | 新增。vitest 双泛型 → 单泛型 codemod，带角度括号深度配对与整文件跳过保护 |
| `.workbuddy/run-tsc.mjs` | 支持 `TSC_CONFIG` / `TSC_LOG` / `TSC_ARGS`，可直接用 CLI 开关做探针 |
| `.tmp/codemod-backup-20260911/` | codemod 前的两个测试文件副本 |

---

## 十二、清零实录（91 → 0）

### 12.1 收敛轨迹

| 轮次 | 动作 | 剩余 |
|---|---|---|
| 起点 | — | 91 |
| Wave 1 | preload 订阅返回类型 codemod + workflow 契约对齐 | 60 |
| Wave 2 | 测试基建 / 字面量联合 / 真 bug 齐修 | 30 |
| Wave 3 | `BookmarkButton` 的 `role` 级联宽化 | 3 |
| 终局 | `bookmarkStore` + preload `voiceBookmarkCreate` 的 `role` 统一为 `string` | **0** |

### 12.2 根因 ①：preload 订阅函数把 `IpcRenderer` 泄漏进 renderer（制造 26 错）

这是本轮**最大的单点根因**，也是首轮完全没识别出来的。

```ts
// src/preload/index.ts —— 修复前，20 处 on* 订阅函数都是这个形状
onSomeEvent: (handler) => {
  const listener = (_e, data) => handler(data)
  ipc.on('some:channel', listener)
  return () => ipc.removeListener('some:channel', listener)   // ← 返回类型是 IpcRenderer
}
```

`ipcRenderer.removeListener()` 是**链式 API，返回 `IpcRenderer` 自身**。箭头函数的隐式返回值于是让这 20 个函数
的返回类型变成 `() => IpcRenderer`，而 `ElectronAPI` 契约里声明的是 `() => void`。

后果是双向的：
- `mockIPC.ts` 里手写的订阅 mock 全部失配；
- 所有 `useEffect(() => { const off = api.onX(...); return off }, [])` 的 cleanup 函数签名不匹配。

修法（`.workbuddy/fix-preload-unsubscribe.mjs`）：把箭头函数体改成**块体**，显式丢掉返回值。

```ts
// 修复后
return () => { ipc.removeListener('some:channel', listener) }
```

codemod 的安全设计：
- 只接受 `'channel', handler` 这一种实参形态，其余整处跳过；
- **按位置逐行校验**：命中行原址展开 3 行，文件其余每一行逐字不变；
- 改写前后频道名清点一致（56 个）；
- 总行数必须等于 `源行数 + 命中数 × 2`。
- 命中 20 处（行 334…461），1606 行 → 1646 行。

### 12.3 根因 ②：契约声明与实际发射端不符

逐条读 `src/main/**` 的真实 `webContents.send()` payload，把 preload 类型对齐过去：

| 频道 / 方法 | 偏差 |
|---|---|
| `onWorkflowRunUpdated` | 实际会带 `error?: string`，类型里没有 |
| `onWorkflowRunStep` | 缺 `agentResult?: string; error?: string` |
| `onOrganizerProgress` | `status: string` → 收窄为 `'idle'｜'organizing'｜'paused'｜'completed'` |
| `onOrchestrationProgress` | `stepStatuses[].status` / `recentMoves[].status` 由 `string` 收窄为实际枚举 |
| `voiceBookmarkCreate` | `conversationContext[].role` 由 `'user'｜'assistant'` **放宽**为 `string` |

注意最后一条方向相反：**该收窄的收窄、该放宽的放宽**，判断依据一律是「main 侧到底发了什么」。

### 12.4 根因 ③：数据层给 `string`，前端声明了窄联合

`slots/types.ts` 的 `MessageItem.role` / `SessionItem.source` / `MessageItem.source`
原本是 `'electron' | 'telegram'` 这类窄联合，但后端是**数据库自由字符串列**，IPC 契约也是 `string`。
在边界硬收窄会在遇到新来源时静默失败（TS 错误只是先兆，运行时是真的丢数据）。
故统一在边界**放宽为 `string`**，收窄职责交回消费点。同类处理：`bookmarkStore` / `BookmarkButton` 的 `role`。

### 12.5 根因 ④：TS 控制流收窄不穿透闭包与函数声明

这是首轮归类时被低估的一类，实际有 3 种变体：

| 形态 | 症状 | 修法 |
|---|---|---|
| `function onWheel(e) { ... el ... }` | 函数声明会提升，前面 `if (!el) return` 的收窄对它无效 → `el is possibly null` | 改箭头函数 `const onWheel = (e) => { ... }` |
| `if (!data.agentResult) return; setState(d => [...d, data.agentResult])` | updater **闭包**里 `data.agentResult` 仍含 `undefined` | 先捕获局部 `const agentResult = data.agentResult` |
| `steps.filter(t => !isToolActive(t))` | TS 不会推出 `ToolTerminal[]` | 加显式类型谓词 `isToolTerminal` |

### 12.6 挖出的真缺陷（非类型瑕疵）

| # | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| 1 | `WorkflowEditor.tsx` | `setActiveRuns` 从未定义（首轮已修） | 点「运行工作流」抛 `ReferenceError`，运行面板打不开 |
| 2 | `store/clockStore.ts` | `let store: ReturnType<typeof create<ClockStore>>` | 类型完全错（`create<T>()` 返回工厂函数，非实例），靠 `as any` 掩盖 |
| 3 | `BlogEditor.tsx` | 读 `saved?.id`，但 main 返回 `{ success, entry? }` | **录音回链 ID 恒为空串**，转写结果挂不回博文 |
| 4 | `BlogReview.tsx` | 同上 | 同上 |
| 5 | `DesktopToolbar.tsx` | 读 `result.message`，但契约是 `{ success, result?, error? }` | 反馈文案**永远退化成「完成」/「失败」**，拿不到真实信息 |

另有两处「类型本就合法、但 React 静默丢弃」的写法：
- `WorkflowEditor.tsx` 的 `<input indeterminate>` —— 不是合法 React prop，**分组的「部分选中」态从未显示过**。
  改为 `ref={(el) => { if (el) el.indeterminate = groupPartial }}`。
- `FieldDef.type` 联合缺 `'array-editor' | 'kv-editor' | 'multi-select-steps'`，
  但 `switch` 分支**已实现** → 属联合漏填，补成员即可。

### 12.7 死功能归档：`SettingsMemoryTab.tsx`

首轮把它列为「A 类：preload 契约过期，可能功能没接线」。本轮做**三重取证**后确认是死功能：

| 取证 | 结果 |
|---|---|
| 零引用 | 全仓无 import |
| 未挂载 | `SettingsModal` 只有 `llm` / `voice` / `appearance` / `system` 四个 tab，无 `memory` |
| IPC 桥从未存在 | 它调用的 5 个方法（`getToolOptimizerSummary` 等）在 preload + main **均零命中** |
| 后端引擎零引用 | `packages/` 下对应能力无任何消费者 |

→ **归档式移除**（不删）：`.tmp/removed-orphan-settings-memory-tab-20260912/`
内含 `SettingsMemoryTab.tsx`（17,547 B，MD5 `C5E662DADCBD805E70DD99A23ECD3CC7`）+ `MANIFEST.md`（记录取证过程与恢复方法）。

### 12.8 文件改动清单

**出厂代码（15 个）**

| 文件 | 改动性质 |
|---|---|
| `src/preload/index.ts` | 20 处订阅函数改块体返回 void；5 个 payload 类型对齐 main 实际发射 |
| `src/renderer/src/store/clockStore.ts` | 真 bug：store 类型 |
| `src/renderer/src/main.tsx` | `state` 显式标注 `{ error: Error \| null }` |
| `src/renderer/src/components/BlogEditor.tsx` | 真 bug：`saved?.entry?.id` + 录制列表归一化 |
| `src/renderer/src/components/BlogReview.tsx` | 真 bug：`saved?.entry?.id` |
| `src/renderer/src/components/DesktopToolbar.tsx` | 真 bug：`result.message` → `result?.result \|\| result?.error` |
| `src/renderer/src/components/WorkflowEditor.tsx` | 局部 `agentResult` 捕获、`FieldDef.type` 补成员、`forceRender` 带参、`setNestedConfig` 标注、`indeterminate` 改 ref、runs 显式 map、菜单空值守卫 |
| `src/renderer/src/components/WorkflowSlot.tsx` | 同上两处 + 类型谓词 |
| `src/renderer/src/components/WorkflowCanvas.tsx` | `onWheel` 改箭头函数 |
| `src/renderer/src/tool/toolTypes.ts` | 新增 `isToolTerminal` 类型谓词 |
| `src/renderer/src/components/ChatSlot.tsx` / `ToolSlot.tsx` | 改用 `isToolTerminal` |
| `src/renderer/src/slots/types.ts` | `role` / `source` 宽化为 `string` |
| `src/renderer/src/slots/index.ts` | `ToolEvent` → `ToolIPCEvent` |
| `src/renderer/src/store/bookmarkStore.ts` / `components/BookmarkButton.tsx` | `role` 宽化为 `string` |
| `src/renderer/src/store/workflowStore.ts` | `WorkflowDef` 补 `enabled?: boolean` |
| `src/renderer/src/widgets/plugins/narrative/SceneRenderer.ts` | 新增 `PARTICLE_DEFAULTS` 常量 |
| `src/renderer/src/widgets/plugins/narrative/useNarrativeWallpaper.ts` | 该桥**从未存在**，改可选探测 + 空操作 |
| `src/renderer/src/widgets/plugins/WorkflowStatusWidget.tsx` | `steps.map` 参数显式标注 |
| `src/renderer/src/settings/SettingsMemoryTab.tsx` | **归档移除** |

**测试代码（2 个）**

| 文件 | 改动 |
|---|---|
| `src/renderer/src/__tests__/mockIPC.ts` | 4 个方法改用 `ElectronAPI['xxx']()` 派生泛型（契约漂移立刻暴露）；返回值补全字段；顶层标注改 `Partial<MockedElectronAPI>`（原先用 `as` 藏住了约 98 个缺口键） |
| `src/renderer/src/components/__tests__/VoiceInput.test.tsx` | 3 处 `getAllByRole('button')[n].disabled` 补 `as HTMLButtonElement` |

**门禁与工具（3 个）**

| 文件 | 改动 |
|---|---|
| `package.json` | `typecheck` 改为 `node && web` 串行；新增 `typecheck:node` |
| `scripts/typecheck-budget.mjs` | 预算门禁改为**统计双配置**（原先只统计 node 侧） |
| `.workbuddy/fix-preload-unsubscribe.mjs` | 新增 codemod |
| `.workbuddy/annotate-tsc-errors.mjs` | 新增：给 tsc 日志每条错误附上源码行（±1 行），一次性看清全部模式 |

---

## 十三、终态验证（含门禁接线）

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.node.json --noEmit` | **0 错** |
| `tsc -p tsconfig.web.json --noEmit` | **0 错**（311 → 91 → 60 → 30 → 3 → 0） |
| `node scripts/typecheck-budget.mjs --budget 0` | **EXIT=0** —— `node: 0 / web: 0 / PASS: typecheck clean.` |
| `electron-vite build` | **EXITCODE=0** |
| `out/main/index.js` | **4,842,014 B 逐字节不变**（与迁移前基线一致） |
| `out/preload/index.js` | 27,916 B |
| renderer 出厂包 | `main-BA0YlomA.js` 999.42 kB |

**门禁接线已完成**，`npm run typecheck` 与 `npm run typecheck:budget` 现在都会同时覆盖
node 侧与 renderer 侧——这是本轮真正的收尾：首轮那 311 个静默出厂错误的**入口已被堵死**。

### 环境坑（本轮新增）

1. **同一文件并发 Edit 会静默丢改动**：三条 Edit 同发一条消息存在竞态，工具均报 "Successfully edited"，
   但只有最后一条落盘。**必须串行**。
2. **Bash 工具持续不可用**（coreutils 缺失，`dirname/ls/head` 全 command not found，Exit 127）。
   全部改走 PowerShell + Node 脚本落盘 → Read 读取。
3. **PowerShell 的 `*> file` 重定向产出 UTF-16**，Read 工具会判为二进制而拒读。
   绕法：`[System.Text.Encoding]::Unicode.GetString(bytes)` 转 UTF-8 落盘。
4. **Edit 偶发 EBUSY**（文件锁竞争），直接重试即可。
5. 首轮那份「`electron-vite build` 偶发挂起」的观察在本轮未复现——本轮所有构建均一次通过，
   推断与并发重型 node 进程相关，**不是代码问题**。
