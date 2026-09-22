# akemi-mio 门禁承重性评估（2026-09-20）

> 方法：`rnd-quality-assessment` skill 的**九种**失效模式 + `falsification-testing` 的变异检验。
> 原则：**没做过变异的门禁标 ⚠️ unverified，绝不标 ✅。** 所有读数可被复核（命令附在表内）。

**本轮结论摘要**（*为事后更新，见各节内「已更新」标记*）：

- 发现并**已修复** 1 个库级缺陷（`withTimeout` 定时器泄漏 → 全量测试 `exit 1`），
  主进程测试 **2988 passed + 2 errors → 2994 passed + 0 errors**。
- 发现并**已修复** 2 个「测不到所声称逻辑」的用例（含 1 个 mock 方法名错配）。
- 发现 **1 个实际失效的门禁**：`lint`（130 条常响警告 + 退出码恒 0）—— ✅ **已修**（`28358e4`）。
- 发现 **2 道真实红**：`format:check`（20 文件）—— ✅ **已修**（`c4c3d2b`）；
  `audit` —— ⚠️ **无法运行**（根因见下条，非 CVE 问题）。
- **2 道门禁无法运行**（缺打包产物，前置条件）→ ✅ **2026-09-22 已闭环**：
  新增 `packaging` job 跑 electron-builder `--win --dir` 产出 exe，两道门禁都接了上去 —— 见 §九。
- ★ **新发现 FM-5：门禁存在、可执行，却不在 CI 流水线上** —— 见 §七。
  原写「**6 道**」，⚠️ **09-21 更正为 5 道**：`test:stress` 其实在 `weekly-stress.yml:18`
  （09-20 只逐条比对了 `ci.yml`，漏看 `.github/workflows/` 下另两个文件）。
  **其中 `check:renderer-entries` 最该补**（它守的是「三形态注册表不一致→空白屏」，其它门禁全看不见）。
  📋 **五道的当前状态**：
  | 门禁 | 状态 |
  |---|---|
  | `typecheck:budget` | ✅ 09-21 顶替 CI 的 typecheck 步骤（已做变异检验） |
  | `test:stress` | ✅ 09-21 修好写法（12 passed）并去掉 `continue-on-error` |
  | `test:unit:fast` | 🗑 09-21 已删（名不副实 8m23s + 是 CI 已跑内容的子集 + 无消费者） |
  | `check:renderer-entries` | ✅ **09-22 进 CI**（`packaging` job）；另补静态等价门禁 `check:form-registry` 守住最关键的那类不一致 |
  | `check:idle-gpu` | ✅ **09-22 进 CI**（同一个 `packaging` job） |
  ⚠️ 新引入的 `packaging` job **尚未在 CI 实跑过**（本机无法预演打包，且 `gh` 未登录看不到运行结果）——
  阈值与「打包形态能否在 runner 上启动」都待首跑标定，见 §九。
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
  ✅ **修复方案已于 2026-09-22 应用**（用户批准「应用全套」）→ `fe3a130`，51 文件：
  `workspace:*`→`*`（46 包 / 79 处）+ 删 `@akemi-mio/eventBus` 悬挂依赖 + **npm 11** 重建 lock
  + CI 5 处显式装 npm 11 + 声明 `engines.npm >=11`。⚠️ **没有用 `.npmrc` 的 `legacy-peer-deps=true`** ——
  缺陷二的正解是升级 npm（见 §5.2 的 09-22 更正），不需要任何 peer 语义让步。
- 🔥 **`audit` 现在能跑了，而且是红的**（09-22 实测，安装链修好后的第一次）：
  `npm audit --audit-level=high` → **exit 1，32 漏洞（14 moderate / 16 high / 2 critical）**。
  2 个 critical：`protobufjs <=7.6.4`、`tar <=7.5.20`。
  建议单列任务升级 vite / exceljs / sharp 等，**未擅自 `audit fix --force`**。
  ⚠️ `audit` **故意仍未进 CI** —— 一进就让所有合并变红，那是既有的存量债，不该由门禁来背（见 §5.2 末）。
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
| 17 | ~~`test:unit:fast`~~ | ~~`vitest --config vitest.config.unit-fast.ts`~~ | **2940** | 3 | ✅ exit 0 | ✅ 有防护 | 🗑 **2026-09-21 已删除**（含 `vitest.config.unit-fast.ts`）：名不副实（耗时 **8m23s**，几乎等同全量），且是 CI 已跑的 `vitest run --coverage` 的**子集**，CI 与脚本**均无消费者**（`grep` 只命中 package.json 与本报告）。见 §七 |
| 18 | `test:stress` | 见 `package.json` | **57** | 0 | ✅ **exit 0** | ✅ 有防护 | **2026-09-21 已修**：原 4 个 glob 全失配 = **0 文件 exit 1**；改用可用写法后实测 **12 passed / 57 tests / ~40s**。同时去掉 `weekly-stress.yml` 的 `continue-on-error`。见 §七 FM-6 |
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

> ⚠️ **2026-09-22 更正：上面「唯一可用路径」的结论是错的。** 见下节。
> 当时把「换 npm 11 也失败」记成了「npm 版本没用」，但那次**是在 `workspace:` 协议仍在的
> 前提下测的** —— 协议不支持是缺陷一，任何 npm 版本都解不了，于是掩盖了 npm 11 对缺陷二的效果。

### ✅ 2026-09-22：缺陷二的正解是**升级 npm**，不是放宽 peer 语义

按「先构造能变绿的最小复现」把两个缺陷拆开重测：

**最小复现**（推翻了「与 `workspace:` 有关」的旧判断）：

| 场景 | 结果 |
|---|---|
| 单包、无 workspaces、**不涉及 `workspace:`**，只有 `vitest@^4.1.7` | ❌ 崩 `edgesOut` |
| `jsdom` 单独 / `vite` 单独 | ✅ 装得上 |
| `vitest 4.0.0` / `4.0.18` | ✅ 装得上 |
| `vitest 4.1.0 / 4.1.4 / 4.1.7 / 4.1.11` | ❌ **全崩**（4.x 最新即 4.1.11） |

→ **缺陷二与 `workspace:` 协议无关**，是 npm 10 在 vitest 4.1 的 peer 结构上触发的 arborist 空指针。

**在真实依赖图上验证**（只拷 68 个 `package.json`，不需要源码）：

| 组合 | 结果 |
|---|---|
| npm 10.9.7 + `workspace:*`→`*` | ❌ `edgesOut` 崩溃 |
| npm 10.9.7 + 同样改动 + 删悬挂依赖 | ❌ **仍崩**（对照组：证明是 npm 版本的问题） |
| **npm 11 + `workspace:*`→`*` + 删 `@akemi-mio/eventBus`** | ✅ **added 978 packages in 25s，exit 0** |

生成的 lock（`npm@11 --package-lock-only`）质量与旧方案等价且更好：

```
lockfileVersion 3 / 1195 条目 / link:true 68 / packages/* 73 / node_modules/@akemi-mio/* 67
（--legacy-peer-deps 方案：1170 / 68 / 73 / 67）
```

**意义**：用户 09-21 暂缓应用修复的理由是「唯一手段是 `--legacy-peer-deps` 这种全局放宽
peer 语义的钝器」。**这个前提现在不成立了** —— 缺陷二可以靠升级 npm 解决，
不需要任何 peer 语义上的让步。

**最终清单（✅ 2026-09-22 全部应用，提交 `fe3a130`，51 文件）**：

1. ✅ 46 个 package.json 的 79 处 `workspace:*` → `*`（缺陷一，无替代）
2. ✅ 删 `packages/audit` 的 `@akemi-mio/eventBus` 悬挂依赖
3. ✅ 用 **npm 11** 重建 lock（`npx --yes npm@11 install --package-lock-only`）
4. ✅ CI 增加 5 步显式装 npm 11（node 20/22 自带的是 npm 10，**不会**自带 11）
5. ✅ `package.json` 声明 `engines.npm >= 11`

⚠️ **第 3 点没用 `.npmrc`**：`legacy-peer-deps=true` 那版方案已被 09-22 的更正推翻（见上节），
改用「5 处 CI 显式装 npm 11」。仓库里**没有** `.npmrc`。

### ✅ 修复已应用（2026-09-22，`fe3a130`）

改动清单与上面的最终清单一致。**实际生成的 lock 与本文档早先记录的方案版本不同**：

| 指标 | `--legacy-peer-deps` 方案（未采用） | **npm 11 方案（已应用）** |
|---|---|---|
| 条目 | 1170 | **1194** |
| `packages[""].workspaces` | `["packages/*"]` | `["packages/*"]` |
| `link: true` | 68 | 68 |
| `packages/*` | 73 | 73 |
| `node_modules/@akemi-mio/*` | 67 | 67 |

> 复核命令（注意 `workspaces` 在 `packages[""]` 里，**不在** lock 顶层 —— 顶层取 `l.workspaces` 得 `null`）：
> `node -e "const l=require('./package-lock.json');console.log(l.lockfileVersion,Object.keys(l.packages).length,JSON.stringify(l.packages[''].workspaces))"`

**最小复现（缺陷二）**：单包 `vitest@^4.1.7`（无 workspaces、不涉及 `workspace:`）即崩
`Cannot read properties of null (reading 'edgesOut')`；`jsdom` / `vite` 单独 OK；
`vitest@4.0.0` / `4.0.18` OK，`4.1.0`→`4.1.11` 全崩。**触发者是 vitest@4.1.x，不是本仓的协议问题。**

→ CI 全部 5 处 `npm ci` 现已可通。判据：`grep -rl '"workspace:' --include=package.json packages/ | wc -l` 应为 **0**。

### 🔥 `audit` 现在能跑，且是红的（09-22 实测）

安装链修好后 `npm audit` 因 lock 正常即可运行。**09-22 在本仓库实测**：

```
npm audit --audit-level=high   → exit 1
32 vulnerabilities (14 moderate, 16 high, 2 critical)
```

2 个 **critical**：`protobufjs <=7.6.4`、`tar <=7.5.20`。
（09-20 在隔离副本上测得 31 个 / 13 moderate；现 32 个 / 14 moderate —— 差异来自上游 advisory 更新，
不是本次改动引入。）**这是安装链修好后才看得见的新问题，与安装链修复本身无关。**

⚠️ **未处理**：`npm audit fix --force` 会大改版本、有破坏风险，未擅自执行。
建议作为**独立任务**排期（升级 vite 到 6.4.3+、exceljs、sharp 等），不在本次安装链修复内。

**为什么 `audit` 仍然没进 CI（这是刻意的，不是漏了）**：它现在能跑了，但**一进就让每次合并变红**
（32 个漏洞全是**存量债**，不是本次改动引入）。把存量债挂在合并门上，结果一定是有人加
`continue-on-error` —— 那就又造出一个 FM-6。正确顺序是**先还债（升依赖）再上门禁**，
或者在还债期间把它放在**不阻塞合并**的周期性 workflow 里做趋势跟踪。这一步需要人定阈值/范围，
所以留作决策项，未擅自加。

---

## 六、⚠️ 无法运行的门禁（前置条件缺失）→ ✅ 09-22 已闭环

| 门禁 | 失败症状 | 退出码 | 缺什么 |
|---|---|---|---|
| `check:renderer-entries` | `Error: 打包目录不存在：dist-electron` + 栈 | 1 | `dist-electron/`（本机只有 `out/`） |
| `check:idle-gpu` | `[idle-gpu] 找不到打包后的 AkemiMio.exe` | **2** | 打包 exe |

**两者的失败都是诚实的**（都在 `dist-electron`/exe 缺失时明确报错并给出非 0 退出码），
不是 FM-2 意义上的假绿。

> 修法：`npm run build && npx electron-builder --win --dir` 生成产物后可补测。
> 本机 `electron-vite build` 受 `emptyOutDir` 撞 safe-delete 限制（见记忆 §五），需按既有配方处理。
> ✅ **09-22：这道修法已经写进 CI 了** —— 见 §九。所以本机无法预演这件事不再是障碍：
> 门禁在 runner 上跑，而不是在我这台跑不起来的机器上跑。

**另注**：`check:idle-gpu` 有一处设计值得留意 —— 它用 `process.exit(2)` 表达「缺前置条件」，
与「检测到回归」区分开（后者 `exit(1)`）。这是好实践，建议其它门禁沿用。

### ★ 但顺着这条线查出一个真缺陷：那份「2 = 运行失败」的契约当时是**假的**

原文只看到脚本**声明**了 `退出码 0=通过 / 1=超预算 / 2=运行失败（起不来/连不上）`，
没验证它在「起不来」这条路径上是否真的返回 2。09-22 实测（这是 `packaging` job 接线时顺手做的）：

```
node scripts/check-idle-gpu.cjs --exe=<空文件冒充的 exe>
→ Error: spawn EFTYPE           ← 未捕获异常 + 栈回溯
→ exit 1                        ← 不是契约承诺的 2
```

**根因**：`spawn` 在 exe 不可执行时是**同步抛出**的，而调用点（`check-idle-gpu.cjs:98`）在
`try/catch` 之外，也不在 `main()` 的 `try` 里（它在顶层，早于那个 `setTimeout` 包装）。

**影响（为什么这不是小事）**：CI 红会被**误读成「GPU 超预算」**（1），实际是「应用根本没起来」。
这正是本次评估一直在打的那个靶子 —— 门禁的输出语义与它的实际行为不一致，
而且**只有真跑一次才看得见**。它属于 FM-2 家族（「存在」≠「可用」）。

**修法**（两条路径都得堵，实测两条都真实可达）：

| 触发条件 | 失败路径 | 修法 |
|---|---|---|
| 空 `.exe` 文件 | **同步抛** `EFTYPE` | `try { spawn } catch → exit(2)` |
| 目录冒充 exe / 路径不存在 | **异步 `'error'` 事件** `ENOENT` | `child.on('error', → exit(2))` |

> 探针实测（`spawn` 空监听 → `Unhandled 'error' event` → **exit 1**）证明异步那条**不是死代码**：
> 不挂监听，`ENOENT` 同样退化成 1。两条路径都各自做了「改坏 → 变红」的对照。

修复后实测三种失败输入全部干净返回 **2** 并打印 `[idle-gpu] 起不来：<code>`，无栈回溯。
**教训**：门禁自己声明的退出码契约，和门禁守的业务逻辑一样需要被验证 ——
否则「区分 2 与 1」这个好实践只是注释里的一句好话。

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
| **`typecheck:budget`** | `node scripts/typecheck-budget.mjs --budget 0` | ✅ **是（09-21 顶替原 typecheck 步骤）** |
| **`test:unit:fast`** | ~~`vitest run --config vitest.config.unit-fast.ts`~~ | 🗑 **09-21 已删除** |
| **`test:stress`** | 12 个 `*.stress/benchmark/endurance/baseline` 文件 | ⚠️ **CI 否，但 weekly-stress.yml:18 会跑**（见下方更正） |
| **`audit`** | `npm audit --audit-level=high` | ❌ **否 —— 且刻意不加**（09-22 它已能跑，但 32 个漏洞是存量债，见 §5.2 末） |
| **`check:renderer-entries`** | `node scripts/check-renderer-entries.cjs` | ✅ **是（09-22 起，`packaging` job）** —— 见 §九 |
| **`check:idle-gpu`** | `node scripts/check-idle-gpu.cjs` | ✅ **是（09-22 起，`packaging` job）** —— 见 §九 |

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
4. ~~`typecheck:budget` 与 `typecheck` 二选一~~ → **已办（09-21）**：CI 的 `Type check` 步骤
   由 `npm run typecheck` 改为 `npm run typecheck:budget`（**顶替，不是叠加**，所以没有跑两遍 tsc）。
   选 budget 而非 typecheck 的理由是实测出来的差异：`npm run typecheck` 是
   `tsc -p node && tsc -p web`，**node 一失败 web 就根本不跑** —— 这正是 2026-09-11 之前
   renderer 长期带着数百个错误静默出厂的机制（renderer 由 esbuild 转译，擦类型不检查）。
   budget 脚本**两个配置都跑**并把合并计数与预算显式打出来，干净时开销相同。
   承重性本轮复验：往 `src/renderer/src/` 注入一个类型错误的临时文件 →
   `tsconfig.web.json: 1 errors`，**exit 1**；探针删除后回绿。
5. ~~`test:unit:fast` 要么改名，要么删~~ → **已删（09-21）**：连同 `vitest.config.unit-fast.ts` 一起删除。
   依据是三条实测：耗时 **8m23s**（名不副实）；选中的是 CI 已跑的 `vitest run --coverage`
   的**子集**（主配置减去 12 个压测文件，而压测只占 ~40s）；`grep unit-fast` 只命中
   package.json 与本报告，**CI 与脚本均无消费者**。留着只能误导人以为有快速反馈通道。

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
   - **测量误差 6 次**（上面列的那些 + 09-22 新增 1 次）——仪器读错，被测对象其实没问题。
     09-22 新增：**Node 里的 `/tmp` ≠ Git Bash 里的 `/tmp`** —— Node 把它解析成 `D:\tmp`，
     写探针脚本时 `MODULE_NOT_FOUND`，一度像「脚本挂了」。同族于 `cmd | tail` 那次：
     **同一个路径/退出码在两层工具里有两种含义。**
   - **结论被推翻 4 次**——仪器是对的，但我**从正确读数推出了错误结论**，
     且四次都已写进正文修正：
     ① §5.1 `format:check` 的「不建议动」；② §5.2 的「lock 陈旧」；
     ③ §七的「6 道门禁不在任何流水线上」（只查了 `ci.yml`，漏看另两个 workflow → 实为 5 道）；
     ④ §5.2 的「npm 11 同样失败」（在 `workspace:` 协议仍在时测的 → 掩盖了 npm 11 对缺陷二的效果）。
     共同特征是：**跳过了一次低成本的验证**（看改动预览 / 做最小复现 / 枚举全部 workflow / 换掉混杂变量）。

---

## 九、★ 09-22 收尾：把两道「需要打包产物」的门禁接进 CI

### 背景

§七 里 `check:renderer-entries` 与 `check:idle-gpu` 之所以没人调用，唯一原因是
**CI 里没有任何 job 跑 electron-builder**，所以拿不到它们要的 `win-unpacked/AkemiMio.exe`。
（`check:renderer-entries.cjs:52` 在**模块顶层**调 `findExe()`，`dist-electron/` 不存在就直接抛，
**永远走不到形态检查段** —— 它进不了只跑 `npm ci` 的 quality job。）

### 新增的 `packaging` job（`.github/workflows/ci.yml`）

