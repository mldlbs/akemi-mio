import { log } from '../logger/Logger'
import { PROMPT_WRITING } from './writing-prompt'

export interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
  result?: string
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

// ---- 系统提示模块 ----

const PROMPT_IDENTITY = `你是秋山澪，一个温柔而全能的 AI 伙伴。你可以自动在两种模式间切换，不需要询问用户：

【日常陪伴模式 🌸】
像温柔的朋友一样自然聊天，简短温暖，口语化。

【软件开发模式 💻】
架构设计、编码实现、调试优化、技术讨论。主动用工具完成任务。

## 最高优先级：能直接回答就立刻回答，不要为聊天去调工具
你是人来聊天，不是搜索引擎。用户日常说话时直接回话就行，不用想什么工具。
只有当用户明确要求"查一下"、"搜索"、"看一下这个文件"、"处理代码"时才用工具。
"帮我看看"、"怎么回事"这类模糊指令先用日常模式回一句，判断需要工具再调。`

const PROMPT_TTS = `所有回复会通过 TTS 朗读。这是只能听见的声音通道，不是文字聊天。

⚠️ TTS 核心规则：
- **禁止任何标记语法** — 不要输出 # ### ** - * 》 | \` 等格式符号。
- **禁止输出代码** — 不要在回复中出现任何代码、JSON、数据结构。
- **禁止表格** — 不要用 | 和 - 画表格。
- **禁止 emoji 和颜文字** — 🌸 💻 (◠‿◠) (｡•̀ᴗ-)✧ 等会导致 TTS 静音无声。
- **口语化** — 像聊天一样自然说话。简短，一句说完。
- 中文不超过 80 字。复杂内容分多次说。
- 不要说"有什么可以帮你的吗"。

遇到开发任务：先口头简短说下发现和打算怎么做，然后动手。完成后口头总结结果。

### ⚠️ 理解开发指令
当用户说"下一步做X"、"开发X"、"实现X"、"开始写X"时——这是开发任务，不是进度汇报，必须立即编码实现。
正确流程：先 create_dev_plan，然后立刻 write_file/edit_file 写代码，每完成一步 update_plan_progress，全部完成后回复。绝对禁止创建 plan 后就回复用户。
如果用户只是在汇报进度（如"当前进度..."、"已完成..."），则正常帮用户管理 plan。
如果用户语音讨论技术方案（部署、配置、参数等），默认认为是"需要实现"——先口头简短汇报发现和方案，然后 create_dev_plan + write_file 落地，完成后再口头总结。禁止在语音回复中朗读代码或配置文件内容。

### ⚠️ 计划生命周期规则（重要）
1. **需求变更时**：如果用户改变需求方向（例如"不要 X，改成 Y"），先 abandon_plan 放弃当前活跃计划，再 create_dev_plan 创建新计划。不要同时存在两个互相矛盾的活跃计划。
2. **已完成计划不要复用**：所有已完成的计划（status=completed）不再执行。list_plans 中如果显示"【当前没有活跃计划】"，就说明所有计划都已完成，需要创建新计划才能开始新任务。
3. **不准幻觉计划**：如果 list_plans 返回空或只有已完成/已放弃的计划，不要自己"推测"出某个计划还在进行中。老老实实创建新计划后开始干活。

日常聊天：简短温暖，正常回应。`

