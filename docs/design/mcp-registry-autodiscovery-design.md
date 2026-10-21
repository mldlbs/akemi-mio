# MCP Registry + Auto-Discovery + Host Onboarding Template（设计草案）

> TaskHub: `a6dcd804` · 阶段：brainstorming → 设计草案（**未实现**，待评审）
> 关联：TaskHub `9ac4a8f8`（"安装一次，所有 Agent 自动接入"演示，已 done，但 `mio install` 因改写宿主配置被设为可选步骤）

## 0. 目标与动机

`9ac4a8f8` 已演示 ADR-017 Phase 0 闭环，但 `mio install <host>` 这一步被 `RUN_INSTALL=1` 门槛挡住，因为它会**改写宿主配置**（codex/opencode/workbuddy/claude-code/hermes 各自的 settings 文件）。本设计把"安装一次、所有 Agent 自动接入"从"逐宿主手动 install"升级为：

1. **MCP Registry** —— Mio 暴露的 MCP server/工具清单的单一事实来源。
2. **Auto-discovery** —— 宿主无需逐个人工 `install` 即可发现自己接入 Mio。
3. **Host onboarding template** —— 用声明式模板替代手写适配逻辑，新增宿主=丢一个模板而非改核心代码。

## 1. 现状（as-built，已核实）

- `mio install <host>` → `adapters[host].install({ node, serverScript, home, workspace })`（`packages/mio-cli/bin/mio.js` `installCommand`，约 3515 行）。
- 适配器接口统一（`packages/mio-cli/adapters/codex.js`）：`configPath()` / `isInstalled()` / `install(...)` / `restartWarningMessage()`。
- 单体内核 `SERVER_SCRIPT` 暴露完整 `mio.*` 工具命名空间（按项目记忆为 49 个工具）。
- `packages/mio-cli/server/mechanism-registry.js` 是**已晋升机制**的内部注册表，与宿主 MCP 接线是**两个不同关注点**，本设计不改动它。

## 2. 设计

### 2.1 MCP Registry 清单

`~/.mio-intelligence/mcp-registry.json`，由 `mio mcp registry --write` 生成（**PR-A 已实现**），作为宿主读取的单一事实来源：

```json
{
  "version": 1,
  "servers": [
    {
      "id": "mio-control-plane",
      "command": "<node>",
      "args": ["<SERVER_SCRIPT>"],
      "env": { "MIO_DATA_DIR": "<home>" },
      "tools": ["mio.task.route", "mio.memory.record", "mio.evolution.report"],
      "capabilities": ["identity", "memory", "observation", "routing", "policy", "evolution"]
    }
  ]
}
```

### 2.2 Auto-discovery

两种互补机制（均为**增量、默认关闭**，验证后再开）：

- **清单轮询**：每个宿主适配器启动时检查 `~/.mio-intelligence/mcp-registry.json`，若缺失/变更则注入 server。把 `mio install` 降级为可选。
- **`mio install --auto`**：扫描 `adapters/` 中所有"已安装"的宿主，一次性全部接线；`mio install --check` 报告与清单的漂移（drift）。
- **Observer 钩子**：首次 `mio observe` 时若没有任何宿主被接线，仅打印一行 `run mio install --auto` 提示（非阻塞，不自动改写）。

### 2.3 Host onboarding template（数据驱动适配器）

把 `adapters/*.js` 里手写的配置写入逻辑替换为声明式模板 `packages/mio-cli/adapters/<host>.template.json`：

```json
{
  "configPath": "~/.codex/settings.json",
  "format": "json",
  "mcpKey": "mcpServers",
  "serverShape": {
    "command": "{{node}}",
    "args": ["{{serverScript}}"],
    "env": { "MIO_DATA_DIR": "{{home}}" }
  }
}
```

适配器加载器读取模板并套用；仅有宿主特异的怪癖（TOML vs JSON、重启语义）保留在一个薄 shim 里。新增宿主 = 丢一个模板 + 极薄 shim，**不碰核心代码**。

## 3. 安全与兼容

- **绝不**在未经备份的情况下自动覆盖用户改过的宿主配置。改前先 `cp` 备份（遵循项目铁律：git stash/restore 对未提交改动等同删除）。
- `mio install <host>` 保持为显式 opt-in；auto-discovery 是增量能力，验证前默认关闭。
- 清单向后兼容（append-friendly、带 `version`、宿主忽略未知字段）。

## 4. 验收标准

- `mio mcp registry --write` 产出合法清单，至少被 codex + opencode 适配器消费。
- `mio install --auto` 一次性接线所有已检测宿主；`--check` 报告与清单的漂移。
- 新增宿主只需一个 `.template.json` + 最小 shim（无需改核心）。
- 不回归现有 `mio install <host>` 行为（现有测试仍绿）。

