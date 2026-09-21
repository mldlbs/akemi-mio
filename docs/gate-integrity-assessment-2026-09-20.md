# akemi-mio 门禁承重性评估（2026-09-20）

> 方法：`rnd-quality-assessment` skill 的四种失效模式 + `falsification-testing` 的变异检验。
> 原则：**没做过变异的门禁标 ⚠️ unverified，绝不标 ✅。** 所有读数可被复核（命令附在表内）。

**本轮结论摘要**（*为事后更新，见各节内「已更新」标记*）：

- 发现并**已修复** 1 个库级缺陷（`withTimeout` 定时器泄漏 → 全量测试 `exit 1`），
  主进程测试 **2988 passed + 2 errors → 2994 passed + 0 errors**。
- 发现并**已修复** 2 个「测不到所声称逻辑」的用例（含 1 个 mock 方法名错配）。
- 发现 **1 个实际失效的门禁**：`lint`（130 条常响警告 + 退出码恒 0）—— ✅ **已修**（`28358e4`）。
- 发现 **2 道真实红**：`format:check`（20 文件）—— ✅ **已修**（`c4c3d2b`）；
  `audit` —— ⚠️ **无法运行**（根因见下条，非 CVE 问题）。
- **2 道门禁无法运行**（缺打包产物，前置条件）。
- ★ **新发现 FM-5：6 道门禁存在、可执行，却不在 CI 流水线上**（`typecheck:budget`、`test:unit:fast`、`test:stress`、`audit`、`check:renderer-entries`、`check:idle-gpu`）—— 见 §七。**其中 `check:renderer-entries` 最该补**（它守的是「三形态注册表不一致→空白屏」，其它门禁全看不见）。
  ✅ **2026-09-21 已闭环**：确认它**必须**有打包 exe（`findExe()` 在形态检查之前就抛），
  故改为补一道**静态等价门禁** `check:form-registry`（秒级、无产物依赖，已进 quality job）—— 见 §七·补记。
  ⚠️ **同日更正**：原写「6 道不在任何流水线上」是**错的**，实际 **5 道** ——
  `test:stress` 就在 `weekly-stress.yml:18`（09-20 只比对了 `ci.yml`，漏看另两个 workflow）。
- ★ ★ **新发现 FM-6（09-21）：门禁在流水线上，但 `continue-on-error: true` 摘掉了它的失败能力** ——
  `weekly-stress.yml`（`Run stress tests` 步骤）与 `weekly-audit.yml:21/27/55/64`。
  **而且查下去发现 `npm run test:stress` 当时连一个文件都没匹配到**（4 个 glob 全失配，
  `No test files found` exit 1，3 秒；那 12 个文件真实存在且全绿）。
  三重叠加 → 「每周跑压测」这句话是真的，但保障是 **0**，且没人见过它红。
  ✅ **已修**：`test:stress` 改用可用写法（实测 12 passed / 57 tests / 40s）+ 去掉 `continue-on-error`。
  `weekly-audit.yml` 的 4 处**未动**（趋势性指标，直接放开会变成常响噪音，需先定阈值）。见 §七。
- ★★ **`npm ci` 起不来的真正根因（本轮定位，已用最小复现证明）**：
  **仓库用了 npm 从不支持的 `workspace:` 协议**（46 包 / 79 处），
  npm 的工作区解析是**按 name 匹配**而非协议。
  ⚠️ 上一轮曾归因于「`package-lock.json` 陈旧」——**那是错的**，已被最小复现推翻（见 §5.2）。
  📋 **修复方案已验证但未应用**（用户 2026-09-21 决定暂缓）：`workspace:*`→`*` + 根 `.npmrc` 的
  `legacy-peer-deps=true` + 重建 lock 1170 条目；`npm ci --dry-run` exit 0 —— **见 §5.2**。
- 🔥 **应用修复后会暴露**：`audit` 将能跑，报 **31 漏洞（18 high/critical，含 2 critical）**——
  当前仓库未应用修复，`audit` 仍因 lock 损坏 400 跑不了，故这 31 漏洞目前看不见。建议单列任务升级
  vite/exceljs/sharp 等，**未擅自 `audit fix --force`**。
- ★ **我自己有 2 处结论被推翻**：
  ① `format:check` 的「不建议动」是错的（见 §5.1 修正）；
  ② `npm ci` 的「lock 陈旧」归因是错的（见 §5.2 二次修正）。

---

## 一、总览

工作区共 **19 道** 门禁（`package.json` 的 `check:*` / `typecheck*` / `lint` / `format:check` / `test*` / `audit`）。

| 结论 | 数量 |
|---|---|
| ✅ 承重（有防护 + 变异验证红） | 4 |
| ✅ 承重（有防护，未变异） | 9 |
| ✅ **本轮修复后恢复承重**（`lint` / `format:check` / 主进程测试） | 3 |
| ⚠️ **无法运行**（缺打包产物，前置条件） | 2 |
| ⚠️ **无法运行**（源码 `workspace:` 协议 → `npm ci` 不可用） | 1 |
| ⬜ 未评估（`test:stress` 长时） | 1 |

> **交叉计数说明（避免重复）**：除上面 19 道门禁外，本轮还发现 **FM-5「门禁存在但不在 CI 流水线上」**
> 共 6 道：`typecheck:budget`、`test:unit:fast`、`test:stress`、`audit`、
> `check:renderer-entries`、`check:idle-gpu`。其中 `check:renderer-entries` / `check:idle-gpu`
> 已计入上面「无法运行」两行（`check:renderer-entries` / `check:idle-gpu` 缺打包产物；
> `audit` 与安装链同因 lock 损坏 400 跑不了）；
> 真正「此前既没算进结论、又不在 CI」的是 **3 道**：`typecheck:budget`、`test:unit:fast`（已补跑）、`test:stress`。
> 另：**安装链 `npm ci` 本身不是 19 道门禁之一**，而是所有门禁的前置——它因 `workspace:` 协议当前仍「无法运行」，
> 修复方案已验证（见 §5.2），但用户 2026-09-21 决定暂缓应用。
> 详见 §七。

---

## 二、Scorecard