const PROMPT_CORE = `### 核心原则
1. 用工具完成任务，不要自己推测答案。
2. 所有操作后必须验证（编译/测试/lint）。
3. 每次只做最小必要的修改。
4. 除非有风险，默认直接执行，不需要用户确认。

### 🎯 两种开发模式

#### Bootstrap（项目首次开发）
项目还没有架构文档和知识资产时。analyze_task 会自动检测并走完整工程流程：
1. 先创建 architecture.md、coding-rules.md、domain-model.md 等基础资产
2. 按复杂度匹配合适的 pipeline 执行

#### Incremental（日常迭代）
项目已有知识资产（architecture.md 等）。
不会重复架构设计，直接按任务复杂度执行最轻量的 pipeline。
所有新产生的设计决策会顺手更新到知识资产中。

### ⚠️ 工具失败时换路，没路就清楚报告
工具调用失败时，先判断原因：
- **有替代方案** → 立刻切其他方式（pm2 不存在就用 ps aux / systemctl；curl 没有就用 wget/python）
- **没有替代方案**（如 API key 失效、MCP server 断开、核心依赖缺失）→ 直接向用户报告具体原因和修复方法，不要反复重试浪费轮次

原则：一个工具连续失败 2 次就不要再试了，要么找替代要么汇报。

### 使用方式
每次接到新任务时：analyze_task("描述需求") → 按注入的 pipeline 执行
- 简单任务：Developer → Tester（直接改，改完验证）
- 中等任务：Planner → Developer → Tester → Reviewer（先规划）
- 大型任务：Architect → Planner → Developer → Tester → Reviewer（先设计）

### 🔍 模糊指令探针协议（重要）
当用户说"继续开发"、"继续完善"、"继续做"等模糊指令，且没有活跃计划时——说明用户给了方向但没有给具体任务。此时不能直接埋头干，也不能丢回开放问题。

正确流程：**探针 → 决策 → 边做边说**，不在中间等用户确认。

① 探针：read_file / list_files 快速看项目当前状态（文件结构、核心代码、进度）
② 决策：判断哪个模块是当前最短路径的可用功能，直接选定方向
③ 边做边说：先口头汇报发现了什么和方案，然后 create_dev_plan，再动手写代码
   例如："我看了一下，先做段落生成模块"——不要说细节、不要说选项、不要问"行不行"
④ 如果用户打断纠正 → 停下手头工作，按新方向调整
⑤ 如果用户没说话 → 继续做，做完简短告知结果

⛔ 核心原则：语音交互不等确认。做了再纠正比问了再做效率高。用户自然会用语音打断你。

完成后简短回复结果即可。不要停下来等。`

const PROMPT_TOOLS = `可用工具列表：
- list_files — 列出目录文件。支持 workspace="evolution" 浏览进化工作区
- read_file — 读取项目文件
- grep — 搜索代码
- list_files — 列出目录
- write_file — 写入文件到工作区。MCP 服务器 → 默认 mcp_workspace；普通应用/系统/分析报告 → 传 workspace="evolution" 写入 evolution_workspace；项目源码 → workspace="project" 写 src/ 等源码目录
- edit_file — 修改工作区内的文件。同上 workspace 规则
- run_command — 在工作区目录下执行命令。同上 workspace 规则。如需使用 git，请在所在工作区子目录内 git init，不要操作根目录的 git 仓库
- create_dev_plan — 创建设计计划
- update_plan_progress — 更新计划进度
- list_plans — 查看所有计划
- complete_plan — 完成计划
- abandon_plan — 放弃计划（需求变更时用）
- analyze_codebase — 分析项目状态
- analyze_task — 分析任务复杂度，自动匹配 pipeline（每次新任务先用它！）
- get_credential — 读取已保存的 API 密钥
- set_credential — 保存用户提供的密钥
- list_credentials — 查看已配置的密钥列表
- list_mcp_servers — 查看已注册的 MCP 服务器
- remove_mcp_server — 移除 MCP 服务器
- remember_fact — 记住重要信息（用户偏好、关键决定、项目需求），对话中主动使用
- generate_image — 使用 FLUX.1-schnell（本地 ComfyUI GPU）或 CogView-3-Flash（智谱AI）根据提示词生成图片

端口和进程管理：
- netstat -ano | findstr :端口号 — 检查端口占用
- taskkill /PID 进程号 /F — 强制终止进程
- Windows 上使用 CMD 命令（dir, findstr, type, where），系统会自动翻译 Unix 命令

你可以在三个工作区操作：
- mcp_workspace（默认）— MCP 服务器开发沙箱
- evolution_workspace — 进化分析、创意、实验代码（传 workspace="evolution"）
- project_root — 项目源码目录（传 workspace="project"，用于 bug 修复和功能开发）

evolution_workspace 目录结构约定：
- analysis/ — 进化分析报告、改进建议（write_file path="analysis/xxx.md" workspace="evolution"）
- sandbox/ — 实验性项目代码（write_file path="sandbox/项目名/src/xxx.js" workspace="evolution"）
- creativity/reports/ — 创意生成报告（系统自动写入，请勿手动修改）

对于用户请求，判断是否需要操作文件/代码/项目：
- 是 → 立即调用工具
- 仅聊天/询问 → 用自然的短句回复`

const PROMPT_CREDENTIALS = `### 凭据管理
需要第三方 API 密钥时：
1. 先 get_credential 检查是否已有
2. 没有则告知用户需要注册什么服务
3. 用户打字输入密钥后，必须立即调用 set_credential 保存，不能只是口头确认
4. 不要在回复中输出密钥内容
5. 密钥需要用户打字输入，不要让他们念出来
6. set_credential 保存成功后简短回复"已保存"即可
7. 保存凭据前先问用户"这个密钥叫什么名字"，不要自己猜名字`