```yaml
  packaging:
    runs-on: windows-latest
    needs: quality
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4   # node 20
      - run: npm i -g npm@11
      - run: npm ci
      - run: npm run build                        # electron-vite build
      - run: npx electron-builder --win --dir      # 产出 dist-electron/win-unpacked
      - run: npm run check:renderer-entries
      - run: npm run check:idle-gpu -- --warmup=30 --samples=2 --interval=6
      - uses: actions/upload-artifact@v4           # if: failure() 才传，便于事后取证
```

### 三个设计决策（都是刻意的）

| 决策 | 理由 |
|---|---|
| `--dir` 而**不是**配置里的 `nsis` | 两道门禁找的都是 `dist-electron/win-unpacked/AkemiMio.exe`；`--dir` 正好产出它，还省掉 NSIS 步骤与 winCodeSign 下载。**不为回答这个问题多花几分钟。** |
| `needs: quality` | quality 已经红的时候不该再花 5–10 分钟打包。 |
| 阈值用默认值、但**注释写明未标定** | 见下面的诚实清单。宁可让首跑给出真实读数，也不先编一个「一定过」的数字 —— 那正是 FM-4（断言是重言式）。 |

### ⚠️ 这个 job **尚未在 CI 实跑过** —— 诚实清单

> **09-22 更新：首跑结果出来了 —— 它被 `needs: quality` 跳过了。**
> `quality` 在第 6 步 `Type check (budget = 0)` 失败，`packaging` 与 4 个测试 job 全部 `skipped`（0s）。
> 所以下表里「未验证」的每一项**仍然未验证**，而且现在知道**为什么**了 —— 见 §十。

| 未验证项 | 为什么 | 首跑后该看什么 |
|---|---|---|
| job 本身能否绿 | 本机 `electron-vite build` 跑不起来（`emptyOutDir` 撞 safe-delete + GPU fatal，见记忆 §五）；`gh` **未登录**，看不到 Actions 结果 | 先看 `Build` / `Package` 两步是否成功 |
| 打包形态能否在 runner 上**启动** | 记忆里有过打包特有缺陷：提前调 `credentialsManager.get()` → 拒启动；缺 `CONSTITUTION.md` | 若 `check:renderer-entries` 报「没有 page 目标」= 应用没起来，**不是**渲染回归 |
| `--gpu-budget=20` 是否适用于 runner | 该值来自有真 GPU 的开发机；runner 是软件光栅 | 看 `基线 GPU` 的实测值再**重新标定**，不要直接放宽 |
| 打包耗时是否可接受 | 未测 | 看 job 时长；若过长，考虑改成只在 push 到 master 时跑 |

**A/B 差值（`--delta-budget=15`）比绝对 GPU 更可跨机器**：它比的是**同一台机器、同一次运行内**
「动画开」与「动画关」的差，直接对准「有常驻无限动画在烧 GPU」这一类回归，
不吃机器绝对性能。所以绝对预算若首跑偏红，**优先信 A/B 那条**。

### 判据：怎么确认它不是在重复 FM-1 / FM-6

1. **它出现在 job 列表里**，且没有 `continue-on-error`（`grep -n "continue-on-error" .github/workflows/ci.yml` 应为空）。
2. **它真的选中了文件/exe**：`check:renderer-entries` 会打印「主窗口 index.html / 形态 pet / chat / wallpaper / agent.html」逐项 ✓；
   若只打印「打包目录不存在」就是**没跑起来**（§七 的老问题换了个位置复发）。
3. **能变红**：`npm run check:renderer-entries` 在 exe 缺失时 exit 1；`check:idle-gpu` 在「起不来」时 exit 2
   （09-22 刚把这个 2 修回来，见 §六）。**两个非 0 语义不同，别混着读。**

### 成本

多一个 job：`npm ci` + `electron-vite build` + `electron-builder --dir` + 两次启动 exe 的冒烟/测量。
比现有任一 job 都重。**如果这个代价不可接受，正确的退路是把它移到周期性 workflow
（像 `weekly-stress.yml` 那样），而不是加 `continue-on-error`** —— 后者会造出新的 FM-6。

---

## 十、★ 09-22 第一次真跑 CI：`npm ci` 通了，露出下一道失败 —— 以及「本机绿 ≠ CI 绿」

§五 修好安装链后第一次把提交推上去（`fix/gate-packaging` 分支，避开 master）。
结果比预期重要得多。

### 10.1 运行结果（run `35675394471`，commit `bd17732`）

| 步骤 | 结果 |
|---|---|
| 4. `npm i -g npm@11` | ✅ |
| **5. `npm ci`** | ✅ **成功** —— 这是安装链修复的实证，也是本仓**史上第一次** `npm ci` 在 CI 跑通 |
| **6. `Type check (budget = 0)`** | ❌ **失败**（exit 1） |
| 7–11. `Lint` / `Format check` / mio-cli 语法 / `check:form-registry` / `Build` | ⏭ 全部 **skipped** |
| `main-tests` / `renderer-tests` / `preload-tests` / `mio-cli-tests` / `packaging` | ⏭ 全部 **skipped**（0s，被 `needs: quality` 拦住） |

### 10.2 由此得到的第一个结论：**整条 CI 至今提供的保障是 0**

`npm ci` 是 quality job 的第一步实质步骤，它**从 monorepo 化起就没成功过**（§5.2）。
所以在此之前：

- quality 里的 `typecheck` / `lint` / `format:check` / `build` **从未在 CI 执行**；
- `main-tests` / `renderer-tests` / `preload-tests` / `mio-cli-tests` 四个 job **从未在 CI 执行**；
- `packaging` 当然也没跑过。

也就是说：本报告 §一 那张「19 道门禁」的表里，**凡是通过 CI 生效的结论，此前都只是「配置在文件里」**，
不是「跑起来过」。修好安装链只是把**第二道**墙露出来 —— 这正是本报告反复讲的
**FM-2「存在 ≠ 可用」在流水线层面的版本**：一条永远红的 CI，等价于没有 CI。

### 10.3 第二个结论：**本机 node_modules 已经漂移出 lock，本机绿不能代表 CI 绿**

实测（`node -e` 逐条比对 `package-lock.json` 与本机 `node_modules/*/package.json`）：

```
顶层依赖条目 855 · 本机缺失 93 · 版本与 lock 不一致 24
```

24 个漂移包里有 `vite` `react` `react-dom` `@types/react` `@types/node` `vitest`
`electron` `@typescript-eslint/*` `eslint` `@testing-library/*` …——**全都直接影响 `tsc` / `eslint` 的结果**。

| 包 | lock（= CI 会装） | 本机（dev 实际在跑） |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.199 | **0.3.241** |
| `vite` | 6.4.2 | 6.4.3 |
| `react` / `react-dom` | 19.2.6 | 19.2.8 |
| `@types/react` | 19.2.15 | 19.2.18 |
| `@types/node` | 22.19.19 | 22.20.1 |
| `vitest` | 4.1.8 | 4.1.11 |
| `electron` | 42.4.0 | 42.9.3 |
| `eslint` | 10.4.1 | 10.9.0 |

⚠️ 顺带修正一个我自己的说法：这不是「新 lock 把版本降级了」。**旧 lock（`ec5bbd3`）锁的就是这些较旧的版本**
（`git show ec5bbd3:package-lock.json` 逐项一致），是**本机 node_modules 跑到了前面**。
所以「`npm run typecheck` 本机绿」这句话，**从来没有在 lock 规定的依赖集上被验证过**。

> 复核命令：
> `node -e "const l=require('./package-lock.json'),fs=require('fs');let d=[];for(const[k,m]of Object.entries(l.packages)){if(!k.startsWith('node_modules/')||m.link)continue;try{if(JSON.parse(fs.readFileSync(k+'/package.json')).version!==m.version)d.push(k)}catch{}}console.log(d.length,d.join(' '))"`

### 10.4 第三：那 4 条错误的确切根因（已用单包替换实验逐字节复现）

CI 的注解给出了原文（这也是我顺手把 `typecheck:budget` 改成会打印错误的收益，见 10.5）：

```
packages/evolution/src/automation/ClaudeCodeExecutor.ts(70,22): error TS7006: Parameter 'block' implicitly has an 'any' type.
packages/evolution/src/automation/ClaudeCodeExecutor.ts(71,19): error TS7006: Parameter 'block' implicitly has an 'any' type.
packages/evolution/src/automation/CreativityExecutor.ts(101,22): error TS7006: Parameter 'block' implicitly has an 'any' type.
packages/evolution/src/automation/CreativityExecutor.ts(102,19): error TS7006: Parameter 'block' implicitly has an 'any' type.
```

对应代码（两处同构）：

```ts
for await (const message of query({ prompt, options: {...} })) {   // query 来自 @anthropic-ai/claude-agent-sdk
  if (message.type === 'assistant') {
    agentOutput += message.message.content
      .filter((block) => block.type === 'text')   // ← TS7006
      .map((block) => block.text)                 // ← TS7006
      .join('')
  }
}
```

**定位手段：把本机 `node_modules/@anthropic-ai/claude-agent-sdk` 单独换成 lock 锁的版本，其他一律不动。**
（用 `mv` 改名备份、`cp -r` 换入，全程不删任何东西，可完整还原。）

| 本机装哪个版本 | `npm run typecheck:budget` |
|---|---|
| **0.3.241**（dev 实际在跑） | ✅ 0 errors |
| **0.3.199**（lock 锁的） | ❌ **4 errors，文件/行/列与 CI 一字不差** |

**机制**（用探针文件让 tsc 报出推断类型，两版各测一次）：

| 表达式 | 0.3.241 | 0.3.199 |
|---|---|---|
| `message.message` | `BetaMessage` | **`any`**（赋给任意字面量类型都不报错） |
| `message.message.content` | `BetaContentBlock[]` | `any` |
| `content[0]` | `BetaContentBlock` | `any` |

`message.message` 塌成 `any` 之后，`.filter((block) => …)` 的回调参数**没有上下文类型** →
`noImplicitAny` 报 TS7006。而 `content` 若是 `any[]` 则**不会**报（数组元素给了上下文类型 `any`）——
这正是「只有 `any` 才报、`any[]` 不报」这个反直觉现象的解释。

**为什么 0.3.199 会塌成 `any` —— 根因已查到最后一层（2026-09-22 补）**：

`0.3.199` 发布的 **`sdk.d.ts` 本身是自相矛盾的**：它引用了 28 处自己没有声明的类型名。
把两个版本的声明文件直接交给 tsc（**关掉 `skipLibCheck`**）就能看见：

| `@anthropic-ai/claude-agent-sdk` | `sdk.d.ts` 内部错误数 |
|---|---|
| `0.3.199`（lock 锁的） | ❌ **28 条** |
| `0.3.241`（dev 在跑的） | ✅ **0 条** |

其中致命的两条落在 `SDKMessage` 这个联合类型里（`sdk.d.ts:3762`）：

```
error TS2552: Cannot find name 'SDKControlRequestProgressMessage'
error TS2304: Cannot find name 'SDKConversationResetMessage'
```

**一个联合类型里只要有一个成员解析不到，整个联合就退化成 `any`** —— 用 `IsAny<T>` 判定可直接证实：

| `IsAny<SDKMessage>` | 结果 |
|---|---|
| `0.3.199` | **`true`**（联合已塌成 `any`） |
| `0.3.241` | `false`（联合完好） |

于是整条链闭合：

```
0.3.199 的 sdk.d.ts 引用未定义名
  → SDKMessage 联合塌成 any
  → query() 产出的 message 是 any
  → message.message.content 是 any
  → .filter((block) => …) 的回调参数失去上下文类型
  → noImplicitAny 报 TS7006，位置在我们的调用点
```

而 `skipLibCheck: true`（本仓设置）把 d.ts 内部那 28 条错误**全部静默吞掉** ——
所以界面上只看得到我们代码里的 TS7006，**没有任何线索指向 SDK**。

⚠️ 注意根因**不是** peer 解析失败：两版 `sdk.d.ts` 的 import 头逐字节相同
（`BetaMessage` 都来自 `@anthropic-ai/sdk/resources/beta/messages/messages.mjs`，该路径在本机
`@anthropic-ai/sdk@0.110.0` 下能正常解析），两版声明的 `dependencies` 也完全一致。
**是 0.3.199 这个已发布版本的声明文件自己坏了。**

**可脱离 `node_modules` 复现**（这才是干净的最小复现，比替换整个包可靠得多）：

```bash
# 1. 取两版 tarball
npm pack @anthropic-ai/claude-agent-sdk@0.3.199
npm pack @anthropic-ai/claude-agent-sdk@0.3.241
# 2. 各自解包，把 package/sdk.d.ts 分别放到能解析到仓库 node_modules 的目录下
# 3. 复刻 ClaudeCodeExecutor.ts 的写法，只改 import 指向哪一版
```

同一份探针代码（`import type { SDKMessage }` + `m.message.content.filter((block) => …)`）：

| 指向 | 结果 |
|---|---|
| `0.3.199/sdk.d.ts` | ❌ `error TS7006: Parameter 'block' implicitly has an 'any' type`（2 条，与 CI 同形状） |
| `0.3.241/sdk.d.ts` | ✅ 0 errors |

**这就是 `skipLibCheck` 的典型代价**：它把第三方声明文件里的错误变成我们自己代码里的「隐式 any」，
报错位置指向调用点而不是根因。本仓为了不被几十个第三方 d.ts 的错误淹没而开着它，
代价就是**这类缺陷只能靠换版本对撞才能定位**。

### 10.5 顺手修掉的一个可诊断性缺陷（`3790be6`）

原来 `scripts/typecheck-budget.mjs` **只打印错误计数，把 tsc 的输出整个丢掉**：

```
  tsconfig.node.json: 4 errors
  tsconfig.web.json: 0 errors
TypeScript errors: 4 (budget: 0)
FAIL: 4 errors exceeds budget ceiling of 0. Fix or triage before merging.
```

CI 上唯一的线索是「Process completed with exit code 1」，而 job 日志**要管理员权限才能下载**
（实测 `GET /actions/jobs/<id>/logs` → **403 Must have admin rights**）。连本地失败也不知道错在哪。

改成失败时按配置分组打印错误原文（≤30 条），并在 GitHub Actions 里加 `::error::` 前缀 →
**直接变成 run 页面上的注解**，不必下载日志就能看见。上面 10.4 那 4 条就是这么拿到的。

变异检验（两条都做）：往 `src/renderer/src/` 与 `src/preload/` 各放一个类型错误探针 →
分别报 `tsconfig.web.json: 1 errors` / `tsconfig.node.json: 1 errors` 并打印 `::error::…error TS2322`；
移除探针后回到 0 errors。退出码语义未变。

### 10.6 修法（未定 —— 需要拍板）

**先补一个关键事实**：`package.json` 声明的是 `@anthropic-ai/claude-agent-sdk: ^0.3.199` ——
**0.3.241 本来就在允许范围内**。也就是说 lock 不是「范围被写死」，而是**解析停在了版本下限**，
而那个下限恰好是一个**声明文件坏掉的发布版**。这改变了三个选项的性价比：

| 选项 | 做法 | 好处 | 代价/风险 |
|---|---|---|---|
| **A. 刷新 lock 到 dev 在跑的版本** | 用 npm 11 重新解析 lock（24 个包） | 一次消除根因；顺带修 `vite 6.4.2` 的 2 个 critical CVE；恢复「本机绿 ⇒ CI 绿」 | lock 变更面大（24 包 + 传递依赖），**需要再跑一次 CI 才知道有没有新的失败**；不需要改任何 manifest 范围 |
| **B. 只升 `@anthropic-ai/claude-agent-sdk` 到 0.3.241** | 单包（仍在既有 `^0.3.199` 范围内） | 最小改动、已由最小复现证明能消掉这 4 条；**且是从一个坏发布版移开，不只是「治标」** | 另外 23 个漂移包仍在 → 「本机绿 ≠ CI 绿」这条没解决 |
| **C. 改代码，给 `block` 显式类型** | 2 个文件 4 处 | 零依赖风险，立刻绿 | **最差的选项**：整条链已是 `any`，等于手工补回丢失的类型信息；SDK 返回值的**任何**误用都不会再被类型系统拦住 |

**建议：先 B 后 A（分两步，各自一次 CI 运行）**

- **第一步 B**：只动一个包，把 CI 从「永远红」推到「能跑完」，**先让门禁具备承重能力**。
  这一步的判据很明确：`typecheck:budget` 变绿，且下游 4 个测试 job 与 `packaging` **真的被执行**（不再是 0s skipped）。
- **第二步 A**：在 CI 已经可信的前提下再刷新 lock —— 此时若冒出新的失败，**那是真问题，会被如实报出来**；
  而在 CI 还红着的时候做 A，新失败会被埋在「反正本来就红」里，等于白做。

⚠️ 三个都**没有擅自做**。按本报告 §八 的口径：A 才是修根因，但它的影响面超出「让门禁承重」这件事，
属于依赖策略决策；B 虽是单包，也仍是依赖变更。**请拍板走哪条。**

> **✅ 已拍板（2026-09-22）：走「先 B 后 A」。** 第一步 B 已实施为 `e255fa5`，
> 结果与后续发现见 §10.7；第二步 A（刷新 24 包 lock）**等 CI 能完整跑通后再做**。

### 10.7 B 已实施，失败点前移：`format:check` 在 CI 上恒红（根因是 `.gitattributes` 没钉 `eol`）

用户选了「先 B 后 A」。B 落地为 `e255fa5`（只改 9 个 lock 条目，35 增 35 删），
推到 `fix/gate-packaging` 后 CI run **#32**（`35686514345`）的结果：

| 步骤 | #31（`57e1c00`，只有文档） | **#32（`e255fa5`，含 B）** |
|---|---|---|
| `npm i -g npm@11` / `npm ci` | ✅ | ✅ |
| `Type check (budget = 0)` | ❌ 4 条 TS7006 | ✅ **绿** |
| `Lint` | ⏭ skipped | ✅ **绿**（注解里有 11 条 warning） |
| **`Format check`** | ⏭ skipped | ❌ **红 ← 新的失败点** |
| mio-cli 语法 / form-registry / Build | ⏭ skipped | ⏭ skipped（在前一步断了） |
| 4 个测试 job + `packaging` | ⏭ skipped | ⏭ skipped |

**这正好验证了「先 B 后 A」的理由**：修掉第一道之后，露出的第二道是**之前被跳过、从来没跑过**的。
`quality` 这一步从 5 分 55 秒跑到断点，说明它确实在干活，不是空转。

#### 根因：检出成 CRLF，而 prettier 默认 `endOfLine: lf`

本机 `npm run format:check` 是**绿的**，CI 是红的 —— 又一处「本机绿 ≠ CI 绿」，
但**这次与 lock 漂移无关**（先排除了它：`prettier` 本机与 lock 都是 3.9.6，版本一致）。

