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
]

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
 * 从用户文本匹配所有意图，返回匹配的意图列表（按 patterns 匹配数排序）
 */
export function matchIntents(text: string): VoiceIntentDef[] {
  const matches: { def: VoiceIntentDef; score: number }[] = []
  const lower = text.toLowerCase()

  for (const def of VOICE_INTENT_MAP) {
    let score = 0
    for (const p of def.patterns) {
      if (lower.includes(p.toLowerCase())) {
        score += p.length // 更长的关键词匹配 = 更高的分数
      }
    }
    if (score > 0) {
      matches.push({ def, score })
    }
  }

  // 按分数降序排列
  matches.sort((a, b) => b.score - a.score)
  return matches.map((m) => m.def)
}
