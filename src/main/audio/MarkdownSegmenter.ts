/**
 * MarkdownSegmenter — 博客 Markdown 文本拆分为 TTS 合成段落
 *
 * 功能：
 * 1. 按标题（H1/H2/H3）拆分文本为逻辑段落
 * 2. 对超长段落（>500 字符）按句号/问号/感叹号再拆分
 * 3. 跳过代码块、表格等不适合朗读的内容
 * 4. 提取标题、元数据，为 ContentVoiceMapper 提供分类依据
 *
 * 输出：TtsSegment[]，每段有文本、标题上下文、内容类型标签
 */

import { log } from '../logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 段落内容类型 — 用于后续选择语音模型 */
export type SegmentContentType = 'title' | 'heading' | 'paragraph' | 'list_item' | 'quote' | 'note' | 'code_skip' | 'table_skip'

/** TTS 合成段落 */
export interface TtsSegment {
  /** 合成文本（已清理 markdown 标记） */
  text: string
  /** 原始文本（用于日志/调试） */
  rawText: string
  /** 内容类型 */
  contentType: SegmentContentType
  /** 所属标题层级（标题本身的层级=自身，段落的层级=最近的标题） */
  headingLevel: number
  /** 所属标题文本（如 "## 简介" → "简介"） */
  headingText: string
  /** 在原始文档中的段落序号 */
  segmentIndex: number
  /** 字符数 */
  charCount: number
  /** 是否为开头的摘要/导语段落 */
  isIntro: boolean
}

/** 文档元数据 */
export interface DocumentMetadata {
  /** 文章标题（第一个 H1 或文件名） */
  title: string
  /** 总字符数 */
  totalChars: number
  /** 段落数 */
  totalSegments: number
  /** 估算的朗读时长（秒, 按 ~4 字/秒 中文语速） */
  estimatedDurationSec: number
  /** 检测到的语言: 'zh' | 'en' | 'mixed' */
  language: 'zh' | 'en' | 'mixed'
}

// ══════════════════════════════════════════
//  正则常量
// ══════════════════════════════════════════