`src/**` 文件转成 CRLF 后 prettier 立刻报 `[warn]` 且 exit 1，还原后逐字节相同 —— 机制成立。
但「CI 上是不是 CRLF」不能靠印象，于是做了一个**独立实验**：在临时 git 仓库里用同样的
`.gitattributes` + `core.autocrlf=true`，提交一个 LF 文件，删掉再重新检出，看落地行尾。

| `.gitattributes` | 全新检出后的行尾 |
|---|---|
| **现状** `* text=auto` + `*.ts text diff=typescript` | **CRLF**（`\r\n`） |
| 改成 `* text=auto eol=lf` | **LF** |

`git check-attr` 同时确认：更具体的 `*.ts text diff=typescript` **不会**覆盖 `eol` ——
git 属性是**逐项**覆盖的，`eol` 仍取自 `* text=auto eol=lf`。

完整因果链：

```
.gitattributes 标了 text 却没钉 eol
  → 检出用平台默认行尾 → windows-latest 上就是 CRLF
  → prettier 的 endOfLine 默认是 lf → 把**每一个**文件都判成未格式化
  → format:check 恒红
```

**为什么藏了这么久**：本机工作区恰好是 LF（文件由编辑器/工具写入，从未重新检出），
而 `git status` 始终干净 —— 因为 `text=auto` 在比较时会规范化行尾，
**工作区是 CRLF 还是 LF，git 根本不会告诉你**。所以这个差异在本机是不可见的。

#### 修法（一条线）

`.gitattributes` 第一行 `* text=auto` → `* text=auto eol=lf`，并写明为什么不能省。
钉死之后各平台检出一致，这道门禁才是在检查「格式」而不是「行尾」。

#### 顺手补上可诊断性（同 10.5 的做法）

`format:check` 原来直接跑 `prettier --check`：不合规文件清单打到 **stderr**，
而 CI 的 job 日志要管理员权限（实测 403）→ 失败时页面上只有一句
「Process completed with exit code 1」，不知道是哪个文件。

新增 `scripts/format-check.mjs`（`package.json` 的 `format:check` 改为调它）：
把每个文件转成 `::error::` 注解，run 页面直接可见；并把退出码分成三态
——**0 = 合规 / 1 = 有文件未格式化 / 2 = prettier 自己跑不起来**
（沿用 §六 那条教训：门禁必须把「工具坏了」和「检查没过」分开，否则 CI 红会被误读成
「有人提交了未格式化的代码」）。

四条路径实测：绿 → exit 0；放一个不合规文件 → exit 1 且指名文件；
`GITHUB_ACTIONS=true` → 输出 `::error::<file> 未按 Prettier 格式化`；
放一个语法错误文件让 prettier 退 2 → 本脚本退 **2**（而不是 1）。

#### ⚠️ 一个差点让我误报的坑（值得单列）

第一次验证时我用 `__fmt_probe.ts` 当探针，prettier 说「所有匹配的文件都合规」——
看起来像是**本地门禁在空转**。差一点就把它当成 FM-1 写进报告。

真相：`.gitignore` 里有 `__*`（一条忽略所有 `__` 开头文件的规则），
而 **prettier 3 默认把 `.gitignore` 也当忽略清单**（`ignorePath` 默认 `['.gitignore', '.prettierignore']`），
所以探针被静默跳过。换成不含 `__` 的文件名，prettier 立刻正常报错。

**教训：用探针文件做变异检验时，探针名不能落在 `.gitignore` 里。**
（`tsc` 不读 `.gitignore`，所以之前给 `typecheck:budget` 用的 `__typecheck_probe.ts` 没暴露这个问题；
是 prettier 会读，才把它顶出来。）

---

### 10.8 ★★ 三道覆盖率门禁：**三个从未被求值过的数字**

`quality` 转绿、下游 job 第一次真的执行之后，露出来的第一件事是：
`main-tests`、`renderer-tests`、`preload-tests` 三个 job 的**用例全部通过**，
红的是覆盖率阈值。

#### 实测 vs 阈值

| job | 配置文件 | 阈值 (lines/funcs/branches/stmts) | 实测 | 差 | 用例 |
|---|---|---|---|---|---|
| `main-tests` | `vitest.config.ts` | 30 / 25 / 20 / 30 | 23.25 / 23.21 / 18.14 / 22.51 | 约 7pp | 3009 全过 |
| `renderer-tests` | `vitest.config.renderer.ts` | 37 / 35 / 26 / 35 | 20.00 / 22.41 / 16.37 / 19.87 | 13–17pp | 449 全过 |
| `preload-tests` | `vitest.config.preload.ts` | 80 / 80 / 80 / 80 | 37.85 / 35.29 / 42.85 / 38.70 | **约 42pp** | 94 全过 |

#### 它们为什么一直没被发现

三条**互相独立**的原因，正好覆盖三种失效模式：

1. **`main-tests` / `renderer-tests`：从来没跑起来过。** `npm ci` 从 monorepo 化起
   就没通过（§10.2），而这两个 job 都是 `needs: quality`。**一个永远红的 CI 等价于
   没有 CI** —— 阈值写在配置里、看起来像门禁，实际从未被求值。
2. **`preload-tests`：跑起来了，但门禁根本没开。** 它的 CI 命令是
   `npx vitest run --config vitest.config.preload.ts` —— **不带 `--coverage`**。
   vitest 只在带 `--coverage` 时才评估 `thresholds`，所以那组 80/80/80/80
   是**一块写得像门禁、实际从未生效的配置**（FM-2 的教科书样本）。
3. **阈值本身没有历史。** `git log -S "thresholds"` 只命中 `244af61`
   （`chore: fresh repository baseline (rebuild #3c)`）—— 那是仓库历史的根提交。
   也就是说**没有任何一次「通过」的记录可以对照**。

#### 分母里是什么：一半是「被加载但从未执行」的文件

用 lcov 把分母拆开（`coverage/lcov.info`）：

| | 文件数 | 可执行行 | 命中 | 0% 的文件 | 0% 文件占的行 |
|---|---|---|---|---|---|
| main | 1229 | 81003 | 18835 (23.25%) | **536 个（43.6%）** | 26286 行（**32.5%**） |
| renderer | 132 | 7925 | 1585 (20.00%) | **69 个（52.3%）** | 4112 行（**51.9%**） |

> 这里有个**差点走错的路**：我最初的假设是「阈值是按旧版 `coverage.all: false`
> 语义标定的，升级到 vitest 4 后分母膨胀了」。查下来**反了** ——
> vitest v4 的迁移指南写明 *"In Vitest v4 we have removed `coverage.all` completely
> and defaulted to include only covered files in the report."*，即 v4 的默认**更窄**；
> 而我们的配置**显式定义了 `coverage.include`**，按文档此时报告会包含
> 「匹配该 glob 的已覆盖 **与** 未覆盖文件」，所以分母就是整个 glob。
> 顺带一个可诊断性细节：`--coverage.all=false` 在 v4 里**被静默忽略**
> （实测加不加这个 flag，三套数字一模一样），因为该选项已被删除。

`main` 的分母按包拆开是 **60 个包**，其中 **17 个包命中为 0**（4763 行，占 5.9%）；
最大的三个包是 `evolution`（128 文件 / 10944 行 / 18.6%）、
`capabilities`（161 / 10658 / 16.9%）、`audio`（109 / 9847 / 20.4%）。

`renderer` 的 0% 里有**一个包是死的**：`src/renderer/src/widgets/`
—— **34 个文件、2326 行、0%**，占分母的 **29%**。而按项目记录
（`MEMORY.md` §三）**`widgets/` 已退役**，壁纸早已迁到
`forms/wallpaper/WallpaperForm.tsx`；`grep` 确认**没有任何生产代码 import 它**
（唯一提到它的 `visualSystem.test.ts` 是把两个文件当**文本**读来做断言，
不是导入）。退役代码以 0% 的形式占着分母，把整体覆盖率从 28% 压到 20%。

#### 拍板：标定成棘轮（不是把数字改小就完事）

用户选择「**先修口径，再按实测标定成棘轮**」，与仓库已有的
`--max-warnings 130` 做法一致（§四：lint 的计数阈值只能「只降不升」地调）。具体：

1. **修口径**：`vitest.config.renderer.ts` 的 `coverage.exclude` 增加
   `src/renderer/src/widgets/**` —— 退役代码不该算进「测试覆盖了多少活代码」。
   （代码本身**保留**，删除是另一笔独立改动。）
2. **阈值改成略低于实测的棘轮**，每个数字留约 1.2–1.9pp 余量：

   | job | 旧 | 新 | 实测（新口径） |
   |---|---|---|---|
   | main | 30 / 25 / 20 / 30 | **22 / 22 / 17 / 21** | 23.25 / 23.21 / 18.14 / 22.51 |
   | renderer | 37 / 35 / 26 / 35 | **27 / 27 / 20 / 26** | 28.30 / 28.68 / 21.71 / 27.86 |
   | preload | 80 / 80 / 80 / 80 | **36 / 34 / 41 / 37** | 37.85 / 35.29 / 42.85 / 38.70 |

3. **给 `preload-tests` 补上 `--coverage`** —— 不补的话第 2 步改的数字仍然是死的。

**为什么要留余量**：覆盖率**不是完全确定的**。同一份代码、同一台机器，
`main` 两次实测得到 23.25 与 23.28，`renderer` 的 branches 两次得到 21.69 与 21.71。
差 0.03pp 量级，但足以把零余量的棘轮顶红。

**这道门禁的承重性怎么确认**：不需要再做变异检验 ——
**我们已经直接观测到它在更高阈值下变红**（三套全是红的），
现在把数字降到实测之下再观测到变绿。红/绿走的是同一条代码路径，
只是数字不同。`preload` 那条尤其干净：`--coverage` 一加上就红（37.85 < 80），
阈值一改就绿，说明开关和阈值都真的在起作用。

#### ⚠️ 这一节必须留下的债（别让棘轮变成「达标」）

棘轮守护的是「**不许退步**」，不是「达到某个质量线」。原来的目标值
**30 / 37 / 80** 仍然没达到，只是从「从未被求值的数字」变成了「已知未达标的数字」：

| job | 目标 | 现在 | 差距 |
|---|---|---|---|
| main | 30% lines | 23.25% | 需再覆盖约 5500 行 |
| renderer | 37% lines | 28.30% | 需再覆盖约 690 行 |
| preload | 80% lines | 37.85% | 需再覆盖约 177 行（261 行未覆盖，散在 159 个小段里） |

`preload` 是三者里**唯一现实可做**的：分母只有 `src/preload/index.ts` 一个文件、
420 行可执行代码，缺的 177 行是一条条独立的 IPC 通道处理器。
`main` 与 `renderer` 则要先处理「536 / 69 个文件一行都没执行过」这件事
—— 那更像是**测试策略**问题（很多是 Electron / LLM 绑定代码），不是「再写几个用例」。

---

### 10.9 ★ `packaging` 首次实跑失败：**`npm ci` 根本不会下载 Electron 二进制**

#### 症状：一个 3 秒的失败

CI #33 里 `packaging` job 的 `Package (unpacked directory)` 步骤
**3 秒就退出了**（`07:13:58Z` → `07:14:01Z`）。而本机同一条命令
（`npx electron-builder --win --dir`）要跑 **8 分钟**，并且**成功**产出
`dist-electron/win-unpacked/AkemiMio.exe`（221MB，日志里一个 error 都没有）。

**3 秒这个数字本身就是线索**：electron-builder 的启动序列
（读配置 → 检测 packageManager → 解析 electron 版本 → 校验 electronDist）
大约就是 3 秒，之后才开始拷 1.6GB 的 Electron。所以它死在**开始拷贝之前**。

#### 根因

`electron-builder.yml` 里有一行：

```yaml
electronDist: node_modules/electron/dist
```

它假定 `npm ci` 会把 Electron 二进制放到 `node_modules/electron/dist`。
**这个假定对 electron 42 不成立**：

```
$ curl -s https://registry.npmmirror.com/electron/42.4.0 | jq '.scripts'
null                                    # ← 没有 scripts 字段，即没有 postinstall
$ jq '.scripts' node_modules/electron/package.json   # 本机装的是 42.9.3
{}                                      # ← 同样没有
```

两版都只提供 `"bin": {"electron": "cli.js", "install-electron": "install.js"}`
—— 二进制改由 **`install-electron` 这个显式命令**下载，npm 装包时不会自动跑。
锁文件也自洽：`hasInstallScript: true` 的包有 16 个（`esbuild`、`sharp`、`koffi`、
`bufferutil`、`onnxruntime-node`…），**`electron` 不在其中**。

所以全新 `npm ci` 之后 `node_modules/electron/dist` **不存在** →
electron-builder 在「using custom unpacked Electron distribution」那一步立即失败。

#### 为什么本机一直是绿的（又一次「本机绿 ≠ CI 绿」）

本机的 `node_modules/electron/dist` 是 **Aug 24 12:52** 建好的（345MB，含
`path.txt`），从此一直躺在 node_modules 里 —— 期间 `npm ci` 从未在本机成功跑过
（§10.3）。**一个从未被清理的缓存目录，把一条 CI 上必然失败的路径伪装成了本机正常。**

#### 验证（隔离副本，不动本机 node_modules）

第一次尝试「把 dist 移走再跑 install.js」**失败得很有教育意义**：
`mv: cannot move 'dist' to 'dist.bak': Permission denied` ——
有 **5 个 `electron.exe` 进程**正占着这个目录。而由于 `mv` 失败、`dist` 其实没被移走，
随后的「install.js 跑完 dist 还在 → 重建成功」是**假阳性**。

改用隔离副本（把 electron 包的几个文件拷到 `.tmp/electron-install-test/`，
使 `require('@electron/get')` 仍能沿目录向上解析到仓库 node_modules）：

```
$ node install.js        # 该目录下没有 dist
exit=0
✅ dist 重建成功: 345M   # 11 秒，含 electron.exe / path.txt
```

即：**`install.js` 确实能重建 dist，且是幂等的**（dist 已在时它空转退 0，
实测 `exit=0` 且目录大小不变）。

#### 修法

`.github/workflows/ci.yml` 的 `packaging` job 在 `Package` 之前加一步：

```yaml
- name: Fetch Electron binary (npm ci does not)
  run: node node_modules/electron/install.js
```

并写明上述机制（含「3 秒」这个症状特征），免得以后有人看到这一步觉得多余而删掉。

#### ⚠️ 遗留：这个 job 里的另外两道门禁仍未标定

`Package` 之后的两个步骤
（`check:renderer-entries`、`check:idle-gpu`）**到本文写作时仍然一次都没跑过**
—— 它们依赖打包产物，而打包在 CI 上从来没成功过。`check:idle-gpu` 的
GPU 阈值本来就注明「在 CI 上未标定」，现在连首次标定的机会都还没有。
**下一个 CI run 才是它们真正的首跑。**

### 10.10 ★ `mio-cli-tests` 第一次绿（run #38），以及它为什么连红四次

`mio-cli-tests` 是整个 CI 里唯一跑 `packages/mio-cli`（`node --test`，非 vitest）的 job，
从 monorepo 化起就没绿过。它的失败点**一次一次往前移**，每一道被修好后才露出下一道：

| run | commit | 失败点 |
|---|---|---|
| #35 | `48c711d` | `mio-agent-runtime tests`（无注解，只有 `exit code 1`）|
| #36 | `fa38927` | 前移到 `check:mcp-live` ← **真根因在这里** |
| #37 | `97da3c1` | 前移到 `mio-agent-runtime tests` 里的 1 个用例（flaky，见 §10.12）|
| #38 | `4769bf0` | **无 —— `mio-cli-tests` succeeded，8m59s，史上第一次绿** |

#### `check:mcp-live` 的真根因：`main` 指向被 gitignore 的 `dist`

```
dispatchable but NOT offered by tools/list (13): mio.insight.generate, mio.insight.list,
  mio.insight.mark_reported, mio.insight.status, mio.observer.collect, mio.observer.dag,
  mio.observer.essays, mio.observer.ferment, mio.observer.insights, mio.observer.research,
  mio.observer.status, mio.observer.trends, mio.observer.world_model
  an isXxxAvailable() gate is swallowing them -- check that the optional package resolves
```

7 个 workspace 包的 `main` 指向 `./dist/index.js`，而 `dist` 被 `.gitignore:2` 排除
—— 全新检出里不存在。`insight-store.js` 的两步解析**两条都指向同一个缺失文件**
（回退的 `require('../../insight')` 命中同一个 `main`），于是 `isInsightAvailable()`
返回 false，`TOOLS` 里的条件展开 `...(isXxxAvailable() ? [...] : [])` 让这 13 个工具
**从 `tools/list` 整体消失**，而分派 `case` 还在源码里 —— 源码和测试都看不出问题。

本机双向复现（因果闭合）：

| `packages/{insight,observer}/dist` | `check:mcp-live` |
|---|---|
| 移走（确认 `mv` 成功） | **exit 1**，13 个工具消失 |
| 放回 | **exit 0** |

修法 `npm run build --workspaces --if-present`（本机 26.4s）。`--if-present` 恰好只命中
那 7 个包 —— 「有 build 脚本的包」与「`main` 指向 dist 的包」经逐一核对是同一批，
以后加包自动跟随。**这不是降质量线**：published 安装里这些包带 `dist`
（`files: ["dist"]` + `prepublishOnly: build`），构建后 CI 才与真实环境一致。

#### 三个被证伪的假设（记下来，免得再走一遍）

在拿到真根因之前，对 #35 的失败提了三个假设，**全部被本机实验证伪**：

| 假设 | 实验 | 结果 |
|---|---|---|
| `packages/insight\|observer/dist` 缺失 | 移走两个 dist 跑全量 | 386/386 全过（测试用假包注入，对包不可用是健壮的）|
| 时区（CI 是 UTC） | `TZ=UTC` 跑全量 | 全过 |
| `node_modules/@akemi-mio/*` 软链差异 | `git archive HEAD` 干净树 + 67 个 junction 跑全量 | 386/386 全过 |

#### 顺带修的：让这个 job 的失败可读（`97da3c1`）

该 job 的 4 个步骤都不是 vitest（`node --test` + 3 个 plain node 脚本），而
**vitest 会自己发 `::error::`（注解无需管理员权限即可读），它们不会**。
所以此前整个 job 的注解只有一句 `Process completed with exit code 1.`，
真正的报错只在 job 日志里，而**公开仓的 job 日志仍要管理员权限**（实测 403）。
新增 `scripts/run-with-annotations.mjs` 包住这 4 步（透明传退出码，只在失败时补注解）。

### 10.11 ★ 包装脚本自己的缺陷：注解取错了位置（`a3d6a1b`）