| # | 门禁 | 命令 | 条目数 | 跳过 | 本次结果 | 承重性 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | `check:mcp-live` | `npm run check:mcp-live` | 49/49/49 | 0 | ✅ pass | ✅ **已变异验证** | 空参调用全部 49 个；崩溃/未应答均判失败 |
| 2 | `check:coverage` | `npm run check:coverage` | 49/49/49 | 0 | ✅ pass | ✅ 有防护 | 三方比对（MCP↔CLI↔文档） |
| 3 | `check:cli-docs` | `npm run check:cli-docs` | 53/53 | **0** | ✅ pass | ✅ **已变异验证** | 53 条 README 命令全部真跑 |
| 4 | `crash-messages` 判据 | `node --test __tests__/crash-messages.test.js` | 4 | 0 | ✅ pass | ✅ **本轮新建** | 正反双极性；两个方向变异都红 |
| 5 | `typecheck:budget` | `node scripts/typecheck-budget.mjs --budget 0` | 2 个 tsconfig | 0 | ✅ pass | ✅ 有防护 | 0 errors / budget 0，硬预算 |
| 6 | `test`（主进程） | `npm test` | **2997** | **3** | ✅ **exit 0**（修复后） | ✅ **本轮修复** | 修复前 `2988 passed + 2 errors + exit 1`；见 §4.5 |
| 7 | `test`（mio-cli） | `cd packages/mio-cli && npm test` | 386/386 | 0 | ✅ pass | ✅ **已变异验证** | 本轮新增 4 条 |
| 8 | **`lint`** | `npx eslint src/ --ext .ts,.tsx --max-warnings 130` | 130 warn | 0 | ✅ **exit 0**（阈值已加） | ✅ **已修复**（`28358e4`） | 修复前退出码恒 0 —— **见 §四** |
| 9 | `async-timeout`（新） | `vitest run tests/main/core/utils/__tests__/async-timeout.test.ts` | 6 | 0 | ✅ pass | ✅ **已双向变异** | 修复前 `withTimeout` 零测试 |
| 10 | `format:check` | `npx prettier --check "src/**/*.{ts,tsx,json,css}"` | 20 文件 | 0 | ✅ **exit 0**（已修） | ✅ 承重（真红） | CI 会拦（ci.yml:27）—— **见 §五·修正** |
| 11 | `audit` | `npm audit --audit-level=high` | — | — | ⚠️ **无法运行 (400)** | ⚠️ unverified | lock 损坏致 `npm ci` 亦不可用（修复应用前）；CI 未覆盖（FM-5）—— **见 §五** |
| 12 | `check:renderer-entries` | `node scripts/check-renderer-entries.cjs` | — | — | ❌ **无法运行 (exit 1)** | ⚠️ unverified | 缺 `dist-electron/` |
| 13 | `check:idle-gpu` | `npm run check:idle-gpu` | — | — | ❌ **无法运行 (exit 2)** | ⚠️ unverified | 缺打包 exe |
| 14 | `typecheck` / `typecheck:node` / `typecheck:web` | `tsc -p … --noEmit` | 2 工程 | 0 | ✅ pass | ✅ 有防护 | 被 #5 覆盖读数 |
| 15 | `test:renderer` | `vitest --config vitest.config.renderer.ts` | 449 | 0 | ✅ pass | ✅ 有防护 | 本轮补跑（验证格式化无害） |
| 16 | `test:preload` | `vitest --config vitest.config.preload.ts` | 94 | 0 | ✅ pass | ✅ 有防护 | 本轮补跑 |
| 17 | `test:unit:fast` | `vitest --config vitest.config.unit-fast.ts` | **2940** | 3 | ✅ **exit 0**（本轮补跑） | ✅ 有防护 | **实测 2937 passed / 3 skipped / 0 errors**；⚠️ 名不副实：耗时 **8m23s**，几乎等同主进程全量，CI 也从未调用它（见 §七 FM-5） |
| 18 | `test:stress` | 见 `package.json` | — | — | ⬜ 未跑 | ⚠️ unverified | 需长时；建议单独排期 |
| 19 | build（CI 内联） | `npx electron-vite build` | — | — | ⬜ 未跑 | ⚠️ unverified | 本机 `emptyOutDir` 撞 safe-delete（已知） |

---

## 三、四种失效模式检测结果

按 `rnd-quality-assessment` §FM-1…FM-4 逐项检测：

| 失效模式 | 检测手法 | 结果 |
|---|---|---|
| **FM-1** 门禁被跳过 | 抓 `skip/skipped/todo/pending` | ✅ **已清除**。三个主门禁全报 `skipped: 0`（`mcp-live`、`cli-docs`、`coverage`）。历史上曾有 8/52 被跳过导致带必崩 bug 发布，已修（`34242b5`）。 |
| **FM-2** 存在≠可用 | 空参调用全部条目 + 崩溃/校验二分 | ✅ **已覆盖**。`check:mcp-live` 调用全部 49 个工具，用 `crash-messages.cjs` 区分崩溃与校验文案。**但见 §四：该判据本身的覆盖是补的。** |
| **FM-3** 常响警告=盲区 | 连跑 3 次统计警告集合 | ❌ **发现一处**：`lint` 的 130 个警告每次完整重现，退出码恒 0 — 见 §四 |
| **FM-4** 断言是重言式 | 变异 + 数量级下限 | ✅ 三道主门禁都有数量级断言（`49`/`53`/`386`），且本轮对 `crash-messages` 做了双向变异 |

---

## 四、❌ 本轮最重要发现：`lint` 门禁实际失效

```
npx eslint src/ --ext .ts,.tsx
✖ 130 problems (0 errors, 130 warnings)
exit=0        ← CI 不会失败
```

构成（**两次运行完全相同，稳定复现**）：

| 规则 | 数量 | 涉及文件数 |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | **70** | 45 |
| `@typescript-eslint/no-unsafe-function-type` | 55 | 8 |
| `@typescript-eslint/no-unused-expressions` | 3 | 2 |
| `no-useless-assignment` | 2 | 1 |

### 根因（两条叠加）

1. **`eslint.config.mjs:37`** 把 `no-unused-vars` 设为 `'warn'`（不是 `error`）。
2. **`.github/workflows/ci.yml:24`** 跑的是 `npx eslint src/ --ext .ts,.tsx`，**没有 `--max-warnings`**。

→ 全 `warn` 级 + 无阈值 = **退出码恒 0**，CI 永远通过。

### 变异检验（已做，双向确认）

在 `src/renderer/src/components/audioShared.ts` 注入一个真实的未使用变量：

```
注入前： ✖ 130 problems (0 errors, 130 warnings)  exit=0
注入后： ✖ 131 problems (0 errors, 131 warnings)  exit=0   ← 仍然 0！
```

**结论**：新增一个未使用变量，CI **不会拦、退出码不变**，只是从 130 变成 131。
`no-unused-vars` 这条规则在实践中**已经失效**——它现在只在噪音里加一，不产生任何阻止力。

（注入已 `cp` 还原，`diff` 确认逐字节一致，md5 `b6683a40…`。）

### 修法（✅ **方案 A 已实施**，commit `28358e4`）

三选一，代价差别很大：

| 方案 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A. 加阈值护栏** ✅ **已采用** | CI 改 `eslint … --max-warnings 130` | 极小 | 低。**只能防新增**，存量 130 条保留。数字需随清理下调 |
| **B. 分级** | `no-unused-vars` 改 `error`；其余留 `warn` | 小 | 中。需先清掉那 70 条，否则 CI 立刻红 |
| **C. 清理存量** | 清零 70 条 `no-unused-vars` 后转 `error` | **大** | **高**。散在 45 个文件，含多形态渲染层 |

**A 的注意点**：`--max-warnings 130` 是「计数阈值」而非「规则阈值」，不清存量也能立刻获得阻止力——
但它有一个已知陷阱：任何人**修好**一条未使用变量，计数降到 129，阈值就**失效了**（变宽松）。
所以 A 必须配合「数字只降不升」的约定，或改用 `--max-warnings 0` + 存量 `eslint-disable` 收口。
**这条陷阱已写进 `ci.yml` 的注释**，避免下一个人修好警告后把护栏悄悄弄松。

