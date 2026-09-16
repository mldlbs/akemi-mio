# 子服务报错处理报告（piper TTS / ComfyUI）

**日期**：2026-09-16
**触发**：启动日志里 piper 与 comfyui 持续报错
**结论**：**不是缺包，是两个独立的「解析/版本」问题。零依赖安装。**

---

## 一、最初的误判（必须记下来）

上一轮我在日志里看到 `ModuleNotFoundError: No module named 'numpy'`，写下了
「系统 python 没装 numpy」的结论。**这是错的。** 实测推翻：

```
裸 `python`   →  C:\Users\gf191\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe   ← 空解释器
探测带包解释器 →  C:\Users\gf191\AppData\Local\Programs\Python\Python312\python.exe          ← 依赖齐全
```

系统 Python 3.12 **已装**：`piper 2.11.0+cu128`、`numpy`、`torch 2.11.0+cu128`、
`torchvision`、`sqlalchemy 2.0.50`、`aiohttp`、`PIL`、`einops`、`transformers`、`safetensors`。

**真正的问题**：PATH 上 `python` 先命中了 WorkBuddy 托管的空 3.13。

---

## 二、根因一：解释器选错了

### 为什么 dev 正常、打包版必坏

`scripts/dev.js:120` **早就**做了探测（`findPythonWithPackage('piper')`），
把结果作为 `PIPER_PYTHON` 环境变量传给主进程。

**但打包版不经过 dev.js** —— 没有这个环境变量，于是落到裸 `python`。
差异不在依赖，在这一条解析链上。

### 修法

把探测**下沉到配置层**，让 dev 与打包版共用同一套逻辑：

`packages/core/src/config/index.ts`
- 新增 `findPythonWithPackage(pkg)` —— 用 `spawnSync` 探测哪个解释器真装了该包
- 新增 `resolvePiperPython()` —— 优先级：env → 探测结果 → 裸 `python`；带模块级缓存
- 原常量 `PIPER_PYTHON` **改成懒函数 `piperPython()`**

消费方：
- `packages/audio/src/PiperOrchestrator.ts` —— 调用 `piperPython()`
- `packages/image/src/ComfyUIManager.ts:121` —— 原读 `process.env.PIPER_PYTHON`
  （打包版为空，仍会退化成裸 python）→ 改调 `piperPython()`

**为什么必须懒解析**：`config` 被 89 个文件 import，若在模块加载期做同步
`spawnSync`，所有 import 它的文件都要白付一次启动代价。

---

## 三、根因二：userData 里的 piper 脚本是旧版本

解释器修对之后，**piper 仍然坏**，但报错变了：

```
FileNotFoundError: 'D:\work\code\akemi-mio\models\piper\zh_CN-huayan-medium.onnx.json'
```