## 5. 范围外 / 需协调

- 实现会触及 `adapters/`、`bin/mio.js`，可能触及 `index.js`（MCP 工具面）——**当前由并发会话持有**（`mechanism-registry.js` + `index.js` 的 hunk 尚未提交）。**实现必须排在该会话落地之后**，避免冲突。
- 不改动 49 工具的表面；Registry 只是记录/暴露它。
- 本轮仅交付设计草案，不写实现代码。

## 6. 建议拆分

- **PR-A** ✅ 已实现（commit 见 git log，`mcp-registry.js` + `bin/mio.js` 的 `mio mcp registry [--write] [--json]` + 测试）：Registry 清单生成器 + `mio mcp registry` 子命令，输出六平面 capability 的 stdio 启动清单（工具经运行时 `tools/list` 发现）。
- **PR-B** ✅ 已实现（`server/install-wiring.js` + `bin/mio.js` 的 `mio install --auto` / `--check` + 5 个适配器新增 `isHostPresent()` + `scripts/check-cli-docs.cjs` 补探测）：`--auto` 只接本机"已安装"的宿主（纯文件存在性探测，不扫进程/不发网络），`--check` 只读报告漂移（registry-missing / host-present-not-wired / stale-server-path），有漂移退出码 1（text 与 --json 一致）。未落地项：Observer 提示钩子（§7.1.4）。
- **PR-C**：模板驱动适配器加载器 + 首批 2 个宿主模板（codex / opencode）。
  - **第一批 ✅ 已实现**：`adapters/loader.js`（`format: toml|json` 编译成现有适配器接口、`{{var}}` 插值、坏模板抛错而非静默回退）+ `adapters/codex.template.json`（codex 改为模板驱动）+ `bin/mio.js` 与 `server/host-capabilities.js` 统一经 loader 解析（`claude → claude-code.js` 的命名差异集中在 loader 的 `MODULE_ALIASES`）。`codex.js` 保留为**等价性 oracle**：`__tests__/adapter-loader.test.js` 用两个实现各装一次、断言写出的配置逐字节相同（变异 `startup_timeout_sec 30→31` 会红）。
  - **第二批：评估后决定不做**（不是"待做"）。原计划给 opencode 做 `opencode.template.json` + 薄 shim，读完代码后推翻：opencode 210 行里 instructions 块 + 读写/repair 逻辑约占 100 行，模板只能省下十来行 server 块；"薄 shim" 会扛走一半代码，等于把逻辑藏进配置文件——正是 `loader.js` 注释里明确反对的形态。**模板的收益只在"纯 server 块"宿主上成立（codex）**；需要注入规则块、注册 hooks、写多个文件的宿主（opencode / workbuddy / claude-code / hermes）保留手写模块，由 loader 回退。这条边界比"凑齐 2 个模板"更重要。

---

## 7. PR-B / PR-C 实现规格（落地就绪）

> 本节约等于「实现用的任务卡」。起草于 2026-10-20，因并发会话仍持有 `mio-intelligence-mcp/index.js` 与 `server/mechanism-registry.js` 的未提交改动（见 §5），实现须排在其落地之后。规格刻意将 install `--auto/--check` 限为 **CLI 子命令、不新增 MCP 工具**，从而完全不触碰 `index.js` 工具面与 `mechanism-registry.js`，绕开并发会话冲突。

### 7.0 落地前置条件（并发会话协调）

- 实现前先 `git status` 复核：`packages/mio-cli/server/mio-intelligence-mcp/index.js` 与 `packages/mio-cli/server/mechanism-registry.js` 必须已干净（已提交或属本会话）。本规格**不引入对这两个文件的任何改动**。
- 本 PR 可安全改动的、且已确认**未被**并发会话持有的文件：`packages/mio-cli/bin/mio.js`、`packages/mio-cli/adapters/*`、新增 `*.template.json` / 加载器 / 测试。
- 提交纪律：每次只 `git add` 本 PR 相关文件；**绝不 `git add -A`**；一项改动做完即提交（PR-B、PR-C 各一提交）。

### 7.1 PR-B：`mio install --auto` / `--check`

#### 7.1.1 适配器接口扩展（向后兼容）

现有四方法（`configPath` / `isInstalled` / `install` / `restartWarningMessage`）保持不变。新增一个探测方法：