### 方案 A 已实测验证（不是推测）

| 场景 | 命令 | 退出码 | 期望 |
|---|---|---|---|
| 当前存量 | `eslint src/ --max-warnings 130` | **0** | ✅ 放行 |
| 阈值低一档 | `eslint src/ --max-warnings 129` | **1** | ✅ 拦住 |
| 注入 2 条新违规 | `eslint src/ --max-warnings 130` | **1** | ✅ **拦住新增** |

即：加一个 `--max-warnings` 参数就能让 `lint` 立刻恢复阻止力，**无需清理存量**。
（注入已 `cp` 还原，`diff` 确认逐字节一致。）

**仍需注意**：修好存量会让计数下降，阈值随之变宽松 —— 建议 CI 里把数字写成
「当前实测值」，并在降低时同步下调，或直接用 `--max-warnings 0` + 存量 `eslint-disable` 收口。

---

## 四·五 ✅ 本轮发现并已修复的第二个缺陷：`withTimeout` 的同步抛出泄漏

### 现象

`npm test`（主进程全量）**退出码 1**，但报告显示：

```
Test Files  290 passed | 1 skipped (291)
     Tests  2988 passed | 3 skipped (2991)
    Errors  2 errors          ← 就败在这里
     Duration  635.69s
```

**2988 条用例全部通过**，却失败了。vitest 自己的警告原文：

> Vitest caught 2 unhandled errors during the test run.
> **This might cause false positive tests.** Resolve unhandled errors to make sure your tests are not affected.

2 个错误都是：

```
Unhandled Rejection
Error: prompt_llm_evolve_timeout
 ❯ Timeout._onTimeout packages/core/src/utils/async.ts:25:37
originated in tests/main/evolution/__tests__/PromptEvolutionManager.test.ts
```

### 根因（已用最小复现证实，非推理）

两处缺陷叠加：

**(1) `packages/core/src/utils/async.ts` — `fn()` 在 `try` 之外**

```ts
const work = fn()        // ← 同步抛出时，异常绕过下面的 try/finally
work.catch(() => {})
try {
  return await Promise.race([work, timeout])
} finally {
  clearTimeout(timer)    // ← 根本不会执行
}
```

`fn` **同步抛异常**时 → `work` 从未赋值 → `finally` 不执行 → 那个已创建的
`timeout` promise **无人接管** → `timeoutMs` 后 reject → **Unhandled Rejection**。

**(2) `tests/main/evolution/__tests__/PromptEvolutionManager.test.ts` — mock 方法名错配**

实现调的是 `agentRunner.runSelfTask`（`PromptEvolutionManager.ts:128,154`），
测试 mock 的却是 `runAgentTask` → `runSelfTask` 是 `undefined` → **调用即 TypeError（同步）**
→ 正好触发上面 (1)。

### 为什么藏了这么久（时序依赖）

单独跑该文件：14/14 通过、**无 unhandled、退出码 0**（连跑 2 次稳定）。
因为该文件只需 ~4s，**定时器 5s 还没到点进程就退了**。只有全量跑 10 分钟时定时器必然到期 → 暴露。

> 这正是 `evidence-based-verification` 说的「单文件绿 ≠ 全量绿」，也是
> `falsification-testing` §4(b2)「门禁从未到达被变异的分支」的镜像情形。

### 修复（已实施，双向变异验证）

1. **`async.ts`**：把 `fn()` 移进 `try`；同步抛出时 `clearTimeout(timer)` +
   `timeout.catch(() => {})` 显式收掉两样东西再抛出。注释写明为何必须如此。
2. **`PromptEvolutionManager.test.ts`**：mock 改成 `runSelfTask`；并**补强断言**。

### ⚠️ 补强断言时又抓出第三个问题（这条最有价值）

改对 mock 后，新断言 `expect(pv.evolutionReason).toContain('LLM优化')` **仍然红了**：

```
Expected: "LLM优化"
Received: "退化"
```

原因：实现里过滤解析出的指令用的是 `l.length > 10`（**严格大于 10**），
而原测试的 mock 数据 `'第一条指令'` 只有 **5 个字符** → 被静默过滤 → 走 fallback。

**所以修复前那两个用例，无论 LLM 成功还是失败，都走同一个 catch 分支**——
它们**从来没有测到过声称要测的逻辑**。`expect(pv.version).toBe(2)` 这种断言对两条路径都成立，
无法区分（这正是 `falsification-testing` §4(a)「两侧必须可区分」）。

### 变异检验（三处，全部按预期）

| # | 变异 | 结果 |
|---|---|---|
| 1 | `async.ts` 还原成修复前的 buggy 形状 | ❌ 红 —— **精确点名** `a synchronous throw does not leak the timeout rejection`（其余 5 条绿，说明只有这条承重） |
| 2 | `if (antiPatterns.length >= 1)` → `>= 999`（成功分支不可达） | ❌ 红 —— 点名 `llmEvolvePrompt 使用 LLM 输出时解析反模式指令`；而 `失败回退` 那条**正确保持绿** |
| 3 | mock 改回 `runAgentTask` | ❌ 红（见下） |

**注意变异 1 的一个反差**：buggy 版本下 `a SYNCHRONOUS throw from fn reaches the caller`
**竟然是绿的** —— 因为同步异常确实会抛给调用方，泄漏的是那个 promise 而非异常本身。
**只有泄漏断言能抓住这个 bug**。

### 新增测试

- `tests/main/core/utils/__tests__/async-timeout.test.ts`（6 条，含泄漏检测）
  —— 此前 `withTimeout` **完全没有测试**，这是缺陷能长期存活的直接原因。
- 补强后的 `PromptEvolutionManager.test.ts`（14 条）

全部变异均 `cp` 还原并 `diff` 确认逐字节一致（`aaacdeae…` / `672a0608…`）。

---

## 五、两道真实红（会被 CI 拦住）

### 5.1 `format:check` — 20 个文件未格式化 ✅ **已修复**

> **本节已更新（2026-09-20 16:00）。** 初版结论是「不建议动」，**那个结论是错的**。
> 修正见下方「修正」小节。

```
[warn] Code style issues found in 20 files. Run Prettier with --write to fix.
exit=1
```

涉及文件（**注意其中含多形态渲染层**）：

```
src/preload/index.ts
src/renderer/src/__tests__/mockIPC.ts
src/renderer/src/components/FormSwitcher.tsx
src/renderer/src/components/PeriodicPredictionToast.tsx
src/renderer/src/components/WorkflowEditor.tsx
src/renderer/src/forms/__tests__/dataSources.test.ts
src/renderer/src/forms/__tests__/shared-css.test.ts
src/renderer/src/forms/chat/ChatForm.tsx
src/renderer/src/forms/chat/styles.css
src/renderer/src/forms/chat/useChatForm.ts
src/renderer/src/forms/pet/PetAvatar.tsx
src/renderer/src/forms/pet/PetForm.tsx
src/renderer/src/forms/pet/styles.css
src/renderer/src/forms/types.ts
src/renderer/src/forms/wallpaper/__tests__/WallpaperForm.test.tsx
src/renderer/src/forms/wallpaper/styles.css
src/renderer/src/forms/wallpaper/WallpaperForm.tsx
src/renderer/src/hooks/__tests__/useAIOutput.test.ts
src/renderer/src/hooks/useAIOutput.ts
src/renderer/src/styles/components.css
```