上一节的包装脚本**第一版就是错的**，而且错法很典型：它从「全局最后 30 行」里找诊断。
但 `node --test` 的诊断块（duration / location / error / expected / actual / stack）
紧跟在 `not ok` 行**之后**、位于输出中段。run #37 有 386 个用例、失败在第 357 个，
于是注解里是：

```
not ok 357 - digest respects topic filter
----- last lines of output -----
# Subtest: task.route returns related memories when no verified match exists
ok 385 - task.route returns related memories when no verified match exists
```

—— 知道哪个用例挂了，不知道**为什么**挂。而这个用例的断言是 `assert.equal(digest.count, 1)`，
`count` 是 0 还是 2 决定完全不同的排查方向（§10.12 就是被这一点拖慢的）。

改成按 `not ok` 行提取缩进的 TAP 诊断块；tail 只在「压根没产出 TAP」时保留
（崩溃、npm 报错、几个 plain node 检查脚本），因为块存在时它严格更有信息量。

**验证（60 个用例、第 30 个失败的夹具）：**

| 路径 | 结果 |
|---|---|
| 旧策略 | `node --test … \| tail -30 \| grep -c 'case 30'` → **0**（确实漏）|
| 新策略 | 注解拿到 `error` / `expected: 0` / `actual: 1` / `operator` / `stack` 全套 |
| 无 TAP 的崩溃脚本 | 仍走 tail，注解里是完整栈 |
| 成功路径 | 0 条注解、exit 0 |

**在真实 CI 上复核过**：run #40（`a3d6a1b`）的 `mio-cli-tests` 注解里出现了
`duration_ms: 7.7483` / `type: 'test'` / `location: '…observer-subscribe.test.js:51:1'`。

### 10.12 ★★ 一个 flaky 门禁的根因：digest 游标的毫秒竞态（`ae4cbd3`）

#### 症状：同一份测试代码，一次绿一次红

| run | commit | `mio-agent-runtime tests` 里的失败 |
|---|---|---|
| #36 | `fa38927` | 无 |
| #37 | `97da3c1` | `not ok 357 - digest respects topic filter`（1 个）|
| #38 | `4769bf0` | 无 |
| #39 | `37cde4b` | `not ok 355 - digest delivers new events once…` + `not ok 357 - digest respects topic filter`（**2 个**）|
| #40 | `a3d6a1b` | `not ok 355 - digest delivers new events once…`（1 个）|

#36 与 #37 的**测试代码完全相同**（#37 只改了 `ci.yml` 并新增包装脚本）→ 先怀疑 flaky。
本机跑该文件 30 次：**30/30 全过**。

挂的用例有一个共同结构：`subscribe → digest（建立游标）→ 紧接着 ingest → digest 期望 count 1`。
同文件里那个只断言 `count 0` 的用例**从未挂过**。

#### 排除法：唯一的非确定性是两次 `new Date()`

该测试里所有 I/O 都是同步的（`appendFileSync` / `writeFileSync`）、
`node:test` 单文件内顶层用例顺序执行、`crypto.randomBytes` 只影响 id、
每个测试文件有自己的 `mkdtemp` 目录 —— 所以**唯一的非确定性就是墙钟**。

两个时间戳来自同一个时钟：

```
subscription-store.js:145   const digestTime = new Date().toISOString()   ← 游标
task-store.js:441            timestamp: new Date().toISOString()          ← 事件
subscription-store.js:171    if (cursorTime !== null && eventTime !== null && eventTime <= cursorTime) continue
```

digest 与 ingest 之间只隔一次小文件写入（digest 写 `digest_state.json`）。

#### 确定性复现（把「靠运气」变成「必然」）

冻结 `Date`（每个无参 `new Date()` 都返回同一瞬间）后跑真实调用序列：

| 自变量 | `traces.jsonl` 行数 | 事件 timestamp | 游标 | `digest.count` |
|---|---|---|---|---|
| 真实时钟 | 2 | `.739` / `.742` | `.739` | **1** ✅ |
| 冻结时钟 | 2 | 都是 `.000` | `.000` | **0** ❌ |

两臂都落盘 2 行 → **排除「ingest 没写进去」**。
冻结臂里第一次 digest 的 `subscriptionCount = 1` → **排除「订阅被 expiresAt 过期过滤」**
（否则订阅根本不在循环里，游标也不会被写）。

#### 量化：窗口本身就是那次文件写入

| 量 | 本机实测 |
|---|---|
| `new Date().toISOString()` | 0.0018ms（可忽略）|
| `writeFileSync` 小文件 | min 0.55ms / 中位 1.98ms / **max 110ms**（Defender 实时扫描）|
| digest→ingest 间隔 | min **2ms** / 中位 17ms |

本机地板 2ms，而「同毫秒」要求窗口 = 0ms → 本机几乎不会发生（30/30 吻合）。
CI runner 的盘更快、工作区被排除实时扫描 → **地板可能 <1ms，「同毫秒」于是成为常态**。
这解释了本机 0/50 与 CI 约 50% 的巨大差异。

⚠️ **方法坑**：第一版窗口探针在 digest 与 ingest 之间读了 `digest_state.json`，
把窗口污染成 9–39ms（量的其实是自己的 I/O）。改用只挂钩 `Date`、关键路径零 I/O 的记录探针后
才拿到上面这组数。

#### 这不只是测试问题 —— 是永久丢事件

游标只前进，所以被吞掉的事件**再也不会被投递**。这是真 bug，不是 flaky 的副作用。

#### 修法：游标改成 `{ time, id }`，语义改为排他下界

事件排在游标**之后**才投递，同毫秒用 `event.id` 破平。`id` 三态，差别是实质性的：

| `id` | 含义 | 同毫秒行为 |
|---|---|---|
| `''` | 墙钟游标（那一刻什么都没投递过）| 空串排在所有真实 id 之前 → **照投**（修掉竞态）|
| `null` | 旧格式游标（tie-break 之前是裸 ISO 字符串）| `null` 排在所有真实 id 之后，**精确复现**原来的时间闭区间比较 → **升级不重新投递** |
| `'<id>'` | 事件游标：该事件已投递 | 按 id 字典序 |

另外投递时游标要停在同毫秒内**最大**的 id 上，否则较低的那些下次会被重复投递。

#### 回归测试与承重性验证

`__tests__/observer-digest-cursor.test.js` 冻结时钟，把竞态变成确定性的。
三个用例都做了**定向变异**（因为用例 2、3 在修复前后都是绿的，承重性必须证明）：

| 变异 | 结果 |
|---|---|
| 未修实现 | 用例 1 红（复现器），2/3 绿 |
| `isNewEvent` 恒返回 true | 用例 2、3 红 |
| legacy 分支改坏 | **仅**用例 3 红 |

验证：新文件 3/3；mio-cli 全量 **389/389**（原 386 + 3）；原 flaky 文件 20/20；
`check:cli-docs` / `check:coverage` / `check:mcp-live` 全 exit 0。

### 10.13 两个顺带发现（均未修，记录以免重复踩）

* **`format:check` 只覆盖 `src/**`**：`scripts/format-check.mjs:17` 的
  `GLOB = 'src/**/*.{ts,tsx,json,css}'`。于是 `packages/mio-cli/**` **完全不在格式门禁内**
  —— `subscription-store.js` 相对根 `.prettierrc`（`printWidth: 140`）有 **23 行既有漂移**。
  本轮只保证**自己新增的行**干净（用 `git show HEAD:<f> | npx prettier --stdin-filepath <f>`
  做基线对比，确认未新增漂移）；全量重排属另一件事，未做。
  ⚠️ 判「我有没有引入漂移」**必须用 `--stdin-filepath`**：直接 `npx prettier /tmp/x.js`
  读不到仓库 `.prettierrc`，会走默认 80 列/双引号，得出**假差异**（实测 213 行 vs 真实 23 行）。
* **`index.js:50` 的 `digestStatePath` 是死变量**（定义后从未使用）。
  真正的游标读写全在 `subscription-store.js`（`readDigestState` / `writeDigestState`），
  所以本次游标格式变更的影响面就是那一个文件。

### 10.14 ★★ `main-tests` 的最后一红：4 条用例隐式依赖**未入库的 `.env`**（`2415bd4`）

#### 症状

`main-tests` 在 CI 上稳定红 4 条，而本机跑同一个文件 **24/24 全过**。
run #39 / #40 / #41 三次连续都是同样这 4 条，注解里的断言行号固定：
`91:29`、`520:37`、`553:19`、`577:19`。

#### 先被证伪的假设：poll 计时器抢响应

`startPolling()`（`TelegramService.ts:256`）是
`this.pollTimer = setInterval(() => this.poll(), 1000)`，而几条用例各挂了
2 个 `mockResolvedValueOnce`。看起来很像「CI 慢 → 测试体超过 1000ms →
定时器抢走第 2 个响应」。

**实测证伪**：带 `--coverage` 跑该文件 → **24/24，测试体 185ms**。
离 1000ms 差得远，poll 根本没机会跑。（幸好测了 —— 这个假说「听起来非常合理」。）

#### 根因（机制链）

1. `initialize()` 的门控（`TelegramService.ts:182-184`）：
   ```ts
   const enabledFlag = credentialsManager.get('telegram_enabled')
   const isEnabled = enabledFlag !== null ? enabledFlag === 'true' : TELEGRAM_ENABLED
   if (!isEnabled) { log('INFO', 'telegram_disabled', …); return }   // :184
   ```
   测试把 `credentialsManager.get` mock 成恒返回 `null` → 落到 `TELEGRAM_ENABLED`。
2. `TELEGRAM_ENABLED` 是 `packages/core/src/config/index.ts:227` 的
   **模块级常量**（import 时求值，不是读时求值）。
3. 它唯一变成 `true` 的来源，是开发机上那份**未跟踪**的 `.env:34`
   （`.gitignore:7` 排除 `.env`）。
4. CI 全新检出**没有 `.env`** → 常量 = `false` → `initialize()` 在 `:184` 提前 `return`。
5. 于是**一个 fetch 都不发**：`/health` 没被消费 →
   `mockResolvedValueOnce` 的整条队列**整体前移一格**。
6. 那 4 条的断言恰好都落在「被前移」之后：`isRunning` 仍 `false`、`retryQueue` 空、
   `insertOutbox` 里一条 `edit` 都没有。

> ⚠️ 关键认知：**红的是断言的坐标，不是功能**。`initialize()` 一个请求没发，
> 后面每个 `sendMessageSync` 都拿到了本该给上一个调用的 mock。
> 这类「队列整体错位」在断言层面长得像功能 bug，实际是夹具问题。

#### 决定性复现（本机，双向）

```
mv .env .env.off  →  npx vitest run <该文件>   →  Tests 4 failed | 20 passed
mv .env.off .env  →  npx vitest run <该文件>   →  Tests 24 passed
```
失败断言与 CI 注解**逐字一致**：`expected false to be true` /
`expected 0 to be greater than or equal to 1` /
`expected '' to contain '自动恢复'` / `expected '' to contain '取消'`。

这是「本机绿 / CI 红」的**第 4 种机制**（前三种见 §10.3 / §10.9：`node_modules/electron/dist`
旧缓存、`packages/{insight,observer}/dist` 旧缓存、被 gitignore 的文件躺在工作区）。

#### 同一个 bug 类的第 4 例

「测试依赖了未入库（gitignored）的文件」：

| # | 未入库的东西 | 修法 |
|---|---|---|
| 1 | `__test_support__.ts` | `d1951cd` |
| 2 | `scripts/m56-capability-migration-report.ts` | `dca48c9` |
| 3 | `extensions/fanqie-mcp/fanqie-mcp.mjs` | `37cde4b` |
| 4 | **`.env`（`TELEGRAM_ENABLED=true`）** | `2415bd4` |

#### 审计：还有没有别的键在暗中起作用

把 `.env` 的 **24 个键**与 `.env.template` 对差 —— 后者有**零个活跃键**
（`comm -23 env-keys tpl-keys` 输出全部 24 个），所以 CI 拿不到任何行为开关。
逐个在 `tests/` 里检索行为开关：

* 只有 **`TELEGRAM_ENABLED`** 造成了失败。
* `EVOLUTION_DISABLE_GIT_SNAPSHOT` / `EVOLUTION_SERVICE_DISABLED` 只在
  `packages/main/src/bootstrap/AppRuntime.ts:2106` 与
  `packages/evolution-core/src/EvolutionUtils.ts:8` 被引用，**无测试依赖**。
* `TelegramTargetRouter.test.ts` / `IntegrationRC1.test.ts` / `SocialPublishService.test.ts`
  都自己显式设 env，不受 `.env` 影响。

#### 修法：在测试侧（`2415bd4`）

两条路都不能走：

* **不给 `.env.template` 加 `TELEGRAM_ENABLED=true`** —— 那会让 CI 真的去连外部服务。
* **不把 `.env` 进库** —— 它含真实 `TELEGRAM_CHAT_ID=8878140402`。

于是改用文件里**已经存在的缝**：`credentialsManager.get('telegram_enabled')` → `'true'`。
同文件 `106` / `121` / `136` 行本来就是这么做的 —— 说明作者的意图就是
「默认关、按需开」，这 4 条只是**漏了**。新增局部助手 `enableTelegram()`，
在 4 条里各调一次（`+21/-0`）。

> ⚠️ 为什么**不**用 `vi.hoisted` 设 `process.env.TELEGRAM_ENABLED`：那样也能工作
> （`vi.hoisted` 在 import 之前跑，能赶上常量求值），但**多一层脆弱** ——
> `packages/core/src/config/index.ts:160-170` 有个**手写 `.env` 解析器**，会
> **无条件覆盖** `process.env` 里的同名键。所以将来只要有人在 `.env` 里写
> `TELEGRAM_ENABLED=false`，hoisted 的值就会被打掉，用例重新变红。
> 走 credentials 这条缝**完全不碰环境**，也不依赖模块加载顺序。

#### 承重性验证

| 条件 | 结果 |
|---|---|
| 带 `.env`，跑该文件 | 24/24 |
| 移走 `.env`，跑该文件 | 24/24 |
| 移走 `.env` + 变异 `'true'` → `'false'` | **4 failed**（行号 109/539/573/598 = 那 4 条） |
| 移走 `.env`，跑**全量** `npx vitest run` | **292 files passed / 3009 tests passed**（另 1 file、3 tests skipped） |

最后一行是关键：**CI 看到的条件（无 `.env`）下全量绿**，而不是只有那一个文件绿。

#### CI 闭环

run #41（`ae4cbd3`）的 `main-tests` 注解正是这 4 条、行号 `91/520/553/577` ——
与本机复现逐字对应。同一次 run 的 **`mio-cli-tests` = success**，
即 §10.12 的游标 tie-break 在真实 CI 上承重（该 job 至今两次绿：#38、#41）。

#### 顺带发现（未修，记录以免重复踩）

同文件 `:51` 的 `process.env.TELEGRAM_SERVER_URL = 'https://test-telegram.local'`
是**死赋值** —— `TELEGRAM_SERVER_URL`（`config/index.ts:230`）同样是 import 时求值的
常量，此刻已冻结。测试之所以仍然过，是因为它们只断言**路径**
（`expect.stringContaining('/health')`、`'/edit'`），没有任何一条断言 host。
也就是说：它**看起来**在测 `test-telegram.local`，实际走的是默认
`https://skills.crlkcloud.cyou/telegram`。修它会让 20 条用例的 `baseUrl` 一起变，
属「影响面超出『让门禁承重』」，故未动 —— 但这行**应该**要么补上 mock，要么删掉。

### 10.15 ★★ 整个 weekly 门禁面是**坏的**：`weekly-audit.yml` 语法非法（0 job），`weekly-stress.yml` 两次全红

> 这一节是查「`weekly-audit` 为什么每次 push 都红」时顺出来的。
> ⚠️ 起因是一个**我差点信了的解释**：`weekly-audit.yml` 里有 4 处
> `continue-on-error: true`（第 22/28/56/65 行），看起来正是 FM-6。
> 但先查证据时发现：**这个 job 连一步都没跑过** —— 那 4 处 `continue-on-error`
> 是**无关的**，真正的失效在更前面一层。

#### 事实 1：`weekly-audit.yml` 从未启动过任何 job

* 该 workflow 每次 push 产生一个 run，`event=push`，`conclusion=failure`；
  查它的 job 列表 → **`total_count: 0`**（没有 job）。
* run 的 `name` 字段显示为 **`.github/workflows/weekly-audit.yml`（文件路径）**，
  而不是文件第 1 行写的 `Weekly Codebase Audit`。
* 两者都与「GitHub 读不出这个文件」一致：读不到 `name:` → 退回显示路径；
  建不出 job → 0 job。

**run 页面把这件事写得更直白**（`curl` 抓 `.../actions/runs/<id>`，页面摘要区逐字）：

```
Triggered via push        September 22, 2026 10:28   mldlbs pushed e19b01e fix/gate-packaging
Status        Failure
Total duration    –                        ← 破折号，一个 job 都没有
Artifacts         –
This workflow graph cannot be shown        ← 图都画不出来
A graph will be generated the next time this workflow is run.
Annotations   1 error
  Invalid workflow file: .github/workflows/weekly-audit.yml#L69
  You have an error in your yaml syntax on line 69
```

即 **GitHub 自己就写着 `Invalid workflow file`** —— 根因不需要我再推断。
页面里 `/actions/runs/<id>/job/<n>` 形式的链接数 = **0**（另有旁证：`Total duration` 为 `–`）。

#### 事实 1b：**从第 1 次运行起就是坏的**，且 50 次运行全是 push 事件

把该 workflow 的**全部 50 次运行**（run #1–#50，两页各 25 条）拉出来看：

* **50/50 全部 `failed`**。
* **50/50 的标题都是提交信息**（`Triggered via push`），**没有一次是 `Scheduled`**
  —— 也就是说这个「每周」workflow **一次都没被调度执行过**。
* run #1 = **2026-09-12 12:47**，`144d5fb` 推到 **`master`**，
  报错是 `...weekly-audit.yml#L68` / `on line 68`（后来变成 L69，文件有过微调）。
  → **这个文件自打被引入那天起就是非法的**，不存在「以前好过、后来坏的」。

> ⚠️ **方法论（补 10.15 开头那条）**：判「某 workflow 死了多久」不能只数失败的 run 数，
> 要看**这些 run 的 event 是不是它声明的触发方式**。
> 一个只有 `schedule` 的 workflow 出现一堆 `event=push` 的失败 run，
> 说明 GitHub **根本没解析出它的 `on:`** —— 这本身就是「文件非法」的独立证据。

#### 事实 2：根因是 YAML 语法错误 —— `Create report` 步骤的 here-string 顶到了第 0 列

`weekly-audit.yml` 第 67-80 行：

```yaml
      - name: Create report
        run: |
@"
## Weekly Audit Report — $(Get-Date -Format 'yyyy-MM-dd')
…
"@ | Set-Content -Path audit-report.md
```

