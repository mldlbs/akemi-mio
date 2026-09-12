/**
 * PlanStepAnalyzer — LLM 驱动的计划步骤分析器
 *
 * 职责：
 * 1. 接收计划步骤描述，调用 LLM 分析所需工具
 * 2. 自动推断步骤间的依赖关系
 * 3. 评估步骤是否为阻塞性、是否需要人工确认
 * 4. 返回结构化的 StepAnalysisResult 供调度器使用
 *
 * 设计：
 * - 使用 chatJson 调用 LLM，强制返回 JSON
 * - 内置已知工具清单，LLM 从中选择
 * - 对 LLM 不可用时提供基于规则的兜底分析
 */

import type { StepAnalysisResult, ToolSuggestion, PlanSchedulerDeps } from './types'

// ════════════════════════════════════════════════════════════════
//  已知工具清单（供 LLM 参考）
// ════════════════════════════════════════════════════════════════

const KNOWN_TOOLS = [
  { name: 'read_file', description: '读取文件内容', category: 'file_ops' },
  { name: 'write_file', description: '写入文件内容', category: 'file_ops' },
  { name: 'edit_file', description: '编辑文件（精确替换）', category: 'file_ops' },
  { name: 'list_files', description: '列出目录文件', category: 'file_ops' },
  { name: 'grep', description: '内容搜索', category: 'search' },
  { name: 'run_command', description: '执行 shell 命令', category: 'exec' },
  { name: 'remember_fact', description: '记忆事实', category: 'memory' },
  { name: 'card_generator', description: '生成卡片图片', category: 'media' },
  { name: 'image_generation', description: '生成图片', category: 'media' },
  { name: 'analyze_codebase', description: '分析代码库结构', category: 'analysis' },
  { name: 'trend_query', description: '查询趋势数据', category: 'analysis' },
  { name: 'insight_analysis', description: '洞察分析', category: 'analysis' },
  { name: 'strategy_tools', description: '策略相关操作', category: 'strategy' },
  { name: 'polish_text', description: '文本润色', category: 'writing' },
  { name: 'blog_publish', description: '博客发布', category: 'publish' },
  { name: 'telegram_send', description: 'Telegram 推送', category: 'notification' },
  { name: 'file_ops', description: '通用文件操作', category: 'file_ops' },
  { name: 'ssh_tools', description: 'SSH 远程操作', category: 'remote' },
  { name: 'github_tools', description: 'GitHub 操作（PR/Issue/代码）', category: 'vcs' },
  { name: 'reasoning_chain', description: '推理链执行', category: 'reasoning' },
  { name: 'writing_plan', description: '写作计划操作', category: 'writing' },
  { name: 'skill_tools', description: '技能调用', category: 'skill' },
  { name: 'agent_pool', description: '子 Agent 池管理', category: 'agent' },
  { name: 'workflow_tools', description: '工作流管理', category: 'workflow' },
  { name: 'cicd_tools', description: 'CI/CD 操作', category: 'vcs' },
  { name: 'piper_tts', description: 'TTS 语音合成', category: 'media' },
  { name: 'tts_speak', description: 'TTS 播放', category: 'media' },
  { name: 'memory_save', description: '保存到长期记忆', category: 'memory' },
  { name: 'memory_load', description: '从长期记忆加载', category: 'memory' },
]

// ════════════════════════════════════════════════════════════════
//  LLM 分析 Prompt
// ════════════════════════════════════════════════════════════════

function buildAnalysisPrompt(stepDescription: string, planTitle: string, otherSteps: { index: number; description: string }[]): string {
  const toolList = KNOWN_TOOLS.map((t) => `  - ${t.name}: ${t.description}（${t.category}）`).join('\n')
  const otherStepsText = otherSteps.map((s) => `  [${s.index}] ${s.description}`).join('\n')

  return `你是一个智能任务调度分析器。请分析一个计划步骤，确定执行它所需的工具和依赖关系。

【计划标题】${planTitle}

【当前步骤】${stepDescription}

【同一计划中的其他步骤】
${otherStepsText}

【可用工具列表】
${toolList}

请严格返回 JSON，格式如下：
{
  "summary": "步骤摘要（5-15字）",
  "toolSuggestions": [
    {
      "toolName": "首选工具名",
      "confidence": 0.9,
      "expectedArgs": { "key": "示例参数值" },
      "fallbackTools": ["备选工具1", "备选工具2"],
      "rationale": "选择理由"
    }
  ],
  "dependsOn": [/* 依赖的其他步骤索引 */],
  "estimatedDurationSec": 120,
  "isBlocking": true,
  "needsConfirmation": false,
  "contextHints": ["执行前需注意的提示"]
}

注意：
- toolSuggestions 按优先级排序，至少 1 个，最多 3 个
- dependsOn 基于 "其他步骤" 的内容判断依赖关系
- estimatedDurationSec 要具体（30-3600 秒范围）
- isBlocking 为 true 表示后续步骤必须等此步骤完成
- 如果需要外部 API key、文件路径等才设置 needsConfirmation: true
- contextHints 提供执行上下文提示，如文件路径、命令参数等
- 只返回 JSON，不要包含其他文字`
}

