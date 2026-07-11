/**
 * WechatFormatter — 工业颂歌 公众号排版格式化器
 *
 * 职责：
 * 1. 将 Agent 输出内容格式化为微信公众号文章排版
 * 2. 遵循工业颂歌风格指南（段落密度、引用样式、强调方式等）
 * 3. 可选使用 LLM 进行智能格式化增强
 *
 * 设计原则：
 * - 纯函数式设计，无副作用
 * - 格式化行为可通过参数调整
 * - 与 TypographyMemoryManager 的排版参数兼容
 */

import { log } from '../../logger/Logger'

// ════════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════════

/** 工业颂歌排版参数 */
export interface WechatFormatOptions {
  /** 是否使用 LLM 增强格式化 */
  useLlmEnhance?: boolean
  /** 断句密度 */
  sentenceDensity?: 'dense' | 'normal' | 'sparse'
  /** 引用样式 */
  citationStyle?: 'blockquote' | 'indent' | 'inline_quote'
  /** 导语长度 */
  introLength?: 'none' | 'short' | 'medium' | 'long'
  /** 段落间距 */
  paragraphSpacing?: 'compact' | 'normal' | 'wide'
  /** 重点强调样式 */
  emphasisStyle?: 'bold' | 'color_mark' | 'bg_mark'
  /** 是否附带发布就绪标记 */
  publishReady?: boolean
}

/** 格式化结果 */
export interface FormatResult {
  /** 格式化后的文本 */
  text: string
  /** 是否成功格式化 */
  success: boolean
  /** 格式化类型 */
  type: 'basic' | 'llm_enhanced'
  /** 使用的排版参数 */
  optionsUsed: WechatFormatOptions
  /** 错误信息 */
  error?: string
}

// ════════════════════════════════════════════════════════════════
//  默认排版参数
// ════════════════════════════════════════════════════════════════

const DEFAULT_OPTIONS: WechatFormatOptions = {
  useLlmEnhance: false,
  sentenceDensity: 'normal',
  citationStyle: 'blockquote',
  introLength: 'medium',
  paragraphSpacing: 'normal',
  emphasisStyle: 'bold',
  publishReady: false,
}

// ════════════════════════════════════════════════════════════════
//  公众号文本模板
// ════════════════════════════════════════════════════════════════

/** 工业颂歌公众号文章标题格式化 */
function formatTitle(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return text

  // 第一个非空行作为标题，使用居中格式
  const title = lines[0].trim()
  const rest = lines.slice(1).join('\n')

  return `╔════════════════════════════╗
║        ${title.padEnd(20)}║
╚════════════════════════════╝

${rest}`
}

/** 工业颂歌公众号段落格式化 */
function formatParagraphs(text: string, options: WechatFormatOptions): string {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim())
  const spacing = options.paragraphSpacing === 'wide' ? '\n\n' : options.paragraphSpacing === 'compact' ? '\n' : '\n\n'

  return paragraphs
    .map((p) => {
      const trimmed = p.trim()
      if (!trimmed) return ''

      // 检测是否已经是 HTML/标记内容
      if (trimmed.startsWith('<') || trimmed.startsWith('╔') || trimmed.startsWith('>')) return trimmed

      // 检测是否包含标题标记（Markdown heading）
      if (trimmed.startsWith('# ')) return `\n【${trimmed.slice(2)}】\n`
      if (trimmed.startsWith('## ')) return `\n【${trimmed.slice(3)}】\n`
      if (trimmed.startsWith('### ')) return `\n· ${trimmed.slice(4)} ·\n`

      return trimmed
    })
    .join(spacing)
}

/** 工业颂歌公众号引用格式化 */
function formatCitations(text: string): string {
  // 将 > 开头的引用行转换为公众号引用格式
  return text.replace(/^>\s?(.+)$/gm, '┃ $1')
}

/** 工业颂歌公众号列表格式化 */
function formatLists(text: string): string {
  // 将 - 开头的无序列表转换为公众号格式
  let result = text.replace(/^- (.+)$/gm, '• $1')
  // 将数字列表转换为公众号格式
  result = result.replace(/^(\d+)\. (.+)$/gm, '$1. $2')
  return result
}

/** 工业颂歌公众号强调格式化 */
function formatEmphasis(text: string, options: WechatFormatOptions): string {
  if (options.emphasisStyle === 'color_mark') {
    // 将 **bold** 替换为彩色标记格式
    return text.replace(/\*\*(.+?)\*\*/g, '〖$1〗')
  }
  if (options.emphasisStyle === 'bg_mark') {
    return text.replace(/\*\*(.+?)\*\*/g, '【[$1]】')
  }
  // default: bold — keep markdown bold
  return text
}

/** 添加公众号发布就绪标记 */
function addPublishReadyMarker(text: string): string {
  const footer = `
---
📱 本文已格式化为工业颂歌公众号排版
✅ 可直接复制到微信公众号编辑器发布
`
  return text + footer
}

