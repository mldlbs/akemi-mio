# akemi-mio 门禁承重性评估（2026-09-20）

> 方法：`rnd-quality-assessment` skill 的四种失效模式 + `falsification-testing` 的变异检验。
> 原则：**没做过变异的门禁标 ⚠️ unverified，绝不标 ✅。** 所有读数可被复核（命令附在表内）。

**本轮结论摘要**：

- 发现并**已修复** 1 个库级缺陷（`withTimeout` 定时器泄漏 → 全量测试 `exit 1`），
  主进程测试 **2988 passed + 2 errors → 2994 passed + 0 errors**。
- 发现并**已修复** 2 个「测不到所声称逻辑」的用例（含 1 个 mock 方法名错配）。
- 发现 **1 个实际失效的门禁**：`lint`（130 条常响警告 + 退出码恒 0）——**未修，待决策**。
- 发现 **2 道真实红**：`format:check`（20 文件）、`audit`（2 critical + 16 high）。
- **2 道门禁无法运行**（缺打包产物，前置条件）。

---

## 一、总览

工作区共 **18 道** 门禁（`package.json` 的 `check:*` / `typecheck*` / `lint` / `format:check` / `test*` / `audit`）。

| 结论 | 数量 |
|---|---|
| ✅ 承重（有防护 + 变异验证红） | 4 |
| ✅ 承重（有防护，未变异） | 3 |
| ✅ **本轮修复后恢复承重**（主进程测试） | 1 |
| ❌ **实际失效**（退出码恒 0，CI 拦不住） | 1 |
| ⚠️ **无法运行**（缺打包产物，前置条件） | 2 |
| ❌ **真实红**（本次读数失败） | 2 |
| ⬜ 未评估（需 GPU / 实机 / 长时） | 5 |

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
| 8 | **`lint`** | `npx eslint src/ --ext .ts,.tsx` | — | — | ⚠️ **0 errors / 130 warnings, exit 0** | ❌ **实际失效** | **见 §四（本轮最重要发现）** |
| 9 | `async-timeout`（新） | `vitest run tests/main/core/utils/__tests__/async-timeout.test.ts` | 6 | 0 | ✅ pass | ✅ **已双向变异** | 修复前 `withTimeout` 零测试 |
| 10 | `format:check` | `npx prettier --check "src/**/*.{ts,tsx,json,css}"` | 20 文件 | 0 | ❌ **fail (exit 1)** | ✅ 承重（真红） | CI 会拦（ci.yml:27）—— **见 §五** |
| 11 | `audit` | `npm audit --audit-level=high` | 32 漏洞 | 0 | ❌ **fail (exit 1)** | ✅ 承重（真红） | **2 critical + 16 high** —— 见 §五 |
| 12 | `check:renderer-entries` | `node scripts/check-renderer-entries.cjs` | — | — | ❌ **无法运行 (exit 1)** | ⚠️ unverified | 缺 `dist-electron/` |
| 13 | `check:idle-gpu` | `npm run check:idle-gpu` | — | — | ❌ **无法运行 (exit 2)** | ⚠️ unverified | 缺打包 exe |
| 14 | `typecheck` / `typecheck:node` / `typecheck:web` | `tsc -p … --noEmit` | 2 工程 | 0 | ✅ pass | ✅ 有防护 | 被 #5 覆盖读数 |
| 15 | `test:renderer` | `vitest --config vitest.config.renderer.ts` | — | — | ⬜ 未跑 | ⚠️ unverified | 本轮未执行 |
| 16 | `test:preload` | `vitest --config vitest.config.preload.ts` | — | — | ⬜ 未跑 | ⚠️ unverified | 本轮未执行 |
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

### 修法（**未实施，需你决策**）

三选一，代价差别很大：

| 方案 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A. 加阈值护栏** | CI 改 `eslint … --max-warnings 130` | 极小 | 低。**只能防新增**，存量 130 条保留。数字需随清理下调 |
| **B. 分级** | `no-unused-vars` 改 `error`；其余留 `warn` | 小 | 中。需先清掉那 70 条，否则 CI 立刻红 |
| **C. 清理存量** | 清零 70 条 `no-unused-vars` 后转 `error` | **大** | **高**。散在 45 个文件，含多形态渲染层 |

**A 的注意点**：`--max-warnings 130` 是「计数阈值」而非「规则阈值」，不清存量也能立刻获得阻止力——
但它有一个已知陷阱：任何人**修好**一条未使用变量，计数降到 129，阈值就**失效了**（变宽松）。
所以 A 必须配合「数字只降不升」的约定，或改用 `--max-warnings 0` + 存量 `eslint-disable` 收口。

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

### 5.1 `format:check` — 20 个文件未格式化

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

⚠️ **不建议无脑 `prettier --write`**：其中 `forms/pet`、`forms/chat`、`forms/wallpaper`、`styles/components.css`
正是本仓有「样式层叠冲突」历史（`components.css` vs `layout.css` 同名类）和形态窗口问题的区域。

### 5.2 `audit` — 32 个漏洞（2 critical / 16 high / 14 moderate）

```
32 vulnerabilities (14 moderate, 16 high, 2 critical)
```

已识别的一条明确来源：

```
sharp inherited vulnerabilities in libvips:
CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
GHSA-f88m-g3jw-g9cj
```

这是**实质安全问题**（非噪音），且 `weekly-audit.yml` 的存在说明团队预期它会周期性地失败。

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
2. **本报告的所有数字都附了命令**，可复核。基准提交：`6dfec76`（本轮含 2 个修复提交）。
3. **未做的事**：`test:renderer` / `test:preload` / `test:unit:fast` / `test:stress` / build 未跑；
   它们的承重性未验证。
4. **一个反复出现的教训**：本报告撰写过程中，我自己有 **3 次**因工具使用不当产生错判——
   `cmd | head` 吃掉真实退出码（把 exit=2 误读成 0）、`grep "[warn]"` 把方括号当字符类、
   断言写错导致假红。**每条结论都值得复核**，包括我的。
