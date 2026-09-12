# 秋山澪 (Akemi Mio) 开发全记录

> AI 语音助手桌面壁纸应用 · 开发历程 · 架构设计 · 系统详解  
> 时间跨度：2026-05-26 至 2026-06-27（32 天）  
> 开发者：mldlbs · 技术栈：Electron + React 19 + TypeScript 5.7 + Vite 6

---

## 目录

1. [项目概述](#1-项目概述)
2. [开发时间线](#2-开发时间线)
3. [架构总览](#3-架构总览)
4. [Electron 主进程详解](#4-electron-主进程详解)
5. [渲染进程 UI 详解](#5-渲染进程-ui-详解)
6. [核心系统详解](#6-核心系统详解)
7. [自进化系统](#7-自进化系统)
8. [认知与创意系统](#8-认知与创意系统)
9. [记忆系统](#9-记忆系统)
10. [数据层](#10-数据层)
11. [工具与技能系统](#11-工具与技能系统)
12. [插件与 MCP](#12-插件与-mcp)
13. [治理与健康](#13-治理与健康)
14. [外部集成](#14-外部集成)
15. [CI/CD 与构建](#15-cicd-与构建)
16. [已知问题与路线图](#16-已知问题与路线图)
17. [关键设计决策](#17-关键设计决策)

---

## 1. 项目概述

### 1.1 项目定位

秋山澪（Akemi Mio）是一个基于 Electron 的 AI 语音助手桌面壁纸应用。最初定位为语音交互的桌面伴侣，后来演化为一个完整的 **Agent OS（代理操作系统）**——具有自进化、认知、创造力、记忆和工具编排能力的自主 AI 系统。

名字来源于《轻音少女》中的角色 **秋山澪**（Akiyama Mio），角色设定为温柔、可靠的 AI 伙伴。

### 1.2 核心能力

| 能力 | 描述 |
|------|------|
| 🎤 语音交互 | 全双工语音对话，支持打断，VAD 语音活动检测 |
| 🤖 AI 对话 | 多模型 LLM 对话（聊天/代码/视觉/文本 四模型分离） |
| 🔊 语音合成 | Edge TTS + Piper TTS 双引擎 |
| 🧠 自进化 | 2 小时间隔的自主进化循环，自动改进行为 |
| 💡 创造力 | 概念混合、梦境循环、创意生成 |
| 📝 记忆系统 | 三层记忆（永久/半永久/短期）+ 向量记忆 + 知识图谱 |
| 🔧 工具调用 | 30+ 内置工具（文件、代码、SSH、图片生成等） |
| 🔌 插件系统 | 沙箱化插件，带权限审计 |
| 🌐 MCP 集成 | 多 MCP 服务器管理（Playwright、Writing 等） |
| 💰 众包任务 | 对接 9 个众包平台自动做任务 |
| 📱 Telegram 机器人 | 远程控制与通知 |
| 🖼️ ComfyUI 集成 | FLUX 模型图像生成 |
| 🪟 桌面壁纸模式 | 支持 Wallpaper Engine 透明窗口叠加 |

### 1.3 技术栈

```
┌─ 框架: Electron 42 + electron-vite 5
├─ 前端: React 19 + TypeScript 5.7 + Vite 6
├─ 样式: CSS Custom Properties (oklch) + Glassmorphism
├─ 数据库: SQLite (sql.js WASM) + Drizzle ORM
├─ LLM: OpenAI 兼容 API (DeepSeek / 智谱 / 通义千问 等 13 个平台)
├─ ASR: Whisper GPU (Vulkan via ONNX) + Baidu ASR 双引擎
├─ TTS: Edge TTS (云端) / Piper TTS (本地)
├─ 3D: Three.js 粒子系统
├─ 测试: Vitest 4 + V8 Coverage
├─ 打包: electron-builder (NSIS 安装器)
└─ 更新: electron-updater (自托管更新服务器)
```

---

## 2. 开发时间线

### 第一阶段：项目脚手架与基础功能（2026-05-26）

项目从 `electron-vite` 脚手架起步，一天内完成了核心交互闭环：

| 提交 | 说明 |
|------|------|
| `2c1fcbe` | `chore: scaffold electron-vite project` — 初始化 Electron + Vite + React 项目结构 |
| `7d8b609` | `feat: transparent window with wallpaper engine support` — 实现透明窗口 + Wallpaper Engine 集成 |
| `194cb65` | `feat: preload bridge with IPC channels` — 建立 contextBridge IPC 通信层 |
| `722e4f3` | `feat: whisper ASR module with init and transcribe` — Whisper 本地语音识别 |
| `e34300b` | `feat: OpenRouter AI chat module with context management` — OpenRouter 驱动的 AI 对话 |
| `bbf30aa` | `feat: TTS module with edge-tts and ffplay playback` — Edge TTS 语音合成 + ffplay 播放 |
| `1e5845c` | `feat: renderer UI with voice input, chat, and status bar` — 初始 React UI |
| `11294de` | `fix: register F2 keyboard listeners in VoiceInput` — 修复 F2 快捷键 |
| `5711803` | `feat: WebM to PCM audio decoding with ffmpeg` — ffmpeg 音频解码 |

**关键决策**：选择了 OpenRouter（而非直接调用单一 LLM 平台）作为初始 LLM 网关，为后续多模型支持埋下伏笔。

### 第二阶段：交互优化与多引擎支持（2026-05-27 至 2026-05-30）

| 提交 | 说明 |
|------|------|
| `b110485` | Apple 风格图标 + HF Mirror 加速 ASR 模型下载 |
| `aa71bc2` | 点击说话 + 完整反馈链（录音→ASR→LLM→TTS） |
| `9849c5e` | 对话模式 + 基于能量的 VAD（Voice Activity Detection） |
| `8b1d8db` | 修复 VAD 性能问题：setInterval 替代 rAF |
| `15384e4` | 修复 TTS 音频回环 + 损坏 WebM 处理 |
| `c05999b` | **集成百度 ASR** + Logger + 模型下载脚本 + 大规模重构 |
| `9b210a8` | 添加 README.md 和 MIT LICENSE |
| `0b04abd` | ASR/Whisper/TTS 管道重构 + ort-log |

**关键决策**：
- 引入百度 ASR 作为 Whisper 的回退方案
- ASR 三引擎回退链的设计确立：GPU Whisper → CPU Whisper → 百度 ASR
- 选择 `setInterval` 而非 `rAF` 驱动 VAD（稳定性和可调试性优先）

### 第三阶段：服务化架构重构（2026-06-02 至 2026-06-03）

项目经历了一次大规模模块化重构：

| 提交 | 说明 |
|------|------|
| `5affaef` | 拆分为 agent/asr/audio/core/ipc/llm/logger/memory/tts/wallpaper 模块 + Piper TTS |
| `e550c13` | 配置集中化、死代码清理、函数提取、JSDoc、渲染进程重组 |
| `2cd894f` | 添加 CI 工作流 + 每周审计工作流 |

**重构后的模块结构**：
```
src/main/
├── agent/       # 代理核心（编排器）
├── asr/         # 语音识别（三引擎）
├── audio/       # 音频服务
├── core/        # 内核基础设施（EventBus、StateManager 等）
├── ipc/         # IPC 通道注册
├── llm/         # LLM 抽象层（四模型分离）
├── logger/      # 日志
├── memory/      # 记忆系统
├── tts/         # 语音合成
└── wallpaper/   # 壁纸引擎集成
```

**关键决策**：模块化架构的奠基石，后续所有功能都基于此结构扩展。

### 第四阶段：进化、洞察与创造力系统（2026-06-04 至 2026-06-07）

密集的功能开发期，引入了项目的核心差异化能力：

| 提交 | 说明 |
|------|------|
| `40e91e6` | SelfEvolution 自进化系统 + Insight 检测器 + 向量/摘要记忆 + MCP ServerManager + Wiki 文档 |
| `3baab5c` | 增强 WhisperGPU + SelfEvolution + PlanManager |
| `85951a0` | Creativity 创造力引擎 + Insight 多样性改进 |
| `e14a955` | ASR 唤醒词优化：拼音归一化 + initial_prompt |
| `7447e60` | 部署指南 + WorkerPool 线程池 + 构建配置改进 |
| `58bed1d` | 修复应用图标 + 进化代理工作空间隔离 |
| `acb46a7` | 双模式系统提示词（陪伴 + 编程） |
| `24db40e` | 增强系统提示词（开发指令感知）+ Plugin 系统 + 服务重构 |
| `85e8727` | NSIS 安装器 + 自动更新 |
| `a3861b3` | 修复每机器 NSIS 安装（允许自定义安装盘） |
| `ec2c617` | 自托管更新服务器 |
| `32cc8f9` | CreativityService + HypothesisGenerator + UpdaterService + afterPack 脚本 |
| `b68543a` | Drizzle ORM 集成 + 工作流模块 + 记忆持久化到数据库 |

**关键决策**：
- 自进化系统成为项目的核心差异化特征
- 双模式系统提示（陪伴/编程）为 Agent OS 架构铺路
- Drizzle ORM 替代原始 SQLite 操作，统一数据访问层

### 第五阶段：SubAgent、知识图谱与 Telegram（2026-06-09 至 2026-06-13）

| 提交 | 说明 |
|------|------|
| `fe9ad47` | SubAgentPool 子代理池 + GpuDetector + ModelLoader + Plugin 系统 + LlmService/MCP/Creativity 增强 |
| `d03e675` | SelfEvolution 管道触发器 + MemoryService 完整 CRUD/搜索 + Inspiration 灵感模块 + Observability + KnowledgeGraph |
| 多次提交 | 进化系统开始**自主生成提交**（标记为 `[evolution] automated test commit`） |
| `eed5a57` | Telegram Bot 服务 + DWM 合成 + AudioService/TTS/VoiceInput 增强 |

**关键转折点**：从 2026-06-11 开始，SelfEvolution 系统开始自主生成代码修改并提交。这标志着项目从"人类编写的 AI 应用"转变为"具有自我修改能力的 AI 系统"。这一天产生了约 70 个进化驱动的提交。

**架构演进**：
- `SubAgentPool`：主 Agent 可以 spawn 子 Agent 并行处理任务
- `KnowledgeGraph`：实体-关系知识图谱（`LLMKnowledgeExtractor` 驱动）
- `MemoryService`：完整 CRUD + 搜索能力
- `TelegramService`：远程控制通道

### 第六阶段：Agent 状态机与工具调度器（2026-06-14）

| 提交 | 说明 |
|------|------|
| `58cf0af` + `2804fa8` | RunContext + ToolScheduler — 形式化状态机与并发调度 |
| `b0bab81` + `4965ce9` | AgentService 集成 RunContext + ToolScheduler |
| 约 30 次进化提交 | 进化系统持续改进 |

**架构升级**：
- `RunContext`：定义了 Agent 的运行时上下文和状态转换规则
- `ToolScheduler`：工具调用的并发调度器，替代了之前的顺序执行
- 工具循环变为**可中断**：EvolutionScheduler 获得活跃状态保护

### 第七阶段：Agent OS 架构（2026-06-19 至 2026-06-22）

重大架构升级，项目从"AI 助手"演变为"代理操作系统"：

| 提交 | 说明 |
|------|------|
| `5e90b29` | Agent OS Core Architecture v1.1：TaskGraph + Budget + Stability + Rollback |
| `4d6b89b` | v2.5 Agent OS：进程隔离的全面重构 |
| 多个 `[snapshot]` 提交 | 进化系统的多步骤计划执行框架 |

**v1.1 关键组件**：
- `TaskGraph`：任务依赖图编排
- `Budget`：资源预算管理（Token、时间）
- `Stability`：稳定性保证机制
- `Rollback`：失败回滚支持

**v2.5 关键特性**：
- 进程隔离：Agent 与 Task 分离独立的执行上下文
- `ChatExecutor` v2：聊天执行器（独立上下文 + toolLoop）
- `TaskExecutor` v2：进化循环执行引擎

**进化系统成熟度**：开始生成结构化的 `[snapshot] plan_XXXXXXXXXXXX_X_step_X` 格式提交，表明进化系统内部的多步骤计划执行器已经成熟。

### 第八阶段：元进化与创造力策略（2026-06-23 至 2026-06-26）

| 提交 | 说明 |
|------|------|
| `d120a8c` | Phase 3 Meta Evolution：MetaLearner + EvaluatorCalibrator + 内核模块 + 进程隔离 |
| `12ec87d` | 写作系统集成：角色概念图生成 |
| `6a59860` | 修复角色面板布局和概念图生成 |
| `b1486ba` | 创造力系统：Strategy 系统（受控概念混合） |

**Phase 3 Meta Evolution**：
- `MetaLearner`：突变追踪、策略评分
- `EvaluatorCalibrator`：评估权重校准
- `PromptEvolutionManager`：提示词覆盖进化
- 内核模块化：AgentModule / MemoryModule / McpModule / EvolutionModule

### 第九阶段：UI 重构与最新工作（2026-06-27）

当前阶段，密集的 UI 现代化重构：

| 提交 | 说明 |
|------|------|
| `bcd1a4b` | 创造力测试 + SkillAgentRegistry + Agent UI Bridge + ComfyUI 场景管线 |
| `4923165` | Persona 仲裁 + WorldTrend 重构 + Writing 意图检测 |
| `b963253` | **Slot 布局系统** + Chat Core 架构 |
| `0dedc14` | App.tsx 布局壳 + Token 更新 |
| `e92f9cf` | 清理死引用 |
| `a162ea7` | 流式文本显示 + Session 列表绑定 Sidebar |
| `25b917b` | 恢复语音输入 + 工具状态显示 |
| `c19e29d` | MainArea Slot 渲染 + InputBar 自动缩放 + 滚动条 + Sidebar 清理 |
| `2ff44fe` | VoiceInput/StatusBar 集成 + **删除 300 行死 CSS** |
| `e351e89` | 窗口可缩放（1024x680，最小 800x500） |
| `c1605d1` | 基于 Session 的消息过滤 + 自动 session_id |

**UI 重构重点**：
- **Slot 系统**：类比 VSCode 的 Editor/Terminal/Output Panel，定义了 3 种 Slot（chat / tool / preview）
- `SlotContext` + `ActiveSlot` 状态机管理视图切换
- 死 CSS 清理：从 500+ 行精简到 200+ 行
- Sidebar 会话分组 + 日期标签
- 窗口从固定大小变为可缩放

---

## 3. 架构总览

### 3.1 系统分层图

```
┌──────────────────────────────────────────────────────────────┐
│                    Perception Layer (感知层)                    │
│  麦克风 → VAD → ASR (Whisper GPU → CPU → Baidu)          │
│  键盘 (F2) → VoiceInput → IPC                              │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│                    Agent Core (代理核心)                       │
│  AgentService                                               │
│  ├─ ChatExecutor v2       ── 聊天执行器                      │
│  ├─ TaskExecutor v2       ── 进化任务执行器                    │
│  ├─ ToolScheduler         ── 并发工具调度                      │
│  ├─ SubAgentPool          ── 子代理池                        │
│  ├─ Guardrail / GoalGuardrail ── 安全护栏                     │
│  ├─ CircuitBreaker        ── 熔断器                          │
│  ├─ ResourceBudget        ── 资源预算                        │
│  ├─ ReflectLoop           ── 事后反思                        │
│  ├─ ProceduralMemory      ── 过程记忆                        │
│  ├─ FailureAnalyzer       ── 失败分析                        │
│  ├─ SleepCycle            ── 空闲维护循环                     │
│  ├─ ErrorClassifier       ── 错误分类                        │
│  └─ SessionRecoveryManager ── 会话恢复                       │
└──────────────────────────────────────────────────────────────┘
          ↓              ↓               ↓               ↓
┌──────────┐ ┌──────────────┐ ┌─────────────┐ ┌─────────────────┐
│ Services │ │ Self-* Systems │ │ Governance  │ │   Data Layer    │
│          │ │               │ │             │ │                 │
│ Llm     │ │ Evolution    │ │ Constitution│ │ SQLite (Drizzle) │
│ Memory  │ │ (2h cycle)   │ │ Capability  │ │ + Vector Store   │
│ TTS     │ │ Insight      │ │ Session     │ │ + Knowledge Graph│
│ ASR     │ │ Creativity   │ │ Governor    │ │ + File Workspace │
│ MCP     │ │ Inspiration  │ │ Health      │ │                 │
│ Plugin  │ │ Cognitive    │ │ Metrics     │ │                 │
│ Image   │ │ Observer     │ │ Guardrail   │ │                 │
└──────────┘ └──────────────┘ └─────────────┘ └─────────────────┘
          ↓                                               ↓
┌──────────────────────────────────────────────────────────────┐
│                    Render Layer (渲染层)                       │
│  Electron Renderer: React + TypeScript                       │
│  ├─ TopBar (拖拽区 + StatusBar + Agent 切换)                  │
│  ├─ Sidebar (会话列表)                                       │
│  ├─ MainArea (Slot 切换: Chat/Tool/Preview)                  │
│  ├─ InputBar (文本输入 + VoiceInput)                         │
│  └─ Waveform (Three.js 粒子动画)                             │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 数据流架构

系统有四种主要数据流：

**1. 用户输入流**（用户 → Agent → LLM → 工具 → 回复）：
```
Microphone/Keyboard → VoiceInput → IPC (ai:chunk) → AgentService
  → ConversationContext → LlmService.chatWithTools() → ToolScheduler
    → Tool Execution → LLM 继续 → 最终回复 → TTS + Renderer
```

**2. 自进化流**（2 小时间隔的自我改进循环）：
```
SelfEvolutionService (IDLE)
  → ANALYZING: 收集指标 → LLM 分析 → 生成计划
  → EXECUTING: 执行计划步骤（可包含子 Agent + git snapshot）
  → VERIFYING: 回归检测 + 沙箱验证 → 合并/回滚
  → COOLDOWN: 5 分钟冷却
```

**3. 认知流**（持续后台自我评估）：
```
CognitiveService
  → MetaCycle: 每周自我评估（Identity → EngineeringMemory → LLM → 特质更新）
  → GoalEngine: 目标优先级动态调整
  → TokenAccount: 每小时 8000 Token 自动津贴
```

**4. 观察者流**（4 小时间隔的外部信息采集）：
```
ObserverService
  → Collect (Bilibili/Douyin/GitHub/HN/RSS)
  → Trend Detection → Tension Field → Deep Research
  → Multi-Brain → Insight Composition → World Model Update
```

### 3.3 事件系统

EventBus 是系统的神经中枢，定义了约 70+ 类型化事件：

```
Event categories: task.* / voice.* / agent.* / tts.* / scheduler.*
  / engine.* / evolution.* / insight.* / creativity.* / recovery.*
  / stability.* / budget.* / guardrail.* / runtime.health.*
```

特性：
- 5 级优先级（critical / high / normal / low / monitor）
- 可选的 EventStore 持久化（事件溯源）
- `SubscriptionTracker` 批量清理
- `getStats()` 运行时诊断

---

## 4. Electron 主进程详解

### 4.1 启动流程（AppRuntime）

启动入口 `src/main/index.ts` → `AppRuntime.start()`，经 9 个阶段：

| 阶段 | 初始化内容 |
|------|-----------|
| 0 | CLI 参数解析、环境变量加载、Transformers 配置 |
| 1 | StateManager / ServerManager / LlmService / ASR / TTS / AgentService / SessionRecovery / Telegram |
| 2 | app.whenReady() → 数据库初始化 → 凭据迁移 → 创建 BrowserWindow → TTS 音频接收器 → UIBridge |
| 3 | MemoryService / SkillManager / Agent 依赖注入 |
| 4 | Kernel 创建 → 注册模块 → ProcessManager / WorkerPool / SessionGovernor / CheckpointV2 / SyscallBus / HealthChecker |
| 5 | PluginLoader / AuditTrail / Telegram Bot |
| 6 | IPC Handlers 注册 / ConstitutionEngine / CapabilityEngine / HealthChecker 子系统注册 |
| 7 | TaskRunner / MemoryIndexer / CognitiveService / LLMKnowledgeExtractor / SystemBus / 事件持久化 |
| 8 | Lazy Services：Evolution / Insight / Creativity / Inspiration / Observer / SleepCycle / ComfyUI / UUMIT 等 |
| 9 | GPU Whisper 异步初始化（超时或失败回退百度 ASR） |

**关闭流程**（有序）：
RuntimeHealthManager → SessionGovernor → HealthChecker → ProcessManager → WorkerPool → Kernel → 恢复检查点 → TaskRunner → ComfyUI → Memory → Evolution/Insight/Creativity → 取消订阅 → 关闭数据库

### 4.2 Kernel 模块化架构

```
Kernel (微内核)
├─ core 模块 (src/main/core/)        ── 不可热重载
├─ constitution 模块 (src/main/constitution/) ── 不可热重载
├─ kernel 模块 (src/main/core/Kernel) ── 不可热重载
├─ AgentModule (进程注册)             ── 可热重载
├─ MemoryModule                      ── 可热重载
├─ McpModule                         ── 可热重载
└─ EvolutionModule                   ── 可热重载
```

特性：
- `freezeModuleRegistry()`：冻结核心模块列表（防止运行时修改）
- `verifyIntegrity()`：检查所有模块存在且状态正确
- `hotReload(name)`：仅对标记为 hotReloadable 的模块生效
- `handleSyscall()`：内核系统调用路由（list_modules / get_module_info / reload_module）

### 4.3 窗口管理（Lifecycle.ts）

| 窗口类型 | 尺寸 | 特性 |
|---------|------|------|
| 主窗口 | 1024x680（最小 800x500） | 无框 / 透明 / 可缩放 / -webkit-app-region: drag |
| Agent 窗口 | 480x580 | 无框 / 透明 / 编码 Agent 面板 |

主要职责（尽管名为 Lifecycle，实际是窗口管理模块）：
- CSP 头设置（开发模式宽松，生产模式严格）
- DWM 白边修复（`disableNCRendering()`）
- 渲染进程崩溃/无响应处理（`app.relaunch()`）
- Wallpaper Engine 暂停/恢复监听

### 4.4 LLM 服务（LlmService）

四模型分离架构，全部基于 OpenAI 兼容 API：

```
LlmService
├─ Chat Model → LLM_API_URL / LLM_CHAT_MODEL / LLM_KEY
│   (对话、意图分类)
├─ Code Model → LLM_CODE_API_URL / LLM_CODE_MODEL / LLM_CODE_KEY
│   (工具循环、代码生成)
├─ Vision Model → LLM_VISION_API_URL / LLM_VISION_MODEL / LLM_VISION_KEY
│   (图片理解)
└─ Text Model → LLM_TEXT_API_URL / LLM_TEXT_MODEL / LLM_TEXT_KEY
    (摘要、提取、重写)
```

API 方法：
- `chatStream()`：流式对话，自动重试（429），SSE 解析，Token 计数，上下文裁剪
- `chatWithTools()`：非流式工具调用模式，验证工具调用链，3 次指数退避重试
- `chatWithToolsStream()`：流式变体，并行 Token 传递 + TTS
- `chatJson()` / `chatJsonWithCode()`：结构化 JSON 提取（含 markdown fence 回退）
- `chatVision()`：多模态图片理解
- `chatText()`：纯文本处理
- `classifyIntent()`：低温意图分类

### 4.5 ASR 系统

**三引擎回退链**：
```
Whisper GPU (Vulkan, RTX 3060, small model)
  → Whisper CPU (Xenova Transformers, tiny model, 按需初始化)
    → Baidu Cloud ASR API
```

关键特性：
- GPU 输出损坏检测：`isGarbled()` 基于 UTF-8 替换字符比例
- 噪声过滤：`isNoise()` 过滤纯标点、Whisper 幻觉（"谢谢大家"等常见误识别）
- 中文热词优化：拼音归一化 + initial_prompt（含 "秋山澪/贝斯/音阶" 等领域热词）

### 4.6 TTS 系统

**双引擎**：
- **Edge TTS**（云端）：zh-CN-XiaoxiaoNeural，+10% 速率，+8Hz 音高
- **Piper TTS**（本地离线）：通过 `USE_LOCAL_TTS` 标志切换

特性：
- 句子缓冲：`addChunk()` 积累缓冲区，标点分割，500ms 防抖批量合成
- 激进 Markdown 清洗：`cleanTTS()` 剥离标题/粗体/代码/链接/emoji/表格，中文多音字修复
- 回退播放：`_playAudio()` 使用 ffplay 进程

---

## 5. 渲染进程 UI 详解

### 5.1 整体结构

```
src/renderer/
├── index.html          # 主窗口 HTML（zh-CN, dark, transparent bg）
├── agent.html          # Agent 窗口 HTML（编码代理面板）
├── src/
│   ├── App.tsx         # 根组件（状态管理 + 布局编排）
│   ├── main.tsx        # React 入口（SlotProvider + StrictMode）
│   ├── slots/          # Slot 系统
│   │   ├── types.ts    # ActiveSlot / UiState / SlotRegistry
│   │   └── SlotContext.tsx  # React Context 状态管理
│   ├── components/     # 12 个 UI 组件
│   ├── hooks/          # 3 个自定义 Hook
│   └── styles/         # 4 个 CSS 文件
```

### 5.2 布局结构（App.tsx）

```
.app-shell (flex column, 100vh)
├── <TopBar>
│   ├── MenuToggle (sidebar 展开/折叠)
│   ├── "秋山澪" Logo
│   ├── <StatusBar>
│   │   ├── .status-dot (活跃/待命)
│   │   ├── 状态文本 ("回复中"/"正在聆听"/"待命")
│   │   ├── Persona 徽章 (hybrid/writer)
│   │   └── Session 健康指示器
│   └── Agent 窗口切换按钮
├── .app-body (flex row, flex: 1)
│   ├── <Sidebar>
│   │   ├── 日期分组 (今天/昨天/更早)
│   │   ├── Session 列表 (活跃高亮)
│   │   ├── 空状态: "暂无会话"
│   │   └── 搜索按钮
│   └── <MainArea>
│       ├── <ChatSlot>     (activeSlot === 'chat')
│       │   ├── 空状态: 聊天图标 + "开始一段新对话"
│       │   ├── 录音转写文本 (transcribed)
│       │   ├── 历史消息 (role/label/content/timestamp)
│       │   ├── 流式消息 (pendingText / displayText)
│       │   └── 自动滚动到底部
│       ├── <ToolSlot>     (activeSlot === 'tool')
│       │   └── 工具面板 (占位)
│       └── <PreviewSlot>  (activeSlot === 'preview')
│           └── 结果预览 (占位)
└── <InputBar>
    └── <VoiceInput> (voiceSlot prop)
```

### 5.3 Slot 系统

类比 VSCode 的多面板设计，Slot 系统管理主内容区的视图切换：

```typescript
type ActiveSlot = 'chat' | 'tool' | 'preview' | null

interface UiState {
  activeChatId: string
  sidebarOpen: boolean
  activeSlot: ActiveSlot
  commandMode: boolean
}
```

- 默认激活 `chat` slot
- ToolStatus 变化时自动切换到 `tool` slot（执行完毕后退回 `chat`）
- 命令模式（输入 `/`）切换 `commandMode`

### 5.4 VoiceInput 全双工语音系统

最复杂的 UI 组件，实现了完整的全双工语音对话：

**状态机**：`idle → wake → listening → processing → playing_tts → echo_tail`

**音频处理管线**：
```
麦克风 → getUserMedia (echoCancellation + noiseSuppression + autoGainControl)
  → AudioContext → 80Hz 高通 + 7600Hz 低通滤波 → ScriptProcessorNode
    → VAD (RMS + 零交叉率 + 动态噪声基底)
      → 语音检测 → 重采样 16kHz → ASR
```

**VAD 参数**：
| 参数 | 值 | 说明 |
|------|-----|------|
| SILENCE_MS | 6000 | 静默超时触发 ASR |
| MIN_SPEAKING_FRAMES | 2 | 最短语音帧 |
| GRACE_FRAMES | 40 | VAD 迟滞帧数 |
| RMS_MULTIPLIER | 2.5 | 动态阈值倍率 |
| NOISE_FLOOR_FRAMES | 50 | 噪声基底历史窗口 |
| SPEECH_ZCR_MAX | 0.25 | 语音零交叉率上限 |

**全双工 TTS 打断**：
- TTS 播放时 → `playing_tts` 模式（捕获但不发送音频）
- 用户说话（18 帧以上超阈值）→ 打断 TTS → `echo_tail` 防护
- 4s 回音尾期（5x 高阈值）→ 4s 静默冷却

### 5.5 设计系统（CSS Tokens）

使用 `oklch` 色彩空间（比 HSL 更感知均匀）：

```
Colors:
  bg-base:      oklch(0.22 0.04 50)    # 深色暖基底
  bg-surface:   oklch(0.27 0.04 50)    # 表面色
  accent:       oklch(0.58 0.2 28)     # 朱红强调色
  accent-blue:  oklch(0.55 0.12 240)   # 蓝色 Slot 指示器
  text-primary: oklch(0.85 0.02 50)    # 暖白文字

Font Sizes: display 24 / heading 16 / body 14 / small 12 / caption 11
Layout:     topbar 56px / sidebar 260px / chat max 720px
Animation:  glass / spring cubic-bezier, durations 200/350/600ms
```

### 5.6 Three.js Waveform

3D 粒子可视化组件（当前未在主流程中渲染）：
- 800 粒子球形云（sine 波动画）
- 5 同心波环（torus 线，蓝→紫渐变）
- 32 发光条（径向平面网格）
- 脉动核心球 + 发光环
- Additive Blending 辉光效果

---

## 6. 核心系统详解

### 6.1 AgentService（主编排器）

项目的心脏，约 550 行，连接所有子系统。

**构造时实例化的内部组件**：
- `ConversationContext`：消息历史管理
- `ChatExecutor` v2：聊天执行器
- `TaskExecutor` v2：进化任务执行器
- `ToolScheduler`：工具并发调度
- `Guardrail`：工具循环安全护栏
- `GoalGuardrail`：宪章合规性（来自 Governance）
- `CircuitBreaker`：级联故障预防（5 次失败 / 30s 窗口）
- `ResourceBudget`：每次请求的 LLM 调用预算
- `SubAgentPool`：子代理管理
- `ReflectLoop`：事后反思
- `ProceduralMemory`：过程记忆
- `FailureAnalyzer`：错误模式分析
- `SleepCycle`：空闲维护循环
- `SessionRecoveryManager`：检查点会话恢复
- `ErrorClassifier`：错误分类

**关键方法**：
- `processTextInput(text, requestId, source, extra)`：处理用户输入的入口点
- `stopConversation()`：中断对话
- `runSelfTask(task, systemPrompt)`：运行自主任务
- `saveRecoverySnapshot(trigger, error)`：创建恢复检查点
- `tryRestoreSession()`：从最新检查点恢复

### 6.2 SubAgentPool

让主 Agent 可以动态 spawn 子 Agent 并行处理任务：

```typescript
await subAgentPool.spawn('analyze-code', {
  task: 'Review the changes in PR #123',
  tools: ['readFile', 'grep', 'listFiles'],
  onResult: (result) => { ... }
})
```

### 6.3 错误分类与恢复（ErrorClassifier + FailureAnalyzer）

```
ErrorClassifier
├─ NETWORK:       LLM 超时/MCP 断开
├─ TOOL_EXEC:     工具执行失败/超时
├─ STATE_CORRUPTION: 检查点损坏 → 需回滚不可重试
├─ RESOURCE_EXHAUSTED: Token/预算耗尽
├─ CONSTRAINT:    Guardrail 拦截
└─ UNKNOWN:       无法分类
```

`FailureAnalyzer` 持续分析失败模式，将热点模式持久化到 `EngineeringMemory`。

### 6.4 Guardrail（安全护栏）

```typescript
interface ToolGuardrailCheck {
  allowed: boolean
  reason?: string
  severity?: 'warn' | 'block'
}
```

检查项：
- 工具调用参数合法性
- 路径安全性（防止目录穿越）
- 命令执行权限
- 资源使用上限
- 循环检测（防止死循环）

### 6.5 CircuitBreaker（熔断器）

- **阈值**：连续 5 次失败，30 秒滑动窗口
- **状态**：`CLOSED`（正常）→ `OPEN`（熔断）→ `HALF_OPEN`（试探恢复）
- **恢复**：HALF_OPEN 成功后自动 CLOSED，失败则回到 OPEN

---

## 7. 自进化系统

### 7.1 系统架构

```
SelfEvolutionService
├── Pipeline (4 阶段)
│   ├── EvolutionAnalyzer  (分析: 收集指标 + LLM 分析)
│   ├── EvolutionStrategizer (策略: 选择最优进化策略)
│   ├── EvolutionExecutor  (执行: 多步骤计划 + git snapshot)
│   └── EvolutionReviewer  (验证: 回归检测 + 沙箱验证)
├── Phase 3 Meta Evolution
│   ├── MetaLearner         (突变追踪 + 策略评分)
│   ├── EvaluatorCalibrator (权重校准)
│   └── PromptEvolutionManager (提示词覆盖进化)
├── Quality Gates
│   ├── ProposalValidator   (提案验证)
│   ├── RegressionDetector  (回归检测)
│   ├── SandboxValidator    (沙箱隔离验证)
│   ├── ResponseValidator   (响应验证)
│   └── VerificationRunner  (验证运行器)
├── EvolutionStateManager   (状态持久化)
├── EvolutionHistory        (循环历史)
├── EvolutionGitOps         (git 操作: 分支/提交/回滚)
├── PlanManager / DrizzlePlanManager (计划存储)
└── PlanIntegrityChecker    (计划完整性检查)
```

### 7.2 状态机

```
IDLE → ANALYZING → EXECUTING → VERIFYING → COOLDOWN → IDLE
       ↑                                              │
       └────────── (退化检测: 渐进退避) ──────────────┘
```

### 7.3 触发条件

- 稳定性下降（`stability.score` 下降）
- 预算耗尽（`budget.exhausted`）
- 循环失败（`evolution.cycle.failed`）
- **用户保护**：对话中自动跳过，10 分钟无活动超时

### 7.4 退化检测

当进化循环连续失败时，系统渐进退避：

```
30min → 1h → 2h → 4h (最大间隔)
同时升级安全模式: normal → cautious → review
```

### 7.5 进化自主提交

从 2026-06-11 开始，进化系统可以：
1. 分析运行日志和性能指标
2. 生成多步骤改进计划
3. 自主创建 git 分支并提交代码
4. 验证修改（回归测试 + 沙箱）
5. 合并成功/回滚失败
6. 提交标记为 `[evolution] automated test commit` 或 `[snapshot] plan_XXXX_step_X`

这是项目最独特的特性——系统具有自我修改能力。

---

## 8. 认知与创意系统

### 8.1 CognitiveService

**三个引擎 + 一个经济系统**：

| 组件 | 功能 |
|------|------|
| GoalEngine | 目标 CRUD + Token 感知优先级调整 |
| StrategyEngine | 策略存储 + 上下文匹配 + 失败模式分析 |
| MetaCycle | 每周 LLM 驱动的自我评估（EMA 平滑特质更新） |
| TokenEconomy | TokenAccount（8000/h 津贴）+ CostEstimator（成本估算） |

**IdentityModule**（从 CONSTITUTION.md 冷启动）：
- 解析宪章 → Core Identity / Capabilities / Personality / Constraints
- 3 个进化特质：`goal_alignment` / `tool_efficiency` / `response_quality`
- EMA 平滑（alpha=0.3）
- `getFormattedContext()` → 自我意识提示词段落

### 8.2 CreativityService

**概念重组引擎**：

```
Sources: Memory / MCP / ASR / TTS / Agent / Evolution / 
         Wallpaper / PiperTTS / UserBehavior / Plans
         → ConceptMixer → IdeaGenerator → NoveltyScorer
           → HypothesisGenerator → ExperimentPlanner
```

- 两种循环：**Normal**（概念混合）和 **Dream**（高随机性 + 失败吸纳）
- 3 种策略轮换：`explore` / `signal` / `stable`
- 5 阶段代码级新颖性评分（包含历史去重）
- 得分 > 220 的创意触发 `creativity.hypothesis.selected` 事件

### 8.3 ObserverService（观察者系统）

4 小时间隔的外部信息采集与分析管线：

```
DAG Pipeline:
Collect (5 collectors) → Trend Detection → Tension Field
  → Deep Research → Multi-Brain Processing
    → Insight Composition → World Model Update
      → Output Publication → Self Evolution
```

**5 个采集器**：
| 采集器 | 来源 |
|--------|------|
| BilibiliCollector | B 站热门 |
| DouyinCollector | 抖音热点 |
| GitHubTrendingCollector | GitHub 趋势 |
| HackerNewsCollector | Hacker News |
| RSSCollector | RSS 订阅源 |
| WeiboCollector | 微博热搜 |

---

## 9. 记忆系统

### 9.1 三层记忆架构

| 层级 | 最大条目数 | 衰减率 | 晋升条件 |
|------|-----------|--------|---------|
| Permanent（永久） | 10 | 1.0（永不衰减） | reinforce >= 5 或 confidence >= 0.97 |
| Semi（半永久） | 30 | 0.998（~346 天半衰期） | confidence >= 0.85 |
| Ephemeral（短期） | 50 | 0.99（~69 天半衰期） | 默认层级 |

### 9.2 子系统

| 子系统 | 功能 |
|--------|------|
| SummaryMemory | 定期对话摘要 |
| VectorMemory | 语义向量存储 + `querySync()` 检索 |
| KnowledgeGraph | 实体-关系图谱（LLMKnowledgeExtractor 驱动） |
| EngineeringMemory | 架构模式、失败模式、代码结构 |
| DecisionStore | 历史决策日志 |
| MetaController | 跨层协调 |
| UnifiedMemoryQuery | 统一跨系统查询 |

### 9.3 上下文构建

`getFormattedContext()` 构建可注入提示词的上下文：
```
永久事实（全部） + 高分半永久/短期 + 向量回忆 + 
摘要 + 交互历史 + 知识图谱
```

---

## 10. 数据层

### 10.1 数据库架构

- **引擎**：SQLite via `sql.js`（WASM 实现）
- **ORM**：Drizzle ORM 封装
- **文件位置**：`%APPDATA%/akemi-mio/akemi-mio.db`
- **持久化**：WAL 模式 + 10s 自动保存间隔

### 10.2 表结构

```
events          — 事件溯源
plans / planSteps — 进化计划
insights        — 洞察发现
conceptCombos / hypotheses / experiments / dreamCycles — 创意
memories / memorySummaries / memoryVectors — 记忆系统
credentials     — 加密凭据
goals / strategies / promptTemplates — 认知系统
messages        — 聊天历史（支持 Session 分组）
telegramOutbox  — Telegram 消息输出队列
decisions       — 决策存储
agent_events    — Agent 审计事件
procedures      — 过程记忆
identity_core / identity_traits / identity_metrics — 身份系统
```

---

## 11. 工具与技能系统

### 11.1 内置工具（30+）

| 类别 | 工具 |
|------|------|
| 文件操作 | readFile / writeFile / editFile / grep / listFiles |
| 命令执行 | runCommand |
| 编程工具 | analyzeCodebase / spawnSkillAgent |
| 计划工具 | createPlan / updatePlan / listPlans / completePlan / abandonPlan |
| 凭据管理 | getCredential / setCredential / listCredentials |
| 记忆工具 | rememberFact |
| 写作工具 | writingSystem |
| 图片生成 | generateImage / cardGenerator |
| 工作流 | workflow tools |
| 技能 | skill tools |
| SSH | centosExec / centosReadFile / centosWriteFile / centosGrep / centosSearchFiles |
| 社交 | socialPipeline / queryTrends |

### 11.2 技能系统（SkillManager）

用户安装的技能（`%APPDATA%/akemi-mio/skills/`）：
- 每个 Skill 有 `manifest.json` + 可选的 `prompt.md` / `SKILL.md`
- 两种类型：`knowledge`（仅提示词注入）和 `executor`（有工具能力）
- `SkillMatcher` 将用户输入匹配到技能

### 11.3 WorkflowEngine

16 个开发工作流技能，分三级：

| 复杂度 | 示例 | 包含阶段 |
|--------|------|---------|
| simple | "改样式" | 0-1 |
| medium | "加功能" | 0-4 |
| large | "架构升级" | 0-8 |

---

## 12. 插件与 MCP

### 12.1 Plugin 系统

```
Plugin
├── manifest: name / version / description / permissions
├── tools: ToolSchema[]
├── handle(toolName, args)
├── onLoad() / onUnload()
└── PluginAPI: toolRegistry / kvStorage / logger / httpClient
```

权限类型：`filesystem:read` / `filesystem:write` / `network:http` / `shell:exec` / `system:manage` / `storage:read` / `storage:write`

安全机制：
- `verifier.ts` + `signing-key.ts`：完整性验证
- `AuditTrail`：权限审计日志
- 内置插件完全受信（`@builtin/` 前缀）

### 12.2 MCP 系统

**三服务器类别**：
| 类别 | 说明 |
|------|------|
| `@builtin/core` | 本地工具（通过 LocalProviderAdapter） |
| `@builtin/mcp-mgr` | 管理工具（list/remove/connect MCP 服务器） |
| 外部 MCP 服务器 | Playwright、Writing 等 |

**健康管理**：
- 120s ± 15 健康检查
- 熔断器：3 次连续失败 → 60s OPEN
- 能力注册表：检测工具集漂移
- 重启预算：每小时最多 10 次自动重启

**传输层**：
- `StdioTransport`：子进程 + 行 JSON 解析
- `HttpTransport`：POST + SSE 响应
- TCP/SSE 连接支持

---

## 13. 治理与健康

### 13.1 ConstitutionEngine

从 `CONSTITUTION.md` 冷启动的 AI 身份宪章：
- Core Identity / Capabilities / Personality / Constraints
- 文件修改后自动触发身份更新
- 与 CapabilityEngine 集成进行文件写入路径验证

### 13.2 SessionGovernor

**会话级健康治理控制器**：

```
状态机: RUNNING → DEGRADED → RECOVERING → SAFE_MODE → REBUILDING → FATAL
```

**8 级恢复措施**：
1. 上下文压缩
2. 注入纠正提示
3. 模型切换（切到 deepseek-chat）
4. 工具降级（只读）
5. 清空上下文
6. 重建会话
7. 安全模式
8. 休眠

**健康评分阈值**：HEALTHY 95-100 / NORMAL 70-95 / RISKY 50-70 / CRITICAL 30-50 / CORRUPTED 0-30

### 13.3 RuntimeHealthManager

**4 维健康度**：
- Session 健康（35%）
- Capability 健康（20%）
- Task 健康（20%）
- Model 健康（25%）

30 秒间隔发布 `runtime.health.updated` 事件，60 点历史队列趋势分析。

### 13.4 CapabilityEngine

能力沙箱授权：
- `DelegationChain`：Token 父子关系权限委派
- 三种模式：`off`（全放行）/ `warn`（记录拒绝）/ `enforce`（阻止）
- Token 生命周期：请求 → 发放 → 委派（范围缩减）→ 撤销（链感知）

---

## 14. 外部集成

### 14.1 Telegram Bot

通过远程代理服务器 `skills.crlkcloud.cyou/telegram` 运行：

**4 个 Bot 人格**：
| 人格 | 用途 |
|------|------|
| chat | 对话 |
| push | 系统事件推送 |
| gen | 图片生成（直连 ComfyUI） |
| write | 写作 |

1s 轮询 `/poll`，400ms 防抖编辑器，4s 输入指示器。

### 14.2 ComfyUI 图像生成

- FLUX.1-schnell GGUF 模型
- 15s 健康检查，最多 3 次自动重启
- 支持自定义 workflow（`flux_pulid_api.json`）
- 图片生成结果通过 SSH 同步到远程服务器

### 14.3 UUMit 众包平台

对接 UUMit（任务市场平台）：
- 每 2 分钟扫描 AI & Automation 类别任务
- 关键词匹配自动申请
- 通过 MCP SSE 协议接入

### 14.4 更新服务器

自托管 `generic` 更新通道：`https://skills.crlkcloud.cyou/update`

---

## 15. CI/CD 与构建

### 15.1 构建流水线

```
npm run dev      → node scripts/dev.js (自定义开发脚本)
npm run build    → electron-vite build
npm run build:win    → build + electron-builder --win portable
npm run build:win:installer → build + electron-builder --win nsis
npm run publish:win   → build + electron-builder --win nsis --publish always
```

### 15.2 GitHub Workflows

| 工作流 | 触发条件 | 检查项 |
|--------|---------|--------|
| CI | push/PR | TypeCheck → Lint → Format Check → Test (coverage) → Build |
| Weekly Audit | 每周定时 | Tests → Dead Code Scan → Long Function Detection → Config Drift |
| Weekly Stress | 每周定时 | Stress / Benchmark / Endurance Tests |

### 15.3 测试

- **框架**：Vitest 4 with forks pool
- **覆盖率**：V8 引擎，30% 阈值
- **类型**：单元测试 + 集成测试 + 压力测试 + 耐久测试

---

## 16. 已知问题与路线图

### 16.1 运行时健康分析（2026-06-23）

分析约 49K 行日志后发现 4 个系统性缺陷：

**问题 1：能力集漂移（Capability Set Drift）**
- MCP 服务器报告 connected=true 但工具集从 28 个减少到 20 个
- 健康模型将 socket 存活等同于服务健康
- **教训：连接健康 ≠ 能力健康**

**问题 2：上下文完整性与状态损坏**
- DeepSeek 400 错误遵循确定性模式：损坏检查点恢复 → 无法匹配工具 → 400 → 重试 → 再次 400
- 错误分类缺少"状态损坏"类别
- **教训：状态损坏需要回滚而非重试**

**问题 3：任务健康与永远运行失败**
- 一个后台任务在每小时的第 16 分钟持续 18 小时超时 30 秒
- 调度器不区分任务关键性
- **教训：任务需要分级 + 自动禁用**

**问题 4：服务治理**
- UUMIT 服务每 30 秒轮询但从未配置 API 密钥，每天 2,880 条 WARN 日志（占总量的 13%）
- 没有 preflight 门控检查配置完整性
- **教训：已知不可能的任务不能运行**

**根本原因**：缺少一个 Runtime Health Management 层。提议 Phase 5 包含 RuntimeHealthManager / CapabilityRegistry / SessionGovernor / FailureRecoveryFramework / User-visibleDegradationLayer。

### 16.2 当前路线图

**Phase 1：安全性**（SessionGovernor + ErrorClassifier 集成）
**Phase 2：Agent 升级**（ChatExecutor v2 + TaskExecutor v2 + 流式 UI）
**Phase 3：元进化**（MetaLearner + PromptEvolutionManager + EvaluatorCalibrator）
**Phase 4：Agent OS**（TaskGraph + Budget + Stability + Rollback + 进程隔离）
**Phase 5：运行时健康管理**（提议但未实现）

### 16.3 技术债务

- 部分 CSS 仍有内联 `!important`
- 部分组件（ToolSlot / PreviewSlot）仍为占位符
- Three.js Waveform 未集成到主 UI
- 数据库迁移链管理未完全自动化
- 部分模块使用 `getRawDb()` 直接 SQL，绕过 Drizzle 抽象

---

## 17. 关键设计决策

### 17.1 为什么选择 Electron + 透明窗口？

壁纸模式需要叠加在 Wallpaper Engine 之上，Electron 的透明窗口和 `-webkit-app-region` 是最高效的方式。替代方案（QT / WinRT）需要更多底层工作。

### 17.2 为什么四模型分离？

不同任务对模型要求不同：
- 聊天需要高情商和创造力（Chat Model）
- 工具调用需要精确性和低延迟（Code Model）
- 视觉理解需要多模态能力（Vision Model）
- 摘要提取需要低成本和快速（Text Model）

分离后总成本低于使用单一强模型，且可以针对每个任务选择最优性价比。

### 17.3 为什么 ASR 三引擎回退？

Whisper GPU（Vulkan）在 RTX 3060 上推理速度约 200-500ms，但 GPU 驱动可能崩溃；CPU Whisper 慢（2-5s）但可靠；百度 ASR 作为云端最后保障。三引擎确保在任一个引擎失败时系统仍可工作。

### 17.4 为什么自进化系统选择 2 小时间隔？

- 太短（<30min）会产生噪音波动导致误触发
- 太长（>6h）会错过及时改进窗口
- 2 小时平衡了数据积累和响应及时性

### 17.5 为什么三层记忆 + 向量记忆？

- 永久层：关键用户事实（永远不会忘记）
- 半永久层：重要知识（渐进衰减）
- 短期层：瞬时信息（快速遗忘）
- 向量层：语义相似性检索（弥补关键词不足）
- 知识图谱：实体关系推理（结构化管理）

### 17.6 为什么 Drizzle ORM 而非 Prisma？

- sql.js（WASM SQLite）兼容性
- 更轻量（无 Prisma Engine 二进制文件）
- 更好的 Electron 环境适配

### 17.7 为什么 Slot UI 系统？

受到 VSCode 的面板系统启发：
- `chat` = Editor（主要内容）
- `tool` = Terminal（工具执行反馈）
- `preview` = Preview（结果预览）
- 分离关注点，避免单个组件过于复杂

### 17.8 为什么 Agent OS 架构？

从"AI 聊天助手"演变为"Agent OS"的原因：
- 需要支持并发子代理（SubAgentPool）
- 需要进程隔离（Chat vs Task 分离）
- 需要资源治理（Budget / CircuitBreaker）
- 需要自我改进（Evolution System）
- 需要外部集成（MCP / Plugin / Telegram）

Agent OS 架构将这堆需求统一为**框架提供的系统服务**，而非应用层的特设解决。

---

## 附录 A：目录结构

```
akemi-mio/
├── src/
│   ├── main/           # Electron 主进程
│   │   ├── agent/      # 代理核心 (AgentService, ChatExecutor, TaskExecutor, SubAgentPool...)
│   │   ├── asr/        # 语音识别 (WhisperGPU, WhisperCPU, BaiduEngine)
│   │   ├── audio/      # 音频服务
│   │   ├── audit/      # 审计 (EventAuditor)
│   │   ├── bootstrap/  # 启动 (AppRuntime, Container)
│   │   ├── capability/ # 能力沙箱
│   │   ├── cognitive/  # 认知系统 (GoalEngine, StrategyEngine, MetaCycle, TokenEconomy)
│   │   ├── config/     # 配置加载
│   │   ├── constitution/ # 宪章引擎
│   │   ├── core/       # 内核 (Kernel, EventBus, StateManager, ProcessManager, WorkerPool...)
│   │   ├── credentials/ # 凭据管理
│   │   ├── creativity/ # 创造力引擎
│   │   ├── db/         # 数据库 (Drizzle ORM, Schema, Migration)
│   │   ├── evolution/  # 自进化系统
│   │   ├── governance/ # 治理 (SessionGovernor, HealthScorer, GoalGuardrail...)
│   │   ├── health/     # 健康管理 (RuntimeHealthManager)
│   │   ├── identity/   # 身份系统
│   │   ├── image/      # 图像生成 (ComfyUIManager)
│   │   ├── insight/    # 洞察引擎
│   │   ├── inspiration/ # 灵感 (GitHub)
│   │   ├── ipc/        # IPC 通道
│   │   ├── llm/        # LLM 服务 (4-model abstraction)
│   │   ├── logger/     # 日志
│   │   ├── mcp/        # MCP 客户端 (ServerManager, McpClient, transport)
│   │   ├── memory/     # 记忆系统
│   │   ├── observability/ # 可观测性 (MetricsCollector)
│   │   ├── observer/   # 观察者系统 (DAG Pipeline, 5 collectors)
│   │   ├── plugin/     # 插件系统
│   │   ├── skill/      # 技能系统
│   │   ├── telegram/   # Telegram 机器人
│   │   ├── tool/       # 工具系统 (30+ 工具定义)
│   │   ├── tts/        # 语音合成
│   │   ├── updater/    # 自动更新
│   │   ├── uumit/      # 众包平台
│   │   ├── utils/      # 工具函数
│   │   ├── wallpaper/  # 壁纸模式
│   │   ├── workflow/   # 工作流引擎 (16 技能)
│   │   └── __tests__/  # 测试
│   ├── preload/        # Electron preload (contextBridge)
│   └── renderer/       # React UI
│       └── src/
│           ├── components/ # 12 组件
│           ├── hooks/      # 3 自定义 Hook
│           ├── slots/      # Slot 系统
│           └── styles/     # 4 CSS 文件
├── docs/               # 文档
├── scripts/            # 开发脚本
├── server/             # MCP + Express 服务器
├── telegram-bot/       # Telegram Bot (独立)
├── build/              # 构建资源
└── .github/workflows/  # CI
```

## 附录 B：版本记录

| 阶段 | 日期 | 版本 | 说明 |
|------|------|------|------|
| Foundation | 2026-05-26 | - | Electron 脚手架 + VAD + ASR + TTS + UI |
| Multi-Engine | 2026-05-27~30 | - | 百度 ASR + Piper TTS + Logger |
| Modular | 2026-06-02~03 | - | 服务化架构重构 |
| Self-* | 2026-06-04~07 | - | Evolution + Insight + Creativity + Memory |
| SubAgent | 2026-06-09~13 | - | SubAgentPool + KG + Telegram + Plugin |
| StateMachine | 2026-06-14 | - | RunContext + ToolScheduler |
| Agent OS v1.1 | 2026-06-19 | v1.1 | TaskGraph + Budget + Rollback |
| Agent OS v2.5 | 2026-06-21 | v2.5 | 进程隔离 + ChatExecutor v2 |
| Meta Evolution | 2026-06-23 | - | MetaLearner + PromptEvolution |
| UI Refactor | 2026-06-27 | - | Slot 系统 + 布局重构 |
