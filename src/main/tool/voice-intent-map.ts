/**
 * 语音意图 → MCP 工具序列映射配置
 *
 * 所有意图识别基于本地关键词匹配，不依赖云端 LLM，保护隐私。
 * 每个意图定义了：
 * - patterns: 触发关键词列表（支持中文/英文模糊匹配）
 * - tools: 要执行的 MCP 工具序列（链式调用，前一步输出 → 下一步输入）
 * - confirmMessage: 执行前展示给用户的确认信息
 */

export interface VoiceIntentToolStep {
  /** MCP 工具名（匹配 ServerManager.toolMap 中的注册名） */
  tool: string
  /**
   * 参数模板 — 支持占位符：
   *   {{slot.xxx}} — 从意图槽位中提取
   *   {{prev.text}} — 前一步工具返回的文本（仅第一步之后可用）
   *   {{prev.json.xxx}} — 前一步返回的 JSON 中的字段
   */
  args: Record<string, string>
}

export interface VoiceIntentDef {
  /** 意图唯一标识 */
  intent: string
  /** 用户可读的描述 */
  description: string
  /** 触发关键词列表 — 任一命中即匹配（大小写不敏感） */
  patterns: string[]
  /**
   * 槽位提取正则 — key 为槽位名，value 为正则（含捕获组）
   * 例: { filename: /(?:文件|打开|读取)\s*[""']?([^\s""']+)[""']?/ }
   */
  slotExtractors?: Record<string, RegExp>
  /** 工具执行序列（按顺序链式调用） */
  tools: VoiceIntentToolStep[]
  /** 执行前确认消息模板 — 用 slots 替换 {{slot.xxx}} */
  confirmMessage: string
  /** 是否需要用户确认（默认 true，安全优先） */
  requireConfirmation?: boolean
}

/**
 * 预定义的语音意图 → MCP 工具映射
 *
 * 设计原则：
 * 1. 关键词匹配宽松（覆盖多种口语表达）
 * 2. 工具序列短（2-4步），避免复杂度爆炸
 * 3. 每步都有确认，防止误操作
 * 4. 所有处理本地完成，不发送到云端
 *
 * 动态意图：BehaviorSequenceLearner 生成的学习模式通过
 *   registerDynamicIntent / unregisterDynamicIntent 在此处注册，
 *   与静态意图共存，匹配时合并处理。
 */