- `isHostPresent()` → boolean：宿主应用是否装在本机（如 `fs.existsSync(configPath())` 或二进制在 PATH）。**注意与 `isInstalled()` 区分**：前者=宿主在不在，后者=Mio 是否已接线。
  - codex：`~/.codex/config.toml` 存在；opencode：`~/.config/opencode/settings.json` 或对应目录存在；workbuddy/hermes/claude 各自判定。
- 现有 `install(...)` 已幂等（已接线则 `changed:false`），`--auto` 直接遍历调用即可，无需重写。

#### 7.1.2 `mio install --auto`

- 入口：`installCommand`（`bin/mio.js:3516`）支持 `host === '--auto'`（或解析 `--auto` flag）。
- 行为：遍历 `Object.keys(adapters)`，对每个 `adapter.isHostPresent()` 为 true 的宿主调用 `adapter.install({ node: process.execPath, serverScript: SERVER_SCRIPT, home: MIO_HOME, workspace: process.cwd() })`；收集 `{ host, changed, configPath, message }`。
- 输出：
  - 文本：逐行 `✓ <host>: installed` / `• <host>: already wired` / `– <host>: not present (skipped)`；结尾汇总 `N wired, M skipped, K changed`。
  - `--json`：返回 `{ results: [...], summary: { present, wired, changed, skipped } }`。
- 退出码：0（即便有 skipped）；单个宿主安装失败记 `console.error` + 整体仍 0，除非加 `--strict`（可选，V1 可不实现）。错误处理沿用现有 installCommand 的 catch 范式（catch → `console.error` + `process.exitCode = 1`）。
- Observer：复用现有 `observer.runCycle` / `observer.startBackground`；auto 下仅首个 `changed` 宿主触发一次，避免重复。

#### 7.1.3 `mio install --check`

- 入口：`host === '--check'` 或 `--check` flag。
- 行为：对 `adapters` 各宿主，比对宿主当前配置与 PR-A 产物 `mcp-registry.json`（路径 `~/.mio-intelligence/mcp-registry.json` 或 `MIO_DATA_DIR`）。drift 类型：
  1. `host-present-not-wired`：`isHostPresent()` 真但 `isInstalled()` 假 → 提示 `mio install <host>`。
  2. `stale-server-path`：`isInstalled()` 真但 `configNeedsRepair(serverScript)`（配置里的 serverScript 与 PR-A 的 SERVER_SCRIPT 不一致）→ 提示 repair。
  3. `registry-missing`：`mcp-registry.json` 未生成 → 提示先 `mio mcp registry --write`。
  4. `config-not-matching-registry`：配置里的 command/args/env 与 registry 该 server 条目不符（深度 diff）。
- 输出：文本逐行 `DRIFT <host>: <type> — <hint>`；`--json` 返回 `{ drifts: [{host, type, hint}], clean: boolean }`。
- 退出码：**有 drift → 1**，无 → 0（供 CI / 定时巡检）。V1 不做自动修复（只读报告）。

#### 7.1.4 Observer 钩子（设计 §2.2 第三项，可并入 PR-B）

- 在 `mio observe --once`（或首次 observe）入口：若 `adapters` 中无任何 `isInstalled()` 为真，仅 `console.log` 一行 `Tip: run \`mio install --auto\` to wire detected hosts.`（非阻塞，不自动改写）。

### 7.2 PR-C：模板驱动适配器 + 首批宿主模板

#### 7.2.1 模板 schema（`adapters/<host>.template.json`）

```json
{
  "hostLabel": "Codex",
  "configPath": "~/.codex/config.toml",
  "format": "toml",
  "mcpKey": "mcp_servers.mio-intelligence",
  "sectionMarkers": {
    "open": "[mcp_servers.mio-intelligence]",
    "envOpen": "[mcp_servers.mio-intelligence.env]"
  },
  "serverShape": {
    "command": "{{node}}",
    "args": ["{{serverScript}}"],
    "extra": { "startup_timeout_sec": 30 },
    "env": { "MIO_DATA_DIR": "{{home}}", "MIO_CONTEXT": "{{context}}" }
  },
  "restart": { "exeName": "codex.exe", "exePathFragment": "OpenAI.Codex" }
}
```

- `format`：`toml` | `json` | `jsonc`。
- 变量 `{{node}}` / `{{serverScript}}` / `{{home}}` / `{{context}}` / `{{workspace}}` 由加载器在 `install` 时填充（与现有 `install` 入参一致）。
- `sectionMarkers`：TOML 专用（对应 codex.js 现有的 `SERVER_SECTION` / `ENV_SECTION` + `stripMioSection`）；JSON 用 `mcpKey` 定位对象。

#### 7.2.2 通用加载器 `adapters/loader.js`（NEW）

