# akemi-mio 门禁承重性评估（2026-09-20）

> 方法：`rnd-quality-assessment` skill 的四种失效模式 + `falsification-testing` 的变异检验。
> 原则：**没做过变异的门禁标 ⚠️ unverified，绝不标 ✅。** 所有读数可被复核（命令附在表内）。

**本轮结论摘要**（*为事后更新，见各节内「已更新」标记*）：

- 发现并**已修复** 1 个库级缺陷（`withTimeout` 定时器泄漏 → 全量测试 `exit 1`），
  主进程测试 **2988 passed + 2 errors → 2994 passed + 0 errors**。
- 发现并**已修复** 2 个「测不到所声称逻辑」的用例（含 1 个 mock 方法名错配）。
- 发现 **1 个实际失效的门禁**：`lint`（130 条常响警告 + 退出码恒 0）—— ✅ **已修**（`28358e4`）。
- 发现 **2 道真实红**：`format:check`（20 文件）—— ✅ **已修**（`c4c3d2b`）；
  `audit` —— ⚠️ **性质已变**：被陈旧的 `package-lock.json` 挡住，`npm audit` 已无法复现原读数。
- **2 道门禁无法运行**（缺打包产物，前置条件）。
- ★ **新发现（本轮）**：`package-lock.json` 早于 monorepo 化 → **`npm ci` 无法工作**，
  CI 第一步即失败。**未修，需决策**（见 §5.2）。
- ★ **我自己有 1 处结论被本轮推翻**：`format:check` 的「不建议动」是错的（见 §5.1 修正）。

---

## 一、总览

工作区共 **19 道** 门禁（`package.json` 的 `check:*` / `typecheck*` / `lint` / `format:check` / `test*` / `audit`）。

| 结论 | 数量 |
|---|---|
| ✅ 承重（有防护 + 变异验证红） | 4 |
| ✅ 承重（有防护，未变异） | 6 |
| ✅ **本轮修复后恢复承重**（主进程测试 / `lint` / `format:check`） | 1 |
| ❌ ~~**实际失效**（退出码恒 0，CI 拦不住）~~ → ✅ **本轮已修**（`lint`） | ~~1~~ 0 |
| ⚠️ **无法运行**（缺打包产物，前置条件） | 2 |
| ⚠️ **无法运行**（lock 陈旧，`npm ci` 不可用） | 1 |
| ❌ **真实红**（本次读数失败） | 0 |
| ⬜ 未评估（需 GPU / 实机 / 长时） | 3 |

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
| 11 | `audit` | `npm audit --audit-level=high` | — | — | ⚠️ **无法运行 (400)** | ⚠️ unverified | lock 陈旧致 `npm ci` 亦不可用 —— **见 §五** |
| 12 | `check:renderer-entries` | `node scripts/check-renderer-entries.cjs` | — | — | ❌ **无法运行 (exit 1)** | ⚠️ unverified | 缺 `dist-electron/` |
| 13 | `check:idle-gpu` | `npm run check:idle-gpu` | — | — | ❌ **无法运行 (exit 2)** | ⚠️ unverified | 缺打包 exe |
| 14 | `typecheck` / `typecheck:node` / `typecheck:web` | `tsc -p … --noEmit` | 2 工程 | 0 | ✅ pass | ✅ 有防护 | 被 #5 覆盖读数 |
| 15 | `test:renderer` | `vitest --config vitest.config.renderer.ts` | 449 | 0 | ✅ pass | ✅ 有防护 | 本轮补跑（验证格式化无害） |
| 16 | `test:preload` | `vitest --config vitest.config.preload.ts` | 94 | 0 | ✅ pass | ✅ 有防护 | 本轮补跑 |
| 17 | `test:unit:fast` | `vitest --config vitest.config.unit-fast.ts` | — | — | ⬜ 未跑 | ⚠️ unverified | 本轮未执行 |
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

### 5.2 `audit` — 被陈旧的 `package-lock.json` 挡住 ⚠️ **未修复，性质已变**

> **本节已更新。** 初版报的是「32 漏洞」，重跑后**这个数字已无法复现**：
> `npm audit` 现在直接报 `400 Bad Request`。

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

**(2) ★ 更严重：`package-lock.json` 早于 monorepo 化，`npm ci` 无法工作**

```
lock 里 root 的 workspaces:  undefined        ← package.json 是 ["packages/*"]
lock 里 packages/ 条目数:     0               ← 实际有 60 个包
lock 里 @akemi-mio/ 条目:     0               ← 60+ 个包用 "workspace:*" 引用
lock 文件时间 / 最后提交:      2026-08-22 / 244af61
```

后果：**任何 `npm install` 都会失败**：

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

而 CI 的第一步就是 `npm ci`（`ci.yml:18`）。**即 CI 从 monorepo 化那天起就跑不起来**，
`audit` 的失败只是最先暴露出来的症状。

⚠️ **这是既有状态，与本次改动无关**：`git show HEAD:package-lock.json` 解析后
`workspaces` 同样是 `undefined`、`packages/` 条目同样是 0。

**我没有擅自重建 lock**：这是 1053 条目的重写，风险与影响面都很大
（会重新解析 60 个包的依赖树，且本机与 CI 的 lock 必须一致）。
重建 lock 应当是**单独一件事、单独一次提交**，需要你先确认。
在那之前，`audit` 的结论**按「无法运行」记，而不是按「32 漏洞」记**。

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

## 七、口径提醒（给读这份报告的人）

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