`run: |` 是 YAML **块标量**，其内容必须比 `run:` **缩进更深**。
而 `@"` 与 `"@ | Set-Content …` 都在**第 0 列** → 块标量在那里就**结束**了，
后面的内容被当成**根级** YAML 节点 → 结构崩掉。

用仓库里现成的 `js-yaml` 直接验：

```
ci.yml               OK   name="CI"
weekly-audit.yml     FAIL end of the stream or a document separator is expected (69:1)
weekly-stress.yml    OK   name="Weekly Stress Test"
```

`69:1` 就是 `@"` 那一行、第 1 列。**只有这一个文件坏**（对照组两个都 OK）。

> ⚠️ **方法论**：判「某个 workflow 是不是死了」不能只看 `conclusion`。
> **`conclusion=failure` + `jobs=0` 是完全不同的一类失败**（文件根本没被解析），
> 和「跑起来了、某一步红了」不是一回事。以后先看 job 数。
> 这一条也解释了 10.3 里那个反常现象：`name` 显示成路径。

#### 事实 3：`weekly-stress.yml` 的两次红**根本没跑到测试** —— 死在 `npm ci`

⚠️ **先更正本节初稿的一条**：初稿写「没有 `continue-on-error`，这道门禁的**意图**是对的」。
那是**分支上（已修）**的文件。**实际跑出那两次红的文件在 `master` 上，它带着
`continue-on-error: true`**（该文件第 18 行）—— 即 FM-6 **在默认分支上仍然活着**。

两次 run 的页面（`curl` 抓 HTML 即可，不需要日志权限）：

```
Triggered via schedule     September 20, 2026 23:46    mldlbs    ec5bbd3    master
Status        Failure
Total duration    31s                       ← 本机光 vitest 段就要 37.75s
Annotations   1 error    stress   Process completed with exit code 1.
              1 warning  stress   Node.js 20 is deprecated…
```

⚠️ 本机实测 vitest 段要 **37.75s**，而整个 job 只跑了 **31s** → **它没跑到测试**。

**步骤级结论**：job 页面里的 `<check-step>` 元素自带 `data-conclusion`，
**不需要日志权限就能读** —— 本轮找到的一个好用的取证缝（日志 403 时的替代）：

```
step  1   success   Set up job
step  4   failure   Run npm ci           23:46:56 → 23:46:58（2 秒）
step  5   skipped   Run stress tests
```

即 **`npm ci` 2 秒失败、`Run stress tests` 被 skipped**。
此前只看到 `Process completed with exit code 1` 而**无任何 vitest 注解**，
原因就在这里 —— 失败在测试**上游**（当时这个判断是对的）。

**根因：`npm ci` 本身在这份检出上是坏的。** `master` 上：

* `packages/*/package.json` 里 **46 个文件**仍是 `"@akemi-mio/core": "workspace:*"`；
* `ci.yml` 里**没有** `npm i -g npm@11`。

npm 从不支持 `workspace:` 协议（那是 pnpm/yarn 的写法），遇到就**立刻**报错。
最小夹具实测（本机 npm 11.17.0）：

```
$ npm install --package-lock-only     # package.json 里只有一个 workspace:* 依赖
EXIT=1   耗时 2471ms
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

**2.471 秒 vs CI 的 2 秒** —— 机制与时长都对上。
而 `fe3a130` 正是修这个（`workspace:*` → `*` + 升 npm 11），**但它不在 `master` 上**。

* ⚠️ 顺带排除了「夹具没选中文件」这个 FM-6 变体：`test:stress` 的 4 个过滤词
  在主树里都有真文件（`AgentState.stress.test.ts` 等 8 个 `*.stress.test.ts`、
  `db-benchmark.test.ts`、`startup-benchmark.test.ts`、`endurance.test.ts`、
  `resource-baseline.test.ts`）→ **不是「0 文件」**；何况它压根没被执行。

#### 结论

**「我们每周跑代码审计和压力测试」目前是假的**：一个**从未启动**
（50 次失败 run、全部 `event=push`、0 job），一个两次红但**红在 `npm ci` 而非测试**
（`Run stress tests` 被 skipped）。CI 的 push 面已经接近全绿，**weekly 面则完全没有保障** ——
而且它一直在产出红色 run，正是「常响的警告 = 永久盲区」的教科书形态。

⚠️ 更糟的是：**两个 weekly workflow 的排期都落在 `master` 上，而 `master` 上
`npm ci` 是坏的**（46 个 `workspace:*` + 无 npm 11）→ 就算文件语法/Node 版本都修好，
调度跑起来仍然会死在 `npm ci`。**这个结论只在修复落到默认分支后才成立**（见下方）。

⚠️ 本节只做诊断，**未改语义**：修 YAML 会让它真的开始跑，而它一旦跑起来就会
`npm install -D ts-prune`（改 `package.json`）、并在 `Create Issue` 步骤
依赖 `audit`/`automated` 两个 label —— 这已经不是「让门禁承重」而是
「要不要这道门禁、要成什么样」，需要拍板。

#### 修法（`07ce2af`，按拍板取最小改动）

**A. `weekly-audit.yml`**：只把 `Create report` 的块内容**缩进 10 格**。
YAML 会按块基准统一剥掉这 10 格，交给 PowerShell 时 `@"` 与 `"@` 仍在**第 0 列**
—— 这正是 here-string 需要的。两处验证：

```
js-yaml：ci.yml OK / weekly-audit.yml OK / weekly-stress.yml OK      （此前 weekly-audit FAIL 69:1）
再取解析后的脚本：lines[0] === '@"'  → true
                lines.some(l => l.startsWith('"@')) → true
```

⚠️ 只改缩进、**不动语义**：4 处 `continue-on-error`、`npm install -D ts-prune`（改 `package.json`）、
`Create Issue` 依赖 `audit`/`automated` 两个 label —— 这些是「要不要这道门禁」的问题，留待单独评估。

**B. `weekly-stress.yml`**：`node-version: 20 → 22`（与 `ci.yml` 对齐），
并把 `npm run test:stress` 换成
`node scripts/run-with-annotations.mjs npm run test:stress`（可诊断性，做法同 §10.11）。
本机验证：`WRAPPED_EXIT=0`、`Test Files 12 passed`；另用不存在的 script 冒烟，
确认包装脚本对失败命令会产出 `::error::` 尾注解、且**退出码透明**。

#### 修完的效果：噪音停了（**已证实**），但修复本身**还是惰性的**（⚠️ 新发现）

**证实部分**：修好后的 4 次 push（`07ce2af` / `c7eb715` / `2533092` / `ba122b5`）
**一次 `weekly-audit` run 都没产生** —— 该 workflow 的最新一条仍是修前的 `e19b01e`（run #50）。
把「事实 1b」的 50 条与这 4 次 push 对起来，机制就闭合了：

> **文件语法非法 → GitHub 解析不出 `on:` → 于是「每个 push 都报一次解析失败」，
> 建出一个 0 job 的失败 run。文件一旦合法，声明的触发器（`schedule`/`workflow_dispatch`）
> 才生效 —— 而它俩都不含 push，所以噪音归零。**

这同时解释了 10.15 开头那个反常现象（一个只有 `schedule` 的 workflow 却 `event=push`）。
此前记为「推断」，现在是**证明**：`on:` 里确实没有 `push`（第 3-6 行只有
`schedule: cron '0 20 * * 0'` 与 `workflow_dispatch:`），却存在 50 个 push 事件 run。

---

⚠️ **但修复现在等于没修 —— 它只在 `fix/gate-packaging` 上。**

| 项 | 值 |
|---|---|
| 默认分支 | **`master`**（`ls-remote --symref origin HEAD` → `refs/heads/master`） |
| 远端 `master` | `ec5bbd36`（`docs: fix two wrong conclusions…`），**其 `weekly-audit.yml` 仍是坏的那份** |
| 远端 `fix/gate-packaging` | `ba122b5`（含修复），是 `master` 的**直系后代**（0 提交分叉，35 笔领先） |
| 两分支关系 | `master` 是 `fix/gate-packaging` 的**祖先** → **可快进，不需要 merge commit** |

后果（三条都要紧）：

1. **`schedule` 只在默认分支触发** → 下次调度（`0 20 * * 0` = 2026-09-27 20:00 UTC
   = **2026-09-28 04:00 GMT+8**）读的是 **`master` 上那份坏文件** → 依旧 0 job 失败。
   **这次「每周审计」的首次真实执行不会发生。**
2. 对 `master` 的任何 push 仍会继续产生 0 job 噪音 run
   （`master` 最后一次 push 就是 weekly-audit run #33，之后 master 没再动过）。
3. ⚠️⚠️ **比 1 更根本：`master` 上 `npm ci` 就是坏的。**
   `master`（`ec5bbd3`，**2026-09-20 16:04**）上 46 个 `package.json` 仍是 `workspace:*`、
   `ci.yml` 里没有 `npm i -g npm@11`，而 `fe3a130`（那个修复）**不在 `master` 上**。
   ⇒ **即使把 YAML 语法和 Node 版本都修好并落到 `master`，调度跑起来仍会死在 `npm ci`。**
   ⇒ 更广的：**`master` 上的 `CI` 也是死的** —— 它 5 处 `npm ci` 都会 2 秒失败。
   也就是说，`master` 作为默认分支，其 CI 自 monorepo 化以来一直是红的，
   **而这两天所有「修好了」的证据全部长在 `fix/gate-packaging` 上。**

> ⚠️ **通用教训（本轮最贵的一条）**：「修好了」必须问**修在哪个分支**。
> 只验证「我推的那个分支不再产生 run / 变绿了」会得到一个
> **正确的局部结论 + 错误的全局结论**。判据要落到
> **该 workflow 真正会执行的那条路径**上（这里 = 默认分支上的 `schedule`）。
> 这一条与 §10.16「门禁在 CI 生效须确认那次运行真跑到它」是同一族的错。

* `weekly-stress` 那两次红**已经查清**（事实 3）：是 `npm ci` 2 秒失败、测试被 skipped，
  **不是压测回归**。所以「升 Node 22 + 接注解包装」修的不是那个红 —— 那个红要等
  `fe3a130` 落到默认分支才会消失。
  ⚠️ 它的调度同样在 `master` 上，`07ce2af` 的两处改动**也要等落到默认分支才在真实调度里生效**。
* ⚠️ **`master` 上那份 `weekly-stress.yml` 还带着 `continue-on-error: true`** ——
  即便 `npm ci` 修好、测试跑起来，压测回归在默认分支上**仍然红不了**（FM-6 未除）。

#### 处置（按 09-22 拍板）

用户选择 **「等 CI #48–#50 全绿再快进」**。三步：

1. 等 `2533092`(#48) / `ba122b5`(#49) / `a38a582`(#50) 三笔 CI 跑完并确认全绿 ——
   其中 **#48 是唯一会真正跑到新 `check:idle-gpu` 的那笔**（本轮代码改动只有它被 CI 覆盖）。
2. 然后**纯快进**默认分支（`master` 是 `fix/gate-packaging` 的直系祖先、0 分叉）：

   ```
   git -c http.proxy= -c https.proxy= push origin <sha>:refs/heads/master
   ```

   预演已通过：`--dry-run` 输出 `ec5bbd3..a38a582  a38a582 -> master`，
   没有分支保护拦截。
3. 落地后**必须复查两件事**：`master` 上 `weekly-audit.yml` 已合法、
   以及**下一次调度（2026-09-28 04:00 GMT+8）是否真的执行了步骤**。
   ⚠️ 这一步不能省 —— 本节的教训正是「**分支上绿 ≠ 默认分支上生效**」。

⚠️ 快进带来的**开发环境后果**：`npm ci` 从此要求 **npm 11**（`fe3a130` 起），
本地若仍是 npm 10 会撞 `edgesOut`（CI 里由 `npm i -g npm@11` 承担）。

#### ⚠️ 已知的首次运行风险：`Create Issue` 会因**缺少 label** 而红（已查证）

把 `weekly-audit.yml` 从头读了一遍，并查了仓库实际的 label 列表：

```
$ curl -sL https://github.com/mldlbs/akemi-mio/labels
→ accessibility, bug, documentation, duplicate, enhancement,
  good first issue, help wanted, invalid, question, wontfix
```

**只有 GitHub 的 10 个默认 label —— 没有 `audit`，也没有 `automated`。**
而最后一步（第 88-100 行）：

```yaml
      - name: Create Issue          # ← 没有 continue-on-error
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.create({ …, labels: ['audit', 'automated'] });
```

`issues.create` 带**不存在的 label** 会被 API 判 **422 Validation Failed**
→ 该步骤失败 → **整个 job 红**。

⚠️ 这个红的性质很坏：**它不是任何代码质量发现引起的**，而是「报告没地方贴标签」。
第一次真实调度（2026-09-28 04:00 GMT+8）最可能就红在这里 ——
而这正是本报告一直在说的那类失败：**门禁红的原因与它要检的东西无关**。

处置（都很小，语义可保持不变）：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（最小）** | 在仓库 Settings → Labels 里**创建 `audit` 与 `automated`** | 一次 UI 操作，workflow 一行不改 |
| B | 把 `labels:` 换成已存在的 label（如 `documentation`） | 改一行，但语义漂移 |
| C | 去掉 `labels:` | 改一行，失去分类 |

#### ✅ 处置结果（09-22 拍板：**改代码去掉 label 依赖**，见 §10.21）

选了「不让 workflow 依赖仓库里预先存在的 label」这条路 ——
**自愈式建 label + 显式声明 `permissions`**。详细验证见 §10.21。

⚠️ 另外三处**同批需要留意的语义债**（本次未改，属「要不要这道门禁」的范畴）：

* **4 处 `continue-on-error: true`**（第 22/28/56/65 行）—— 四个分析步骤永远不能让 job 红。
  对「产报告 + 开 issue」这个意图而言**可能是故意的**，但报告里就分不出
  「扫出来没问题」和「扫描根本没跑起来」。
* **`npm install -D ts-prune`**（第 26 行）—— 在 CI 里**改 `package.json` + lockfile**；
  一旦失败，死代码报告静默变成空文件。
* **`node-version: 20`**（第 15 行）—— `ci.yml` 与 `weekly-stress.yml` 都已到 22，此处没对齐。

### 10.16 ★★★ 里程碑：CI 六个 job **首次全绿**，且连续三笔

| run | commit | 结果 |
|---|---|---|
| #43 | `2415bd4`（TelegramService 修复） | **Success —— 六个 job 全部通过，史上第一次** |
| #44 | `d053632`（§10.14 文档） | Success |
| #45 | `e19b01e`（§10.15 文档） | Success |
| #46 | `07ce2af`（weekly 修复） | **Success** —— 证明这两处 workflow 改动没有破坏 `quality`/`packaging` |
| #47 | `c7eb715`（§10.15 修法 + 本节） | Success |
| #48 | `2533092`（`check-idle-gpu` 改造） | 抓取时仍在跑 —— **本轮唯一会真正跑到新 `check:idle-gpu` 的那笔** |
| #49 | `ba122b5`（§10.17 文档） | 抓取时仍在跑 |

即 **#43–#47 连续五笔全绿**。

> ⚠️ 计数说明：run 号是**按 workflow 各自计数**的，所以 `CI` 与 `weekly-audit` 会各有一套
> 40+ 的号（此前一度把它误读成「同一个 run 号出现在两个 workflow 上」）。

至此，**push 面上的六道 job 都有「承重」证据**（不是「配了」，而是「跑到了且能红」）：

| job | 承重证据 |
|---|---|
| `quality` | 曾是 `format:check` 恒红 / `typecheck:budget` 报错（§10.7） |
| `main-tests` | §10.14：4 条用例曾在 CI 上稳定红，修复后转绿 |
| `renderer-tests` / `preload-tests` | 覆盖率棘轮已标定（§10.8） |
| `mio-cli-tests` | §10.12 游标竞态曾在 CI 上红 → 修复后 #38、#41 两次绿 |
| `packaging` | §10.9：曾在 CI 上 3 秒失败 → 修复后实跑 |

⚠️ **但「全绿」不等于「门禁没问题了」**。仍未闭合的：
* ✅ ~~`fix/gate-packaging` 整个分支（35 笔）还没落到默认分支 `master`~~ ——
  **09-22 已闭合**（§10.18：纯快进到 `fe25623`，`master` 的 CI 第一次有机会变绿）。
* `weekly-stress` 两次红**已查清**（§10.15 事实 3：死在 `npm ci`，测试被 skipped），
  但**下一次调度（2026-09-28）能否真的跑起来**仍未验证。
* ✅ ~~**`weekly-audit` 首次运行几乎必红在 `Create Issue`**（缺 `audit`/`automated` 两个 label）~~
  —— **09-22 已闭合**（§10.21：改成自愈式建 label，并补上缺失的 `permissions: issues: write`，
  桩件 + 变异检验通过）。
* `weekly-audit` 的 4 处 `continue-on-error` 语义问题未动。
* ⚠️ **`check:idle-gpu` 只守主窗口**（§10.17 顺带发现 4）——
  `wallpaper`/`pet`/`chat` 三个形态窗口完全没被守。
  「把量到了什么变成 notice」**09-22 已做并验证**（§10.19：受控夹具 + 变异检验通过）；
  **扩大覆盖**仍未做（已探明路径，见 §10.19 末尾与 §10.22 末段）。
* ✅ ~~**`check:idle-gpu` 的主判据可能在 CI 上永远是死的**~~
  —— **09-22 已加仪器自检**（§10.22）：注入一条确定无疑的重负载动画再看 GPU 响不响应。
  零动画页（= CI 情形）上自检把 GPU 顶到 **41.4%**（基线 0.1%）⇒ 「动画 → GPU」这条链是通的。
  v1 **只报数不判红**（本机实测两次差值 43.3 / 19.9，约 2 倍波动，紧阈值会变成 FM-8）。
  ✅ **CI 上已验证**（§10.22，四笔 run）：runner **有 GPU 进程**（`GPU 进程 1`），
  注入动画把 GPU 顶到 **147%**（147.3/147.2/146.9/147.6，极差 0.7 个点）
  ⇒ 这条链在 CI 上**是通的**，A/B 判据**能红**。
* ⚠️ **待拍板**：是否把自检从「报数」**升级成判红**（如 `--selfcheck-min=5`）。
  CI 上稳定 ≈147、仪器失灵会是 0，下限取 5 有约 **29 倍**余量。
  这一步属「改门禁语义」，按惯例先给选项。
* ✅ ~~**`main-tests` 有一处抖动**（§10.20）：`connection.path.test.ts` 的 5s 超时
  从未在 Windows runner 上标定过（本机 1.1–1.4s）。**master 上实测 5 笔 2 红（≈40%）**~~
  —— **09-22 已处置**：成本查清（迁移 88ms vs 冷 import 957ms），
  采用 **A′（`beforeAll` 预热 + `resetModules`）**：测试体从 1374ms 降到 **96ms**
  （对 5000ms 是 52 倍余量），**超时阈值未动**，变异检验通过。
  统计已补全（§10.20）：**A′ 前 8 run 4 红（50%）→ A′ 后 6 run 0 红**，
  且四个红 run 都只有 `main-tests` 一个 job 失败（归因干净）。
  ⚠️ 0/6 的 95% 单侧上界仍有 ≈39%，「降低但未归零」尚未排除 —— 继续累积样本。
* 覆盖率目标值 30/37/80 仍是**未还的债**（§10.8）。
* `check:idle-gpu` 的 GPU 阈值仍未在 CI 上标定（§10.17 已把数字变成注解，
  CI #48 已拿到基线数字：GPU 0.0% / CPU 2.5%）。
* `audit` 门禁仍未进 CI（要先还 32 个漏洞的债）。

### 10.17 `check:idle-gpu`：**判据自己没法被标定**（`2533092`）

#### 缺陷：注释里的操作指令，按它做不到

`ci.yml` 的 `Idle GPU budget` 步骤上写着：

> THRESHOLDS ARE UNCALIBRATED ON CI. `--gpu-budget` / `--delta-budget` default to 20 / 15,
> derived on a dev machine with a real GPU; GitHub runners are software-rasterised, so the
> absolute number is not comparable yet. **If the absolute budget goes red on the first runs,
> recalibrate it from the measured numbers** -- do NOT silence the step.

问题在于：**「the measured numbers」读不到**。公开仓的 job 日志要管理员权限（403），
只有 check-run annotation 无认证可读 —— 而这道门禁只往 stdout 打数字。
于是「从实测数字重标定」这条指令**从写下的那天起就无法执行**。
这是「门禁的判据自己没法被标定」那一类缺陷，和 §10.11 的「失败原因读不到」是同一个根。

#### 修法：让数字离开日志

* **每次运行**都发一条 `::notice::`（通过也发、失败也发），带上
  基线 GPU / 关动画 GPU / A-B 差值 / 基线总 CPU / 基线运行中动画数
  → 下次 CI 跑完就能直接从注解标定阈值，不需要任何权限。
* **失败时**额外发 `::error::`，红的那次能直接说清「谁超了哪个预算」。
* ⚠️ workflow-command 格式里 `%` 必须转义（`20%` → `20%25`，GitHub 会还原）。
  **顺序要紧**：先转义 `%`，再处理 `\r\n` —— 反过来会把刚插入的 `%0D` 二次转义成 `%250D`。
* 门禁语义**未变**：只加输出，不动判据（仍是 20 / 15）。

#### 顺带发现 1：量的是哪个窗口，看不见

本地实跑（`GITHUB_ACTIONS=true`）的结果是：

```
[基线] GPU 0.0%  总 CPU 0.0%  运行中动画 0/0
```

`0/0` 不是「0 个在跑」，而是**这个页面上一个动画都没有**。
它既可能是「真的空闲」（`80c530e` 修好后的期望状态），也可能是
**「量到了一个空窗口」**——后者会让这道门禁**永远绿**。

而选窗口这件事是隐式的：

```js
const page = list.filter(t => t.type === 'page').find(t => t.url.includes('index.html'))
          || list.filter(t => t.type === 'page')[0]