export const VOICE_INTENT_MAP: VoiceIntentDef[] = [
  // ── 文件操作 ──
  {
    intent: 'read_file',
    description: '读取文件内容',
    patterns: [
      '读', '读取', '打开', '查看', '看看',
      'read', 'open', 'show', 'view', 'cat',
      '读文件', '读取文件', '打开文件', '查看文件',
    ],
    slotExtractors: {
      filename: /(?:文件|读取|打开|查看|看看|读)\s*[""'']?([^\s""'']+(?:\.[a-zA-Z]+)?)[""'']?/,
    },
    tools: [
      { tool: 'read_file', args: { path: '{{slot.filename}}' } },
    ],
    confirmMessage: '将读取文件: {{slot.filename}}',
  },

  {
    intent: 'write_file',
    description: '写入内容到文件',
    patterns: [
      '写', '写入', '保存', '创建文件', '新建文件',
      'write', 'save', 'create file', 'new file',
    ],
    slotExtractors: {
      filename: /(?:到|为|文件\s*)\s*[""'']?([^\s""'']+(?:\.[a-zA-Z]+)?)[""'']?/,
      content: /(?:内容|写入|写)\s*[：:]\s*(.+)/,
    },
    tools: [
      { tool: 'write_file', args: { path: '{{slot.filename}}', content: '{{slot.content}}' } },
    ],
    confirmMessage: '将写入文件: {{slot.filename}}\n内容: {{slot.content}}',
  },

  {
    intent: 'edit_file',
    description: '编辑文件中的文本',
    patterns: [
      '编辑', '修改', '替换', '改成', '改为',
      'edit', 'modify', 'replace', 'change',
    ],
    slotExtractors: {
      filename: /(?:文件)\s*[""'']?([^\s""'']+(?:\.[a-zA-Z]+)?)[""'']?/,
      oldText: /(?:把|将)\s*[""'']?(.+?)[""'']?\s*(?:替换|改成|改为|修改)/,
      newText: /(?:替换|改成|改为|修改)\s*[为成]?\s*[""'']?(.+?)[""'']?(?:\s*$)/,
    },
    tools: [
      { tool: 'edit_file', args: { path: '{{slot.filename}}', old_string: '{{slot.oldText}}', new_string: '{{slot.newText}}' } },
    ],
    confirmMessage: '将在 {{slot.filename}} 中:\n把 "{{slot.oldText}}" 替换为 "{{slot.newText}}"',
  },

  {
    intent: 'search_code',
    description: '搜索代码/文本',
    patterns: [
      '搜索', '查找', '找', 'grep', '搜',
      'search', 'find', 'look for',
    ],
    slotExtractors: {
      pattern: /(?:搜索|查找|找|grep|搜)\s*[""'']?(.+?)[""'']?(?:\s|$)/,
      path: /(?:在|路径|目录)\s*[""'']?([^\s""'']+)[""'']?/,
    },
    tools: [
      { tool: 'grep', args: { pattern: '{{slot.pattern}}', path: '{{slot.path}}' } },
    ],
    confirmMessage: '将搜索: {{slot.pattern}}\n路径: {{slot.path || "当前项目"}}',
  },

  {
    intent: 'list_files',
    description: '列出目录文件',
    patterns: [
      '列出', '列表', '有哪些', '显示文件', 'ls',
      'list', 'ls', 'dir', 'what files',
    ],
    slotExtractors: {
      path: /(?:目录|路径|文件夹)\s*[""'']?([^\s""'']+)[""'']?/,
    },
    tools: [
      { tool: 'list_files', args: { path: '{{slot.path}}' } },
    ],
    confirmMessage: '将列出目录: {{slot.path || "当前项目"}}',
  },

  // ── 系统状态 / 查询 ──
  {
    intent: 'system_status',
    description: '查询系统状态',
    patterns: [
      '状态', '怎么样', '如何', '运行情况', '健康',
      'status', 'health', 'how is', 'diagnostics',
      '系统状态', '运行状态',
    ],
    tools: [
      { tool: 'get_system_health', args: {} },
    ],
    confirmMessage: '将查询系统运行状态',
  },

  {
    intent: 'list_plans',
    description: '查看开发计划',
    patterns: [
      '计划', '规划', 'plan', '任务', '有哪些计划',
      'plans', 'tasks', 'todo',
    ],
    tools: [
      { tool: 'list_plans', args: {} },
    ],
    confirmMessage: '将查看当前开发计划',
  },

  // ── 开发计划操作：查询、更新状态、完成、切换焦点 ──
  {
    intent: 'query_plan_status',
    description: '查询开发计划进度和状态',
    patterns: [
      '计划进度', '计划状态', '进度如何', '看看计划',
      '当前计划', '活跃计划', '开发进度', '计划情况',
      'plan status', 'plan progress', 'progress',
      '我的计划', '全部计划', '计划怎么样了',
      '计划进行', '进度', '任务的进展',
    ],
    tools: [
      { tool: 'list_plans', args: {} },
    ],
    confirmMessage: '将查看当前开发计划进度',
    requireConfirmation: false,
  },

  {
    intent: 'mark_step_done',
    description: '标记计划步骤为已完成',
    patterns: [
      '标记完成', '完成了', '做好了', '搞定',
      '步骤完成', '任务完成', '做完',
      'mark done', 'step done', 'complete step',
      '完成步骤', '这个完成了', '做完了',
      '搞定了', '好了', '这个搞定',
      '合并完成', '实现完成', '测试完成',
    ],
    slotExtractors: {
      stepDescription: /(?:标记|完成|做完|做好|搞定|做|完成步骤)\s*(?:步骤|任务)?\s*[：:""]?([^""\s]{1,30})(?:完成|了|$)/,
      stepIndex: /第\s*(\d+)\s*步/,
    },
    tools: [
      { tool: 'voice_update_plan_step', args: { stepDescription: '{{slot.stepDescription}}', stepIndex: '{{slot.stepIndex}}', status: 'done' } },
    ],
    confirmMessage: '将标记步骤完成: {{slot.stepDescription || "第" + slot.stepIndex + "步"}}',
  },

  {
    intent: 'mark_step_in_progress',
    description: '标记计划步骤为进行中',
    patterns: [
      '开始做', '开始', '进行中', '正在做',
      '开始步骤', '着手', '开始搞',
      'start step', 'in progress', 'working on',
      '开始任务', '开始这个',
    ],
    slotExtractors: {
      stepDescription: /(?:开始|做|进行|着手)\s*(?:步骤|做|搞|任务)?\s*[：:""]?([^""\s]{1,30})/,
      stepIndex: /第\s*(\d+)\s*步/,
    },
    tools: [
      { tool: 'voice_update_plan_step', args: { stepDescription: '{{slot.stepDescription}}', stepIndex: '{{slot.stepIndex}}', status: 'in_progress' } },
    ],
    confirmMessage: '将标记步骤为进行中: {{slot.stepDescription || "第" + slot.stepIndex + "步"}}',
  },

  {
    intent: 'complete_current_plan',
    description: '完成当前活跃计划',
    patterns: [
      '完成计划', '计划完成', '结束计划',
      'complete plan', 'finish plan',
      '这个计划完成了', '计划结束',
      '计划做完', '开发完成',
    ],
    tools: [
      { tool: 'complete_plan', args: { plan_id: '' } },
    ],
    confirmMessage: '将标记当前活跃计划为已完成',
    requireConfirmation: true,
  },

  {
    intent: 'switch_plan_focus',
    description: '切换工作焦点到指定计划',
    patterns: [
      '切换到', '切换', '聚焦到',
      '打开计划', '查看计划',
      'switch to plan', 'focus on plan',
      '看看计划', '显示计划',
      '切换到开发', '聚焦开发',
      '这个计划', '那个计划',
    ],
    slotExtractors: {
      planName: /(?:切换到|切换|聚焦|打开|查看|看|显示|到|聚焦)\s*[「」""''""]?([^「」""''""\s]{1,20})[「」""''""]?\s*(?:计划|开发)?/,
    },
    tools: [
      { tool: 'voice_switch_plan_focus', args: { planTitle: '{{slot.planName}}' } },
    ],
    confirmMessage: '将切换工作焦点到计划: {{slot.planName}}',
  },

  // ── 工作流操作 ──
  {
    intent: 'list_workflows',
    description: '列出工作流',
    patterns: [
      '工作流', 'workflow', '流水线', '有哪些工作流',
      'pipelines', '自动化',
    ],
    tools: [
      { tool: 'list_workflows', args: {} },
    ],
    confirmMessage: '将列出所有工作流',
  },

  // ── 创造力 / 内容生成 ──
  {
    intent: 'generate_image',
    description: '生成图片',
    patterns: [
      '生成图', '画', '绘制', '生成图片', '图片生成',
      'generate image', 'draw', 'create image', 'make picture',
    ],
    slotExtractors: {
      prompt: /(?:生成图|画|绘制|生成图片|图片生成)\s*[：:]*\s*(.+)/,
    },
    tools: [
      { tool: 'generate_image', args: { prompt: '{{slot.prompt}}' } },
    ],
    confirmMessage: '将生成图片: {{slot.prompt}}',
  },

  // ── 链式操作：搜索 + 读取 ──
  {
    intent: 'find_and_read',
    description: '搜索关键词后读取匹配文件',
    patterns: [
      '找.*读', '搜.*打开', '查.*看',
      'find.*read', 'search.*open',
    ],
    slotExtractors: {
      pattern: /(?:找|搜|查|find|search)\s*[""'']?(.+?)[""'']?\s*(?:读|打开|看|read|open)/,
    },
    tools: [
      { tool: 'grep', args: { pattern: '{{slot.pattern}}', path: '.' } },
      // 第二步由用户选择读取哪个文件（暂简化为读取第一个匹配）
      { tool: 'read_file', args: { path: '{{prev.firstMatch}}' } },
    ],
    confirmMessage: '将搜索 "{{slot.pattern}}" 并读取第一个匹配文件',
  },

  // ── 学习查询 ──
  {
    intent: 'learning_query',
    description: '查询 TypeScript 学习知识点',
    patterns: [
      '什么是', '解释', '说明', '学习', '知识点',
      'what is', 'explain', 'tell me about',
      '条件类型', '泛型', '映射类型', '类型守卫',
      '类型推断', '工具类型', '模板字面量',
      'Conditional Types', 'Mapped Types', 'Generic',
    ],
    slotExtractors: {
      concept: /(?:什么是|解释|说明|学习|知识点|tell me about|what is|explain)\s*[""'']?(.+?)[""'']?(?:\s*$|\.|。)/,
    },
    tools: [
      { tool: 'learning_query', args: { query: '{{slot.concept}}' } },
    ],
    confirmMessage: '将查询 TypeScript 知识点: {{slot.concept || "全部"}}',
    requireConfirmation: false,
  },

  // ── 口述代码 ──
  {
    intent: 'oral_code',
    description: '口述生成 TypeScript 类型代码',
    patterns: [
      '写', '生成', '代码', '类型',
      'create', 'generate', 'make', 'code',
      '一个泛型', '一个条件', '一个映射',
      '写一个', '生成一个', '创建',
      '函数', '接口', '类型',
    ],
    slotExtractors: {
      description: /(?:写|生成|创建|make|create|generate)\s*(.+)/,
    },
    tools: [
      { tool: 'oral_code_generate', args: { description: '{{slot.description}}' } },
    ],
    confirmMessage: '将生成类型代码描述: {{slot.description}}',
    requireConfirmation: false,
  },

  // ── 文件整理操作 ──
  {
    intent: 'organize_file',
    description: '语音整理文件 — 将文件移动到指定类别目录',
    patterns: [
      '整理', '归类', '分类', '移到', '移动到', '搬', '搬到',
      '归档', '放到', '放入', '放进',
      'organize', 'move to', 'put in', 'classify', 'archive',
      '把.*放到', '把.*移到', '把.*归类',
      '这个.*放到', '这个.*移到',
      '这份.*放到', '那些.*放到',
    ],
    slotExtractors: {
      targetCategory: /(?:到|去|进|放入|移到|归到|放到|归档到)\s*["']?([^\s"'"]{2,})["']?/,
      targetFile: /(?:把|将|拿)\s*["']?([^\s"']+)["']?\s*(?:放到|移到|归类到|整理到|归档到)/,
    },
    tools: [
      { tool: 'organize_file_with_voice', args: { category: '{{slot.targetCategory}}', fileDescription: '{{slot.targetFile}}' } },
    ],
    confirmMessage: '将文件整理到: {{slot.targetCategory}}',
  },

  {
    intent: 'move_file_to',
    description: '语音移动文件到指定目录',
    patterns: [
      '移到', '移动到', '搬到', '搬去', '挪到',
      'move', 'move file', 'mv',
      '把这个.*到', '把这个.*移到',
      '拖到', '拖入',
    ],
    slotExtractors: {
      targetPath: /(?:到|去|入)\s*["']?([^\s"']{2,})["']?/,
      fileName: /(?:把|将)\s*["']?([^\s"']+\.[a-zA-Z]+)["']?/,
    },
    tools: [
      { tool: 'move_file', args: { source: '{{slot.fileName}}', target: '{{slot.targetPath}}' } },
    ],
    confirmMessage: '将移动文件 {{slot.fileName}} 到 {{slot.targetPath}}',
    requireConfirmation: true,
  },

  {
    intent: 'list_categories',
    description: '查询可用的文件类别建议',
    patterns: [
      '有哪些类别', '分类', '类别', '归类建议',
      'categories', 'suggestions', 'folder ideas',
      '整理成什么', '怎么归类', '文件夹建议',
    ],
    tools: [
      { tool: 'query_file_categories', args: {} },
    ],
    confirmMessage: '将查询文件整理类别建议',
    requireConfirmation: false,
  },

  {
    intent: 'confirm_file_operation',
    description: '确认高风险文件操作',
    patterns: [
      '确认', '是的', '对的', '没错', '确定', '执行',
      '是', '好', '行', '可以', '没问题',
      'confirm', 'yes', 'ok', 'sure', 'go ahead', 'do it',
    ],
    tools: [
      { tool: 'confirm_voice_operation', args: {} },
    ],
    confirmMessage: '确认执行操作',
    requireConfirmation: false,
  },

  {
    intent: 'cancel_file_operation',
    description: '取消高风险文件操作',
    patterns: [
      '取消', '取消操作', '不要', '不', '不行', '错了',
      '算了', '撤回', '停止', '停下',
      'cancel', 'no', 'stop', 'abort', 'never mind',
    ],
    tools: [
      { tool: 'cancel_voice_operation', args: {} },
    ],
    confirmMessage: '取消操作',
    requireConfirmation: false,
  },
]