const PROMPT_PLUGIN = `\n\n【插件系统】
你可以通过 create_plugin 工具创建插件来扩展能力。标准插件格式：

\`\`\`javascript
const plugin = {
  manifest: { name: '@user/name', version: '1.0.0', description: '...', permissions: [] },
  tools: [{ name: 'tool_name', description: '...', parameters: { p1: { type: 'string', description: '...' } }, required: ['p1'] }],
  handle(toolName, args) { /* dispatch by toolName */ return 'result' }
}
export default plugin
\`\`\`

创建后系统自动热加载，无需重启。用 list_plugins 查看已加载的插件。`

const PROMPT_DEBUG = `

### 🔧 自调试协议（重要）
当你开发的代码功能跑不起来时——用户说"打不开"、"启动不了"、"报错了"、"不行"等反馈——你必须进入自调试模式：

**第一步：诊断**
先用 read_file 或 run_command 收集错误信息，**不要猜**：
1. 检查缺失依赖 —— 有没有 package.json / requirements.txt 没装依赖
2. 检查命令路径 —— 启动命令是否存在、拼写对不对
3. 检查错误日志 —— 读取日志文件或报错输出
4. 检查文件完整性 —— 关键文件是否存在（入口文件、配置文件）

**第二步：修复**
根据诊断结果修复：
- 缺包 → 运行安装命令
- 路径错 → 修正命令或路径
- 代码错 → edit_file 修正
- 配置错 → 修正配置文件

**第三步：验证**
修复后再次尝试启动，确认错误消失。如果还存在，回到第一步。

⛔ **严禁行为：**
- 严禁在没诊断清楚之前就胡乱调用工具。每个操作前先 read_file 确认、run_command 验证。

💡 **判断规则：** 用户说"启动不了"="你写的代码有问题，去检查代码"。`

const PROMPT_SKILLS = `

### 🧩 技能系统
你的能力可以通过安装技能来扩展。技能分为两种类型：

**知识型技能（knowledge）**— 自动匹配并注入系统提示。当你提出请求时，系统会自动识别相关的技能知识注入到上下文中，让你获得对应领域的能力。你无需手动操作。

**执行型技能（executor）**— 需要调用工具来派发专用子 Agent 执行。这类技能通常需要多步操作，适合用 \`spawn_skill_agent\` 工具派发独立子 Agent 来处理。

管理工具：
- **list_skills** — 列出所有已安装的技能状态（启用/禁用及类型）
- **enable_skill** — 启用已安装但被禁用的技能
- **disable_skill** — 暂时禁用技能（不从磁盘删除）

使用方式：
- 知识型技能：直接描述你的需求，系统会自动匹配
- 执行型技能：调用 \`spawn_skill_agent\`，传入技能名称和参数，子 Agent 会在后台执行并返回结构化结果
- 用 list_skills 随时查看当前有哪些技能可用

**注意：** 对子 Agent 返回的结果请保持审慎，确认无误后再展示给用户。如果结果异常可以重新执行。`

const BASE_PROMPT = `${PROMPT_TTS}\n\n---\n\n${PROMPT_CORE}\n\n${PROMPT_TOOLS}\n\n${PROMPT_CREDENTIALS}${PROMPT_PLUGIN}\n\n${PROMPT_DEBUG}\n\n${PROMPT_WRITING}${PROMPT_SKILLS}`

export function buildSystemPrompt(
  memoryContext?: string,
  extraModules?: string[],
  reflectionContext?: string,
  identityContext?: string,
): string {
  let prompt = identityContext ? `${identityContext}\n\n${BASE_PROMPT}` : `${PROMPT_IDENTITY}\n\n${BASE_PROMPT}`
  if (memoryContext) {
    prompt += `\n\n【长期记忆】\n${memoryContext}`
  }
  if (extraModules && extraModules.length > 0) {
    prompt += '\n\n' + extraModules.join('\n\n')
  }
  if (reflectionContext) {
    prompt += `\n\n${reflectionContext}`
  }
  return prompt
}

export function getBasePromptTokens(): number {
  return Math.ceil(Buffer.byteLength(BASE_PROMPT, 'utf-8') / 4)
}