// ════════════════════════════════════════════════════════════════
//  LLM 格式化提示词
// ════════════════════════════════════════════════════════════════

/**
 * 构建 LLM 格式化提示词。
 * 用于调用 LLM 对内容进行智能公众号排版。
 */
function buildLlmFormatPrompt(text: string, options: WechatFormatOptions): string {
  const densityGuide = options.sentenceDensity === 'dense' ? '每段1-2句，紧凑有力' :
    options.sentenceDensity === 'sparse' ? '每段3-5句，舒缓有致' :
    '每段2-3句，节奏适中'

  const introGuide = options.introLength === 'none' ? '不需要导语' :
    options.introLength === 'short' ? '导语控制在1-2句' :
    options.introLength === 'long' ? '导语控制在4-6句' :
    '导语控制在2-3句'

  return `你是一个专业的微信公众号排版编辑，请将以下内容排版为"工业颂歌"公众号文章格式。

排版要求：
- ${densityGuide}
- ${introGuide}
- 引用内容使用 ┃ 前缀
- 标题使用 【】 包裹
- 段落之间使用空行分隔
- 重点内容加粗或使用〖〗标记
- 保持原文的完整信息和语气

原文内容：
${text}

请直接输出排版后的结果。`
}

// ════════════════════════════════════════════════════════════════
//  核心格式化函数
// ════════════════════════════════════════════════════════════════

/**
 * 对文本进行基本的公众号排版格式化（无需 LLM 调用）。
 * 支持标题、段落、引用、列表、强调等基本格式。
 */
export function formatBasic(text: string, options?: Partial<WechatFormatOptions>): FormatResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  try {
    let result = text.trim()

    // 1. 格式化引用
    result = formatCitations(result)

    // 2. 格式化列表
    result = formatLists(result)

    // 3. 格式化强调
    result = formatEmphasis(result, opts)

    // 4. 格式化段落
    result = formatParagraphs(result, opts)

    // 5. 格式化标题
    result = formatTitle(result)

    // 6. 添加发布就绪标记
    if (opts.publishReady) {
      result = addPublishReadyMarker(result)
    }

    return {
      text: result,
      success: true,
      type: 'basic',
      optionsUsed: opts,
    }
  } catch (err) {
    log('WARN', 'wechat_format_basic_failed', { error: String(err) })
    return {
      text,
      success: false,
      type: 'basic',
      optionsUsed: opts,
      error: String(err),
    }
  }
}

/**
 * 使用 LLM 增强的公众号排版格式化。
 * 当 enableLlmEnhance 为 true 且提供了 llmService 时使用。
 */
export async function formatWithLlm(
  text: string,
  options?: Partial<WechatFormatOptions>,
  llmService?: { chatJson(prompt: string, opts?: unknown): Promise<unknown> },
): Promise<FormatResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // 如果未提供 LLM 服务或未启用 LLM 增强，回退到基础格式化
  if (!llmService || !opts.useLlmEnhance) {
    return formatBasic(text, opts)
  }

  try {
    const prompt = buildLlmFormatPrompt(text, opts)
    const result = await llmService.chatJson(prompt, {
      temperature: 0.3,
      max_tokens: 4096,
    })

    const formattedText = typeof result === 'string' ? result : (result as any)?.reply || text

    // LLM 格式化后，再应用基础格式规则做二次处理
    let final = formattedText
    if (opts.publishReady) {
      final = addPublishReadyMarker(final)
    }

    return {
      text: final,
      success: true,
      type: 'llm_enhanced',
      optionsUsed: opts,
    }
  } catch (err) {
    log('WARN', 'wechat_format_llm_failed', { error: String(err) })
    // LLM 格式化失败时回退到基础格式化
    return formatBasic(text, opts)
  }
}

/**
 * 检测文本是否适合公众号排版。
 * 返回是否需要格式化及其置信度。
 */
export function detectFormatNeed(text: string): { needsFormat: boolean; confidence: number; reason?: string } {
  if (!text || text.length < 50) {
    return { needsFormat: false, confidence: 0, reason: '文本过短' }
  }

  const lower = text.toLowerCase()

  // 检测是否包含公众号相关的关键词
  const wechatKeywords = ['公众号', '排版', '工业颂歌', '发布', '文章', '推文']
  const keywordMatch = wechatKeywords.filter((k) => text.includes(k)).length

  if (keywordMatch >= 2) {
    return { needsFormat: true, confidence: 0.9, reason: `检测到 ${keywordMatch} 个公众号关键词` }
  }
  if (keywordMatch === 1) {
    return { needsFormat: true, confidence: 0.6, reason: '检测到 1 个公众号关键词' }
  }

  // 检测是否包含长文本（适合文章的场景）
  if (text.length > 500) {
    const hasHeaders = /^#{1,3}\s/m.test(text)
    if (hasHeaders) {
      return { needsFormat: true, confidence: 0.5, reason: '长文本含标题，可能需排版' }
    }
  }

  return { needsFormat: false, confidence: 0 }
}