// =============================================================================
// 动态意图注册（由 BehaviorSequenceLearner 管理）
// =============================================================================

/**
 * 动态注册的语音意图 — 由行为序列学习器生成。
 * 与静态 VOICE_INTENT_MAP 并列，匹配时合并处理。
 * 动态意图的优先级低于静态意图。
 */
const DYNAMIC_VOICE_INTENTS: Map<string, VoiceIntentDef> = new Map()

/**
 * 注册一条动态语音意图。
 * 如果相同 intent id 已存在，会被替换。
 *
 * @param id 意图唯一标识（如 "bp_grep_read_file_edit_file"）
 * @param def 意图定义
 */
export function registerDynamicIntent(id: string, def: VoiceIntentDef): void {
  DYNAMIC_VOICE_INTENTS.set(id, def)
}

/**
 * 注销一条动态语音意图。
 * @returns true 如果确实找到了并删除了
 */
export function unregisterDynamicIntent(id: string): boolean {
  return DYNAMIC_VOICE_INTENTS.delete(id)
}

/**
 * 清空所有动态语音意图。
 */
export function clearDynamicIntents(): void {
  DYNAMIC_VOICE_INTENTS.clear()
}

/**
 * 获取所有已注册的动态意图列表（用于调试/展示）。
 */
export function getAllDynamicIntents(): VoiceIntentDef[] {
  return Array.from(DYNAMIC_VOICE_INTENTS.values())
}