```

多窗口形态（pet / chat / wallpaper / agent）下，这个 fallback 会静默选到第一个页面目标。
所以加了输出：**页面 title + 文件名 + 页面目标总数**，并把它写进 `::notice::`。
「量到了什么」必须和「量出来多少」一起可见。

#### 顺带发现 2：A/B 这次可能没有信息量

`ci.yml` 的注释说 A/B 差值才是「load-bearing assertion」。但 A/B 只在
**基线本来就有动画可关**时才带信息量 —— 基线 0 个运行中动画时，差值为 0 是**必然**的，
这时那次绿其实**只由绝对预算那条承担**。所以基线无动画时额外发一条 notice 说明，
免得把一次没有信息量的通过读成「A/B 这条承重断言也验过了」。

#### 顺带发现 3：这道门禁会留下 MCP 孤儿，并且会毒死下一次运行

`shutdown()` 原来只 `process.kill(child.pid)` —— 杀主进程，不杀进程树。
Electron 会再拉一个 MCP 子进程（`node.exe`，监听 **1841**），它活下来。

实测的连锁反应：

| 运行 | 前置状态 | 结果 |
|---|---|---|
| 1 | 干净 | **EXIT=0**，正常出数 |
| 2 | 1841 上有孤儿 | `EXIT=2`，`Received network error or non-101 status code` |
| 3 | 1841 上又有孤儿 | `EXIT=2`，`Cannot read properties of null (reading 'filter')`（`/json/list` 一直不响应） |
| 4 | 手工清掉孤儿后 | 仍 `EXIT=2`（non-101），且又留了一个孤儿 |

改成 `taskkill /PID <pid> /T /F`（Windows）后，**主进程还活着时**整棵树会被收掉。
⚠️ **局限（实测）**：主进程若已自己退出（`non-101` 那次就是），孙子进程会被 reparent
而逃掉，失败路径上仍可能留孤儿 —— 所以注释里写明了要人工
`netstat -ano | grep :1841` 清一下。

⚠️ **不能**把「自动杀掉 1841 的占用者」写进门禁：**开发实例（`electron .`）的 MCP 服务
同样监听 1841**，自动清会误杀用户正在跑的应用。本机当时就有 5 个 09-19 起的
electron 进程（`--user-data-dir=%APPDATA%\akemi-mio`）在跑 —— 而且它们与打包 exe
**共用同一个 userData 目录**，这也是本地反复实跑不稳定的背景之一。

#### 验证状态（诚实记录）

* ✅ `GITHUB_ACTIONS=true` 本地实跑一次 → `EXIT=0`，`::notice::` 如期出现、
  `%` 转义正确（原文 `0.0%25`，GitHub 还原为 `0.0%`）。
* ⚠️ **未观察到**：页面标签那两行、以及树杀后「不留孤儿」。本地后续三次复跑都被
  上述环境污染挡住（共用 userData + 1841 孤儿），只做了 `node --check` 与代码路径审阅。
* ⚠️ 顺带一条通用教训：**「实跑一次就绿」之后紧接着的三次复跑都红** ——
  这种时候先怀疑**自己上一次留下的状态**（这里是 1841 孤儿 + 共用的 userData），
  而不是先怀疑刚改的代码。改动本身在 WebSocket 之前/之后都不参与那条失败路径。

#### ★★ 顺带发现 4（CI 上拿到数字后才发现）：**这道门禁量的是一个没有动画的窗口**

上面两条「未观察到」在 **CI #48**（`2533092`，`completed successfully`）上补到了 ——
两个 `::notice::` 都出现在 run 页的 Annotations 区（**不需要日志权限**），逐字：

```
packaging  [idle-gpu] 页面 Akemi Mio index.html
           / 基线 GPU 0.0%（预算 20%） / 关动画 0.0% / A-B 差值 0.0 个点（预算 15）
           / 基线总 CPU 2.5% / 基线运行中动画 0

packaging  [idle-gpu] A/B 本次无信息量：基线就没有运行中动画，差值为 0 是必然的
           （本次判定只由绝对预算那条承担）
```

✅ **机制本身验证成功**：`::notice::` 在 CI 上可见、`%` 转义正确（`0.0%（预算 20%）`）、
页面标签给出了 `Akemi Mio index.html` —— §10.17 开头那个「判据没法被标定」的缺陷**已闭合**：
以后每次运行的实测数字都能无权限读到。

⚠️ **但它一上来就暴露了一个更深的缺陷。** 数字说：

| 量到的 | 值 |
|---|---|
| 被测页面 | `Akemi Mio index.html`（**主窗口**） |
| 基线运行中动画 | **0**（且 `anims.length` 也是 0） |
| 基线 GPU | **0.0%** ≤ 预算 20 |
| A-B 差值 | **0.0** ≤ 预算 15 |

**两条判据同时结构性为空**：没有动画 ⇒ GPU 必然是 0、A/B 差值必然是 0。
**这道门禁今天不可能红** —— 它绿不是因为「应用空闲时不烧 GPU」，而是因为**没东西可量**。

而代码里其实**还有 72 条 `infinite` 动画**：

```
$ grep -rn 'infinite' src/renderer/src --include=*.css | wc -l
72
$ grep -rln 'infinite' src/renderer/src --include=*.css
src/renderer/src/forms/chat/styles.css
src/renderer/src/forms/pet/styles.css
src/renderer/src/forms/wallpaper/styles.css      ← 历史上打爆到 136% 的那个窗口
src/renderer/src/styles/components.css
src/renderer/src/styles/layout.css
src/renderer/src/styles/redesign.css
```

根因在页面选择上（`scripts/check-idle-gpu.cjs:234-236`）：

```js
const page =
  list.filter((t) => t.type === 'page').find((t) => String(t.url).includes('index.html')) ||
  list.filter((t) => t.type === 'page')[0]
```

**硬编码偏好 `index.html`（主窗口）**。而渲染层有 5 个入口
（`electron.vite.config.ts` 的 `index` / `agent` / `pet` / `chat` / `wallpaper`），
动画住在**形态窗口**里；主窗口渲染不到那些元素 ⇒ `document.getAnimations()` 返回空。

⇒ 结论：**`check:idle-gpu` 只守主窗口，`wallpaper`/`pet`/`chat` 三个窗口完全没被守**。
其中 `wallpaper` 正是 §四那个「停掉常驻动画，GPU 136% → 0.0%」事故的现场。
脚本自己的文档写的是「防止『应用啥也不干却常驻吃满一个核』回归」——
按这个意图，只量主窗口**覆盖不到它声称要防的那类回归**。

> ⚠️ **这一段的价值恰在于它是怎么被发现的**：`2533092` 之前，这个门禁的输出只有
> 「过 / 不过」，**没人能从结果里看出被测窗口有没有动画**。把数字变成注解之后，
> **第一次运行就暴露了它一直是空的**。这是「可观测性本身就是门禁质量」的一个直接证据，
> 也再次印证 §10.11 那条：**门禁失败（或通过）必须能让人看见它到底量了什么。**

#### 但**不要过度断言**：它作为「绊线」仍然是有效的

上面的结论只说到「今天不可能红」，**不等于「这道门禁没用」**。把两种读法分开：

| 读法 | 成立吗 |
|---|---|
| 「它现在绿 ⇒ 应用空闲时省 GPU」 | ❌ **不成立**（没东西可量，绿是空的） |
| 「有人往主窗口加回一条 infinite 动画 ⇒ 它会红」 | ✅ **成立**（这正是绊线的作用） |

判据本身是对的：基线动画数为 0 时，绝对值那条退化成「量了个 0」，
但**一旦动画回来，两条判据都会真的动起来**
（历史上的 `atelier-control-glint` 让 GPU 到 126%，远超 20% 的预算）。
所以准确的表述是：

> **它是一根合格的绊线，但覆盖面比它文档声称的窄** ——
> 只拦主窗口，拦不住 `wallpaper`/`pet`/`chat` 三个形态窗口。

⚠️ 这一条也顺手纠正了本报告开头的一个倾向：**「当前量到 0」与「判据失效」是两件事**，
不能因为数字好看就推断门禁空转，也不能因为门禁空转而否认它作为绊线的价值。
区分点在于：**如果给它喂进本该变红的输入，它会不会红**（→ §四「变异检验」）。
对这道门禁，这个检验**已于 09-22 完成**（→ §10.19，结论：夹具承重）。


### 10.18 ★★★ 落地默认分支：`master` 的 CI **第一次有机会变绿**（`fe25623`）

按 09-22 拍板（「等 CI 全绿再快进」），CI #52 = `completed successfully` 之后执行了
**纯快进**：

```
$ git push origin fe25623:refs/heads/master
   ec5bbd3..fe25623  fe25623 -> master
```

38 笔、0 分叉、无 merge commit、无分支保护拦截。

#### 落地后**在默认分支上**复查（不靠「分支上绿」推断）

| 检查项 | 命令 | 结果 |
|---|---|---|
| `weekly-audit.yml` 能否解析 | `js-yaml` 直接 `load` | ✅ **OK**，`name="Weekly Codebase Audit"`，`triggers=schedule+workflow_dispatch` —— **该文件史上第一次合法** |
| `weekly-stress.yml` 还有没有 `continue-on-error` | `grep -cE '^[[:space:]]*continue-on-error:'` | ✅ **0 处**（唯一一处字样在第 21 行的**注释**里） |
| `package.json` 还剩几个 `workspace:` | `git grep -c '"workspace:'` | ✅ **0 个** |
| `ci.yml` 是否升了 npm 11 | `grep -c 'npm i -g npm@11'` | ✅ **6 处** |

> ⚠️ 这里有个自己差点踩的坑：第一次用 `grep -c 'continue-on-error'` 得到 **1**，
> 差点报成「master 上还留着」。实际那行是
> `# No continue-on-error: a stress regression has to make this run red.` ——
> **注释**。判 YAML 指令必须用 `^[[:space:]]*key:` 这种锚定写法，
> 否则注释/文档字符串会把结论带偏（同一类错误在 §四「常响的警告」里也出现过）。

#### ★ 最有说服力的一幕：master 的 CI 历史**每一条都是 failed**

push 之后 master 上的 run 列表（`?query=branch%3Amaster`）：

```
35722147564 | currently running:  Run 53 of CI. docs(gate): §10.17 纠正一处过度断言…
35545632467 | failed:  Run 2  of Weekly Stress Test.
35498567869 | failed:  Run 28 of CI.
35498567184 | failed:  Run 33 of Weekly Codebase Audit.
35498478091 | failed:  Run 27 of CI.
35498477656 | failed:  Run 32 of Weekly Codebase Audit.
35496047624 | failed:  Run 26 of CI.
35496047233 | failed:  Run 31 of Weekly Codebase Audit.
```

**`Run 53 of CI` 是默认分支上第一条有资格变绿的运行。** 在它之前的每一条
（`CI` #26/#27/#28、`Weekly Codebase Audit` #31/#32/#33、`Weekly Stress Test` #2）
**全部 failed** —— 这正是「master 的 CI 自 monorepo 化以来一直是红的」的直接证据，
而且它同时解释了「为什么这两天所有修复的证据都只长在分支上」。

⚠️ 也正因为如此：**`Run 53` 的结果必须复查**，不能因为「分支上绿了」就假定默认分支也绿。
这条判据本身就是本节 10.15 末尾那条教训的第二次应用。

#### ✅ 复查结果：`Run 53` 与 `Run 54` **连续两笔绿**（09-22 已复核）

| run | 提交 | 结论 |
|---|---|---|
| `Run 53 of CI`（35722147564） | `docs(gate): §10.17 纠正一处过度断言…` | ✅ `completed successfully` |
| `Run 54 of CI`（35722394558） | `docs(gate): §10.18 —— 落地默认分支…` | ✅ `completed successfully` |

**默认分支的 CI 从此不再是「结构性地红」。** 同一页上紧挨着的历史全部 failed
（`CI` #18–#28、`Weekly Codebase Audit` #23–#33、`Weekly Stress Test` #2），
所以这不是「一直就绿」—— 是**这一次才第一次绿**。

⇒ 至此「修在哪个分支」这条教训完成闭环：
**分支绿不算数 → 快进默认分支 → 默认分支也绿了**。三步缺一步，结论都是错的。

> ⚠️ **但两笔绿之后立刻出现了第三笔红**：`Run 58`（35725473675）= `failed`，
> 原因是一个**与本次改动无关的测试抖动**（`connection.path.test.ts` 超时）→ **§10.20**。
> 所以准确的说法是「**结构性的红已经修好；剩下的是抖动**」——
> 这两件事必须分开，否则会把「门禁坏了」和「门禁响了但响错了」混为一谈。

#### 顺带：`fix/gate-packaging` 现在与 `master` 同点

两者都是 `fe25623`。后续改动仍按「先分支验证 → 再快进默认分支」的老路子走，
因为本轮的核心教训正是**「修在哪个分支」是必须显式检查的一环**。


### 10.19 把「量到了什么」变成注解，并**第一次对这道门禁做变异检验**

按 09-22 拍板（「先只把『量到了什么』变成 notice」），在 `master` 落地之后动手。
**判据、阈值、退出码一律不动**，只增加输出。

#### 改了什么（`scripts/check-idle-gpu.cjs`，+42/−9）

| 改动 | 理由 |
|---|---|
| `phase()` 返回值补 `animCount`（动画**总数**）与 `animProbeOk` | 原来只报「运行中动画 N」，报不出「总共几个」—— 分不清「0 个在跑但有 72 个存在」和「一个都没有」 |
| 标定注解改为 `基线动画 <运行中>/<总数>` | 同上；探测失败时明确写 `探测失败` 而不是 `0/0` |
| 新增注解：**可量页面清单** | 页面是**隐式**挑的（优先 url 含 `index.html`），只报挑中的那个，「别的窗口没被量」就看不见 |
| 新增注解：**页面一个 CSS 动画都没有 ⇒ 关于动画的判据结构性为空** | 空绿必须自曝；否则会把「没有量到东西」读成「验过了」 |
| 新增注解：**探测失败**（与上一条互斥） | `document.getAnimations()` 取不到结果时，`anims.length` 同样是 0 —— 不对它加以区分就会**说出假话** |
| 旧的「A/B 无信息量」注解加条件 `animCount > 0` | 让它只在「有动画但都没在跑」时说，与上面两条各管一种情形、不重复 |
| 页面名回退到标题 | url 以 `/` 结尾时 basename 是空串，清单里会出现读不懂的空条目 |

#### 验证：受控夹具 + 变异检验（这道门禁**第一次**做）

本地直接复跑**被环境挡住**（见下），于是用 Edge 的远程调试端口做受控夹具
—— 脚本本来就有 `--exe=` / `--port=` 两个口子，把 `--port` 指到一个已就绪的
Chromium 即可（`snap()` 对不支持 `SystemInfo.getProcessInfo` 的浏览器是**优雅降级**的：
`r?.result?.processInfo || []` → 空表，不影响后面的动画探测与注解阶梯）。

| 夹具 | `基线动画` | 「结构性为空」注解 | 结论 |
|---|---|---|---|
| `zero/index.html`（**无** CSS 动画） | `0/0` | ✅ 出现 | 空绿自曝 |
| `anim/index.html`（**1 个** `infinite` 动画） | `1/1`（并列出 `glint <DIV> .btn`） | ❌ 不出现 | **不是永远在响的废消息** |

