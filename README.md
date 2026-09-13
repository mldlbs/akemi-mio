# 秋山澪 Akemi Mio

一个会听、会说、会记事的 Electron 桌面壁纸。按下快捷键说话，壁纸上的角色会开口回答你。

![status](https://img.shields.io/badge/status-active-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## 为什么用它

大多数桌面助手的窗口都得你自己去找。这个直接住在壁纸上，一直可见，也从不挡路。按一个键就能唤起，不用伸手摸鼠标。

除了「长在壁纸上」，还有两点不一样：

- **语音默认在你本机处理。** 本地 Whisper 模型走 ONNX Runtime，除非你主动开启云端服务商，否则音频不会离开这台电脑。
- **它会攒记忆。** `mio` 运行时会记录决策和结果，再把有用的部分喂回后续会话。

## 功能

- **语音输入** —— 本地 Whisper，或选云端服务商百度语音识别
- **AI 对话** —— 通过 Anthropic 或 OpenAI SDK 与 LLM 对话
- **语音合成** —— 用 Edge TTS 把回复读出来
- **快捷键唤起** —— 不用离开当前窗口就能切换语音输入
- **原生壁纸** —— 渲染在桌面层，位于图标之下
- **技术栈** —— Electron 42、React 19、TypeScript、Vite

## 环境要求

- **Node.js 22** 或更新版本
- **pnpm 9+**（推荐；本工程是 pnpm workspace，配置见 `pnpm-workspace.yaml`）
- **Windows 11** 用于打包构建。开发环境在 macOS 和 Linux 上也能跑。
- **原生模块编译环境**（首次安装需要）：
  - Python 3.x（node-gyp 依赖）
  - C/C++ 构建工具链（Windows 装 *Desktop development with C++* 工作负载或 VS Build Tools）

> [!IMPORTANT]
> `models/` 目录不在仓库里。语音输入要先准备模型权重才能用，详见 [模型权重](#模型权重)。

## 安装

克隆仓库并安装依赖：

```bash
git clone https://github.com/akemi-mio/akemi-mio.git
cd akemi-mio
pnpm install
```

`pnpm install` 按 `pnpm-workspace.yaml` 链接 `packages/` 下全部 68 个本地包，并依据 `allowBuilds` 为 `better-sqlite3` / `onnxruntime-node` / `sharp` 等原生模块构建 Electron prebuild。

> 若只用 npm：`package.json` 已声明 `"workspaces": ["packages/*"]`，`npm install` 也能链接本地包。但仓库锁文件是 `pnpm-lock.yaml`，混用会导致依赖树漂移，建议坚持 pnpm。

首次运行 `pnpm dev` 时，`scripts/dev.js` 会自动为 `better-sqlite3` 安装/校验 Electron 原生 prebuild，无需手动操作。

## 快速开始

以开发模式启动（壁纸窗口出现，并注册全局快捷键）：

```bash
pnpm dev
```

启动期可用环境变量（仅本地调试，可选）：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `RUNTIME_ENABLED` | 是否启用 mio 运行时 | `1` |
| `LLM_KEY` | 直接注入 LLM API Key（绕过凭据库，仅本地调试） | 空 |
| `AKEMI_MIO_OBSERVABILITY` | 打开运行时可观测性日志 | 空 |

启动后按 <kbd>Ctrl</kbd> + <kbd>Space</kbd> 切换交互模式，开始收音。

构建分发包：

```bash
pnpm build:win            # Windows 免安装版 (portable) → dist-electron/
pnpm build:win:installer  # Windows NSIS 安装包
pnpm publish:win          # 构建并发布（含自动更新）
```

### Mio 运行时 CLI

本仓库内置 `mio` 智能体运行时（`packages/mio-cli`），也可作为已发布的 `mio-agent-runtime` 独立安装：

```bash
# 仓库内直接调用
node packages/mio-cli/bin/mio.js --help

# 或全局安装发布版
npm install -g mio-agent-runtime
mio init                   # 初始化 MIO_HOME
mio install workbuddy      # 接入宿主（codex|opencode|workbuddy|hermes|claude）
mio status                 # 查看运行时与适配器状态
mio observe --start        # 后台被动观察，自动沉淀任务结果到记忆库
mio recall "上次失败的根因"   # 从终端检索 Mio 记忆
```

CLI 暴露 47 个 MCP 工具，覆盖记忆、观察管线、洞察自省、创意引擎与演化（evolution）五大域；运行时依赖 9 个 `@akemi-mio/*` 包，详见 [`packages/mio-cli/README.md`](packages/mio-cli/README.md)。

## 模型权重

语音输入需要的模型文件太大，不适合放进 git。运行时会在仓库根目录的 `models/` 里找，目录结构沿用 Transformers.js 的缓存布局：

```text
models/
└── Xenova/
    └── whisper-<size>/
```

应用优先读本地文件。如果找不到，首次使用时会回退到从 Hugging Face 下载。

> [!WARNING]
> `package.json` 里虽然列了 `npm run download:model`，但它指向的脚本（`scripts/download-model.cjs`）在本仓库中并不存在。请依赖运行时的自动下载，或自己把模型文件放进 `models/`。

## 配置

配置存放在应用的用户数据目录。常用项：

| 配置项 | 作用 | 默认值 |
|---|---|---|
| 快捷键 | 切换交互模式 | <kbd>Ctrl</kbd> + <kbd>Space</kbd> |
| ASR 服务商 | `local` 或 `baidu` | `local` |
| LLM 服务商 | `anthropic` 或 `openai` | `anthropic` |
| TTS 音色 | Edge TTS 音色名 | 跟随系统 |

云端服务商需要 API Key。应用从凭据库读取，而不是写在源码里，所以不会有敏感信息被提交进仓库。

<details>
<summary>切换到百度语音识别或云端 LLM</summary>

1. 从壁纸菜单打开设置面板。
2. 选择服务商。
3. 粘贴 API Key，它会写入凭据库。
4. 重启应用，让 ASR 服务重新绑定。

如果 Key 有误，日志里会出现 `asr_provider_failed`。此时应用会回退到本地模型，而不是直接罢工。

</details>

## 开发

提 PR 之前先跑完这些检查（等价 `pnpm typecheck && pnpm lint && pnpm test`）：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 带热重载的开发构建（启动壁纸 + 注册快捷键） |
| `pnpm build` | 生产构建，不打包 |
| `pnpm build:win` | Windows 免安装版本 |
| `pnpm build:win:installer` | Windows NSIS 安装包 |
| `pnpm typecheck` | node 与 web 两个目标各做一次类型检查 |
| `pnpm lint` | 对 `src/` 跑 ESLint |
| `pnpm test` | Vitest 测试套件 |
| `pnpm test:renderer` | 只跑渲染层测试 |
| `pnpm test:preload` | 只跑预加载层测试 |
| `pnpm coverage` | 覆盖率报告 |
| `pnpm typecheck:budget` | 类型错误数超出预算时失败 |

测试用 Vitest。压力测试与基准测试收在 `pnpm test:stress` 后面。

## 仓库结构

```text
akemi-mio/
├── packages/           68 个 workspace 包
│   └── main/           Electron 主进程入口
├── src/
│   ├── preload/        预加载桥接层
│   └── renderer/       React 界面，含壁纸页与 agent 页
├── server/             MCP 服务端及配套服务
├── scripts/            构建、模型与校验脚本
├── docs/               设计笔记与决策记录
└── tests/              跨包测试套件
```

主进程入口在 `packages/main`，预加载和渲染层代码在 `src/`。真正有意思的逻辑都在 `packages/` 下：

- `audio/` —— ASR 与 TTS 引擎，含 Whisper 的 CPU 和 GPU 插件
- `platform/` —— 壁纸窗口控制与全局快捷键
- `voicenote/` —— 语音笔记采集与剪贴板集成
- `core/` —— 生命周期、配置、日志、EventBus、schema 定义
- `mio-cli/` —— `mio` 运行时 CLI 与 MCP 服务端

### 已发布的包

有两组包可以脱离本应用单独复用。它们都是零依赖、接受注入式运行时，可以直接丢进另一个 Node 工程。

| 包名 | 作用 |
|---|---|
| `@akemi-mio/analysis` | 对包源码树做静态分析 |
| `@akemi-mio/messaging` | 入站消息路由与通知分发 |
| `@akemi-mio/reasoning` | 纯函数打分规划器 |
| `@akemi-mio/resource-control` | 资源预算与后台任务运行器 |
| `@akemi-mio/agent-persona` | 人格漂移控制与行为分析 |
| `@akemi-mio/runtime-contracts` | 共享类型定义 |
| `@akemi-mio/runtime-foundation` | 日志、EventBus、记忆 schema |
| `mio-agent-runtime` | CLI 加 MCP 服务端，共 47 个工具 |

其余包依赖 Electron 宿主，通过 `tsconfig` 路径从源码引用，不对外发布。

## 参与贡献

欢迎贡献。完整流程如下。

### 起步
1. Fork 并 `git clone` 你自己的副本。
2. 从 `main` 切出功能分支：`git checkout -b feat/short-description`。

### 开发
3. 用 **pnpm** 管理依赖，不要混用 npm。
4. 改动保持聚焦——**一个 PR 只做一件事**。
5. 提交前跑完质量门禁：

   ```bash
   pnpm typecheck   # node + web 两套类型检查
   pnpm lint        # ESLint 仅扫 src/
   pnpm test        # Vitest 全量
   ```

   也可只跑某个层面：`pnpm test:renderer`、`pnpm test:preload`、`pnpm typecheck:budget`。
6. 提交信息用祈使句，聚焦「改了什么 / 为什么」；关联 issue 时写 `Fixes #123`。

### 提交 PR
7. PR 描述说明**你验证了什么**，而不只是改了什么——附复现步骤或测试输出。
8. 不要提交任何敏感或体积大的产物：`API Key`、`models/` 权重、`test-user-data/`、`.env`、构建目录均已 gitignore，但提交前仍用 `git status` 过一眼。

### 约定
- 代码风格由 **ESLint + Prettier** 约束，可跑 `pnpm format` 自动格式化。
- 新增 `packages/` 下的本地包时，只要落在 `pnpm-workspace.yaml` 的 glob（`packages/*`）内就会被自动链接，无需手改 `package.json` 的 workspaces。
- 本仓库集成 Mio 记忆体系：`AGENTS.md` 记录了 `mio` 的记忆 / 观察 / 策略约定，AI 编程助手会自动遵循；涉及架构、依赖或长期行为的改动，记得让 Mio 记录决策（CLI `mio memory record` 或对应 MCP 工具）。

> [!TIP]
> 不清楚该改哪层？渲染层在 `src/renderer/`，主进程入口在 `packages/main`，可独立复用的纯逻辑包在 `packages/`（如 `audio/`、`platform/`、`core/`），详见 [仓库结构](#仓库结构)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