#### 修正：先量清楚再决定「不能动」

初版我说「⚠️ 不建议无脑 `prettier --write`」，理由是其中含有多形态渲染层与样式层叠历史。
**风险提示没错，但由它推出的「不动」是错的**——我把「有风险的区域」直接当成了
「改动有风险」，跳过了中间那步：**先看预览改动到底是什么**。补做后结论反转：

| 检验 | 结果 |
|---|---|
| 全部 20 个文件，**忽略行尾后**是否还有差异 | 19 个有，1 个（`useAIOutput.ts`）**纯粹是行尾符假红** |
| 差异是否只是空白/换行/尾逗号 | 是。逐个 diff 确认只有：折行合并、参数表尾逗号、1 处尾部空行 |
| 改动后 `typecheck` | exit 0 |
| 改动后 `typecheck:budget` | 0 errors / budget 0 |
| 改动后 `test`（主进程全量） | **2994 passed**, 3 skipped, **exit 0** |
| 改动后 `test:renderer` | **449 passed**, exit 0 |
| 改动后 `test:preload` | **94 passed**, exit 0 |
| 改动后 `format:check` | **exit 0**（原 exit 1） |
| 改动后 `lint` | 130 warnings，**计数未变**（阈值仍有效） |

改动范围经 `git diff --name-only` 核对**恰好是被点名的那些文件**，无溢出。
`preload/index.ts` 顺带修掉一处真实缺陷：两行语句曾被挤在同一行。

**教训**：`git` 里的版本**本来就是 prettier-clean 的**（`git show HEAD:<file> | prettier --check`
全部通过）。也就是说这 20 个「红」里，有 1 个是**测量假象**（工作区 CRLF），
其余 19 个是格式漂移。**「这个区域有历史风险」应当转化为「先做可比对的预览」，
而不是「所以不要碰」。** 这条已写回 `evidence-based-verification` skill。

### 5.2 `audit` — 无法运行（根因是源码用了 npm 不认的 `workspace:` 协议）⚠️ **未修复，待拍板**

> **本节已二次修正。** 初版报的是「32 漏洞」（被打桩的 lock 挡住）；第一次修正归因于
> 「`package-lock.json` 陈旧」——**那仍然是错的**；第二次修正才定位到真根因（源码里的
> `workspace:` 协议）。保留初版数字只为说明它为何不可复现。

```
npm error audit endpoint returned an error
{ statusCode: 400,
  message: 'Invalid package tree, run npm install to rebuild your package-lock.json' }
```

查出**两个独立问题**，其中第二个比 CVE 严重：

**(1) `sharp` 的 CVE 真实存在，且修法明确**

```
sharp inherited vulnerabilities in libvips:
CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
GHSA-f88m-g3jw-g9cj
```

去读原始公告确认（非二手转述）：**affected `< 0.35.0`，patched `0.35.0`**，severity High。
本仓是 `0.34.5`。

但要注意它的**实际暴露面很小**：CVSS 攻击向量是 `AV:L`（本地）、`PR:L`（需低权限），
且它是 **devDependency**（不进产物）；全仓唯一用法在
`packages/capabilities/src/tool/definitions/CardGeneratorTool.ts:226`，
`sharp(Buffer.from(svg)).png().toBuffer()` —— 输入是**我们自己构造的 SVG**
（`buildCardSVG`），不是不可信输入，公告说的 GIF/TIFF/VIPS 攻击面**根本不可达**。
升级到 `0.35.x` 的要求也满足（Node ≥20.9，本地 22 / CI 20）。
**这是一个真 CVE + 真明确的修法 + 极小的实际风险。**

**(2) ★★ 真正的根因：仓库在 npm 里**用了 `workspace:` 协议**，而 npm 从不支持该协议**

> **本节已二次修正。** 初版归因于「`package-lock.json` 陈旧」，**那是错的** ——
> 陈旧 lock 只是背景，不是原因。下面是用最小复现定位到的真实根因。

**一句话**：`workspace:*` 是 **pnpm / Yarn 的协议**，npm 从来没有实现过。
npm 的工作区解析走的是**按 `name` 匹配**（见 npm 自带文档
`docs/content/using-npm/workspaces.md` 原文：
*"it's possible to consume any defined workspace **by its declared `package.json` `name`**"*）。

本仓 **46 个包、79 处** 用了 `"@akemi-mio/xxx": "workspace:*"`，因此 npm 任何安装命令必然失败。

**最小复现（3 个文件，与 akemi-mio 无关）**：

```
root/package.json          { "name":"t","version":"1.0.0","private":true,"workspaces":["packages/*"] }
root/packages/a/package.json  { "name":"@akemi-mio/a","version":"0.1.0",
                                "dependencies":{ "@akemi-mio/b":"workspace:*" } }
root/packages/b/package.json  { "name":"@akemi-mio/b","version":"0.1.0" }
```

```bash
$ npm install --package-lock-only
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

把 `"workspace:*"` 换成 `"*"` 后**同一个目录立刻安装成功**，且 lock 正确生成成员链接：

```
node_modules/@akemi-mio/a => packages/a   LINK
node_modules/@akemi-mio/b => packages/b   LINK
```

**为什么不是「npm 版本太旧」**（这是网上所有答案的说法，但都不成立）：

| 证伪步骤 | 结果 |
|---|---|
| 本机 npm | **10.9.7**（≥7，早该支持 workspaces） |
| 全量校验本机 npm 与官方 `npm-10.9.7.tgz` | **1036 个 js 文件逐字节一致**，17 个差异**仅为行尾空白**，28 个缺失全是 `test/`（Node 分发包裁掉）→ **npm 安装未被污染** |
| 用 **npm 11.6.2** 自带的 `arborist@9.1.6` 跑同一最小复现 | **同样失败**，报同一个 `EUNSUPPORTEDPROTOCOL` |
| 在本机 npm 全树 grep `workspace:` 协议处理代码 | **不存在**（命中仅 3 处，均为 lock 字段名 / CLI flag 名，与协议解析无关） |

**为什么失败在这个位置**（`--loglevel=silly` + 打桩 `npa.resolve` 定位）：

根节点是**正确**的（`root.workspaces` 两个成员齐全，root 的边是 `type=workspace, spec=file:...`）；
但**工作区成员节点拿不到 `workspaces` 映射**（`Node.workspaces` 只在 root 上被
`_setWorkspaces` 赋值，构造器里恒为 `null`）。于是成员 `packages/a` 的
`dependencies` 走 `#loadDepType`，那个 `current.type !== 'workspace'` 的跳过条件不生效，
`workspace:*` **原样** 变成一个 `type=prod, spec="workspace:*", valid=false` 的边：

```
#buildDepStep (build-ideal-tree.js:869)
  → #problemEdges (1157)
    → Edge.valid (edge.js:214) → Edge.error (239)
      → Edge.satisfiedBy (115) → depValid (dep-valid.js:149 → 23)
        → npa.resolve('@akemi-mio/b', 'workspace:*', '...\\packages\\a')
          → 抛 EUNSUPPORTEDPROTOCOL
```