/**
 * 在静态和动态意图中查找指定 intent id 的定义。
 * 静态意图优先匹配。
 */
export function findIntentById(id: string): VoiceIntentDef | undefined {
  // 先查静态
  const staticMatch = VOICE_INTENT_MAP.find((d) => d.intent === id)
  if (staticMatch) return staticMatch
  // 再查动态
  return DYNAMIC_VOICE_INTENTS.get(id)
}

/**
 * 从用户文本中提取槽位值
 */
export function extractSlots(
  text: string,
  extractors: Record<string, RegExp>,
): Record<string, string> {
  const slots: Record<string, string> = {}
  for (const [key, regex] of Object.entries(extractors)) {
    const match = text.match(regex)
    if (match) {
      slots[key] = (match[1] || match[0]).trim()
    }
  }
  return slots
}

/**
 * 关键词匹配：检查文本是否包含任一 pattern
 * 大小写不敏感，支持部分匹配
 */
export function matchKeywords(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase()
  return patterns.some((p) => lower.includes(p.toLowerCase()))
}

/**
 * 从用户文本匹配所有意图（静态 + 动态），返回匹配的意图列表。
 *
 * 匹配逻辑：
 * 1. 静态意图（VOICE_INTENT_MAP）先匹配，按 patterns 匹配数排序
 * 2. 动态意图（DYNAMIC_VOICE_INTENTS）追加，分数相同但排在静态之后
 * 3. 分数 = 关键词长度之和（更长关键词优先）
 */
export function matchIntents(text: string): VoiceIntentDef[] {
  const matches: { def: VoiceIntentDef; score: number; isDynamic?: boolean }[] = []
  const lower = text.toLowerCase()

  // 1. 静态意图匹配
  for (const def of VOICE_INTENT_MAP) {
    const score = scoreIntent(lower, def)
    if (score > 0) {
      matches.push({ def, score, isDynamic: false })
    }
  }

  // 2. 动态意图匹配（优先级低于静态）
  for (const def of DYNAMIC_VOICE_INTENTS.values()) {
    const score = scoreIntent(lower, def)
    if (score > 0) {
      matches.push({ def, score, isDynamic: true })
    }
  }

  // 按分数降序排列，同分时静态优先
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 同分：静态优先于动态
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1
    return 0
  })
  return matches.map((m) => m.def)
}

/**
 * 计算一段文本对一个意图定义的匹配分数。
 */
function scoreIntent(lowerText: string, def: VoiceIntentDef): number {
  let score = 0
  for (const p of def.patterns) {
    if (lowerText.includes(p.toLowerCase())) {
      // 更长的关键词匹配 = 更高的分数（更精确）
      // 动态意图的短语可能较长，加分使其被恰当匹配
      score += p.length
    }
  }
  return score
}
