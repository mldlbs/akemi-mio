/**
 * 小说创作模式 — 教秋山澪如何用 writing_system 工具在远程写作系统上创作小说
 *
 * 使用方式（二选一）：
 * 方案 A（推荐）：通过 MCP 协议连接写作系统（结构化工具，无需手动拼 JSON）
 *   1. connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/ transport=http
 *   2. 连接后可使用 writing_create_story、writing_create_character 等结构化工具
 *
 * 方案 B（兼容）：通过旧版 writing_system 工具直接调用远程 API
 *   需要手动拼接 JSON 字符串传给 data 参数
 */

// ─── 写作工具指引（BASE_PROMPT 静态注入） ───

/**
 * 写作系统工具操作指引 — 注入 BASE_PROMPT，在 LLM 需要实际操作写作工具时可用
 */
export const PROMPT_WRITING = `【小说创作工具】

使用方式（二选一）：
方案 A（推荐）：通过 MCP 协议连接写作系统（结构化工具，无需手动拼 JSON）
  1. connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/ transport=http
  2. 连接后可使用 writing_create_story、writing_create_character 等结构化工具

方案 B（兼容）：通过旧版 writing_system 工具直接调用远程 API
  需要手动拼接 JSON 字符串传给 data 参数

【创作记忆驱动续写】
续写新章节前，使用 writing_memory 工具获取读者期望摘要：
  1. writing_memory action=get_summary storyName="故事名"
     → 获取关于该故事的历史反馈摘要（300字以内），将返回的【读者期望摘要】附加到 prompt 底部
  2. 如果无历史反馈，直接按原始方向续写即可

续写完成后，收集用户新一轮反馈并存入 Memory：
  3. writing_memory action=store_feedback storyName="故事名" feedback="用户反馈内容" category="分类"
     分类可选：emotion_preference | setting_disagreement | style_feedback | plot_suggestion | general

查询已有反馈（调试/查看用）：
  4. writing_memory action=search_feedback storyName="故事名"`

// ─── 写作意图检测 ───

/** 语义簇：按写作维度分组的关键词 */
export const WRITING_INTENT_CLUSTERS = {
  creative: ['故事', '小说', '剧情', '情节', '角色', '章节'],
  stylistic: ['文笔', '润色', '改写', '描写', '修辞'],
  expressive: ['场景', '氛围', '细节', '气氛', '画面感'],
}

/** 带权重的评分模式 — 用于精确意图强度检测 */
export const WRITING_SCORE_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /写.*故事|写.*小说|创作.*故事/, weight: 0.9 },
  { pattern: /小说|故事|剧情|角色|章节|情节/, weight: 0.8 },
  { pattern: /描述|场景|文笔|文风|润色|改写|修辞/, weight: 0.6 },
  { pattern: /氛围|气氛|画面|灵感|细节|描写/, weight: 0.5 },
  { pattern: /改|写|著|稿/, weight: 0.3 },
]

/** 计算写作意图分数 [0, 1] */
export function detectWritingIntent(text: string): number {
  if (!text) return 0
  let score = 0
  for (const { pattern, weight } of WRITING_SCORE_PATTERNS) {
    if (pattern.test(text)) {
      score = Math.max(score, weight)
    }
  }
  return score
}

// ─── 人格身份注入 ───

export type PersonaLevel = 'core' | 'hybrid' | 'writer'

/** 根据意图分数和当前状态（带状态惯性优先）解析人格等级 */
export function resolvePersona(score: number, current: PersonaLevel): PersonaLevel {
  // writer 惯性：状态本身是强先验，需要足够低的分数才能降级
  if (current === 'writer') {
    if (score > 0.35) return 'writer'
    if (score > 0.2) return 'hybrid'
    return 'core'
  }
  // hybrid 惯性：比 core 更容易升级到 writer，比 writer 更容易降级到 core
  if (current === 'hybrid') {
    if (score > 0.6) return 'writer'
    if (score > 0.25) return 'hybrid'
    return 'core'
  }
  // core 基线：无惯性，纯分数驱动
  if (score > 0.75) return 'writer'
  if (score > 0.4) return 'hybrid'
  return 'core'
}

/**
 * 完整作家人格 — 高置信度写作意图时注入
 * 偏置（bias）而非覆盖（override），不改变核心推理逻辑
 */
export const PROMPT_WRITER_IDENTITY = `【作家偏置】
当涉及创作内容时，秋山澪也是笔名「泠汀」的作者。

风格指引：
- 用具体细节代替概括性语言
- 避免直接标注情绪（不说"他很愤怒"，写他攥紧的拳头）
- 对话自然口语化，符合人物身份
- 叙述视角保持稳定，不随意切换
- 留白优于说破，信任读者的理解力

避免：
- 滥用"震惊""不可思议""突然"等空洞修饰
- 为炫技而堆砌辞藻
- 解释自己写了什么`

/**
 * 轻量风格偏置 — 混合模式（低-中置信度写作意图时注入）
 * 仅影响表达方式，不改变对话模式
 */
export const PROMPT_WRITER_STYLE = `【表达偏置】
在回复中请适度注意表达的画面感和细节。`