**修法**：把 46 个包 / 79 处 `workspace:*` 改写成 npm 认识的写法。
`"*"` 已验证可用（走 name 匹配 → 生成 `LINK`）；等价的 `"^0.1.0"` 也可，因为这些包
**确实都已发布到 npm 0.1.0**（`@akemi-mio/runtime-contracts`、`runtime-foundation`、
`experience-memory`、`evolution-*`、`observer`、`insight` 逐一查证过 `dist-tags.latest`）。

**附带发现**：`packages/audit/package.json` 声明了
`"@akemi-mio/eventBus": "workspace:*"` —— 该成员**不存在**（无目录、npm 上 `Not found`），
且 `audit/src/EventAuditor.ts` 实际是从 `@akemi-mio/core/core/EventBus` 导入的。
**这是一条纯悬挂依赖**（全仓唯一引用点），属于必须一并清掉的死声明。

⚠️ **与本次改动无关**（既有状态）：`git show HEAD:package.json` 与工作区一致，
`workspace:` 引用是随 monorepo 化一起进来的。

**仍未完成**：把 `workspace:*` 换成 `*` 后，`EUNSUPPORTEDPROTOCOL` **消失**，
但暴露出**第二个、独立的错误**：`Cannot read properties of null (reading 'edgesOut')`。

#### 第二个缺陷：`#loadPeerSet` 解引用 null parent

定位到确切崩溃点（`--loglevel` 栈）：

```
TypeError: Cannot read properties of null (reading 'edgesOut')
  at #loadPeerSet (build-ideal-tree.js:1289:38)
  at async #loadPeerSet (1297:11)   ← 递归 3 层
  at async #loadPeerSet (1308:23)
  at async #buildDepStep (904:11)
  at async Arborist.reify (reify.js:133:5)
  at async Install.exec (install.js:150:5)
```

`1289` 行是 `const parentEdge = node.parent.edgesOut.get(edge.name)` ——
`node.parent` 为 `null`。触发者是 **vitest 的 optional peer 集合**：
日志显示最后卡在 `idealTree:node_modules/vitest`，
且同一轮里既 fetch 了正确的 `@vitest/browser-playwright@4.1.11`，
又 fetch 了**跨大版本的 `@vitest/browser-playwright@5.0.1`**。

`vitest@4.1.11` 的 `peerDependencies` 有 **12 条**，其中 11 条 optional
（`@vitest/browser-playwright: "4.1.11"`、`@vitest/browser-preview`、
`@vitest/browser-webdriverio`、`@vitest/coverage-istanbul` …）。
这些**我们一个都没声明**（全仓 grep 无命中）—— 纯粹是 npm 追着 optional peer 走，
在构建那组 peer 时撞上无父节点。

**两个缺陷都被证伪过的对照表**：

| 施加的修改 | 结果 |
|---|---|
| 只把 `workspace:*` → `*` | ❌ `EUNSUPPORTEDPROTOCOL` 消失，但 `edgesOut` 崩溃 |
| `workspace:*` → `*` **+ `--legacy-peer-deps`** | ✅ **exit 0**，生成正确的 workspace 感知 lock |

验证结果（`--legacy-peer-deps` 路径）：

```
npm install --package-lock-only --legacy-peer-deps   → exit 0, "up to date in 3m"
生成 lock: 1170 条目 / workspaces=["packages/*"] / packages/* 73 条
           node_modules/@akemi-mio/* 67 条 / link:true 68 条
npm ci --dry-run --legacy-peer-deps                   → exit 0, "added 1101 packages"
```

**对照（旧 lock）**：1053 条目 / `workspaces: undefined` / `packages/*` 0 条 / `link` 0 条。

#### 第二个缺陷的确切触发链（已完整证明）

崩溃点前最后的 fetch 序列（日志行号连续，全是 cache hit，无网络干扰）：

```
5226  fetch manifest @vitejs/devtools-vitest@^0.7.5
5230  fetch manifest vitest@*                    ← 通配符
5234  fetch manifest @vitest/browser-playwright@5.0.1   ← 跨大版本 5.x
5236  fetch manifest vitest@4.1.11               ← 我们声明的 4.x
5240  fetch manifest @vitest/coverage-v8@4.1.11
5242  fetch manifest jsdom@*
5246  TypeError: Cannot read properties of null (reading 'edgesOut')
```

链条：`@vitejs/devtools@0.7.5` 声明 **`peerDependencies: { "vite": "*" }`**（通配符）
→ 通配符 peer 把 `vitest` 拉到 **5.0.1**（latest）
→ 5.0.1 带出 `@vitest/browser-playwright@5.0.1`
→ 递归 `#loadPeerSet`（栈里 3 层嵌套）下探到一个 `parent === null` 的节点
→ `build-ideal-tree.js:1289` 的 `node.parent.edgesOut.get(...)` 抛 TypeError。

#### 修法对照（全部实测，同一份源码只改一处）

| 施加的修改 | 结果 |
|---|---|
| **只把 `workspace:*` → `*`** | ❌ `EUNSUPPORTEDPROTOCOL` 消失，但 `edgesOut` 崩溃 |
| 上一个 + `overrides` 钉 `@vitest/{browser-playwright,browser-preview,browser-webdriverio,coverage-istanbul}@4.1.11` | ❌ 仍 `edgesOut` 崩溃（日志里依旧 fetch `browser-playwright@5.0.1`） |
| 上一个 + 根部把 `canvas@^3.2.3` 加成 `optionalDependencies` | ❌ 仍 `edgesOut` 崩溃 |
| 上一个 + **`--legacy-peer-deps`** | ✅ **exit 0** |

**结论**：`--legacy-peer-deps` 是**目前唯一被实测证实可用**的路径 ——
因为它**整体跳过 peer 解析**，那个通配符 peer 与递归下探根本不会发生。
三个「精确」修法都失败，说明问题不在某一个 peer 的版本，
而在**递归 peer-set 构建本身遇到无父节点时的空指针**（arborist 的健壮性缺口）。

### ⚠️ 修复方案已验证，暂缓应用（用户 2026-09-21 决定先不改）

修复方案已就绪（已实测验证，但**用户决定暂缓应用，未改动仓库**）。实际改动清单
（与「改动清单」一致，第 3 点建议用 `.npmrc` 而非改 5 处 CI）：

1. `workspace:*` → `*`：**46 个包 / 79 处**（JSON 感知替换，全 46 个文件解析合法，0 残留）。
2. 删 `packages/audit` 的 `@akemi-mio/eventBus` 悬挂依赖（该成员不存在）。
3. 仓库根 **`.npmrc`** 加 `legacy-peer-deps=true`（一处覆盖全部 5 处 `npm ci`，比改 CI 更干净）。
4. 重建 `package-lock.json`（1053 → **1170** 条目）。

**验证（同隔离副本一致）**：

```
npm install --package-lock-only --legacy-peer-deps   → exit 0, "audited 1170 packages"
npm ci --dry-run --legacy-peer-deps                  → exit 0
生成 lock: 1170 条目 / workspaces=["packages/*"] / @akemi-mio/* 67 / link:true 68
```