**变异检验**（把 `base.animCount === 0` 反成 `base.animCount > 0`）：
两个夹具的结论**同时反转** —— 0 动画页不再报、1 动画页反而报了，
而且那条假注解与同一行的 `基线动画 1/1` **自相矛盾**。
⇒ **夹具是承重的**：它能抓住一个方向写反的判据。恢复后 md5 与备份一致、无 `MUTATION` 残留。

> 这一步的意义超出这道门禁本身：它把 §10.17 那句「**「当前量到 0」与「判据失效」是两件事**」
> 从原则变成了**可执行的动作** —— 判据的可靠性靠**喂坏输入看它红不红**来确立，
> 而不是靠当前数字好不好看。

#### ✅ 更强的证据：CI 上真的说出了那句话（`fix/gate-packaging` CI #56 = 绿）

本地夹具是替代品，**最终证据必须在 runner 上**。推 `ab0d3fd` 后
`Run 56 of CI`（35723759041）= `completed successfully`，run 页 Annotations 区
**逐字**是：

```
[idle-gpu] 页面 Akemi Mio index.html / 基线 GPU 0.0%（预算 20%） / 关动画 0.0%
          / A-B 差值 0.0 个点（预算 15） / 基线总 CPU 3.1% / 基线动画 0/0
[idle-gpu] 可量页面 1 个：index.html（本次只量了挑中的那一个）
[idle-gpu] 被测页面一个 CSS 动画都没有：本次关于动画的判据（A/B 差值、常驻无限动画）
          结构性为空，没有量到任何东西 —— 绿只由绝对预算那条承担
```

三点值得单独记下：

| 观察 | 含义 |
|---|---|
| 三条注解都出现了，`%` 转义正确 | 新代码在 runner 上跑通，不只是在我本机的 Edge 夹具上 |
| `基线动画 0/0` | **打包版主窗口确实一个 CSS 动画都没有** —— §10.17 的结论在 CI 上复现 |
| **`可量页面 1 个：index.html`** | CI 里连**一个**形态窗口都不存在 ⇒ 扩大覆盖不能只改测量循环，**必须先有窗口**（见下） |

⇒ 至此 §10.17「判据自己没法被标定」+「量的是什么看不见」两个缺陷**都已闭合**，
且闭合的证据链是完整的：**本地夹具（含变异检验）→ CI 注解**。

#### ⚠️ 本地直接复跑仍然做不到：**有一个 3 天前就在跑的 dev 实例占着 userData**

`node scripts/check-idle-gpu.cjs`（用真实打包 exe）报：

```
[idle-gpu] 页面      (无标题) index.html
[idle-gpu] 页面目标  1 个：index.html
[idle-gpu] 异常: Received network error or non-101 status code.
```

排查结论（**已核实，不是猜的**）：

| 现象 | 实测 |
|---|---|
| `electron.exe` 进程 | 5 个，`Start = 2026-09-19 07:53`，命令行 `electron.exe . --in-process-gpu` → **dev 实例**，占着 userData `akemi-mio` |
| 打包 exe 是否残留 | 无 `AkemiMio.exe` 进程 → 它起不来（single-instance 锁），不是「起来后崩」 |
| 端口 1841 上的进程 | `hjgo2claude … serve --port 1841`（**无关工具**，不是本仓的 MCP 孤儿） |

⇒ 这是 §五「dev 直跑 ≠ 打包 exe」那条坑的**进程级版本**：
**dev 实例与打包 exe 共用 userData，同时存在时后者起不来。**
（该 dev 实例是用户自己的，**没有动它**；要本地复跑需先由用户确认关掉。）

#### 仍未做（等拍板）

* **扩大覆盖**：让门禁也量 `wallpaper` / `pet` / `chat` 三个形态窗口。
  路径已探明 —— 形态窗口只在用户操作时创建，`globalShortcut` 走的是 OS 级快捷键、
  CDP 合成按键触发不了；但 `src/preload/index.ts` 的 `exposeInMainWorld('akemiForms', …)`
  是**无条件**暴露的，所以 CDP 里 `window.akemiForms.setFormVisible('wallpaper', true)`
  即可拉起（约十几行）。**这是改判据的覆盖面，超出本次拍板范围，先不动。**
  ⚠️ CI #56 的 `可量页面 1 个：index.html` 给这条加了一个前提：
  **CI 里一个形态窗口都不存在** ⇒ 扩大覆盖不是「改测量循环」那么简单，
  **必须先让窗口存在**（拉起 → 等 target 出现 → 再量）。量不到时要**明确报「未覆盖」**，
  不能静默跳过（否则就是 FM-1）。
  ⭐ **09-22 补充：这个「拉起窗口」的配方本仓已有、且已经在 CI 里通过** ——
  `scripts/check-renderer-entries.cjs` 就在同一个 `packaging` job 里，从主窗口
  `index.html` 上调 `window.akemiForms.toggleForm(kind)`，再去找
  `pet.html` / `chat.html` / `wallpaper.html` 目标逐个验证渲染。
  所以扩大覆盖**不需要新机制**，只需要把同样的调用接进 idle-gpu。
  （已核对源码：`Lifecycle.showForm` → `createFormWindow` 是**按需创建**的。）
* ⚠️ **比「扩大覆盖」更要紧的另一个缺口**：即便在它**已经量的那个窗口**上，
  它的主判据（A/B 差值）也可能从来没活过 —— 健康状态下应用 0 个常驻动画，
  差值必然是 0，所以「这条判据能不能红」在 CI 上从未被验证。
  **09-22 已加仪器自检处置，见 §10.22。**
* 该文件的 prettier 漂移：`format:check` 只覆盖 `src/**/*.{ts,tsx,json,css}`、`lint` 只覆盖 `src/`，
  **`scripts/` 不在任何门禁内**。`HEAD` 版本已有 **37 行**漂移（本次新增区域再添同类 15 行，
  沿用文件既有风格）。属「已文档化但未门禁」，与 `subscription-store.js` 同类。


### 10.20 ⚠️ 落地 master 后立刻撞上：`main-tests` 有一处**抖动**（`connection.path.test.ts` 超时）

把 `ab0d3fd`+`4876be5` 快进到 `master`（`ce0018d..4876be5`）后，
**`Run 58 of CI`（35725473675）= `failed`** —— 而**同一份脚本内容的
`fix/gate-packaging` `Run 56` 是绿的**。这正是 §10.18 那条教训第三次生效：
**默认分支必须单独复查。**

#### 失败的是什么（run 页 Annotations 区，无需日志权限）

```
main-tests   ✗  Process completed with exit code 1.
  tests/main/db/__tests__/connection.path.test.ts > database connection paths
    > resolves database files from USER_DATA_DIR at initialization time
  Error: Test timed out in 5000ms.
   ❯ tests/main/db/__tests__/connection.path.test.ts:17:3
```

**与本次 idle-gpu 改动无关**：同一笔 run 里 idle-gpu 的三条新注解**逐字正常出现**
（`基线动画 0/0` / `可量页面 1 个` / `结构性为空`），说明新脚本在 master 上跑通了。

#### 判定「这是抖动，不是确定性失败」的依据

| run | 树内容 | `main-tests` |
|---|---|---|
| `Run 53`（35722147564，master） | `fe25623` | ✅ 通过（整笔 `completed successfully`） |
| `Run 54`（35722394558，master） | `ce0018d` | ✅ 通过 |
| `Run 56`（35723759041，分支） | `ab0d3fd`（**含新脚本**） | ✅ 通过 |
| `Run 58`（35725473675，master） | `4876be5`（**含新脚本**） | ❌ 超时 |
| `Run 60`（35727277728，master） | `54bfd36`（与 `4876be5` **只差 43 行 markdown**） | ✅ 通过 |

`4876be5` 与 `ab0d3fd` 的差异**只有 43 行 markdown**（`docs/` 内），
`connection.path.test.ts` 五次完全相同 ⇒ **同一份代码，结果不同 = 非确定性**。

⭐ **`Run 60` 是刻意取证**：`54bfd36` 是一次 docs-only 推送，除了「再跑一轮」没有别的目的。
结果 **#58 红、#60 绿**（两份树只差 43 行 markdown）⇒ 抖动**被实测坐实**，
不是「一次性的环境异常」这种不可证的说法。目前 master 上 4 笔里 1 红。

#### 已排除的机制（都不是原因）

| 假设 | 证据 | 结论 |
|---|---|---|
| 5 个 job 抢同一台机器 | `main-tests`/`renderer-tests`/`preload-tests`/`mio-cli-tests`/`packaging` 都是 `needs: quality` 的**兄弟**，但 GitHub 托管 runner **每个 job 一台独立 VM** | ❌ 不成立 |
| job 内部测试文件并行争用 | `vitest.config.ts:75` `fileParallelism: false` | ❌ 不成立 |
| 覆盖率棘轮把它判红 | 报的是 `Test timed out`，不是 coverage threshold | ❌ 不成立 |

#### 成本实测：**迁移不是大头，冷模块加载才是**（原假设被推翻）

第一版猜测是「48 次 DB migration 太慢」。用一个**临时探针测试**直接量了各阶段
（`tests/main/db/__tests__/zz-scratch-timing.test.ts`，跑完即删，未提交）：

```
[probe] import=988ms  initDatabase=88ms  close=14ms
[probe] second initDatabase (fresh dir, warm module)=83ms
[probe] third initDatabase (same dir, migrations already applied)=10ms
```

| 阶段 | 耗时 | 占整条测试的比例 |
|---|---|---|
| `await import('@akemi-mio/core/db/connection')`（**冷**） | **988ms** | **~81%** |
| `initDatabase()`（含 **48 次 migration**） | 88ms | ~7% |
| `closeDatabase()` | 14ms | ~1% |

⇒ **48 次迁移只要 88ms** —— 「降低迁移成本」这个方向**基本不会有用**
（把迁移砍到 0 也只能省 88ms）。真正的成本是**冷启动时加载那个模块图**
（better-sqlite3 原生模块 + drizzle + 迁移模块）。

这也解释了为什么它特别容易在 CI 上超时：冷 FS + 覆盖率插桩 + Windows Defender
扫新文件，都会放大**模块加载**这一项，而它与该测试要断言的东西（路径解析）无关。

而 `vitest.config.ts` **没有显式 `testTimeout`** → 用的是默认 5000ms。
本机整条测试 1374ms（无覆盖率）/ 1097ms（`--coverage`，CI 就是这条），
对 5000ms 是 3.6–4.6× 余量 —— 而 CI 上被吃掉了。

⇒ **这个超时是在一台不忙的机器上「继承」来的，从未针对 Windows runner 标定过。**
（与 §四那条「阈值是在开发机上量的」是同一类问题：**阈值没在它真正运行的机器上标定**。）

⚠️ 该测试**不能**把动态 import 挪到测试体外：它的全部意义就在于
「先删掉 `USER_DATA_DIR` 再 import（证明 import 时不解析路径）→ 再设上它并
`initDatabase()`（证明 init 时才解析）」。
冷 import 是这个断言的**机制本身**，不是可以优化掉的浪费。

#### 为什么这件事严重：**抖动的门禁 = 会被学会忽略的门禁**

这道门禁刚刚（§10.15–10.18）才从「50 次全废」修成「真的能红」。
如果它现在以约 1/4 的概率因为**与代码质量无关**的原因变红，
团队学到的是「`main-tests` 红可以重跑」—— 那正是 §四 FM 里
**「常响的警告 = 永久盲区」**的翻版：红不再携带信息。

⚠️ 但**不要因此把它判成「门禁没用」**（§10.17 那条教训的同一形状）：
断言本身是对的，问题只在**超时这个与断言无关的参数**。

#### 处置选项（**未动**，等拍板）

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| ✅ **A′. `beforeAll` 预热（09-22 拍板并实施）** | 在测试体之外付掉进程级冷启动；该测试超时**保持 5s** | 严格优于 A：消除假红且**不降低灵敏度**；⚠️hook 需显式给超时；⚠️**必须** `resetModules()`，否则 `doMock` 静默失效 → 假通过（已实测，见下） |
| **A. 只给这一个测试放宽超时** | `it('…', { timeout: 30_000 }, …)`（或在 `vitest.config.ts` 设 `testTimeout`） | 最小；实测支持它：超时预算被**模块加载**吃掉，而该测试断言的是**路径**不是**速度**；⚠️仍会**掩盖** DB 初始化真的变慢的回归（虽然它本来也不是性能门禁） |
| ~~**B. 降低测试成本**~~ | ~~查这 48 次 migration 是否必需~~ | ❌ **已被实测否决**：迁移只占 88ms（7%），砍掉也救不了；成本在冷 import（957ms），而那个 import 是该断言的**机制本身** |
| **C. 只记录不改** | 保留现状 + 本节记录，遇到红就重跑 | ⚠️ 实测 40% 的红率下，「重跑」等于承认这道门禁**在默认分支上不携带信息** |
| ✅ **D. 先取证再决定** | ~~重跑该 run / 再推一笔看是否复现~~ | **已完成**：`54bfd36` 的 docs-only 推送 → `Run 60` 绿（#58 红）；`13b3b89` → `Run 61` 又红 ⇒ 2/5 |

**09-22 查证结论**：拍板选了「先查清成本再定」，成本已查清（见上）——
**B 被实测否决**，A 的依据从「看起来合理」变成了「有数字支撑」。
剩余决策仍留给用户：**A / C**（D 已顺带完成）。本节在处置前保持「未动」状态。

#### ⭐ 查证途中发现了一个**严格优于 A** 的做法（`Run 61` 又一次红之后）

`Run 61`（35729356608）**再次红在同一个测试、同一行**（`connection.path.test.ts:17`，
`Test timed out in 5000ms`）。于是 master 上的实测变成：

| run | `main-tests` |
|---|---|
| #53 / #54 / #60 | ✅ |
| #58 / #61 | ❌ |

⇒ **5 笔里 2 红 ≈ 40%** —— 比先前估的 1/4 严重得多。
这个量级下「门禁红」已经**不再携带任何关于代码的信息**，A 或 C 之外的选项需要重新考虑。

再测一次「冷 import 能否靠预热消除」（同样用临时探针，跑完即删）：

```
[probe] first import (cold)      = 957ms
[probe] after resetModules (2nd) =   8ms
[probe] after resetModules (3rd) =   7ms
```

⇒ **冷启动成本是「进程级一次性」的**（原生模块 + 首次 transform），
`vi.resetModules()` **之后不再重付**。

**这意味着存在一个不用放宽任何阈值的修法：**

```ts
beforeAll(async () => {
  // 只为付掉进程级冷启动（原生模块/首次 transform）。
  // import 本身没有副作用 —— initDatabase() 才开库。
  await import('@akemi-mio/core/db/connection')
}, 60_000)
```

把 957ms 挪到**测试体之外**，测试自己那次 `await import(...)` 就只剩 ~8ms，
于是**该测试的 5000ms 超时原封不动**（灵敏度零损失），假红消失。

| | A（放宽测试超时） | **A′（beforeAll 预热）** |
|---|---|---|
| 消除假红 | ✅ | ✅ |
| 该测试的超时预算 | 放宽到 30s | **不变（5s）** |
| 真实变慢还能被抓到吗 | ❌ 被掩盖 | ✅ **仍然能** |
| 代价 | 调测试参数 | 多一个 hook；⚠️ **hook 自身的超时也要显式给**（默认同样 5000ms），否则冷启动会把 hook 判红 |

⚠️ A′ 有一个**必须验证**的前提：预热 import 之后，测试里那次带 `vi.doMock` 的
import 是否**真的重新求值**（而不是复用被缓存的模块）。若没重新求值，
`doMock` 就失效了 → 测试会变成**假通过** —— 那正是本报告最反对的那类失败。
验证方式仍是**变异检验**：把断言改坏，确认它**仍然会红**。

#### ✅ 处置（09-22 拍板 A′）：实施与验证

按拍板选了 A′。实施时**那个前提确实是个真陷阱**，不是假想 —— 探针实测：

```
[probe] (a) 预热+resetModules  → 落到了 mock 给的路径? true
[probe] (b) 预热无 resetModules → 落到了 mock 给的路径? false
```

**为什么 (b) 会静默变成假通过**（这段是本节最该记住的部分）：

1. 预热 import 把 `@akemi-mio/core/db/connection` 放进了模块注册表，
   它内部的 `@akemi-mio/core/config` 引用指向**真实配置**；
2. 测试里 `vi.doMock('@akemi-mio/core/config', …)` 之后那次 `await import(connection)`
   **拿回的是缓存实例** → mock 被绕过；
3. 而 `getDatabaseDirectory()` 是
   `process.env.USER_DATA_DIR ? … : WORKSPACE.databases` ——
   `USER_DATA_DIR` **优先级更高**，测试在调用 `initDatabase()` 前已经把它设成了
   `dynamicRoot` ⇒ 前两条断言**照样通过**；
4. 第三条断言（`fixedRoot` 下不该有库）在没有 mock 时**也是真的**（没人往那儿写）。

⇒ **四条路径全部通过，测试绿，但 `vi.doMock` 已经死了。** 没有任何信号。

所以 `beforeAll` 里的 `vi.resetModules()` **是修法的一部分**，不是保险起见：

```ts
beforeAll(async () => {
  await import('@akemi-mio/core/db/connection')  // 付掉进程级冷启动
  vi.resetModules()                              // ← 必须：否则上面的 mock 静默失效
}, 60_000)                                       // hook 超时须显式给（默认也是 5000ms）
```

**验证结果**：

| 检查 | 结果 |
|---|---|
| 改后该测试 | ✅ 通过，**测试体 96ms**（改前 1374ms / 插桩下 1097ms）→ 对 5000ms 是 **52 倍**余量 |
| `tests/main/db` 全目录 | ✅ 9 文件 20 用例全过 |
| **变异检验**（`getDatabaseDirectory()` 改成忽略 `USER_DATA_DIR`） | ✅ 如期变红（`expected false to be true` = 断言 1） |
| mock 是否仍生效 | ✅ 探针 (a)：预热+reset 后落到 **mock 给的路径** |
| `prettier --check` | ✅ 通过（HEAD 与工作区都过，不是 CRLF 假红） |
| 恢复 | ✅ 用 `cp`（**没用 git**），md5 与备份一致、`grep -c MUTATION` = 0 |
| **CI 复跑**（`Run 65` / `a668cd0`，35731742312） | ✅ `completed successfully`；页面**不含** `Test timed out` / `connection.path.test.ts`；注解计数从「**2 errors**, 16 warnings, 3 notices」变成「16 warnings and 3 notices」= **0 error**；idle-gpu 三条注解仍在 |
| **CI 复跑**（`Run 66` / `a668cd0`，35731742852） | ✅ `completed successfully`（另一个 ref 的那一笔） |
| **CI 复跑**（`Run 67`/`68` / `4175641`、`Run 69`/`70` / `31f651a`） | ✅ 四笔全绿 |

