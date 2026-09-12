# 自定义项目工作区（方案 A）设计

> 状态：已实现
> 日期：2026-08-11
> 范围：允许用户在设置中选择一个本地目录作为「项目工作区」，Mio 的文件类工具在该目录内读写；未配置时行为与现状完全一致。

## 1. 背景与目标

当前 Mio 的文件工具只能在三个内部工作区内操作（`src/main/tool/utils/workspace.ts`）：

- `project` → `<WORKSPACE_ROOT>/projects/`（`WORKSPACE_ROOT` 默认 `%APPDATA%/akemi-mio/`）
- `evolution` → `<WORKSPACE_ROOT>/evolution_workspace/`
- `mcp`（默认沙箱）→ `<WORKSPACE_ROOT>/projects/__sandbox__/`

用户希望让 Mio 在一个自己指定的本地文件夹里干活（读写文件、跑命令、搜索），而不是被限制在 `%APPDATA%` 内的 `projects/` 沙箱。

**目标**：设置页新增「工作区」配置，用户选择一个本地目录后，`project` 工作区根目录指向该目录，文件工具（`list_files` / `read_file` / `write_file` / `edit_file` / `move_file` / `copy_file` / `delete_file` / `append_file` / `read_multiple_files` / `search_files` / `grep` / `run_command` / `analyze_codebase`）以该目录为沙箱根工作。

## 2. 现状关键事实（已核实）

| 事实 | 位置 |
| --- | --- |
| `WORKSPACE_ROOT` / `WORKSPACE` 为模块加载时计算的静态常量 | `src/main/config/index.ts:36` |
| 工具层路径在 handler 调用时解析（`resolveWorkspace` / `safeWorkspacePath` / `inferWorkspace`） | `src/main/tool/utils/workspace.ts` |
| 少数工具在模块顶层缓存路径常量 | `GrepTool.ts`（`PROJECT_ROOT`）、`AnalyzeCodebaseTool.ts`（`PROJECT_ROOT`） |
| 设置持久化在固定位置的 `databases/main.db` `credentials` 表 | `src/main/credentials/CredentialsManager.ts` |
| 设置 UI 复用 `credentials:getAll` / `credentials:set` IPC | `src/main/ipc/handlers/credentials.ts` |
| 无现成「选择目录」对话框 IPC | — |
| Agent 系统提示词中的工作区说明为静态文本 | `src/main/agent/context.ts`（`BASE_PROMPT` / `PROMPT_TOOLS`） |
| `workspace-cleanup` 层默认扫描 `WORKSPACE.projects`，但支持注入 `workspaceRoot` | `src/main/workspace-cleanup/WorkspaceCleanupLayer.ts:86` |

关键点：**方案 A 不移动 databases / memory / evolution / logs / cache**，设置存在固定位置，因此不存在「设置自身被搬走」的鸡生蛋问题；工具层路径在调用时解析，因此**保存后无需重启，下一次工具调用即生效**。

## 3. 范围界定

### 做
1. 设置页「系统」tab 新增「工作区」区块：显示当前项目工作区、选择目录、恢复默认。
2. 新增主进程工作区配置模块（校验 + 读取 + 保存）。
3. `project` 工作区根解析改为「自定义目录 || 默认 projects 目录」。
4. `grep` / `analyze_codebase` 的搜索/执行根跟随自定义目录（保留默认行为）。
5. 自定义根下放宽 `write_file` / `edit_file` 的 project 硬阻断规则（见 D4）。
6. Agent 系统提示词动态注入当前项目工作区路径。
7. 测试与文档。

### 不做（第一版）
- 不动 `WORKSPACE_ROOT` 整体（方案 B 范畴）。
- 不做多项目列表/切换（一次一个自定义目录 + 恢复默认）。
- 不改 `workspace-cleanup` 扫描范围（仍扫描默认 `WORKSPACE.projects`；自定义根用户如启用清理功能需另行设计，见风险 R6）。
- 不改变 `evolution` / `mcp` 工作区。
- 不改变 `inferWorkspace` 的默认推断规则（保持向后兼容，见 D3）。
- 不新增「绝对路径参数」支持（保持相对路径模型，见 D9）。

## 4. 核心设计决策