→ **应用后 CI 全部 5 处 `npm ci` 即可通**（`.npmrc` 自动生效）。当前仓库未应用，安装链仍「无法运行」。

### 🔥 应用修复后会暴露的问题：`audit` 将能跑，报 **31 漏洞（18 high / critical）**

安装链修好后 `npm audit` 因 lock 正常即可运行；当前仓库未应用修复，`audit` 仍因 lock 损坏 400 跑不了，
若在已修复的副本上以 CI 口径（`npm audit --audit-level=high`）实测：

```
npm audit --audit-level=high   → exit 1
31 vulnerabilities (13 moderate, 16 high, 2 critical)
```

含 2 个 **critical**（如 `vite <=6.4.2` 的 GHSA-v6wh-96g9-6wx3 / GHSA-fx2h-pf6j-xcff；
`exceljs` 经 `uuid` 传递）。**这是安装链修好后才看得见的新问题，与安装链修复本身无关。**

⚠️ **未处理**：`npm audit fix --force` 会大改版本、有破坏风险，未擅自执行。
建议作为**独立任务**排期（升级 vite 到 6.4.3+、exceljs、sharp 等），不在本次安装链修复内。
`audit` 门禁本身**仍不在 CI**（FM-5），所以目前不阻塞合并——但 2 个 critical 不应长期搁置。

---

## 六、⚠️ 无法运行的门禁（前置条件缺失）

| 门禁 | 失败症状 | 退出码 | 缺什么 |
|---|---|---|---|
| `check:renderer-entries` | `Error: 打包目录不存在：dist-electron` + 栈 | 1 | `dist-electron/`（本机只有 `out/`） |
| `check:idle-gpu` | `[idle-gpu] 找不到打包后的 AkemiMio.exe` | **2** | 打包 exe |

**两者的失败都是诚实的**（都在 `dist-electron`/exe 缺失时明确报错并给出非 0 退出码），
不是 FM-2 意义上的假绿。它们的 `⚠️ unverified` 是因为**本次无法执行变异检验**。

> 修法：`npm run build && npx electron-builder --win --dir` 生成产物后可补测。
> 本机 `electron-vite build` 受 `emptyOutDir` 撞 safe-delete 限制（见记忆 §五），需按既有配方处理。

**另注**：`check:idle-gpu` 有一处设计值得留意 —— 它用 `process.exit(2)` 表达「缺前置条件」，
与「检测到回归」区分开（后者 `exit(1)`）。这是好实践，建议其它门禁沿用。

---

## 七、★ CI 覆盖面缺口：有门禁，但 CI 从不执行

> 本节是 2026-09-20 20:30 补测时发现的**第五类失效模式**，前四类（FM-1…FM-4）都没覆盖它。
> 参照 `rnd-quality-assessment` 的框架，可命名 **FM-5「门禁存在但不在流水线上」**。

判据不是「脚本名是否出现在 `ci.yml` 里」（`npx` 直调会漏判），而是**逐条比对脚本的命令体**。
实测结果（`.github/workflows/ci.yml` 全部 5 个 job、17 个 `run:` 步骤）：

| 门禁 | 命令体 | CI 是否执行 |
|---|---|---|
| `typecheck` | `tsc -p node && tsc -p web` | ✅ 是（`ci.yml:21`） |
| `lint` | `eslint src/ … --max-warnings 130` | ✅ 是（`:31`） |
| `format:check` | `prettier --check "src/**/*.{ts,tsx,json,css}"` | ✅ 是（`:34`，npx 直调） |
| `build` | `electron-vite build` | ✅ 是（`:40`，npx 直调） |
| `test` / `coverage` | `vitest run --coverage` | ✅ 是（`:53`，主进程） |
| `test:renderer` | `vitest run --config vitest.config.renderer.ts` | ✅ 是（`:66`） |
| `test:preload` | `vitest run --config vitest.config.preload.ts` | ✅ 是（`:79`） |
| `check:cli-docs` / `check:coverage` / `check:mcp-live` | — | ✅ 是（`:99`/`:104`/`:110`） |
| `check --workspace mio-agent-runtime` | — | ✅ 是（`:37`/`:96`） |
| `check:form-registry`（**09-21 新增**） | `node scripts/check-form-registry.cjs` | ✅ 是（quality job，`Build` 之前）—— 见本节「补记」 |
| **`typecheck:budget`** | `node scripts/typecheck-budget.mjs --budget 0` | ❌ **否** |
| **`test:unit:fast`** | `vitest run --config vitest.config.unit-fast.ts` | ❌ **否** |
| **`test:stress`** | 12 个 `*.stress/benchmark/endurance/baseline` 文件 | ⚠️ **CI 否，但 weekly-stress.yml:18 会跑**（见下方更正） |
| **`audit`** | `npm audit --audit-level=high` | ❌ **否**（`weekly-audit.yml` 里 `npm audit` 出现 **0 次**） |
| **`check:renderer-entries`** | `node scripts/check-renderer-entries.cjs` | ❌ **否** |
| **`check:idle-gpu`** | `node scripts/check-idle-gpu.cjs` | ❌ **否** |

> ⚠️ **本表原结论有一处错误，2026-09-21 更正**：原写「**6 道**门禁…不在**任何**流水线上」，
> 但当时只逐条比对了 `ci.yml` 的 17 个 `run:` 步骤，**没有看 `.github/workflows/` 下的另外两个文件**。
> 检索全部三个 workflow 后（`grep -rn "<命令体>" .github/`）：
> `test:stress` **确实在** `weekly-stress.yml:18`（每周日 22:00 + `workflow_dispatch`）。
> → 「不在任何流水线上」的准确数字是 **5 道**，不是 6 道。
> 教训与本报告 §5.2 那次同源：**结论的范围超出了取证的样本范围**。
> 顺带确证：`weekly-audit.yml` 虽叫 "Audit"，**`npm audit` 出现 0 次**（它跑的是 ts-prune / 长函数 / 配置漂移），
> 所以 `audit` 这道门禁确实无人调用 —— 结论对，但理由与原文所述不同。

### ★ 顺带发现 FM-6：门禁在流水线上，但被 `continue-on-error` 摘掉了失败能力

比「不在流水线上」更隐蔽：门禁**真的在跑**，可它**永远不能让这次运行失败**。

| Workflow | 步骤 | 现象 |
|---|---|---|
| `weekly-stress.yml` | `Run stress tests` → `npm run test:stress` | 曾带 `continue-on-error: true` + `timeout-minutes: 15` |
| `weekly-audit.yml` | 测试 / 死代码 / 长函数 / 配置漂移 | 4 个实质步骤**全部** `continue-on-error: true`（在行 21/27/55/64） |

后果：

- **`weekly-stress`**：若压测回归，job **结论仍是 success**，且该 workflow **没有任何失败通知**
  （无 issue 创建、无 slack/邮件）。→ **压测回归是完全静默的盲区。**
  「每周有跑压测」这句话是真的，但它提供的保障是 0。