而模型**明明存在**于 `%APPDATA%\akemi-mio\models\piper\`。

### 原因

`%APPDATA%\akemi-mio\scripts\piper_speak.py` 是一份 **6 月的旧脚本**，
与仓库版本**接口完全不兼容**：

| | userData 旧脚本 | 仓库正确脚本 |
|---|---|---|
| 取模型路径的方式 | `os.environ['PIPER_MODEL_PATH']` | `--model` **CLI 参数** |
| 回落默认值 | **硬编码** `D:\work\code\akemi-mio\models\...` | 无（required） |
| 有无 argparse | **没有** | 有 |

主进程传的是 `--model <userData路径>`，旧脚本**根本不认**这个参数，
直接按硬编码路径去找模型 → 指向一个不存在的仓库目录。

**为什么没人发现**：
- 全仓**没有任何机制**把 `scripts/piper_speak.py` 同步到 userData
- `scripts/` 也**没打进 asar**（`electron-builder.yml` 的 `files` 只收
  `out/**`、`package.json`、`CONSTITUTION.md`）
- dev 之所以正常，只因非打包态 `PIPER_SCRIPT` 优先取**仓库**脚本

### 修法

- `electron-builder.yml`：`extraResources` 增加 `scripts/piper_speak.py`
  —— **必须以文件形式**（裸 python 读不了 asar 里的成员）
- `config` 新增 `resolvePiperScript()`（懒 + 缓存）：
  - 打包态：以 `resources/scripts/piper_speak.py` 为准，
    **内容不同才**覆盖 userData 副本
  - 开发态：直接用仓库脚本
- `PiperOrchestrator.ts` 调用点改 `resolvePiperScript()`
- 原 `PIPER_SCRIPT` 常量标 `@deprecated` 保留兼容

---

## 四、验证（全部真机实测）

### 验证一：脚本自动同步（故意还原坏环境）

启动 pkg14 前**故意把 userData 脚本还原成陈旧版本**：

```
启动前: PIPER_MODEL_PATH=true   argparse=false
启动后: PIPER_MODEL_PATH=false  argparse=true    是否被覆盖: 是 ✔
```

### 验证二：pkg12（改前） vs pkg14（改后）

| 指标 | pkg12 | pkg14 |
|---|---|---|
| `No module named` | 53 | **0** |
| `comfyui_ready` | 无 | **1** |
| `comfyui_restart` | 6 | **0** |
| `comfyui_start_timeout` | 4 | **0** |
| `comfyui_exit` | 1 | **0** |
| `piper_warmup_success` | 无 | **1** |
| `piper_warmup_failed` | 有 | **0** |
| piper stderr 错误 | 63 | **0** |
| `phrase_pregen_completed` | `generated:0 failed:24` | **`generated:24 failed:0`** |

### 最硬的一条证据

`%APPDATA%\akemi-mio\tts_cache\` 从**空目录**变成 **24 个真实 WAV（7.5MB）**，
用 Python `wave` 逐个校验有效：

```
1ch 22050Hz 15360frames 0.70s  ✔
```

同时 ComfyUI 真正就绪：8188 LISTENING + `curl http://127.0.0.1:8188/` → **HTTP 200**。

### 测试

- `piper-script-contract.test.ts`：6/6 通过
- **做了变异检验**（故意改坏 4 处，确认测试都会红）：
  1. `piperPython()` 退回 `'python'` → 红
  2. config 探测换成裸 `'python'` → 红
  3. 去掉「内容不同才覆盖」守卫 → 红
  4. `resolvePiperScript()` 退回常量 → 红
- 全量：**283 文件 / 2920 通过 / 0 失败**
- typecheck（node + web）：均 0 错误

---

## 五、两个「不是问题」的澄清

1. **剩下的 2 条 `piper_warmup_model_unavailable`**
   （`zh_CN-ling_ling-medium`、`zh_CN-tx_mati-medium`）
   是这两个**音色本来就没装**（只有 `huayan` 装了）。配置使然，不是 bug。

2. **ComfyUI 启动时的 3 条 `ModuleNotFoundError`**
   （`triton` / `gguf` / `insightface`）属于**可选第三方 custom_nodes**，
   只打 `[WARNING] Cannot import ... custom nodes` 后就继续，非核心依赖。

3. **`PromptEvolutionManager.test.ts` 的 2 条未处理拒绝**
   （`prompt_llm_evolve_timeout`）是**既有**的测试隔离问题
   （`withTimeout` 在测试结束后才 fire，仅并行负载下出现）。
   单独跑该文件 14/14 通过无报错；把我的改动 stash 掉后全量跑**同样有**。

---

## 六、验证打包版时的仪器教训（本轮都真踩到）

1. **单实例锁会让新包静默不启动**
   pkg12 还活着时启 pkg13，两者共用同一 userData（`%APPDATA%\akemi-mio`）
   → pkg13 拿不到锁直接退出。我第一版分析的那份日志**大部分是 pkg12 写的**，
   差点得出完全错误的结论。
   **教训：换包验证前必须先杀干净旧实例，并清掉孤儿 MCP（1841 端口）。**

2. **`stdio:'pipe'` + 父进程 exit 会截断子进程输出**
   第一版探针只拿到 4 秒日志，所有指标都是 0，
   把「根本没启动」误读成了「启动得很干净」。
   **教训：stdout/stderr 直接写文件 + 轮询进程存活；
   判据里必须同时有正向指标（`comfyui_ready` / `lazy_init_all_done`），
   否则"全 0"分不清是"修好了"还是"根本没跑"。**

---

## 七、改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/config/index.ts` | 新增 `findPythonWithPackage()` / `resolvePiperPython()` / `resolvePiperScript()`；`PIPER_PYTHON` → 懒函数 `piperPython()`；`PIPER_SCRIPT` 标 deprecated |
| `packages/audio/src/PiperOrchestrator.ts` | import 与调用点改用 `piperPython()` / `resolvePiperScript()` |
| `packages/image/src/ComfyUIManager.ts` | Python 解析改用 `piperPython()` |
| `electron-builder.yml` | `extraResources` 增加 `scripts/piper_speak.py` |
| `tests/main/tts/__tests__/piper-script-contract.test.ts` | 断言改为锁**行为**（探测路径 + 脚本同步），并加变异验证 |

**未改动**：`scripts/dev.js`（env 优先级已在 `resolvePiperPython` 中保留）。
