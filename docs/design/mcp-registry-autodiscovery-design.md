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
- **PR-B**：`mio install --auto` / `--check`。
- **PR-C**：模板驱动适配器加载器 + 首批 2 个宿主模板（codex / opencode）。