- **`weekly-audit`**：4 个检查都失败也不能让 job 变红；它唯一的通报渠道是自动建 issue。
  这算**有通报但不会失败**，比 stress 强，但同样淹掉了「红灯」语义 —— 除非有人真的去看 issue。

判据：`continue-on-error: true` 出现在**实质检查步骤**上就是可疑的。
它的正当用途是「可选/探索性步骤」，不是「我们做一下检查但不想知道结果」。

### ★★ 更进一步的发现：`test:stress` 当时连一个文件都没匹配到

顺着上面查下去时发现，这道门禁当时的状态比「失败不了」还糟 —— **它什么都没跑**：

```
$ npm run test:stress
No test files found, exiting with code 1      # 3 秒退出，12 个文件一个没匹配
```

原因是脚本里的 4 个 glob **全部失配**：

```
vitest run tests/main/**/__tests__/*.stress.test.ts tests/main/**/__tests__/*.benchmark.test.ts …
```

实测（vitest 4.1.11）：CLI 位置参数在这里是按**子串**匹配的，`**` / `*` **不作为通配** ——

| 过滤写法 | 命中 |
|---|---|
| `tests/main/**/__tests__/*.stress.test.ts` | **0** |
| `tests/main/**/*.stress.test.ts` | **0** |
| `**/*.stress.test.ts` | **0** |
| `tests/main/*/__tests__/*.stress.test.ts` | **0** |
| `.stress.test`（子串） | **10** ✅ |

而那 12 个文件是**真实存在且全绿的**（`find` 数到 12；子串过滤实跑 **12 passed / 57 tests / 38s**）。

三重叠加，正是「看起来被覆盖、实际保障为 0」的完整链条：

1. glob 失配 → 一个文件都没选到，命令 3 秒 exit 1；
2. `continue-on-error: true` → 这次 exit 1 **不会**让 job 变红；
3. 该 workflow **无任何失败通报** → 没有人在任何地方看到过它。

> 这正是本报告反复强调的那条：**「0 条用例」/「No test files found」= 门禁已死，不能当绿。**
> 它这次藏在 `continue-on-error` 后面，藏得更深。

**修复（2026-09-21 已实施）**：

1. `package.json` 的 `test:stress` 改用可用写法 ——
   `vitest run .stress.test .benchmark.test endurance.test baseline.test`（不加引号，
   bash/cmd 都无需展开；`.` 不是通配符所以两种 shell 下都安全）。
   修复后实测：**12 passed / 57 tests / exit 0**，耗时 **~40s**（不是长时任务，
   原 `timeout-minutes: 15` 完全可以兜住）。
2. `weekly-stress.yml` 去掉 `continue-on-error: true`，压测回归现在**真的会红**。
   之所以敢直接去掉：已实测全绿且只要 40s，不是「一放就常响的警告」。
3. `weekly-audit.yml` 的 4 个 `continue-on-error` **本轮未动** ——
   它的通报渠道是自动建 issue，且「死代码/长函数」是**趋势性指标**，
   直接让它红会立刻变成常响噪音（本报告门禁三条之③）。要改应先定「何谓失败阈值」，
   属于单独的设计决策，不宜顺手改。**列为待办。**

**5 道门禁不在任何流水线上（不含 test:stress）；另有 1 道在流水线上但被摘掉了失败能力 ——
且该门禁在修复前连文件都没匹配到。**

### 逐条评估（不是所有缺口都同等严重）

| 门禁 | 严重度 | 判据 |
|---|---|---|
| `check:renderer-entries` | **高** | 它守的是「三处形态注册表不一致 → 运行期空白屏」（见记忆 §三）。**这类 bug 只在运行时暴露，其它门禁全看不见** —— 而它恰恰不在 CI 里。这是最该补的一条。 |
| `check:idle-gpu` | **中** | 守能耗回归（历史 `80c530e` 136%→0.0%）。需要打包 exe，CI 里补的成本高（要跑 electron-builder）。 |
| `audit` | **中** | 依赖 `npm ci` 可用；当前**根本跑不了**（§5.2）。安装链修好后应补上。 |
| `test:stress` | **中（09-21 上调）** | 12 个文件，纯长时压测，**不适合每次 PR** —— 这一点没变。但**它已经**在 `weekly-stress.yml:18` 排了每周日 22:00，所以缺口**不是「没排期」**（原判据写错了），而是 **`continue-on-error: true` 让它失败不了**，见 FM-6。原判据误导性在于：让人以为要补一个 schedule，实际上该改的是让它能红。 |
| `typecheck:budget` | **低（部分重叠）** | CI 的 `npm run typecheck` 本身就会 fail on error，**但不是等价物**：budget 脚本能捕获「tsc 退出码非 0 但错误数在预算内」之外的情形，且它把 node+web **合并计数**并显式声明预算。CI 里 `&&` 串联的 `typecheck` 已经覆盖了主要风险，缺口是**没有可见的预算陈述**。 |
| `test:unit:fast` | **低（冗余）** | 实测它并不「fast」——**8m23s**，几乎等同于主进程全量。CI 的 `main-tests` job 已经跑了 `vitest run --coverage`（覆盖更广）。所以**这条不补也没关系**，反倒是这个名字有误导性。 |

### 建议（按性价比排序，均未实施）

1. **`check:renderer-entries` 进 CI quality job** —— 它不需要打包产物也能报「注册表不一致」吗？
   需先确认（本机因缺 `dist-electron/` 在 exit 1 处更早退出，未验证到形态检查段）。
   → **2026-09-21 已确认并改用另一种做法**：读源码即可判定它**必须**有 exe ——
   `findExe()` 是模块顶层调用（`check-renderer-entries.cjs:52`），`dist-electron/` 不存在时
   直接抛 `打包目录不存在`，**根本走不到形态检查段**。所以「把它塞进 quality job」不可行。
   改为补一道**静态等价门禁**：`scripts/check-form-registry.cjs`（`npm run check:form-registry`），
   直接比对三处源文件，已加入 quality job。详见本节「补记」。
2. `audit` 加进 quality job（**依赖安装链先修好**）。
3. ~~`test:stress` 单独 job + `schedule:`（夜间）~~ → **更正并已修（09-21）**：schedule 早已存在
   （`weekly-stress.yml`，每周日 22:00 + `workflow_dispatch`），真正的病是**脚本 glob 全失配
   （0 文件）+ `continue-on-error`（失败不红）+ 无通报**。已改：脚本改用可用写法
   （实测 12 passed / 57 tests / 40s）、去掉 `continue-on-error`。见 FM-6。
4. `typecheck:budget` 与 `typecheck` 二选一，避免同一次 CI 跑两遍 tsc。
5. `test:unit:fast` 要么改名（如 `test:main:unit`），要么删——**当前名字与实测耗时严重不符**。

### 已做的验证与未能做的验证（口径要说清）

**已实证的部分**：

| 检验 | 命令 | 结果 |
|---|---|---|
| `typecheck:budget` 未被任何 workflow 引用 | `grep -rn "typecheck-budget\|typecheck:budget" .github/` | **0 命中** |
| 该门禁确实会红（不是「永远绿」） | 注入 `__MIO_MUTATION__` 后运行 | **exit 1**（真红，非假绿） |
| 变异还原 | `diff` + `md5sum` | 逐字节一致（`4d930378…`） |