#### ✅ 统计结果（09-22 补全 —— 这里修正了本节初稿的两个记账错误）

把 run 列表**拉全**之后才看清两件事：

1. **每笔提交会推两个 ref（`master` + `fix/gate-packaging`）→ 产生两个 run**，
   所以样本要按 **run** 算、按**提交**分组；
2. 初稿**漏看了 `Run 62` 与 `Run 64`** —— 当时只看了局部窗口。

完整窗口：

| 提交 | runs | 结果 |
|---|---|---|
| `4876be5`（文档） | #57 / #58 | ✅ / **❌** |
| `54bfd36`（文档） | #59 / #60 | ✅ / ✅ |
| `13b3b89`（weekly-audit） | #61 / #62 | **❌ / ❌** |
| `a793a5f`（文档） | #63 / #64 | ✅ / **❌** |
| **`a668cd0`（A′ 修法）** | #65 / #66 | ✅ / ✅ |
| `4175641`（文档） | #67 / #68 | ✅ / ✅ |
| `31f651a`（文档） | #69 / #70 | ✅ / ✅ |

⇒ **A′ 之前 8 个 run 里 4 个红（50%）；A′ 之后 10 个 run 全绿（#65–#74）。**
在 50% 红率下连续 10 绿的概率是 `0.5^10 ≈ 0.1%` —— 「红率没变」在 α=0.05 上可以被拒绝。

归因也是干净的：四个红的 run **都只有一个 job 失败，即 `main-tests`**
（`quality` / `renderer-tests` / `preload-tests` / `mio-cli-tests` / `packaging` 全绿），
注解逐字都是 `connection.path.test.ts:17:3 — Test timed out in 5000ms`
⇒ 「50%」这个分母没有被别的失败污染。

> ⚠️ 但**不要把 10/10 读成「已证明修好」**：0/10 的 95% 单侧上界仍有 **≈26%**
> （解 `(1-p)^10 = 0.05`），也就是「红率降低但没有归零」这个假设**还没有被严格排除**
> （虽然「仍是 50%」已经被 0.1% 的 p 值否掉了）。
> 真正强得多的是**机制层证据**：测试体 1374ms → **96ms**，对 5000ms 的余量从
> 3.6× 变成 **52×**，而吃掉预算的那个机制（进程级冷 import）已经不在这段窗口里了。
> 结论按「机制已消除 + 统计一致但样本仍偏小」记录，后续运行自然累积。

> ⭐ 这一段的记账教训值得单独记：**「绿了几笔」这个说法必须先把 run 与提交对齐。**
> ①同一笔提交推多个 ref 会产生多个 run —— 按 run 数算「样本」时它们是有效的抖动
> 试验（同树不同果正是抖动的判据），但按「改了几次」算就会被重复计数；
> ②只看「最近 N 个 run」的局部窗口会漏掉更早的红，把红率算低。
> 判抖动率要**把窗口拉全 + 按提交分组**，两个维度都要看。


> ⭐ 这一段的元教训：**「把成本挪出超时窗口」和「不让 mock 静默失效」是两个必须
> 同时满足的约束**。只做前者会让测试变绿，而绿的原因是**它不再检查任何东西** ——
> 这正好是 FM-2b（断言变成恒真）的另一种制造方式，且比原来那个抖动**更危险**：
> 抖动至少会红，假通过永远绿。


### 10.21 ✅ 还掉 `weekly-audit` 的 label 债，并补上**缺失的 `permissions`**（09-22 拍板）

按 09-22 拍板（「改代码去掉 label 依赖」）改了 `.github/workflows/weekly-audit.yml`。
**不是**去建两个 label，而是让 workflow **不再依赖**仓库里预先存在它们。

#### 改了什么

**1）`Create Issue` 改为自愈式建 label**

```js
const wanted = ['audit', 'automated'];
const labels = [];
for (const name of wanted) {
  try {
    await github.rest.issues.getLabel({ ...context.repo, name });   // 存在就直接用
    labels.push(name);
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      await github.rest.issues.createLabel({ ...context.repo, name, color: 'ededed' });
      labels.push(name);                                            // 404 → 建出来
    } catch (e2) {
      core.warning(`创建 label "${name}" 失败（${e2.status}）：本次省略该 label`);
    }                                                               // 建不了 → 只 warning
  }
}
await github.rest.issues.create({ …, labels });
```

关键设计：**建 label 失败也不能让 job 红**（只 `core.warning`）。
审计 job 的成败应当由**审计结果**决定，而不是由「报告能不能贴标签」决定。

**2）补上 `permissions:`（这是同一次查证里发现的**第二个**红点）**

原文件**没有 `permissions:` 块** → token 权限取决于仓库设置，
**新建仓库默认只读** → `issues.create` 会直接 **403**，
和 label 存不存在毫无关系。现在显式声明：

```yaml
permissions:
  contents: read    # checkout
  issues: write     # 建 issue / label
```

> ⚠️ 这条比 label 那条更隐蔽：label 缺失至少会报 `422 Validation Failed`，
> 而权限不足报 403，两者都指向「创建 issue」这一步，**不看日志分不出**（而日志要管理员权限）。

#### 验证（两级，都不靠「看起来对」）

**① 静态**：`js-yaml.load` 能解析 + 内嵌 JS 过 `node --check`

```
YAML OK  name= "Weekly Codebase Audit"   triggers= schedule+workflow_dispatch
permissions= {"contents":"read","issues":"write"}   内嵌 JS 语法 OK
```

**② 行为（桩件 + 变异检验）**：把脚本从 YAML 里抽出来，用假的
`github` / `context` / `core` 跑四个分支：

| 分支 | 期望 | 结果 |
|---|---|---|
| 两个 label 都已存在 | 不建、直接用 | ✅ `["audit","automated"]`，未调用 `createLabel` |
| 都不存在 | 先建再用 | ✅ `createLabel` 调用两次 |
| 都不存在且建不了 | 省略 label，**issue 仍创建** | ✅ `labels: []` + 2 条 warning |
| 只存在 `audit` | 补建 `automated` | ✅ `createLabel` 只调用一次 |

**变异检验**：把 `wanted` 从 `['audit','automated']` 改成 `['audit']` → **6 项断言翻红** ⇒
桩件是承重的（不是「怎么改都绿」）。恢复用 `cp`（**没用 git**），md5 与备份一致。

#### 仍未动（属「要不要这道门禁」的范畴）

`weekly-audit` 的另外三处语义债：**4 处 `continue-on-error: true`**、
`npm install -D ts-prune` 污染 `package.json`、`node-version: 20` 与 CI 的 22 不一致。
这些改的是**门禁的语义**，不是「让它别因为无关原因红」，所以按惯例先给选项。


### 10.22 ★★★ idle-gpu 的 A/B 判据在健康状态下**永远没有信号** —— 给它加一个仪器自检（`25c84b8`）

这一节回答的是 §10.19 留下的、比「覆盖不够」更麻烦的一个问题。

#### 问题的形状

这道门禁的两条判据（绝对 GPU 预算 20%、A/B 差值预算 15）**都建立在同一个前提上**：

> CSS 动画会体现在 **GPU 进程的 CPU 时间**上。

而这个前提在 CI 上**从来没有被验证过**：

* 健康状态下应用**一个常驻动画都没有** —— 那条 `atelier-control-glint`（5.5s infinite）
  已经在 `80c530e` 里移除了，`components.css:6577` 只留下一句墓碑注释；
  其余 `infinite` 动画全挂在**状态性元素**上（录音 `rec-pulse`、状态点 `pulse-dot`、
  `pet-*`、`chat-*`），空闲主壳上 `document.getAnimations()` 就是 **0**。
* 于是「基线 vs 关动画」的差值**必然是 0**，`Run 56` 的注解正是
  `基线动画 0/0` + `A/B 差值 0.0`。
* ⇒ **「A/B 到底能不能红」在 runner 上永远是未测状态。**
  如果哪天 GPU 计数在这台机器上失灵（纯软件渲染、压根没有 GPU 类型进程…），
  两条判据**都**永远不会触发，这道门禁就成了**永久绿** —— 而它本该抓的那类回归
  正好从它眼皮下溜过去。这就是 FM-3/FM-1，只是伪装成了「健康」。

⭐ 值得注意：**这个形状在本仓已经有现成解法**。隔壁 `scripts/check-renderer-entries.cjs`
早就在做仪器自检 —— 它往页面里发一个必然产生 `console.error` + `throw` 的探针，
然后断言「探针抓不到 ⇒ 仪器失灵 ⇒ 此时的『0 错误』不可信，必须记为失败」。
既然同一个 job 里的另一道门禁已经有这个模式，这道也该有。

#### 第一步：先证明「A/B 能红」，不要假设

用受控夹具（headless Edge + 一个全视口、每帧重绘 + `filter` 的动画页）跑门禁：

```
[基线]   GPU 51.9%  总 CPU 67.5%  动画 2/2：spin <DIV> . | hue <DIV> .
[关动画] GPU  0.1%  总 CPU 13.4%  动画 0/0
[恢复]   GPU 48.5%  总 CPU 62.3%  动画 2/2：spin <DIV> . | hue <DIV> .
A/B 差值 51.8 个点（预算 15）→ EXIT=1
  - 空闲 GPU 51.9% 超预算 20%
  - A/B 差值 51.8 个点超预算 15 —— 很可能有常驻无限动画在烧 GPU
    当前默认就在跑的动画：spin <DIV> . / hue <DIV> .
```

⇒ A/B 这条路径**不是恒真的空断言**，`KILL_ANIM` / `RESTORE_ANIM` 也都真的生效
（`[恢复]` 那一段动画回来了、GPU 也回来了）。

⚠️ **但第一次尝试是失败的**：最初的夹具只在 8px 的小 div 上挂了一条 opacity 闪烁，
差值量出来 ≈ 0 —— 于是「A/B 不会响」这个结论**看起来被证实了**，其实只是夹具太轻。
**夹具的力度不够时，「测不到」和「不存在」分不开。**

#### 改动：注入一条确定无疑的重负载动画

* 新增**自检阶段**：注入全视口 + 每帧重绘 + `filter` 的合成动画 → 采样 → 移除 →
  **核对清理结果**。挂在 `documentElement` 而不是 `body`：应用里 `body` 下可能有
  `transform` 祖先，那会让 `position:fixed` 退化成相对该祖先定位，注入物可能只有 0 面积。
* 新增**进程类型直方图**（`GPU 进程 N`）：把「真的空闲」和「没有 GPU 进程可量」分开。
  没有 `GPU` 这一项时，两条判据都永远不会触发 —— 这是最直接的解释。
* 三条异常注解各自独立：**注入没生效** / **链路不响应** / **清理不干净**。
* **v1 只报数，不判红**（阈值还没有标定数据 —— 见下面的波动实测）。
  CI 参数下（`--warmup=30 --samples=2 --interval=6`）这一段多花约 **16 秒**。

#### 验证：零动画页 = CI 的对应情形

关键的一次测量是在**零动画页**上做的 —— 那正是 CI 里主窗口的样子：

| 检查 | 零动画页（= CI 情形） | 重负载页 |
|---|---|---|
| 基线 | GPU 0.1%，动画 0/0 | GPU 51.0%，动画 2/2 |
| 关动画 | GPU 0.1%，动画 0/0 | GPU 0.0%，动画 0/0 |
| **自检**（注入后） | **GPU 41.4%**，动画 **2/2**（注入的两条） | GPU 52.0%，动画 **4/4**（2 真实 + 2 注入） |
| 自检差值 | **41.3 个点** | 52.0 个点 |
| 清理残留 | ✅ `0|el0|style0`（= 期望值） | ✅ `0|el0|style0` |
| 退出码 | 0（通过） | 1（A/B 超预算，**符合预期**） |

⇒ **基线两条判据都无事可做时，自检照样把 GPU 顶到 41%** —— 这条链在「被测页面
一个动画都没有」的情形下依然是通的。这正是此前缺失的那块证据。

重负载页还顺带证明了两件事：注入物没有污染判据（失败信息只点名 `spin`/`hue`
两条真实动画），以及自检读数与真实动画叠加时行为正常（`动画 4/4`）。

#### 变异检验：抓到了我自己代码的一个盲点

**变异 A —— 故意不删注入的元素。第一次没被抓住。**

```
自检 差值 47.5 个点   清理后残留 0 条      ← 期望是「元素还在」
```

原因：`SELFCHECK_OFF` 当时只数**动画条数**，而它同时删掉了 keyframes 那段 `<style>`
→ 动画名解析不到 → `getAnimations()` 归零 → **「元素还挂在页面上」被报成「清理干净」**。

修法：同时查三样 —— 动画条数、元素、style —— 期望值变成 `0|el0|style0`。
重放同一个变异：`0|el1|style0` ≠ 期望值 → 「清理不干净」注解如期出现 ✅

> ⭐ 这是本轮**最能说明变异检验价值**的一处：这个检查**看起来**是对的，
> 它的输出**看起来**也是对的（`残留 0`），只有把代码改坏才发现它根本没在检查
> 我声称它检查的东西。**「一个通过的检查」和「一个能失败的检查」是两回事。**

**变异 B —— 把 `scDelta <= 1` 翻成 `>= 0`** → 「空绿」注解如期出现 ✅
说明那条分支是活的（不是一段永不执行的死代码）。

两次变异都用 `cp` 恢复（**没用 git**），md5 与备份一致、`grep -c MUTATION` = 0。

#### ✅ CI 上的答案（`Run 71`/`72` / `25c84b8`，`Run 73`/`74` / `92dd8a7`）

四笔 run 的注解逐字（`completed successfully`，两个 ref 各一笔）：

```
[idle-gpu] 仪器自检：注入全视口合成动画后 GPU 147.3%（对照「关动画」0.0%，差值 147.3 个点）
            / 自检动画 2/2 / 清理后残留 0|el0|style0（期望 0|el0|style0）
            / 进程类型 browserx1 rendererx1 GPUx1 network.mojom.NetworkServicex1
[idle-gpu] 页面 Akemi Mio index.html / 基线 GPU 0.0%（预算 20%）/ 关动画 0.0%
            / A-B 差值 0.0 个点（预算 15）/ 基线总 CPU 3.3% / GPU 进程 1 / 基线动画 0/0
```

| run | 自检 GPU | 自检差值 | 自检动画 | 清理残留 | GPU 进程 | 空绿注解 |
|---|---|---|---|---|---|---|
| #71（35736660158） | 147.3% | **147.3** | 2/2 | ✅ `0|el0|style0` | **1** | 未出现 ✅ |
| #72（35736660877） | 147.2% | **147.2** | 2/2 | ✅ `0|el0|style0` | **1** | 未出现 ✅ |
| #73（35736912491） | 146.9% | **146.9** | 2/2 | ✅ `0|el0|style0` | **1** | 未出现 ✅ |
| #74（35736912579） | 147.6% | **147.6** | 2/2 | ✅ `0|el0|style0` | **1** | 未出现 ✅ |

⇒ 三个此前未知的问题**全部有了答案**：

1. **runner 上确实有 GPU 类型的进程**（`GPU 进程 1`）⇒ 「没有 GPU 进程可量」这个假设**被推翻**；
2. **注入的动画把 GPU 顶到 147%**（对照「关动画」0.0%）⇒ **「动画 → GPU 进程 CPU」这条链在 CI 上是通的**；
   因此 A/B 判据**能红** —— 一个真实回归会让差值从 0 变成三位数，而预算是 15；
3. **`自检动画 2/2`** ⇒ 注入确实生效，不是「注入失败导致差值 0」；
   **`清理后残留 0|el0|style0`** ⇒ 清理也没问题（CI 上同样验证了）。

同时「空绿」注解正确地**没有**出现（差值 147 ≫ 1），而「结构性为空」注解照旧出现
（基线确实 0 个动画）—— 三条互斥的分支在 CI 上各自落在了正确的位置。

#### 标定数据已经有了，而且比本机稳定得多

| 环境 | 几次测量 | 波动 |
|---|---|---|
| 本机（headless Edge 夹具） | 43.3 / 19.9 | **约 2 倍** |
| **CI runner** | 147.3 / 147.2 / 146.9 / 147.6 | **极差 0.7 个点（≈0.5%）** |

本机那 2 倍波动**没有在 CI 上重现** —— 差异的来源很清楚：本机同时有用户那个跑了
三天的 dev 实例、我自己的浏览器在抢资源，而 GitHub 的 runner 是**独占**的。

⭐ 这恰好说明「先只报数」这一步是**必要的、不是谨慎过度**：如果我按本机的 43.3/19.9
去定阈值（比如「必须 ≥ 20」），那在 CI 上固然不会红，但那个阈值是**凭本机噪声定**的
—— 而按 CI 的真实分布，安全区间其实宽得多。

⇒ **升级成判红的条件已经具备**：CI 上稳定在 ≈147，「仪器失灵」会是 0，
两者之间差了三个数量级。一个只用来抓「仪器死了」的下限（比如 `--selfcheck-min=5`）
有约 29 倍余量，几乎不可能误红 —— 而它换来的正是本节开头担心的那件事：
**判据死掉时不再静默变绿。**

⚠️ 但这一步要不要做、阈值定多少，属「改门禁语义」，按惯例**先给选项**（见 §10.16）。
若 CI 上自检差值本身就是 0（即仪器真的不响应），正确结论**不是**加一条判据，
而是承认这两条判据在 runner 上不可用，改去用 `document.getAnimations()` 的存在性
+ 总 CPU 做替代判据 —— 这次的实测数据说明**不需要**走这条路。

#### 与「扩大覆盖」的区别

§10.19 的「仍未做」里有一条是**扩大覆盖**（也量 `wallpaper`/`pet`/`chat`）。
本节是**另一个**缺口：即便在它已经量的那个窗口上，它的主判据也可能从来没活过。

顺带把扩大覆盖的路径也查清了：**「在 CI 里创建形态窗口」的配方本仓已有且已在 CI 里通过**
—— `scripts/check-renderer-entries.cjs` 就是从主窗口 `index.html` 上调
`window.akemiForms.toggleForm(kind)`，再去找 `pet.html` / `chat.html` / `wallpaper.html`
目标（`Lifecycle.showForm` → `createFormWindow` 是**按需创建**的，
preload 里的 `akemiForms` 也是**无条件**暴露的）。所以扩大覆盖不需要新机制，
只需要把同样的调用接进 idle-gpu，并**在拉不起来时明确报「未覆盖」**而不是静默通过。

#### 仍未做

* ⬜ **把自检从「报数」升级成「判红」** —— 等 CI 上收几轮数据后再定阈值（见上）。
* ⬜ **扩大覆盖**：让门禁也量形态窗口（`setFormVisible` / `toggleForm` 路径已探明）。

