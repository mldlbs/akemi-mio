# 秋山澪 Ai Voice Assistant Wallpaper

基于 Electron 的 AI 语音助手桌面壁纸应用，支持语音唤醒、语音识别（Whisper/Baidu ASR）、AI 对话、语音合成（TTS）。

## 功能

- 🎤 语音输入：Whisper 本地语音识别 / 百度语音识别（可选）
- 🤖 AI 对话：与 LLM 进行自然对话
- 🔊 语音合成：Edge TTS 朗读回复
- 🎯 按键唤醒：F2 快捷键唤醒语音输入
- ⚡ 轻量高性能：基于 Electron + Vite + React

## 开始使用

```bash
# 安装依赖
npm install

# 下载 ASR 模型
npm run download:model

# 启动开发环境
npm run dev

# 构建生产版本
npm run build:win
```

## 技术栈

- **框架**: Electron + electron-vite
- **前端**: React 19 + TypeScript
- **语音识别**: Whisper (Xenova Transformers) / 百度语音识别 API
- **语音合成**: Edge TTS
- **桌面打包**: electron-builder

## Package Layout

```text
packages/
├── core/          Electron lifecycle, config, logging, EventBus, patterns, schemas
├── cli/           CLI helpers
├── runtime-contracts/   Shared type definitions
├── runtime-foundation/  Logging, EventBus, memory schemas
├── experience-memory/   Experience recording and retrieval
├── evolution-learning/  Evolution learning engine
├── evolution-strategy/  Evolution strategy engine
├── evolution-safety/    Safety guardrails
├── evolution-scheduler/ Evolution scheduler
├── analysis/      ModuleScanner — static analysis of package source trees (npm-ready, zero deps)
├── messaging/     ExternalMessageGateway — inbound routing + notification dispatch (npm-ready, zero deps)
├── reasoning/     Reasoning planner — pure-function scoring (npm-ready, injectable runtime)
├── resource-control/  Resource budgets + background task runner (npm-ready, injectable runtime)
├── agent-persona/     Persona drift control + behavior analysis (npm-ready, injectable runtime)
├── creativity/    CreativityService — concept generation, conflict detection, merging, fermentation
├── observer/      ObserverService — multi-source data collection, trend analysis, deep research, world model
├── insight/       InsightService — LLM-based insight generation, detectors, presence service
├── intelligence/  Original intelligence source (core logic)
├── mio-cli/       Runtime CLI + MCP server (published as mio-agent-runtime)
└── akemi-mio/     Electron desktop app
```

`mio-agent-runtime` (0.5.22) bundles the runtime packages with 47 MCP tools.
The npm-usable packages above (`analysis`, `messaging`, `reasoning`,
`resource-control`, `agent-persona`) are published under the `@akemi-mio`
scope with zero host dependencies; host-coupled packages (core,
creativity, intelligence, capabilities, ...) are consumed from source via
tsconfig paths and are not published.

## License

MIT