### D1 配置存储：`credentials` 表，键 `project_workspace_root`
- 空值 / 不存在 = 未配置（默认行为）。
- 复用现有 `CredentialsManager`（`get` / `set` / `delete`），与 LLM key 等设置同机制。
- 值经 `safeStorage` 加密存储（与现有凭据一致，路径非敏感但机制统一）。
- **保存必须走专用入口 `setCustomProjectRoot()`**（带校验），不允许裸 `credentials:set` 写入（Agent 工具 `set_credential` 可写任意键，设计上接受该风险，见 R3）。

### D2 生效时机：保存后立即生效，无需重启
- 工具 handler 每次调用时通过 `getEffectiveProjectRoot()` 解析根目录。
- 需把 `GrepTool.ts` / `AnalyzeCodebaseTool.ts` 的模块级 `PROJECT_ROOT` 常量改为调用时求值（这是仅有的两处模块级缓存）。

### D3 语义：自定义目录只替换 `project` 工作区根
- `resolveWorkspace('project')` 与「不传 workspace 的默认分支」→ `getEffectiveProjectRoot()`。
- `resolveWorkspace('evolution')` / `resolveWorkspace('mcp')` 不变。
- `inferWorkspace()` **保持不变**：未显式传 `workspace="project"` 的相对路径仍按现有规则推断（默认 `evolution`）。依赖 Agent 按提示词显式传 `workspace="project"`（现有提示词已如此要求，见 §6）。
- `grep` / `analyze_codebase` 的 `PROJECT_ROOT` 解析顺序改为：`自定义项目根 || DEV_PROJECT_ROOT || WORKSPACE_ROOT`（保持「未配置时行为不变」）。

### D4 自定义根下放宽 project 硬阻断（行为变化点）
现状（`WriteFileTool.ts` / `EditFileTool.ts`）：
- project 工作区禁止写/编辑根级文件；
- project 工作区禁止写 `.txt / .json / .log / .tmp / .out` 临时文件。

这些规则是为内部 `projects/` 沙箱设计的（防止 Agent 把临时文件撒进沙箱根）。但用户的自定义目录**就是真实项目**，`package.json`、`tsconfig.json` 等根级文件是合法目标，必须允许。

**决策**：
- 已配置自定义根：两条规则全部跳过（允许根级写入与 `.json` 等文件）。
- 未配置：规则原样保留（默认行为零变化，现有测试不受影响）。
- 实现：`WriteFileTool` / `EditFileTool` 内增加 `isCustomProjectRootConfigured()` 判断（读 credentials，与解析同源）。

### D5 校验规则（`validateProjectRoot`）
输入为用户选择的目录绝对路径或空串（空 = 恢复默认）。校验通过后保存归一化路径：