- `loadAdapter(host)`：
  - 若 `adapters/<host>.template.json` 存在 → 返回由模板驱动的适配器实例（实现 `configPath` / `isHostPresent` / `isInstalled` / `install` / `restartWarningMessage`，逻辑由模板参数化）。
  - 否则 → 回退 `require('./<host>.js')`（手写适配器，兼容 workbuddy / hermes / claude 等尚未模板化的宿主）。
- 模板驱动适配器行为（通用实现，取代 codex.js 当前的手写 TOML 拼接）：
  - `install`：读模板 → 按 `format` 解析宿主 config → 删除既有 `mcpKey` 段落（TOML 走 `sectionMarkers` strip；JSON 走对象删除）→ 注入 `serverShape`（填模板变量）→ **改前 `cp` 备份** `${target}.bak-mio-${Date.now()}` → 写回 → 返回 `{ changed, configPath, backup, message }`。复用 `host-utils.js` 的 `restartWarning`。
  - `isInstalled`：宿主 config 含 `mcpKey` 且 command 指向当前 `node` / `serverScript`。
  - `configNeedsRepair`：同 codex 现有逻辑，比对 `serverScript` 路径（大小写/反斜杠归一）。
- 安全性：严格沿用「改前备份」铁律，**绝不静默覆盖用户改动**。

#### 7.2.3 首批模板（PR-C 范围）

- `adapters/codex.template.json`（TOML，含 `sectionMarkers`）。
- `adapters/opencode.template.json`（JSON / settings，含 `mcpKey`）。
- 将 `codex.js` / `opencode.js` 改为经 `loader.js` 导出的模板驱动别名（V1 推荐：codex/opencode 走模板；workbuddy/hermes/claude 保留手写，经 loader 回退）。`bin/mio.js` 第 14–18 行的 `adapters` 注册改为经 `loader.loadAdapter(host)` 解析，**`adapters[host]` 对外接口完全不变** → 现有 status / install 逻辑零改动。

#### 7.2.4 兼容性

- 不改动 49 工具表面，不碰 `index.js` / `mechanism-registry.js`。
- 模板驱动的适配器与手写适配器在 `adapters[host]` 上行为一致，现有测试（status / install）应继续全绿。

### 7.3 测试（落地时新增）

- 位置：`packages/mio-cli/server/mio-intelligence-mcp/__tests__/` 或 `packages/mio-cli/__tests__/`（沿用现有约定，`require` 用 `../../` 相对深度，勿用 `../`）。
- `install-auto.test.js`：
  - 在临时 `os.tmpdir()` 下构造假宿主 config，stub `isHostPresent`（或真实存在性），断言 `--auto` 对 present 宿主调用 install 且汇总正确、skipped 正确。
  - 断言 `--check` 在「宿主 present 但未接线」时报告 `host-present-not-wired` drift 且退出码 1；接线后 `--check` 退出 0。
  - 断言本 PR 不修改 `index.js`（可用 `git diff --name-only` 断言或单纯不 import 该文件）。
- `adapter-loader.test.js`：
  - 临时目录放一个 `<host>.template.json`（TOML + JSON 各一），断言 loader 生成的适配器 install 后 config 含正确 `serverShape`、`isInstalled` 正确、备份文件生成、重复 install 幂等。
  - 断言未知宿主回退手写 `.js`。
- 跑法：`node --require <EBUSY-shim> --test`（沿用 Windows `spawnSync` EBUSY shim 纪律）。
- 变异/护栏：变异一处（删备份、改坏模板）须使对应用例红；遵循项目「只断言错误行 ≠ 断言流向」纪律（同时钉 stderr 与 stdout）。

### 7.4 验收（对照设计 §4）

- `mio mcp registry --write` + `mio install --auto` 一次接线所有 detected 宿主；`--check` 报告漂移且退出码语义正确。
- 新增宿主 = 丢一个 `.template.json`（+ 必要薄 shim），无需改核心；codex / opencode 经模板驱动。
- 现有 `mio install <host>` 行为不回归（既有测试仍绿）。
- 全程不碰 `index.js` / `mechanism-registry.js`（实现前 `git status` 复核）。

### 7.5 提交切分建议

- **PR-B**：一个提交（`installCommand` 扩展 + `--auto` / `--check` + observer tip + 测试）。仅 stage 本 PR 文件。
- **PR-C**：一个提交（`loader.js` + codex/opencode 模板 + `bin` require 改 loader + 测试）。仅 stage 本 PR 文件。
- 两者均不混入并发会话的未提交改动（index.js / mechanism-registry.js / creativity/* / README / AGENTS / CLAUDE 等）。→ 实现规格见 §7（已起草）。