/** LLM 不可用时的规则兜底分析 */
function fallbackAnalysis(stepDescription: string, stepIndex: number, planTitle: string): StepAnalysisResult {
  const lower = stepDescription.toLowerCase()

  // 工具匹配规则
  const suggestTool = (matches: RegExp[], toolName: string, fallbacks: string[]): ToolSuggestion | null => {
    if (matches.some((re) => re.test(lower))) {
      return {
        toolName,
        confidence: 0.6,
        expectedArgs: {},
        fallbackTools: fallbacks,
        rationale: `步骤描述匹配关键词，自动分配 ${toolName}`,
      }
    }
    return null
  }

  const suggestions: ToolSuggestion[] = [
    suggestTool([/编辑|修改|替换|改写|更正/i], 'edit_file', ['write_file', 'run_command']),
    suggestTool([/读取|查看|打开|加载/i], 'read_file', ['list_files']),
    suggestTool([/写入|创建|新建|保存|生成/i], 'write_file', ['edit_file']),
    suggestTool([/搜索|查找|查询|grep|搜索/i], 'grep', ['run_command']),
    suggestTool([/运行|执行|命令|部署|构建|编译/i], 'run_command', ['ssh_tools']),
    suggestTool([/分析|评估|审查|检查|扫描/i], 'analyze_codebase', ['grep', 'run_command']),
    suggestTool([/推送|发送|通知|发布/i], 'telegram_send', ['blog_publish']),
    suggestTool([/备份|归档|移动|复制|整理|归类/i], 'file_ops', ['run_command']),
    suggestTool([/提交|推送|pr|merge|合并|分支/i], 'github_tools', ['run_command']),
    suggestTool([/写作|撰写|起草|润色/i], 'polish_text', ['write_file']),
    suggestTool([/博客|文章/i], 'blog_publish', ['write_file', 'telegram_send']),
    suggestTool([/记忆|记住|存储|记录/i], 'remember_fact', ['memory_save']),
    suggestTool([/生成|创作|绘图|图片|图像/i], 'image_generation', ['card_generator']),
    suggestTool([/语音|tts|朗读/i], 'piper_tts', ['tts_speak']),
    suggestTool([/ssh|远程/i], 'ssh_tools', ['run_command']),
    suggestTool([/工作流|workflow/i], 'workflow_tools', ['run_command']),
    suggestTool([/推理|reasoning|链条/i], 'reasoning_chain', ['run_command']),
  ].filter((s): s is ToolSuggestion => s !== null)

  // 兜底：如果没有任何匹配，用 run_command 作为通用工具
  const finalSuggestions =
    suggestions.length > 0
      ? suggestions
      : [
          {
            toolName: 'run_command',
            confidence: 0.3,
            expectedArgs: {},
            fallbackTools: [],
            rationale: '未能匹配规则，使用通用执行工具',
          },
        ]

  // 基于 stepIndex 推断依赖（相邻步骤有依赖）
  const dependsOn = stepIndex > 0 ? [stepIndex - 1] : []

  return {
    stepIndex,
    summary: stepDescription.slice(0, 30),
    toolSuggestions: finalSuggestions,
    dependsOn,
    estimatedDurationSec: lower.includes('分析') || lower.includes('扫描') ? 300 : 120,
    isBlocking: true,
    needsConfirmation: lower.includes('api_key') || lower.includes('密钥') || lower.includes('密码'),
    contextHints: [],
  }
}

// ════════════════════════════════════════════════════════════════
//  PlanStepAnalyzer
// ════════════════════════════════════════════════════════════════

export class PlanStepAnalyzer {
  private deps: PlanSchedulerDeps
  private enableLLM: boolean

  constructor(deps: PlanSchedulerDeps, enableLLM = true) {
    this.deps = deps
    this.enableLLM = enableLLM
  }

  /**
   * 分析单个步骤。
   * 优先使用 LLM，不可用时回退到规则引擎。
   */
  async analyzeStep(
    stepDescription: string,
    stepIndex: number,
    planTitle: string,
    otherSteps: { index: number; description: string }[],
  ): Promise<StepAnalysisResult> {
    // LLM 模式
    if (this.enableLLM) {
      try {
        const prompt = buildAnalysisPrompt(stepDescription, planTitle, otherSteps)
        const result = await this.deps.llmService.chatJson(prompt, {
          temperature: 0.2,
          timeoutMs: 30000,
        })

        if (result.data && !result.error) {
          const parsed = result.data as StepAnalysisResult
          parsed.stepIndex = stepIndex
          return parsed
        }

        this.deps.log('WARN', 'plan_analyzer_llm_fallback', {
          error: result.error,
          stepIndex,
        })
      } catch (err) {
        this.deps.log('WARN', 'plan_analyzer_llm_error', {
          error: String(err),
          stepIndex,
        })
      }
    }

    // 规则兜底
    return fallbackAnalysis(stepDescription, stepIndex, planTitle)
  }

  /**
   * 批量分析一个计划的所有步骤。
   * 返回按步骤索引排序的分析结果。
   */
  async analyzePlan(
    planId: string,
    planTitle: string,
    planDescription: string,
    steps: { index: number; description: string }[],
  ): Promise<StepAnalysisResult[]> {
    this.deps.log('INFO', 'plan_analyzer_start', {
      planId,
      planTitle,
      stepCount: steps.length,
      mode: this.enableLLM ? 'llm' : 'rule',
    })

    // 全量上下文（每个步骤能看到其他步骤描述，便于推断依赖）
    const allSteps = steps.map((s) => ({ index: s.index, description: s.description }))

    // 串行分析（避免 LLM 并发导致不稳定）
    const results: StepAnalysisResult[] = []
    for (const step of steps) {
      const result = await this.analyzeStep(step.description, step.index, `${planTitle}: ${planDescription}`, allSteps)
      results.push(result)
    }

    this.deps.log('INFO', 'plan_analyzer_complete', {
      planId,
      results: results.length,
    })

    return results
  }

  /** 获取已知工具列表 */
  getKnownTools(): typeof KNOWN_TOOLS {
    return [...KNOWN_TOOLS]
  }
}
