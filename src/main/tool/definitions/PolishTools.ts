/**
 * PolishTools — 润色工具箱集成
 *
 * 基于 MCP 框架的一组文学润色专用工具：
 * 1. polish_style_scan     — 风格一致性扫描器
 * 2. polish_dialogue_eval  — 对话自然度评估器
 * 3. polish_ai_detect      — AI 味检测器
 * 4. polish_rhythm_analyze — 节奏分析仪
 *
 * 每个工具支持两种模式：
 * - quick（纯规则，无需 LLM，毫秒级返回）
 * - deep（LLM 深度分析，更精确但略慢）
 *
 * 架构：轻量规则 + LLM chatJson 双通道，以模式参数切换。
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCredentialsManager } from '../deps'
import { LLM_TEXT_API_URL, LLM_TEXT_MODEL, LLM_TEXT_KEY } from '../../config'

// ============================================================
//  类型定义
// ============================================================

export interface PolishIssue {
  /** 问题描述 */
  description: string
  /** 相关原文片段 */
  excerpt: string
  /** 严重程度 1-5（1=轻微提示, 5=严重问题） */
  severity: 1 | 2 | 3 | 4 | 5
  /** 修改建议 */
  suggestion: string
}

export interface PolishSuggestion {
  /** 建议标题 */
  title: string
  /** 建议详情 */
  detail: string
}

export interface StyleScanResult {
  /** 风格一致性评分 0-100 */
  score: number
  /** 发现的问题列表 */
  issues: PolishIssue[]
  /** 改进建议 */
  suggestions: PolishSuggestion[]
}

export interface DialogueEvalResult {
  /** 对话自然度评分 0-100 */
  score: number
  /** 发现的问题 */
  issues: PolishIssue[]
  /** 改进建议 */
  suggestions: PolishSuggestion[]
}

export interface AiDetectResult {
  /** AI 味评分 0-100（越高 AI 味越重） */
  score: number
  /** 检测到的 AI 标记 */
  markers: Array<{
    phrase: string
    type: string
    severity: 1 | 2 | 3 | 4 | 5
  }>
  /** 去 AI 味建议 */
  suggestions: PolishSuggestion[]
}

export interface RhythmResult {
  /** 节奏评分 0-100 */
  score: number
  /** 统计信息 */
  stats: {
    /** 平均句长（字符数） */
    avgSentenceLength: number
    /** 句长标准差 */
    sentenceLengthStdDev: number
    /** 最短句 */
    minSentenceLength: number
    /** 最长句 */
    maxSentenceLength: number
    /** 段落数 */
    paragraphCount: number
    /** 每段平均句数 */
    avgSentencesPerParagraph: number
    /** 标点密集度（标点/总字符） */
    punctuationDensity: number
    /** 短句比例（<20字） */
    shortSentenceRatio: number
    /** 长句比例（>50字） */
    longSentenceRatio: number
  }
  /** 节奏问题 */
  issues: PolishIssue[]
}

// ============================================================
//  LLM 分析调用（轻量 chatJson 模式）
// ============================================================

const DEFAULT_TIMEOUT = 15000