// 代码块（必须优先处理）
const CODE_FENCE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`([^`]+)`/g

// 标题
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm

// 表格
const TABLE_RE = /^\|.+\|$/gm
const TABLE_SEP_RE = /^\|[-:\s]+\|$/gm

// 引用
const BLOCKQUOTE_RE = /^>\s+(.+)$/gm

// 列表标记
const LIST_MARKER_RE = /^[\s]*[-*+]\s+/gm
const NUMBERED_LIST_RE = /^\s*\d+[.、]\s+/gm

// 水平线
const HR_RE = /^[-*_]{3,}\s*$/gm

// HTML 注释
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

// 链接与图片
const IMG_LINK_RE = /!\[([^\]]*)\]\([^)]+\)/g
const TEXT_LINK_RE = /\[([^\]]*)\]\([^)]+\)/g

// Markdown 标记清理
const BOLD_RE = /\*{1,2}/g
const STRIKETHROUGH_RE = /~~(.+?)~~/g

// 换行与空白
const MULTI_NEWLINE_RE = /\n{3,}/g
const TRAILING_WS_RE = /\s+$/gm

// 句子分隔符（用于长段落拆分）
const SENTENCE_BOUNDARY_RE = /(?<=[。！？；\n!?;])/

// 中英文检测
const CHINESE_CHAR_RE = /[一-鿿㐀-䶿]/
const ENGLISH_WORD_RE = /[a-zA-Z]{2,}/

/** 最大段落字符数（超过此值按句子拆分） */
const MAX_PARAGRAPH_CHARS = 500

/** 最小段落字符数（低于此值与前一段合并，除非是标题） */
const MIN_PARAGRAPH_CHARS = 15

// ══════════════════════════════════════════
//  MarkdownSegmenter
// ══════════════════════════════════════════

export class MarkdownSegmenter {
  /**
   * 将 Markdown 文本拆分为 TTS 合成段落列表。
   *
   * 处理流程：
   * 1. 预处理：移除 HTML 注释、代码块、表格
   * 2. 按标题结构分组
   * 3. 对超长段落按句子拆分
   * 4. 合并过短段落
   * 5. 生成元数据
   */
  segment(markdown: string): { segments: TtsSegment[]; metadata: DocumentMetadata } {
    const t0 = Date.now()
    const rawText = markdown || ''

    // ── 预处理：移除不可读内容 ──
    const cleaned = this.preprocess(rawText)

    // ── 提取标题结构 ──
    const headings = this.extractHeadings(rawText)

    // ── 按标题拆分段落 ──
    const rawSegments = this.splitByHeadings(cleaned, headings)

    // ── 细化：拆分超长段落 + 合并过短段落 ──
    const refinedSegments = this.refineSegments(rawSegments)

    // ── 标记 intro ──
    this.markIntroSegments(refinedSegments)

    // ── 生成元数据 ──
    const metadata = this.buildMetadata(rawText, refinedSegments)

    log('INFO', 'markdown_segmenter_done', {
      total_segments: refinedSegments.length,
      total_chars: metadata.totalChars,
      estimated_duration_sec: metadata.estimatedDurationSec,
      duration_ms: Date.now() - t0,
    })

    return { segments: refinedSegments, metadata }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /** 预处理 Markdown */
  private preprocess(md: string): string {
    let text = md

    // 移除 HTML 注释
    text = text.replace(HTML_COMMENT_RE, '')

    // 提取代码块（用占位替换以便保留位置，但后续跳过）
    text = text.replace(CODE_FENCE_RE, (match) => {
      return `\n\n[代码块: ${match.length} 字符, 已跳过]\n\n`
    })

    // 提取表格（用占位替换）
    text = text.replace(TABLE_RE, (match) => {
      if (TABLE_SEP_RE.test(match)) return ''
      return `\n[表格内容: ${match.replace(/[|│]/g, ' ').trim()}}]\n`
    })

    // 移除水平线
    text = text.replace(HR_RE, '')

    // 规范化换行
    text = text.replace(MULTI_NEWLINE_RE, '\n\n')

    return text.trim()
  }

  /** 提取所有标题 */
  private extractHeadings(md: string): Array<{ level: number; text: string; position: number }> {
    const headings: Array<{ level: number; text: string; position: number }> = []
    let match: RegExpExecArray | null

    // 重置正则
    HEADING_RE.lastIndex = 0
    while ((match = HEADING_RE.exec(md)) !== null) {
      const headingText = match[2].replace(/[#*_`]/g, '').trim()
      if (headingText) {
        headings.push({
          level: match[1].length,
          text: headingText,
          position: match.index,
        })
      }
    }

    return headings
  }

  /** 按标题拆分文本 */
  private splitByHeadings(
    text: string,
    headings: Array<{ level: number; text: string; position: number }>,
  ): Array<{ text: string; headingLevel: number; headingText: string; contentType: SegmentContentType }> {
    if (headings.length === 0) {
      // 无标题：整篇作为一个大段落
      return [{ text, headingLevel: 0, headingText: '', contentType: 'paragraph' }]
    }

    const segments: Array<{
      text: string
      headingLevel: number
      headingText: string
      contentType: SegmentContentType
    }> = []

    // 第一个标题之前的内容（intro）
    if (headings[0].position > 0) {
      const introText = text.slice(0, headings[0].position).trim()
      if (introText) {
        segments.push({ text: introText, headingLevel: 0, headingText: '', contentType: 'paragraph' })
      }
    }

    // 遍历每个标题
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]
      const nextPos = i + 1 < headings.length ? headings[i + 1].position : text.length
      const content = text.slice(h.position, nextPos).trim()

      // 标题行本身作为标题段落
      segments.push({
        text: h.text,
        headingLevel: h.level,
        headingText: h.text,
        contentType: h.level === 1 ? 'title' : 'heading',
      })

      // 标题后的正文内容
      const bodyText = this.extractBodyAfterHeading(content)
      if (bodyText) {
        segments.push({
          text: bodyText,
          headingLevel: h.level,
          headingText: h.text,
          contentType: 'paragraph',
        })
      }
    }

    return segments
  }

  /** 从标题+正文中提取正文部分（去掉标题行） */
  private extractBodyAfterHeading(sectionText: string): string {
    const lines = sectionText.split('\n')
    // 跳过第一行（标题行），以及后面的空行
    let startIdx = 1
    while (startIdx < lines.length && lines[startIdx].trim() === '') {
      startIdx++
    }
    return lines.slice(startIdx).join('\n').trim()
  }

  /** 精细化段落：拆分超长段落、合并过短段落 */
  private refineSegments(
    raw: Array<{ text: string; headingLevel: number; headingText: string; contentType: SegmentContentType }>,
  ): TtsSegment[] {
    const result: TtsSegment[] = []
    let segmentIndex = 0

    for (const seg of raw) {
      const cleanedText = this.cleanSegmentText(seg.text)

      if (!cleanedText) continue

      // 标题/heading 直接保留（即使短）
      if (seg.contentType === 'title' || seg.contentType === 'heading') {
        result.push({
          text: cleanedText,
          rawText: seg.text,
          contentType: seg.contentType,
          headingLevel: seg.headingLevel,
          headingText: seg.headingText,
          segmentIndex: segmentIndex++,
          charCount: cleanedText.length,
          isIntro: false,
        })
        continue
      }

      // 短文本合并到前一段
      if (cleanedText.length < MIN_PARAGRAPH_CHARS && result.length > 0) {
        const last = result[result.length - 1]
        if (last.contentType !== 'title' && last.contentType !== 'heading') {
          last.text += '，' + cleanedText
          last.charCount = last.text.length
          last.rawText += '\n' + seg.text
          continue
        }
      }

      // 超长段落按句子拆分
      if (cleanedText.length > MAX_PARAGRAPH_CHARS) {
        const sentences = cleanedText.split(SENTENCE_BOUNDARY_RE).filter((s) => s.trim().length > 0)
        for (const sentence of sentences) {
          const trimmed = sentence.trim()
          if (trimmed) {
            result.push({
              text: trimmed,
              rawText: trimmed,
              contentType: 'paragraph',
              headingLevel: seg.headingLevel,
              headingText: seg.headingText,
              segmentIndex: segmentIndex++,
              charCount: trimmed.length,
              isIntro: false,
            })
          }
        }
      } else {
        result.push({
          text: cleanedText,
          rawText: seg.text,
          contentType: 'paragraph',
          headingLevel: seg.headingLevel,
          headingText: seg.headingText,
          segmentIndex: segmentIndex++,
          charCount: cleanedText.length,
          isIntro: false,
        })
      }
    }

    return result
  }

  /** 清理段落文本中的 Markdown 标记 */
  private cleanSegmentText(text: string): string {
    let cleaned = text

    // 移除行内代码标记
    cleaned = cleaned.replace(INLINE_CODE_RE, '$1')

    // 移除图片标记
    cleaned = cleaned.replace(IMG_LINK_RE, '$1')

    // 链接只保留文字
    cleaned = cleaned.replace(TEXT_LINK_RE, '$1')

    // 移除粗体/斜体标记
    cleaned = cleaned.replace(BOLD_RE, '')

    // 移除删除线标记
    cleaned = cleaned.replace(STRIKETHROUGH_RE, '$1')

    // 移除引用标记
    cleaned = cleaned.replace(BLOCKQUOTE_RE, '$1')

    // 移除列表标记
    cleaned = cleaned.replace(LIST_MARKER_RE, '')
    cleaned = cleaned.replace(NUMBERED_LIST_RE, '')

    // 移除表格标记
    cleaned = cleaned.replace(TABLE_RE, '')
    cleaned = cleaned.replace(TABLE_SEP_RE, '')

    // 移除尾部空白
    cleaned = cleaned.replace(TRAILING_WS_RE, '')

    // 多音字修正（复用 TtsService 中的处理）
    cleaned = this.fixPolyphone(cleaned)

    return cleaned.trim()
  }

  /** 多音字修正 */
  private fixPolyphone(text: string): string {
    return text
      .replace(/还行/g, '还型')
      .replace(/行吧/g, '型吧')
      .replace(/行了/g, '型了')
      .replace(/行吗/g, '型吗')
      .replace(/行不/g, '型不')
      .replace(/行啊/g, '型啊')
      .replace(/行啦/g, '型啦')
  }

  /** 标记开头的段落为 intro */
  private markIntroSegments(segments: TtsSegment[]): void {
    let count = 0
    for (const seg of segments) {
      if (seg.contentType === 'title' || seg.contentType === 'heading') continue
      if (count >= 2) break
      seg.isIntro = true
      count++
    }
  }

  /** 构建文档元数据 */
  private buildMetadata(rawText: string, segments: TtsSegment[]): DocumentMetadata {
    const title = this.findTitle(segments, rawText)
    const totalChars = segments.reduce((sum, s) => sum + s.charCount, 0)
    const language = this.detectLanguage(rawText)

    return {
      title,
      totalChars,
      totalSegments: segments.length,
      // 中文朗读速度约 4 字/秒
      estimatedDurationSec: Math.ceil(totalChars / 4),
      language,
    }
  }

  /** 提取文章标题 */
  private findTitle(segments: TtsSegment[], rawText: string): string {
    // 优先使用第一个 H1 标题
    for (const seg of segments) {
      if (seg.contentType === 'title') return seg.text
    }

    // 其次使用第一个 H2
    for (const seg of segments) {
      if (seg.contentType === 'heading' && seg.headingLevel === 2) return seg.text
    }

    // 从原始文本中提取第一个非空行
    const firstLine = rawText.split('\n')[0]?.trim()
    if (firstLine && firstLine.replace(/^#+\s*/, '').trim()) {
      return firstLine.replace(/^#+\s*/, '').trim()
    }

    return '未命名文章'
  }

  /** 检测文本语言 */
  private detectLanguage(text: string): 'zh' | 'en' | 'mixed' {
    const chineseCount = (text.match(CHINESE_CHAR_RE) || []).length
    const englishCount = (text.match(ENGLISH_WORD_RE) || []).length

    if (chineseCount > 0 && englishCount === 0) return 'zh'
    if (englishCount > 0 && chineseCount === 0) return 'en'
    if (chineseCount > 0 && englishCount > 0) return 'mixed'
    return 'zh' // 默认中文
  }
}

/** 全局单例 */
export const markdownSegmenter = new MarkdownSegmenter()