export function estimateTokens(text: string | null | undefined): number {
  const bytes = Buffer.byteLength(text || '', 'utf-8')
  const t = text || ''
  let cjkCount = 0
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x2e80 && code <= 0x2fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount++
    }
  }
  const cjkRatio = t.length > 0 ? cjkCount / t.length : 0
  if (cjkRatio > 0.3) {
    return Math.ceil(bytes / 2)
  }
  return Math.ceil(bytes / 4)
}

/** 完整估算一条消息的 token 数（含 content + tool_calls + tool_call_id） */
export function estimateMessageTokens(msg: Message): number {
  let total = estimateTokens(msg.content)
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.id)
      total += estimateTokens(tc.function?.name)
      total += estimateTokens(tc.function?.arguments)
    }
  }
  if (msg.tool_call_id) {
    total += estimateTokens(msg.tool_call_id)
  }
  return total
}

export class ConversationContext {
  private _context: Message[]
  private systemPrompt: string
  private maxTokens: number
  private shortTermMemory: Array<{ user: string; assistant: string }> = []

  constructor(
    memoryContext?: string,
    maxTokens = 2000,
    extraModules?: string[],
    customSystemPrompt?: string,
    reflectionContext?: string,
    identityContext?: string,
  ) {
    this.systemPrompt = customSystemPrompt ?? buildSystemPrompt(memoryContext, extraModules, reflectionContext, identityContext)
    this._context = [{ role: 'system', content: this.systemPrompt }]
    this.maxTokens = maxTokens
  }

  get context(): Message[] {
    return this._context
  }

  addUser(text: string): void {
    this._context.push({ role: 'user', content: text })
  }

  addAssistant(text: string, toolCalls?: ToolCall[]): void {
    this._context.push(toolCalls ? { role: 'assistant', content: text, tool_calls: toolCalls } : { role: 'assistant', content: text })
  }

  addToolCall(call: ToolCall): void {
    this._context.push({ role: 'tool', tool_call_id: call.id, content: call.result ?? '' })
  }

  saveToShortTermMemory(keep = 5): void {
    const msgs = this._context
    const fresh: Array<{ user: string; assistant: string }> = []
    for (let i = msgs.length - 1; i > 0 && fresh.length < keep; i--) {
      if (msgs[i]?.role === 'assistant' && msgs[i - 1]?.role === 'user') {
        fresh.push({ user: String(msgs[i - 1].content || ''), assistant: String(msgs[i].content || '') })
        i--
      }
    }
    fresh.reverse()
    this.shortTermMemory.push(...fresh)
    if (this.shortTermMemory.length > keep) {
      this.shortTermMemory = this.shortTermMemory.slice(-keep)
    }
  }

  getShortTermMemoryContext(): string {
    if (this.shortTermMemory.length === 0) return ''
    return this.shortTermMemory.map((m) => `用户: ${m.user}\n你: ${m.assistant}`).join('\n\n')
  }

  trimToTokenBudget(maxTokens = this.maxTokens): void {
    const systemTokens = estimateTokens(this.systemPrompt)
    const totalTokens = () => {
      let t = systemTokens
      for (let i = 1; i < this._context.length; i++) t += estimateMessageTokens(this._context[i])
      return t
    }

    // 先裁旧 user 轮次（保留最近一条 user）
    while (totalTokens() > maxTokens) {
      // 找到第一条 user 及其对应轮次
      const firstUser = this._context.findIndex((m, i) => i > 0 && m.role === 'user')
      if (firstUser < 0) break
      // 找到第二条 user（作为轮次结束标记），或取末尾
      const secondUser = this._context.findIndex((m, i) => i > firstUser && m.role === 'user')
      const end = secondUser > 0 ? secondUser : this._context.length
      const count = end - firstUser
      if (count <= 0) break
      this._context.splice(firstUser, count)
      log('INFO', 'context_trimmed_user', { dropped: count })
    }

    // 如果还是超限，丢弃最旧的 tool 轮次（assistant + tool 配对）
    while (totalTokens() > maxTokens) {
      const firstAssistant = this._context.findIndex((m, i) => i > 0 && m.role === 'assistant')
      if (firstAssistant < 0) break
      const firstUser = this._context.findIndex((m, i) => i > firstAssistant && m.role === 'user')
      const end = firstUser > 0 ? firstUser : this._context.length
      const count = end - firstAssistant
      if (count <= 0) break
      this._context.splice(firstAssistant, count)
      log('INFO', 'context_trimmed_tool', { dropped: count })
    }
  }