async function llmAnalyze<T>(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<{ data?: T; error?: string }> {
  const key = LLM_TEXT_KEY || getCredentialsManager()?.get('llm_text_key') || process.env.LLM_KEY || ''
  if (!key) {
    return { error: 'LLM key not configured — can only use quick (rule-only) mode' }
  }

  try {
    const res = await fetch(LLM_TEXT_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_TEXT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { error: `LLM API error ${res.status}: ${body.slice(0, 200)}` }
    }

    const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
    const reply = data.choices?.[0]?.message?.content?.trim() || ''

    // 尝试解析 JSON
    try {
      return { data: JSON.parse(reply) as T }
    } catch {
      // 尝试从 markdown 围栏提取
      const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (match) {
        try {
          return { data: JSON.parse(match[1].trim()) as T }
        } catch {
          // fallthrough
        }
      }
      return { data: reply as unknown as T }
    }
  } catch (err: any) {
    return { error: `LLM call failed: ${err.message}` }
  }
}

// ============================================================
//  AI 味标记词库（中文文学常见 AI 痕迹）
// ============================================================

const AI_MARKER_PATTERNS: Array<{ pattern: RegExp; type: string; label: string; severity: 1 | 2 | 3 | 4 | 5 }> = [
  // 过度使用的过渡词
  { pattern: /(值得注意的是|值得一提的是|不可否认|毋庸置疑|毫无疑问|显而易见|众所周知)/g, type: 'overused_transition', label: '过度过渡词', severity: 3 },
  // 空洞的总结词
  { pattern: /(综上所述|总的来说|总而言之|从这个角度|从这个意义上|在这一背景下)/g, type: 'hollow_summary', label: '空洞总结', severity: 3 },
  // 机械的因果连接
  { pattern: /(因此|因而|故此|鉴于此|有鉴于此|基于此)/g, type: 'mechanical_causality', label: '机械因果', severity: 2 },
  // 生硬的转折
  { pattern: /(然而|然而，值得注意的是|但值得注意的是|不过值得注意)/g, type: 'stiff_transition', label: '生硬转折', severity: 2 },
  // 过度修饰
  { pattern: /(深深地|默默地|静静地|轻轻地|缓缓地|微微地|悄悄地|渐渐地|默默)/g, type: 'overused_adverb', label: '过度使用副词', severity: 2 },
  // AI 常用套话
  { pattern: /(在这个充满|在这个喧嚣|在这个快节奏|在这个瞬息万变|在这个数字时代|在当今社会)/g, type: 'cliched_opening', label: '套话开头', severity: 4 },
  // 万能情感词
  { pattern: /(心中涌起一股|一股暖流|一种说不出的|一种莫名的|一种难以言喻的)/g, type: 'generic_emotion', label: '万能情感描写', severity: 3 },
  // 冗余强调
  { pattern: /(真的|真的很|确实是|实际上是|本质上|本质上来说)/g, type: 'redundant_emphasis', label: '冗余强调', severity: 1 },
  // 机械的时间推进
  { pattern: /(时间一分一秒地过去|时光飞逝|岁月如梭|转眼间|不知不觉|一晃)/g, type: 'mechanical_time', label: '机械时间推进', severity: 3 },
  // 常见的 AI 排比结构
  { pattern: /(既是……也是……更是……|不仅……而且……更……|无论……还是……都)/g, type: 'ai_parallelism', label: 'AI 式排比', severity: 2 },
]

// ============================================================
//  规则引擎 — 风格扫描
// ============================================================

function ruleBasedStyleScan(text: string, styleGuide?: string): StyleScanResult {
  const issues: PolishIssue[] = []
  const suggestions: PolishSuggestion[] = []

  // 1. 检测叙述视角跳跃
  const firstPersonCount = (text.match(/我|我们/g) || []).length
  const thirdPersonCount = (text.match(/他|她|它|他们|她们|它们/g) || []).length
  if (firstPersonCount > 0 && thirdPersonCount > 0) {
    const ratio = firstPersonCount / (thirdPersonCount || 1)
    if (ratio > 0.2 && ratio < 5) {
      issues.push({
        description: '叙述视角可能不统一：同时出现了第一人称和第三人称',
        excerpt: text.slice(0, 60),
        severity: 4,
        suggestion: '检查是否需要统一叙述视角。第一人称和第三人称混用会干扰读者沉浸感。',
      })
    }
  }

  // 2. 检测时态/语气一致性（「了」「着」「过」滥用）
  const leCount = (text.match(/了/g) || []).length
  const zheCount = (text.match(/着/g) || []).length
  const totalChars = text.replace(/\s/g, '').length
  if (totalChars > 0) {
    const leDensity = leCount / totalChars
    if (leDensity > 0.05) {
      issues.push({
        description: `「了」字使用过于频繁（出现 ${leCount} 次，密度 ${(leDensity * 100).toFixed(1)}%）`,
        excerpt: text.slice(0, 60),
        severity: 2,
        suggestion: '适当减少「了」的使用，尝试换用其他时态表达方式。',
      })
    }
  }

  // 3. 检测短段落（风格指示）
  const paragraphs = text.split(/\n\s*\n/)
  const shortParas = paragraphs.filter((p) => p.trim().length > 0 && p.trim().length < 20)
  if (shortParas.length > 0 && paragraphs.length > 3) {
    issues.push({
      description: `存在 ${shortParas.length} 个过短段落（<20 字符），可能影响行文节奏`,
      excerpt: shortParas[0].trim().slice(0, 60),
      severity: 1,
      suggestion: '考虑将过短段落与相邻段落合并，或补充细节内容。',
    })
  }

  // 4. 风格指南对比（如果有）
  if (styleGuide && styleGuide.trim()) {
    suggestions.push({
      title: '风格指南深度对比',
      detail: `建议使用 deep 模式对文本与风格指南进行 LLM 对比分析。当前风格指南要点：${styleGuide.slice(0, 200)}`,
    })
  }

  // 计算粗略风格评分
  let score = 100
  score -= issues.reduce((sum, i) => sum + i.severity * 3, 0)
  score = Math.max(0, Math.min(100, score))

  return { score, issues, suggestions }
}

// ============================================================
//  规则引擎 — 对话自然度
// ============================================================

function ruleBasedDialogueEval(text: string): DialogueEvalResult {
  const issues: PolishIssue[] = []
  const suggestions: PolishSuggestion[] = []

  // 提取对话行（引号内的内容）
  const dialogueLines: string[] = []
  const dialogueRegex = /[「「『』""]([^「「『』""]{1,200})[」」』」""]/g
  let match
  while ((match = dialogueRegex.exec(text)) !== null) {
    dialogueLines.push(match[1])
  }

  if (dialogueLines.length === 0) {
    // 无对话，仅做提示
    suggestions.push({
      title: '未检测到对话',
      detail: '当前文本中没有找到明显的对话内容。对话评估仅在包含对话的段落中有效。',
    })
    return { score: 100, issues, suggestions }
  }

  for (const line of dialogueLines) {
    // 检测过于书面化的对话
    const writtenMarkers = [
      /(罢了|而已|岂能|岂敢|何以|并非|绝非|未曾|尚未|未曾想|殊不知)/,
      /(在此|于此|于|之|其|所|与否)/,
    ]
    for (const marker of writtenMarkers) {
      if (marker.test(line)) {
        issues.push({
          description: `对话过于书面化：${line.slice(0, 40)}`,
          excerpt: line.slice(0, 60),
          severity: 3,
          suggestion: '口语对话中减少文言/书面词汇，使用更自然的日常表达。',
        })
        break
      }
    }

    // 检测过长对话
    if (line.length > 80) {
      issues.push({
        description: `对话过长（${line.length} 字）：${line.slice(0, 30)}...`,
        excerpt: line.slice(0, 60),
        severity: 2,
        suggestion: '日常对话通常较短，长段独白建议拆分或添加对方反应。',
      })
    }

    // 检测过于正式的称呼
    if (/您好|尊敬的|亲爱的/.test(line)) {
      issues.push({
        description: `对话中使用了过于正式的称呼：「${line.match(/您好|尊敬的|亲爱的/)?.[0]}」`,
        excerpt: line.slice(0, 60),
        severity: 3,
        suggestion: '根据角色关系选择合适的称呼方式，避免生硬。',
      })
    }
  }

  // 检测对话标签单一
  const speechVerbs = text.match(/说|道|问|答|喊|叫|嚷|吼|嘟囔|嘀咕|自言自语/g)
  if (speechVerbs) {
    const shuoCount = speechVerbs.filter((v) => v === '说').length
    if (shuoCount > 3 && shuoCount / speechVerbs.length > 0.6) {
      issues.push({
        description: `对话标签过于单一：「说」字出现 ${shuoCount} 次，占所有引述动词的 ${((shuoCount / speechVerbs.length) * 100).toFixed(0)}%`,
        excerpt: text.slice(0, 60),
        severity: 2,
        suggestion: '尝试使用更多样的引述动词（如「低声道」「叹了口气」「笑着摇头」），或省略对话标签用动作替代。',
      })
    }
  }

  // 评分
  let score = 100
  score -= issues.reduce((sum, i) => sum + i.severity * 4, 0)
  score = Math.max(0, Math.min(100, score))

  if (issues.length === 0) {
    suggestions.push({
      title: '对话自然度良好',
      detail: '规则检测未发现明显问题。建议使用 deep 模式进行 LLM 深度评估以获得更精确的分析。',
    })
  }

  return { score, issues, suggestions }
}

// ============================================================
//  规则引擎 — AI 味检测
// ============================================================

function ruleBasedAiDetect(text: string): AiDetectResult {
  const markers: AiDetectResult['markers'] = []
  const suggestions: PolishSuggestion[] = []

  for (const mp of AI_MARKER_PATTERNS) {
    const matches = text.match(mp.pattern)
    if (matches) {
      markers.push({
        phrase: matches[0],
        type: mp.type,
        severity: mp.severity,
      })
    }
  }

  // 额外检测：句子结构过于规整
  const sentences = text.split(/[。！？\n]/).filter((s) => s.trim().length > 0)
  const avgLen = sentences.reduce((sum, s) => sum + s.length, 0) / (sentences.length || 1)

  // 检测句子长度过于接近（AI 的典型特征）
  if (sentences.length >= 5) {
    const lengths = sentences.map((s) => s.length)
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
    const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length
    const stdDev = Math.sqrt(variance)
    if (stdDev < mean * 0.3 && sentences.length >= 5) {
      markers.push({
        phrase: `句长标准差 ${stdDev.toFixed(1)}（均值 ${mean.toFixed(1)}）`,
        type: 'uniform_sentence_length',
        severity: 3,
      })
    }
  }

  // 评分
  const markerScore = Math.min(100, markers.reduce((sum, m) => sum + m.severity * 4, 0))
  let score = Math.min(100, markerScore)

  if (markers.length > 0) {
    suggestions.push({
      title: '替换检测到的 AI 标记短语',
      detail: `检测到 ${markers.length} 个 AI 标记短语。建议逐一替换为更自然、个性化的表达，避免模板化语言。`,
    })
  }

  if (score > 30) {
    suggestions.push({
      title: '全局去 AI 味建议',
      detail: '增加个人化的视角和独特的表达方式。使用具体细节替代抽象概括，让文本更有「人味」。',
    })
  } else {
    suggestions.push({
      title: 'AI 味较低',
      detail: '当前文本的 AI 特征较少。如需进一步提高自然度，可使用 deep 模式做更精细的 LLM 检测。',
    })
  }

  return { score, markers, suggestions }
}

// ============================================================
//  规则引擎 — 节奏分析（纯算法，无需 LLM）
// ============================================================

function ruleBasedRhythmAnalyze(text: string): RhythmResult {
  const issues: PolishIssue[] = []

  // 分句（支持中文标点）
  const sentences = text
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // 分段落
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  // 句长统计
  const lengths = sentences.map((s) => s.length)
  const avgLen = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  const minLen = lengths.length > 0 ? Math.min(...lengths) : 0
  const maxLen = lengths.length > 0 ? Math.max(...lengths) : 0

  // 标准差
  const variance =
    lengths.length > 0 ? lengths.reduce((sum, l) => sum + (l - avgLen) ** 2, 0) / lengths.length : 0
  const stdDev = Math.sqrt(variance)

  // 短句/长句比例
  const shortCount = lengths.filter((l) => l < 20).length
  const longCount = lengths.filter((l) => l > 50).length
  const shortRatio = sentences.length > 0 ? shortCount / sentences.length : 0
  const longRatio = sentences.length > 0 ? longCount / sentences.length : 0

  // 标点密集度
  const punctuationCount = (text.match(/[，。！？、；：""''（）《》【】\-—…·]/g) || []).length
  const totalChars = text.replace(/\s/g, '').length
  const punctDensity = totalChars > 0 ? punctuationCount / totalChars : 0

  // 分析节奏问题

  // 1. 句长过于单调
  if (stdDev < avgLen * 0.3 && sentences.length >= 5) {
    issues.push({
      description: `句子长度过于均匀（标准差 ${stdDev.toFixed(1)}），节奏单调`,
      excerpt: sentences.slice(0, 3).join(' ').slice(0, 80),
      severity: 3,
      suggestion: '尝试混合长短句：连续短句营造紧张感，长句用于描述和抒情。',
    })
  }

  // 2. 短句不足
  if (shortRatio < 0.1 && sentences.length >= 5) {
    issues.push({
      description: `短句比例过低（${(shortRatio * 100).toFixed(0)}%），缺乏节奏变化`,
      excerpt: sentences.slice(0, 2).join(' ').slice(0, 80),
      severity: 2,
      suggestion: '适当加入短句来打破节奏，短句能强化情感表达和关键信息。',
    })
  }

  // 3. 长句过多
  if (longRatio > 0.4) {
    issues.push({
      description: `长句比例过高（${(longRatio * 100).toFixed(0)}%），可能影响阅读流畅性`,
      excerpt: sentences.slice(0, 2).join(' ').slice(0, 80),
      severity: 2,
      suggestion: '将过长的句子拆分为更短的句子，每句聚焦一个核心信息。',
    })
  }

  // 4. 有句子特长
  if (maxLen > 100) {
    issues.push({
      description: `存在超长句（${maxLen} 字），可读性差`,
      excerpt: sentences.find((s) => s.length > 100)?.slice(0, 60) || '',
      severity: 3,
      suggestion: '将超长句拆分为 2-3 个短句，每个短句表达一个完整意思。',
    })
  }

  // 5. 段落过大
  const avgSentPerPara = paragraphs.length > 0 ? sentences.length / paragraphs.length : 0
  if (avgSentPerPara > 8 && paragraphs.length >= 3) {
    issues.push({
      description: `段落平均句数过多（${avgSentPerPara.toFixed(1)} 句/段）`,
      excerpt: paragraphs[0].slice(0, 60),
      severity: 1,
      suggestion: '考虑将长段落拆分为 3-5 句一段，提升阅读舒适度。',
    })
  }

  // 6. 标点密集度异常
  if (punctDensity > 0.2) {
    issues.push({
      description: `标点密集度过高（${(punctDensity * 100).toFixed(1)}%）`,
      excerpt: text.slice(0, 60),
      severity: 1,
      suggestion: '适当减少逗号/顿号的使用，或用句子拆分替代。',
    })
  }

  // 评分
  let score = 100
  score -= issues.reduce((sum, i) => sum + i.severity * 4, 0)
  // 极端的句长变化也扣分
  if (stdDev > avgLen * 0.8 && avgLen > 0) score -= 5
  score = Math.max(0, Math.min(100, score))

  return {
    score,
    stats: {
      avgSentenceLength: Math.round(avgLen * 10) / 10,
      sentenceLengthStdDev: Math.round(stdDev * 10) / 10,
      minSentenceLength: minLen,
      maxSentenceLength: maxLen,
      paragraphCount: paragraphs.length,
      avgSentencesPerParagraph: Math.round(avgSentPerPara * 10) / 10,
      punctuationDensity: Math.round(punctDensity * 1000) / 1000,
      shortSentenceRatio: Math.round(shortRatio * 1000) / 1000,
      longSentenceRatio: Math.round(longRatio * 1000) / 1000,
    },
    issues,
  }
}

// ============================================================
//  LLM 增强分析（deep 模式）
// ============================================================

const STYLE_SCAN_SYSTEM = `你是一个专业的文学编辑和风格分析师。你的任务是分析文本的风格一致性。

请严格以 JSON 格式返回分析结果：
{
  "score": 0-100,
  "issues": [
    {
      "description": "问题描述（中文）",
      "excerpt": "相关原文片段",
      "severity": 1-5,
      "suggestion": "修改建议"
    }
  ],
  "suggestions": [
    { "title": "建议标题", "detail": "建议详情" }
  ]
}

评估维度：
1. 叙述视角一致性（第一人称/第三人称是否混用）
2. 语气和情感基调一致性
3. 句式风格是否统一（是否忽文忽白）
4. 词汇选择是否符合整体风格
5. 修辞手法使用是否与风格协调

注意：只标记真正的问题，不要过度诊断。`

const DIALOGUE_EVAL_SYSTEM = `你是一个专业的文学编辑，专注于评估小说对话的自然度。

请严格以 JSON 格式返回分析结果：
{
  "score": 0-100,
  "issues": [
    {
      "description": "问题描述（中文）",
      "excerpt": "相关原文片段",
      "severity": 1-5,
      "suggestion": "修改建议"
    }
  ],
  "suggestions": [
    { "title": "建议标题", "detail": "建议详情" }
  ]
}

评估维度：
1. 对话是否符合角色身份和性格
2. 语气是否自然，不僵硬
3. 对话节奏是否合理（长短交替）
4. 对话标签是否丰富自然
5. 对话是否推动情节或塑造角色
6. 是否存在信息倾倒（info-dump）

注意：只标记真正的问题，不要过度诊断。如果文本中没有对话，请返回 score: 100 和空 issues。`

const AI_DETECT_SYSTEM = `你是一个专业的文本检测专家，擅长识别 AI 生成文本的特征。

请严格以 JSON 格式返回分析结果：
{
  "score": 0-100,
  "markers": [
    {
      "phrase": "检测到的短语",
      "type": "标记类型",
      "severity": 1-5
    }
  ],
  "suggestions": [
    { "title": "建议标题", "detail": "建议详情" }
  ]
}

检测维度：
1. 过度使用模板化过渡词（值得注意的是、不可否认等）
2. 空洞的总结性语句
3. 缺乏具体细节的抽象描写
4. 过于对称/工整的句子结构
5. 缺乏个性化的情感表达
6. 机械的时间推进方式
7. 万能情感词汇的滥用

分数含义：0-20=很自然，21-40=少量AI痕迹，41-60=明显AI特征，61-80=强烈AI味，81-100=极可能AI生成`

// ============================================================
//  工具定义
// ============================================================

// ── 1. 风格一致性扫描器 ──

export const polishStyleScanTool = buildTool({
  name: 'polish_style_scan',
  description: `润色工具箱 — 风格一致性扫描器

扫描文本的风格一致性，检测叙述视角跳跃、语气不统一、句式风格混杂等问题。

参数：
- text: （必需）待分析的文本段落
- styleGuide: （可选）风格指南或参考文本，用于对比
- mode: （可选）分析模式，"quick"=纯规则(默认)，"deep"=LLM深度分析
- context: （可选）额外上下文说明`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '待分析的文本段落',
        minLength: 1,
      },
      styleGuide: {
        type: 'string',
        description: '风格指南或参考文本（可选）',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'deep'],
        description: '分析模式，"quick"=纯规则快速分析(默认)，"deep"=LLM深度分析',
      },
      context: {
        type: 'string',
        description: '额外上下文说明，如人物设定、作品类型等（deep模式有效）',
      },
    },
    required: ['text'],
  },
  handler: async (args) => {
    try {
      const { text, styleGuide, mode, context } = args as {
        text: string
        styleGuide?: string
        mode?: string
        context?: string
      }

      if (!text.trim()) {
        return formatToolError('输入文本不能为空')
      }

      if (mode === 'deep') {
        const userPrompt = [
          `请分析以下文本的风格一致性：\n\n${text}`,
          styleGuide ? `\n\n风格指南参考：\n${styleGuide}` : '',
          context ? `\n\n额外上下文：\n${context}` : '',
        ].join('')
        const result = await llmAnalyze<StyleScanResult>(STYLE_SCAN_SYSTEM, userPrompt, 20000)
        if (result.error) return formatToolError(result.error)
        return formatToolResult(JSON.stringify(result.data, null, 2))
      }

      // quick 模式（纯规则）
      const quickResult = ruleBasedStyleScan(text, styleGuide)
      return formatToolResult(JSON.stringify(quickResult, null, 2))
    } catch (err: any) {
      return formatToolError(`风格扫描失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// ── 2. 对话自然度评估器 ──

export const polishDialogueEvalTool = buildTool({
  name: 'polish_dialogue_eval',
  description: `润色工具箱 — 对话自然度评估器

评估文本中对话的自然度，检测过于书面化的表达、对话标签单一、对话过长等问题。

参数：
- text: （必需）包含对话的文本段落
- mode: （可选）分析模式，"quick"=纯规则(默认)，"deep"=LLM深度分析
- characterName: （可选）角色名（deep模式有效）
- context: （可选）角色设定、关系等上下文`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '包含对话的文本段落',
        minLength: 1,
      },
      mode: {
        type: 'string',
        enum: ['quick', 'deep'],
        description: '分析模式，"quick"=纯规则快速分析(默认)，"deep"=LLM深度分析',
      },
      characterName: {
        type: 'string',
        description: '角色名（deep模式用于角色一致性判断）',
      },
      context: {
        type: 'string',
        description: '角色设定、性格、关系等上下文（deep模式有效）',
      },
    },
    required: ['text'],
  },
  handler: async (args) => {
    try {
      const { text, mode, characterName, context } = args as {
        text: string
        mode?: string
        characterName?: string
        context?: string
      }

      if (!text.trim()) {
        return formatToolError('输入文本不能为空')
      }

      if (mode === 'deep') {
        const userPrompt = [
          `请评估以下文本中对话的自然度：\n\n${text}`,
          characterName ? `\n\n角色名：${characterName}` : '',
          context ? `\n\n角色设定/上下文：\n${context}` : '',
        ].join('')
        const result = await llmAnalyze<DialogueEvalResult>(DIALOGUE_EVAL_SYSTEM, userPrompt, 20000)
        if (result.error) return formatToolError(result.error)
        return formatToolResult(JSON.stringify(result.data, null, 2))
      }

      // quick 模式
      const quickResult = ruleBasedDialogueEval(text)
      return formatToolResult(JSON.stringify(quickResult, null, 2))
    } catch (err: any) {
      return formatToolError(`对话评估失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// ── 3. AI 味检测器 ──

export const polishAiDetectTool = buildTool({
  name: 'polish_ai_detect',
  description: `润色工具箱 — AI 味检测器

检测文本中的 AI 生成痕迹，包括过度使用的过渡词、模板化表达、空洞的总结语句等。

参数：
- text: （必需）待检测的文本
- mode: （可选）检测模式，"quick"=纯规则(默认)，"deep"=LLM深度分析`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '待检测的文本',
        minLength: 1,
      },
      mode: {
        type: 'string',
        enum: ['quick', 'deep'],
        description: '检测模式，"quick"=纯规则快速检测(默认)，"deep"=LLM深度分析',
      },
    },
    required: ['text'],
  },
  handler: async (args) => {
    try {
      const { text, mode } = args as {
        text: string
        mode?: string
      }

      if (!text.trim()) {
        return formatToolError('输入文本不能为空')
      }

      if (mode === 'deep') {
        const userPrompt = `请检测以下文本中的 AI 生成特征：\n\n${text}`
        const result = await llmAnalyze<AiDetectResult>(AI_DETECT_SYSTEM, userPrompt, 20000)
        if (result.error) return formatToolError(result.error)
        return formatToolResult(JSON.stringify(result.data, null, 2))
      }

      // quick 模式（纯规则）
      const quickResult = ruleBasedAiDetect(text)
      return formatToolResult(JSON.stringify(quickResult, null, 2))
    } catch (err: any) {
      return formatToolError(`AI 味检测失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// ── 4. 节奏分析仪 ──

export const polishRhythmAnalyzeTool = buildTool({
  name: 'polish_rhythm_analyze',
  description: `润色工具箱 — 节奏分析仪

分析文本的节奏特征，包括句长分布、段落结构、标点密集度等。纯算法分析，无需 LLM。

参数：
- text: （必需）待分析的文本`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '待分析的文本',
        minLength: 1,
      },
    },
    required: ['text'],
  },
  handler: async (args) => {
    try {
      const { text } = args as { text: string }

      if (!text.trim()) {
        return formatToolError('输入文本不能为空')
      }

      // 节奏分析始终使用纯算法（无需 LLM）
      const result = ruleBasedRhythmAnalyze(text)
      return formatToolResult(JSON.stringify(result, null, 2))
    } catch (err: any) {
      return formatToolError(`节奏分析失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})