1. 非空时必须指向一个**已存在**的目录（`statSync().isDirectory()`）。
2. `resolve()` 归一化为绝对路径，去除尾部 `\` / `/`。
3. 拒绝以下目标：
   - Mio 自身工作区内部（`WORKSPACE_ROOT` 及其任意子目录）——防止与默认沙箱/数据库互相嵌套；
   - 应用安装目录（`RUNTIME_ROOT`，即 `app.getAppPath()`）；
   - 系统盘根 / `C:\Windows` 等系统目录（硬拒绝 Windows 目录与盘符根）。
4. 通过后写入 `credentials`（键 `project_workspace_root`）。

### D6 安全边界
- `safeWorkspacePath` 以 `getEffectiveProjectRoot()` 为 project 沙箱边界，路径穿越校验沿用 `resolve + startsWith`。
- **收紧大小写**：Windows 下将「解析后路径」与「边界」统一 `toLowerCase()` 后比较，避免大小写差异导致误判或绕过（现状为区分大小写的 `startsWith`，本次对 project 根边界修正）。
- `run_command` 在自定义根下执行命令：**保持现有命令白名单**不变；文档提示用户自行承担在自有目录执行命令的风险。

### D7 读取性能与一致性
- 第一版 `getEffectiveProjectRoot()` 每次调用直接 `credentialsManager.get()`（本地 sqlite prepare+step，亚毫秒级），**不做内存缓存**，避免与 Agent `set_credential` 写入产生不一致。
- 若后续出现性能问题（工具调用高频场景），再考虑「缓存 + set 时失效」优化。

### D8 UI：设置 → 系统 tab「工作区」区块
- 展示：
  - 当前生效路径（自定义：显示目录 + 绿色标识；默认：显示 `默认（%APPDATA%/akemi-mio/projects）` + 灰色标识）。
  - 若自定义目录已被删除，显示黄色告警（主进程 `getProjectRoot` 返回 `exists: false`）。
- 操作：
  - 「选择目录」→ `dialog:selectDirectory`（`showOpenDialog`，`properties: ['openDirectory', 'createDirectory']`，默认路径取用户目录）→ 确认后调用 `workspace:setProjectRoot`，返回校验错误时展示。
  - 「恢复默认」→ `workspace:setProjectRoot('')`。
- 说明文字：影响文件工具读写范围，保存后立即生效；记忆、设置、进化工作区不受影响。
- 输入框为**只读展示**（不允许手输路径，强制走目录选择器，减少非法输入面）。

### D9 路径模型：保持相对路径
- 工具参数继续使用相对路径（现状模型），Agent 从 `list_files .` 开始浏览。
- `stripWorkspaceLabelPrefix` 不匹配时不裁剪，行为不变；绝对路径参数仍会被边界校验拒绝（与现状一致）。
- 后续如需要「绝对路径直接引用自定义根内文件」再单独设计（不在本次范围）。

### D10 Agent 提示词
- `buildSystemPrompt()`（`src/main/agent/context.ts`）在自定义根已配置时追加一段：
  「当前项目工作区（project workspace）：`<绝对路径>`。涉及项目源码的读写/命令请使用 workspace="project"。」
- `BASE_PROMPT` 保持静态常量；动态片段在函数内拼接，路径需转义换行。
- 未配置时不追加（提示词零变化，现有 golden 测试不受影响）。

## 5. 改动文件清单

### 新增
| 文件 | 职责 |
| --- | --- |
| `src/main/workspace/project-root.ts` | 配置读取/保存/校验的唯一入口：`getCustomProjectRoot()`、`getEffectiveProjectRoot()`、`validateProjectRoot()`、`setCustomProjectRoot()`、`isCustomProjectRootConfigured()` |
| `src/main/ipc/handlers/workspace.ts` | `workspace:getProjectRoot`、`workspace:setProjectRoot`、`dialog:selectDirectory` |
| 测试文件（见 §8） | — |

### 修改
| 文件 | 改动 |
| --- | --- |
| `src/main/tool/utils/workspace.ts` | `resolveWorkspace('project'/默认)` 走 `getEffectiveProjectRoot()`；`PROJECT_ROOT` 改函数或由调用方改取 `getEffectiveProjectRoot()`；`safeWorkspacePath` 边界比较大小写归一化 |
| `src/main/tool/definitions/WriteFileTool.ts` | 自定义根时跳过两条硬阻断 |
| `src/main/tool/definitions/EditFileTool.ts` | 自定义根时跳过根级编辑阻断 |
| `src/main/tool/definitions/GrepTool.ts` | `PROJECT_ROOT` 模块常量 → handler 内取 `getEffectiveProjectRoot()` |
| `src/main/tool/definitions/AnalyzeCodebaseTool.ts` | 同上 |
| `src/main/agent/context.ts` | `buildSystemPrompt` 动态注入项目工作区路径 |
| `src/main/ipc/handlers.ts` | 注册 `workspace` handler 组（模式同 `credentials.ts`） |
| `src/preload/index.ts` | `createElectronAPI` 增加 `getProjectRoot` / `setProjectRoot` / `selectDirectory` |
| `src/renderer/src/settings/SettingsSystemTab.tsx` | 「工作区」区块 |
| 类型声明（preload 暴露的 electronAPI 类型，若有） | 同步新增方法 |

### 明确不改
- `src/main/config/index.ts`（保持静态常量，自定义根是运行时配置）。
- `src/main/credentials/CredentialsManager.ts`。
- `src/main/workspace-cleanup/*`（见 R6）。
- `src/main/mcp/*`（registry / server 配置仍在默认根，不受影响）。

## 6. Agent 行为对齐

- 现有提示词已要求「项目源码 → workspace="project"」（`context.ts` PROMPT_TOOLS）。
- 自定义根配置后，该规则的实际落点从 `projects/` 变为用户目录；D10 追加的提示词让 Agent 明确感知。
- 工具 schema 描述中的 `workspace="project"` 文案（`WriteFileTool` / `FileOpsTools` / `RunCommandTool` 等）保持不动（描述仍成立）；如评审认为需要，可在描述中追加「project = 用户配置的项目目录」，属可选文案优化。

## 7. 数据与迁移

- 无数据结构变更；新增 credentials 键 `project_workspace_root`，空串/缺失 = 默认。
- 无需迁移脚本；恢复默认只是删除该键。
- 切换自定义目录不会丢失任何设置/记忆/消息（它们不随 project 根移动）。

## 8. 测试策略

参考现有测试模式：`src/main/config/__tests__/index.test.ts`、`src/main/ipc/__tests__/handlers.test.ts`、`src/main/tool/__tests__/*`。

1. `project-root` 模块单测：
   - 未配置 → `getEffectiveProjectRoot()` = 默认 projects 目录；
   - set 合法目录 → 生效；空串 → 恢复默认；
   - 校验拒绝：不存在目录 / 位于 `WORKSPACE_ROOT` 内 / 系统目录 / 应用安装目录；
   - 配置目录被删除后 → 回退默认并告警（见 R2）。
2. `workspace.ts` 单测：
   - 自定义根下 `resolveWorkspace('project')` 返回自定义根；`evolution`/`mcp` 不变；
   - `safeWorkspacePath` 边界：`..` 穿越、绝对路径、大小写变体均被拦/正确解析；
   - 默认行为回归（未配置时与现状完全一致）。
3. 工具单测：
   - `write_file`：自定义根下允许根级 `package.json`、允许 `src/x.json`；未配置时仍拒绝（现状回归）；
   - `edit_file`：自定义根下允许编辑根级文件；
   - `grep` / `analyze_codebase`：mock 自定义根后搜索/执行根跟随（未配置时回归）。
4. IPC 单测（`handlers.test.ts` 模式）：`workspace:setProjectRoot` 成功/校验失败/恢复默认；`workspace:getProjectRoot` 返回 `{ configured, effective, isCustom, exists }`。
5. preload 单测（`src/preload/__tests__/index.test.ts` 模式）：新方法暴露。
6. `context.ts`：自定义根时 `buildSystemPrompt` 含路径；未配置时输出与现状一致。
7. 回归：`npm run test:unit`、`npm run typecheck`、`npm run lint`。

## 9. 风险与缓解

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 模块级路径缓存导致自定义根不生效 | 唯一两处（GrepTool / AnalyzeCodebaseTool）改为调用时求值；测试覆盖 |
| R2 | 自定义目录被删除/移动后工具行为怪异 | `getEffectiveProjectRoot()` 在目录不存在时回退默认并 `log('WARN', ...)`；UI 显示 `exists:false` 告警 |
| R3 | Agent `set_credential` 可绕过校验写入该键 | 接受（用户本机 Agent 行为）；`getEffectiveProjectRoot` 对不存在目录回退兜底；UI 显示当前值便于发现 |
| R4 | 路径大小写导致的沙箱边界误判/绕过 | 边界比较统一小写归一化；单测覆盖 |
| R5 | `write_file` 规则放宽后默认行为变化 | 放宽仅发生在「已配置自定义根」；默认路径行为零变化，现有测试即回归护栏 |
| R6 | `workspace-cleanup` 在自定义根上自动整理文件（破坏性） | 第一版**不改**该层（仍扫描默认 projects）；文档标注后续项；用户未启用该功能 flag 时无影响 |
| R7 | `run_command` 在用户目录执行命令的合规/安全 | 维持命令白名单；UI 说明文字提示风险 |
| R8 | 提示词注入路径含换行等特殊字符 | 拼接前转义换行/控制字符 |

## 10. 验收标准

1. 设置 → 系统 → 工作区可查看当前项目工作区、选择目录、恢复默认，校验错误有提示。
2. 配置后，`list_files .`（默认 project）列出用户目录内容；`write_file workspace="project"` 可写入用户目录（含根级 `.json` 文件）；`grep` 搜索范围为用户目录。
3. 恢复默认后，所有工具回到 `%APPDATA%/akemi-mio/projects/` 行为。
4. 未配置时全量行为与现状一致（现有单测全绿）。
5. `npm run test:unit` / `typecheck` / `lint` 通过。

## 11. 待确认决策（评审点）

- [ ] D4：自定义根下允许写根级文件与 `.json` 等文件（推荐）——是否同意？
- [ ] D3：`grep` / `analyze_codebase` 搜索范围跟随自定义根（推荐）——是否同意？
- [ ] D8：路径只读 + 目录选择器，不允许手输（推荐）——是否同意？
- [ ] D2：保存后立即生效、无需重启（推荐）——是否同意？