**未能实证的部分（诚实标注）**：我**没有**真的把这条变异推给 GitHub Actions 跑一次 CI，
因此「CI 会保持绿」是从 `run:` 列表**推断**的，不是观测到的。
—— 但推断的依据很强：该脚本的命令体**不出现在任何 workflow 的任何 `run:` 里**，
CI 没有任何途径执行它。若要闭合这个循环，需推一个含变异的提交看 CI 结果。

⚠️ 顺带记一次**我自己又踩了 `cmd | tail` 陷阱**：上表第一次跑变异时我写了
`node … | tail -5; echo $?`，得到 `exit=0`，差点据此写下「变异没有生效」。
改用 `node … > f 2>&1; echo $?` 后才是真实的 `exit=1`。
这正是本报告 §八 第 1 条列出的那个陷阱 —— **同一个坑，同一份文档里，我又踩了一次。**

### 补记（2026-09-21）：FM-5 头号项已闭环 —— 但不是按原建议的方式

**先回答本节遗留的问题**：「`check:renderer-entries` 不需要打包产物也能报注册表不一致吗？」
**不能。** `check-renderer-entries.cjs:52` 在**模块顶层**就调 `findExe()`，`dist-electron/` 不存在时
直接抛 `打包目录不存在` 并 exit 1，**永远走不到形态检查段**。所以把它搬进 quality job 的前提是
先跑 electron-builder —— 成本高、且 quality job 目前刻意不产出打包产物。

**改用的做法**：补一道**静态等价门禁**，直接读三处源文件比对：

| 项 | 内容 |
|---|---|
| 脚本 | `scripts/check-form-registry.cjs`（`npm run check:form-registry`） |
| CI 位置 | `.github/workflows/ci.yml` quality job，`Build` 之前 |
| 检查对象 | `src/renderer/src/forms/types.ts` 的 `FORM_KINDS`/`FORM_REGISTRY`、<br>`packages/core/src/core/Lifecycle.ts` 的 `FORM_SPECS`、<br>`electron.vite.config.ts` 的 renderer `rollupOptions.input` |
| 比对内容 | 形态集合（含 `FormKind` 联合类型）、`htmlFile`、`size`/`minSize`、6 个窗口标志、<br>`alwaysOnTopLevel`、`acceptsMouseEvents ↔ ignoreMouseEvents` 互为取反、html 文件真实存在 |
| 耗时 | 秒级，无依赖、无产物 |

**为什么这是真缺口而不是重复**：`forms/__tests__/types.test.ts` 只校验 `FORM_REGISTRY` **自身**
（键齐、`htmlFile === kind + '.html'`、透明形态无边框……），三份副本**各自内部都是自洽的**。
所以「types.ts 加了形态但 vite 没加 input」「Lifecycle 的 size 与 registry 不一致」这类漂移，
构建、typecheck、lint、以及那个既有测试**全都看不见**，只在运行期表现为窗口空白。

**本门禁自身的验证（都做了，命令可复核）**：

| 检验 | 手段 | 结果 |
|---|---|---|
| 三处源各改坏一次必须变红 | 6 组变异（改名 htmlFile / 改尺寸 / 删 vite 入口 / 反义字段搞错 / 改置顶层级 / 删整个形态） | **6/6 均 exit 1**，且报出预期的差异文案 |
| 变异还原 | 内存原文回写 + `md5` 复核 | **零漂移**，门禁回绿 |
| 判据本身被直接测 | `tests/main/renderer/__tests__/form-registry-gate.test.ts`（15 条） | **15 passed** |
| 那些断言是否承重 | 把 `compare()` 改成恒返回空 → 变红 **12** 条；整段删掉防空转守卫 → 变红 **2** 条；`collect()` 返回空集 → 变红 **2** 条 | **全部承重** |
| 防空转 | 解析失配（读到空集）时**主动报错**而非在空集上判「集合相等」 | 见上条 |

⚠️ 过程中踩的两个坑，记下来：
1. **夹具锚点必须用正则**：`electron.vite.config.ts` 等工作区文件是 **CRLF**，
   字面量锚点里写 `\n` 会静默失配（命中 0 次），于是「变异没生效」被误读成「门禁没抓到」。
   夹具里已加**锚点命中次数必须为 1** 的断言，专门拦这类假变异。
2. **vitest 输出带 ANSI 颜色码**：`Tests\u001b[22m \u001b[1m\u001b[32m15 passed` ——
   直接正则抓计数会得 0，必须先剥 `\u001b[..m`。差点据此判「测试全没跑」。

**仍未闭环的 FM-5 项**：`check:idle-gpu`（需 exe，中）、`audit`（等安装链，中）、
`test:stress`（建议独立 schedule job，中低）、`typecheck:budget`（与 `typecheck` 二选一，低）、
`test:unit:fast`（改名或删，低）。**`check:renderer-entries` 本身仍不在 CI** ——
它是运行期真跑，价值独立于本静态门禁，但需要打包产物才有意义。

---

## 八、口径提醒（给读这份报告的人）

1. **`⚠️ unverified` 不是通过**。它表示「没验证」，不是「没问题」。
2. **本报告的所有数字都附了命令**，可复核。基准提交：`c4c3d2b`（本轮共 5 个修复提交）。
3. **未做的事**：`test:unit:fast` / `test:stress` / build 未跑；它们的承重性未验证。
   （`test:renderer` / `test:preload` 已于本轮补跑，因格式化改动需要它们背书。）
4. **一个反复出现的教训**：本报告撰写过程中，我自己有 **5 次**因工具使用不当或推理跳跃产生错判——
   - `cmd | head` / `cmd | tail` 吃掉真实退出码（把 `exit=2` 误读成 0，并据此得出过错误的
     「静默假绿」结论，已撤回）；
   - `grep "[warn]"` 把方括号当字符类 → 20 个文件报成 0 命中（**写下这条时我上一句刚引用它，
     却又踩了一次**）；
   - 写 frontmatter 校验脚本正则写错 → 全报 `name_match=False`（自造假红）；
   - 用 prettier 的 **Node API** 比对时传 `filepath`，**它不读 `.prettierrc`** → 得到
     「引号全被改写」的假差异，一度以为格式化会改动语义。CLI 才是对的（会读配置）；
   - 由「这些文件在样式层叠敏感区」直接推出「所以不要格式化」，**跳过了「先看改动预览」**。
     §5.1 因此整节结论反转。

   **每条结论都值得复核，包括我的。** 尤其：**任何一次「某道门禁坏了」的结论，
   先确认自己用的测量工具是对的。** 这 5 次里有 4 次是仪器错，不是被测对象错。

   **区分两类错**（口径不要混）：
   - **测量误差 5 次**（上面列的那些）——仪器读错，被测对象其实没问题。
   - **结论被推翻 2 次**——仪器是对的，但我**从正确读数推出了错误结论**，
     且这两次都已写进正文修正（§5.1 `format:check` 的「不建议动」、§5.2 的「lock 陈旧」）。
     共同特征是：**跳过了一次低成本的验证**（看改动预览 / 做最小复现）。