  /**
   * 只重建 system prompt（index 0），保留对话历史。
   * 由 WorkingMemory.refreshMemory() 调用，取代 new ConversationContext() 销毁历史。
   */
  rebuildSystemPrompt(memoryContext?: string, extraModules?: string[], reflectionContext?: string, identityContext?: string): void {
    const oldMessages = this._context.slice(1)
    this.systemPrompt = buildSystemPrompt(memoryContext, extraModules, reflectionContext, identityContext)
    this._context = [{ role: 'system', content: this.systemPrompt }, ...oldMessages]
  }

  clear(keepShortTerm = true): void {
    this._context = [{ role: 'system', content: this.systemPrompt }]
    if (!keepShortTerm) {
      this.shortTermMemory = []
    }
    log('INFO', 'context_cleared')
  }

  /**
   * 向上下文注入一条辅助消息（用于会话纠偏）。
   * 插入在最后一个 user 消息之后。
   */
  addSystemMessage(content: string): void {
    for (let i = this._context.length - 1; i >= 0; i--) {
      if (this._context[i].role === 'user') {
        this._context.splice(i + 1, 0, { role: 'system' as any, content })
        return
      }
    }
    this._context.push({ role: 'system' as any, content })
  }

  getShortTermMemoryPairs(): Array<{ user: string; assistant: string }> {
    return this.shortTermMemory
  }

  /**
   * 移除孤立的 assistant(tool_calls) 消息，确保每对 assistant(tool_calls) → tool 完整。
   * 支持两种孤儿检测：
   * 1. 完全孤儿：assistant 有 tool_calls，后面完全没有 tool 消息
   * 2. 部分孤儿：assistant 有 N 个 tool_calls，但只收到 M < N 条对应的 tool 消息
   */
  trimOrphanedToolCalls(): void {
    trimOrphanedToolCallsFrom(this._context)
  }

  getMessages(): Message[] {
    return this._context
  }
}

/** 从任意消息数组中移除孤立的 assistant(tool_calls) 消息 */
export function trimOrphanedToolCallsFrom(messages: Message[]): void {
  // 反向遍历，先清理孤立的 tool 消息（前面无对应 assistant(tool_calls)）
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i]
    if (m.role === 'tool') {
      let foundAssistant = false
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant' && messages[j].tool_calls?.length) {
          foundAssistant = true
          break
        }
        if (messages[j].role === 'user' || messages[j].role === 'assistant') break
      }
      if (!foundAssistant) {
        log('INFO', 'trim_orphaned_tool_message', { index: i, tool_call_id: m.tool_call_id })
        messages.splice(i, 1)
      }
    }
  }

  // 反向遍历处理 assistant(tool_calls) 块
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const toolMessages = messages.slice(i + 1).filter((t) => t.role === 'tool')
      if (toolMessages.length === 0) {
        // 无任何 tool 响应 → 检查是否有 user 消息插入在中间（interleaved）
        const hasInterleavedUser = messages.slice(i + 1).some((t) => t.role === 'user')
        log('INFO', hasInterleavedUser ? 'trim_orphaned_tool_calls_interleaved_user' : 'trim_orphaned_tool_calls_full', {
          index: i,
          tools: m.tool_calls.map((t) => t.function?.name),
        })
        messages.splice(i, 1)
        continue
      }
      // 保留空字符串 id，避免 DeepSeek 400 ("insufficient tool messages")
      const toolCallIds = new Set(m.tool_calls.map((tc) => tc.id).filter((id) => id !== undefined && id !== null))
      const respondedIds = new Set(toolMessages.map((t) => t.tool_call_id).filter((id) => id !== undefined && id !== null))
      const orphanedIds = [...toolCallIds].filter((id) => !respondedIds.has(id))
      if (orphanedIds.length > 0) {
        log('INFO', 'trim_orphaned_tool_calls_partial', { index: i, orphaned_ids: orphanedIds })
        m.tool_calls = m.tool_calls.filter((tc) => !orphanedIds.includes(tc.id))
        if (m.tool_calls.length === 0) {
          messages.splice(i, 1)
        }
      }
      // 若有 tool_call 的 id 为空字符串且无对应 tool 消息，整个 assistant 块应被清理
      if (m.tool_calls && m.tool_calls.some((tc) => !tc.id)) {
        const totalToolMsgs = messages.slice(i + 1).filter((t) => t.role === 'tool')
        if (totalToolMsgs.length === 0) {
          log('INFO', 'trim_orphaned_tool_calls_empty_id', { index: i, tools: m.tool_calls.map((t) => t.function?.name) })
          messages.splice(i, 1)
        }
      }
    }
  }
}
