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
- **Windows** 用于打包构建。开发环境在 macOS 和 Linux 上也能跑。

> [!IMPORTANT]
> `models/` 目录不在仓库里。语音输入要先准备模型权重才能用，详见 [模型权重](#模型权重)。

## 安装

克隆仓库并安装依赖：

```bash
git clone https://github.com/akemi-mio/akemi-mio.git
cd akemi-mio
npm install
```

这是个 workspace 工程，所以 `npm install` 会同时把 `packages/` 下的本地包链接好。

## 快速开始

以开发模式启动：

```bash
npm run dev
```

壁纸会出现，应用同时注册全局快捷键。按 <kbd>Ctrl</kbd> + <kbd>Space</kbd> 切换交互模式，开始收音。

构建 Windows 免安装版本：

```bash
npm run build:win
```

产物输出到 `dist-electron/`。

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

提 PR 之前先跑完这些检查：

```bash
npm run typecheck
npm run lint
npm test
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 带热重载的开发构建 |
| `npm run build` | 生产构建，不打包 |
| `npm run build:win` | Windows 免安装版本 |
| `npm run build:win:installer` | Windows NSIS 安装包 |
| `npm run typecheck` | node 与 web 两个目标各做一次类型检查 |
| `npm run lint` | 对 `src/` 跑 ESLint |
| `npm test` | Vitest 测试套件 |
| `npm run test:renderer` | 只跑渲染层测试 |
| `npm run coverage` | 覆盖率报告 |
| `npm run typecheck:budget` | 类型错误数超出预算时失败 |

测试用 Vitest。压力测试和基准测试收在 `npm run test:stress` 后面。

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

欢迎贡献。简化版流程如下：

1. Fork 并从 `main` 切分支。
2. 改动保持聚焦，一个 PR 只做一件事。
3. 跑 `npm run typecheck`、`npm run lint` 和 `npm test`。
4. 说明你验证了什么，而不只是改了什么。

请不要提交 API Key、模型权重，或 `test-user-data/` 里的任何内容。这些路径已在 gitignore 里，但提交前还是用 `git status` 过一眼。

> [!TIP]
> `AGENTS.md` 记录了本仓库的 `mio` 记忆约定。如果你在这里用 AI 编程助手，它会自动遵循这些规则。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
