/**
 * BlogToolboxTools — MCP 标准化博客工具箱
 *
 * 将博客写作和发布功能封装为标准 MCP 工具集，支持：
 * 1. 内容转换工具 (Markdown→HTML)
 * 2. SEO 优化工具（关键词分析、内链检查）
 * 3. 多平台适配工具（格式化不同平台）
 * 4. 流水线编排工具（按推理链顺序调用）
 *
 * ## 设计原则
 *
 * - 每个工具独立、自描述，符合 MCP Tool 规范
 * - 工具名统一前缀 blog_toolbox_，方便动态发现
 * - 返回值统一为 markdown 文本格式
 * - 支持通过 blog_toolbox_pipeline 串联多个工具
 *
 * ## 热插拔支持
 *
 * 工具定义为标准 MCP 工具格式，可通过 register_tool / unregister_tool
 * 动态注册注销。后续可通过添加新文件扩展工具集（如 AI 配音、图片生成）。
 */

import { buildTool, formatToolResult, formatToolError } from '../types'

// =============================================================================
// 常量
// =============================================================================

const COMMON_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  '什么', '怎么', '因为', '所以', '但是', '如果', '虽然', '而且', '或者',
  '不过', '然后', '这个', '那个', '已经', '可以', '应该', '可能', '需要',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'must', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
])

// =============================================================================
// 内部工具函数
// =============================================================================

/** 简易 Markdown → HTML 渲染器（无需外部依赖） */
function renderMarkdownToHtml(md: string): string {
  let html = md

  // 1. 代码块（必须优先处理）
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? ` class="language-${lang}"` : ''
    const escaped = escapeHtml(code.trimEnd())
    return `<pre><code${langClass}>${escaped}</code></pre>`
  })

  // 2. 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // 3. 图片
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')

  // 4. 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 5. 水平线
  html = html.replace(/^---+$/gm, '<hr />')

  // 6. 标题
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')

  // 7. 粗体和斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // 8. 删除线
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')

  // 9. 引用
  html = html.replace(/^>\s+(.+)$/gm, (_, content) => {
    // 嵌套引用处理
    const inner = content.replace(/^>\s+/gm, '')
    if (inner.startsWith('>')) {
      return `<blockquote><blockquote>${inner.replace(/^>\s*/, '')}</blockquote></blockquote>`
    }
    return `<blockquote>${inner}</blockquote>`
  })

  // 10. 无序列表
  html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (_, indent, content) => {
    const depth = Math.floor(indent.length / 2)
    if (depth === 0) return `<li>${content}</li>`
    return `<li style="margin-left:${depth * 20}px">${content}</li>`
  })

  // 11. 有序列表
  html = html.replace(/^(\s*)\d+\.\s+(.+)$/gm, (_, indent, content) => {
    const depth = Math.floor(indent.length / 2)
    if (depth === 0) return `<li>${content}</li>`
    return `<li style="margin-left:${depth * 20}px">${content}</li>`
  })

  // 12. 表格
  html = html.replace(/^\|(.+)\|$/gm, (line) => {
    const cells = line.split('|').filter(Boolean).map((c) => c.trim())
    // 忽略分隔行（|---|）
    if (cells.length > 0 && /^[-:\s]+$/.test(cells[0])) return line
    return `<td>${cells.join('</td><td>')}</td>`
  })
  // 将连续的 <td> 行包装成 <table><tr>
  html = html.replace(/((?:<td>.*?<\/td>\n?)+)/g, '<tr>$1</tr>')
  html = html.replace(/((?:<tr>.*?<\/tr>\n?)+)/g, '<table>$1</table>')

  // 13. 段落（非标题、非列表、非引用、非表格、非空行的文本块）
  const lines = html.split('\n')
  const result: string[] = []
  let inParagraph = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<li') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('</blockquote') ||
      trimmed.startsWith('<table') ||
      trimmed.startsWith('</table') ||
      trimmed.startsWith('<tr') ||
      trimmed.startsWith('</tr>') ||
      trimmed.startsWith('<td') ||
      trimmed.startsWith('</td>') ||
      trimmed.startsWith('<pre') ||
      trimmed.startsWith('</pre>') ||
      trimmed.startsWith('<hr') ||
      trimmed.startsWith('<img') ||
      trimmed.startsWith('<ul') ||
      trimmed.startsWith('</ul') ||
      trimmed.startsWith('<ol') ||
      trimmed.startsWith('</ol')
    ) {
      if (inParagraph) {
        result.push('</p>')
        inParagraph = false
      }
      result.push(line)
    } else if (trimmed.startsWith('<')) {
      if (inParagraph) {
        result.push('</p>')
        inParagraph = false
      }
      result.push(line)
    } else {
      if (!inParagraph) {
        result.push('<p>')
        inParagraph = true
      }
      result.push(line)
    }
  }
  if (inParagraph) result.push('</p>')
  html = result.join('\n')

  // 14. 包装无序/有序列表
  html = html.replace(/((?:<li[^>]*>.*?<\/li>\n?)+)/g, (match) => {
    // 如果已经有 <ul> 或 <ol> 包裹，跳过
    if (match.includes('<ul') || match.includes('<ol')) return match
    return `<ul>\n${match}\n</ul>`
  })

  return html
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 提取纯文本（去除 markdown 标记） */
function extractPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[#*_~>`\-|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 提取中英文单词 */
function extractWords(text: string): string[] {
  const tokens: string[] = []

  // 英文单词
  const englishWords = text.match(/[a-zA-Z]+/g) || []
  for (const w of englishWords) {
    const lower = w.toLowerCase()
    if (!COMMON_STOP_WORDS.has(lower) && lower.length > 1) {
      tokens.push(lower)
    }
  }

  // 中文词组（2-4 字窗口）
  const chineseChars = text.replace(/[^一-鿿]/g, '')
  for (let i = 0; i < chineseChars.length; i++) {
    // 单字（过滤停用词）
    const single = chineseChars[i]
    if (!COMMON_STOP_WORDS.has(single)) {
      tokens.push(single)
    }
    // 双字词
    if (i + 1 < chineseChars.length) {
      tokens.push(chineseChars.substring(i, i + 2))
    }
    // 三字词
    if (i + 2 < chineseChars.length) {
      tokens.push(chineseChars.substring(i, i + 3))
    }
    // 四字词
    if (i + 3 < chineseChars.length) {
      tokens.push(chineseChars.substring(i, i + 4))
    }
  }

  return tokens
}

/** 计算词频 */
function computeTermFrequency(words: string[]): Array<{ word: string; count: number; density: number }> {
  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1)
  }
  const total = words.length || 1
  return Array.from(freq.entries())
    .map(([word, count]) => ({ word, count, density: count / total }))
    .sort((a, b) => b.count - a.count)
}

/** 估算中文可读性分数（基于平均句子长度和难词比例） */
function estimateReadability(text: string): { score: number; level: string } {
  const sentences = text.split(/[。！？\n!?\n]+/).filter(Boolean)
  const totalChars = text.replace(/\s/g, '').length
  const totalWords = text.split(/[\s,，、]+/).filter(Boolean).length
  const avgSentenceLength = sentences.length > 0 ? totalWords / sentences.length : 0

  // 难词检测（字数≥4 的词视为难词）
  const hardWords = text.split(/[\s,，、]+/).filter((w) => w.length >= 4)
  const hardWordRatio = totalWords > 0 ? hardWords.length / totalWords : 0

  // 评分公式（0-100，越高越易读）
  const sentenceScore = Math.max(0, 100 - Math.abs(avgSentenceLength - 20) * 2)
  const hardWordScore = Math.max(0, 100 - hardWordRatio * 200)
  const score = Math.round(sentenceScore * 0.5 + hardWordScore * 0.5)

  let level: string
  if (score >= 80) level = '非常易读'
  else if (score >= 60) level = '较易读'
  else if (score >= 40) level = '中等'
  else if (score >= 20) level = '较难读'
  else level = '难读'

  return { score, level }
}

/** 分析内部链接 */
function analyzeInternalLinks(md: string): {
  totalLinks: number
  internalLinks: number
  externalLinks: number
  brokenLinks: string[]
  linkDetails: Array<{ text: string; url: string; type: 'internal' | 'external' | 'image' }>
} {
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g
  const links: Array<{ text: string; url: string; type: 'internal' | 'external' | 'image' }> = []
  const brokenLinks: string[] = []

  let match: RegExpExecArray | null
  while ((match = linkPattern.exec(md)) !== null) {
    const text = match[1]
    const url = match[2]
    if (url.startsWith('http') || url.startsWith('https')) {
      links.push({ text, url, type: 'external' })
    } else if (url.startsWith('#') || url.startsWith('/')) {
      links.push({ text, url, type: 'internal' })
    } else if (url.startsWith('mailto:')) {
      links.push({ text, url, type: 'external' })
    } else {
      // 相对路径视为 internal
      links.push({ text, url, type: 'internal' })
    }
    // 检查明显断链
    if (!url || url === '#' || url === '' || url.startsWith('javascript:')) {
      brokenLinks.push(url || '(空)')
    }
  }

  while ((match = imagePattern.exec(md)) !== null) {
    links.push({ text: match[1] || '(图片)', url: match[2], type: 'image' })
  }

  return {
    totalLinks: links.length,
    internalLinks: links.filter((l) => l.type === 'internal').length,
    externalLinks: links.filter((l) => l.type === 'external').length,
    brokenLinks: [...new Set(brokenLinks)],
    linkDetails: links,
  }
}

/** 检查标题结构 */
function analyzeHeadingStructure(md: string): {
  valid: boolean
  issues: string[]
  headings: Array<{ level: number; text: string }>
} {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm
  const headings: Array<{ level: number; text: string }> = []
  const issues: string[] = []

  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(md)) !== null) {
    headings.push({ level: match[1].length, text: match[2] })
  }

  // 检查标题层级跳跃
  let lastLevel = 0
  for (const h of headings) {
    if (lastLevel > 0 && h.level > lastLevel + 1) {
      issues.push(`标题层级跳跃：从 H${lastLevel} 直接到 H${h.level}（"${h.text}"）`)
    }
    lastLevel = h.level
  }

  // 检查是否有 H1
  const hasH1 = headings.some((h) => h.level === 1)
  if (!hasH1 && headings.length > 0) {
    issues.push('缺少 H1 标题（建议使用一个 H1 作为文章主标题）')
  }

  // 检查多个 H1
  const h1Count = headings.filter((h) => h.level === 1).length
  if (h1Count > 1) {
    issues.push(`存在 ${h1Count} 个 H1 标题（建议仅使用一个主标题）`)
  }

  // 检查标题总长度
  for (const h of headings) {
    if (h.text.length > 60) {
      issues.push(`标题过长（${h.text.length}字）："${h.text.slice(0, 50)}..."`)
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    headings,
  }
}

// =============================================================================
// 平台格式化适配器
// =============================================================================

interface PlatformFormatter {
  name: string
  formatTitle(title: string): string
  formatContent(md: string): string
  formatCode(lang: string, code: string): string
  formatImage(alt: string, url: string): string
  formatLink(text: string, url: string): string
}

/** CSDN 格式化 */
const csdnFormatter: PlatformFormatter = {
  name: 'CSDN',
  formatTitle: (t) => `# ${t}`,
  formatContent: (md) => {
    // CSDN 支持标准 Markdown，代码块用 ``` 包裹
    // 添加 TOC 标记
    let content = md
    if (!content.includes('[TOC]') && !content.includes('@[toc]')) {
      content = '@[toc]\n\n' + content
    }
    return content
  },
  formatCode: (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  formatImage: (alt, url) => `![${alt}](${url})`,
  formatLink: (text, url) => `[${text}](${url})`,
}

/** 知乎格式化 */
const zhihuFormatter: PlatformFormatter = {
  name: '知乎',
  formatTitle: (t) => `# ${t}`,
  formatContent: (md) => {
    // 知乎使用特殊代码块格式
    let content = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `\`\`\`${lang}\n${code.trimEnd()}\n\`\`\``
    })
    // 知乎不支持 [TOC]
    content = content.replace(/\[TOC\]/gi, '')
    // 知乎外链需要保留
    return content
  },
  formatCode: (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  formatImage: (alt, url) => `![${alt}](${url})`,
  formatLink: (text, url) => `[${text}](${url})`,
}

/** 掘金格式化 */
const juejinFormatter: PlatformFormatter = {
  name: '掘金',
  formatTitle: (t) => `# ${t}`,
  formatContent: (md) => {
    // 掘金支持标准 Markdown
    // 掘金不支持 [TOC]
    let content = md.replace(/\[TOC\]/gi, '')
    return content
  },
  formatCode: (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  formatImage: (alt, url) => `![${alt}](${url})`,
  formatLink: (text, url) => `[${text}](${url})`,
}

/** 博客园格式化 */
const cnblogsFormatter: PlatformFormatter = {
  name: '博客园',
  formatTitle: (t) => `# ${t}`,
  formatContent: (md) => {
    // 博客园支持标准 Markdown
    let content = md
    // 博客园代码块推荐使用 ``` 而非缩进
    // 添加博客园特有的摘要标记
    if (!content.includes('<!--more-->') && content.length > 300) {
      const lines = content.split('\n')
      // 在第一个段落或标题后插入 <!--more-->
      let insertIdx = -1
      for (let i = 1; i < Math.min(lines.length, 15); i++) {
        if (lines[i].trim() === '' && lines[i - 1].trim() !== '') {
          insertIdx = i
          break
        }
      }
      if (insertIdx > 0) {
        lines.splice(insertIdx, 0, '<!--more-->')
        content = lines.join('\n')
      }
    }
    return content
  },
  formatCode: (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  formatImage: (alt, url) => `![${alt}](${url})`,
  formatLink: (text, url) => `[${text}](${url})`,
}

/** 微信公众号格式化 */
const wechatFormatter: PlatformFormatter = {
  name: '微信公众号',
  formatTitle: (t) => t, // 公众号编辑器有单独的标题输入
  formatContent: (md) => {
    // 公众号富文本编辑，返回 HTML
    const html = renderMarkdownToHtml(md)

    // 添加公众号样式
    const styled = html
      .replace(/<p>/g, '<p style="font-size:15px;line-height:1.75;margin:10px 0;letter-spacing:0.5px;">')
      .replace(/<h1>/g, '<h1 style="font-size:22px;font-weight:bold;text-align:center;margin:20px 0 15px;">')
      .replace(/<h2>/g, '<h2 style="font-size:18px;font-weight:bold;margin:18px 0 10px;padding-left:10px;border-left:4px solid #07c160;">')
      .replace(/<h3>/g, '<h3 style="font-size:16px;font-weight:bold;margin:15px 0 8px;">')
      .replace(/<blockquote>/g, '<blockquote style="background:#f5f5f5;padding:10px 15px;border-left:4px solid #07c160;margin:10px 0;color:#666;">')
      .replace(/<code>/g, '<code style="background:#f0f0f0;padding:2px 5px;border-radius:3px;font-size:13px;color:#d63384;">')
      .replace(/<pre>/g, '<pre style="background:#f8f8f8;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;line-height:1.5;">')
      .replace(/<img /g, '<img style="max-width:100%;border-radius:4px;margin:10px 0;" ')

    return styled
  },
  formatCode: (_lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    return `<pre style="background:#f8f8f8;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;line-height:1.5;"><code>${escaped}</code></pre>`
  },
  formatImage: (_alt, url) => {
    return `<img src="${url}" style="max-width:100%;border-radius:4px;margin:10px 0;" />`
  },
  formatLink: (text, url) => `<a href="${url}" style="color:#07c160;">${text}</a>`,
}

/** 通用 Markdown 格式化 */
const genericFormatter: PlatformFormatter = {
  name: '通用 Markdown',
  formatTitle: (t) => `# ${t}`,
  formatContent: (md) => md,
  formatCode: (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\``,
  formatImage: (alt, url) => `![${alt}](${url})`,
  formatLink: (text, url) => `[${text}](${url})`,
}

const PLATFORM_FORMATTERS: Record<string, PlatformFormatter> = {
  csdn: csdnFormatter,
  zhihu: zhihuFormatter,
  juejin: juejinFormatter,
  cnblogs: cnblogsFormatter,
  wechat: wechatFormatter,
  generic: genericFormatter,
}

const PLATFORM_KEYS = Object.keys(PLATFORM_FORMATTERS)

/**
 * 格式化内容为目标平台格式。
 * 返回 { formatted, warnings, platform }
 */
function formatForPlatform(md: string, platform: string): { formatted: string; warnings: string[]; platform: string } {
  const formatter = PLATFORM_FORMATTERS[platform.toLowerCase()]
  if (!formatter) {
    return { formatted: md, warnings: [`未知平台 "${platform}"，使用通用 Markdown 格式`], platform: 'generic' }
  }
  const warnings: string[] = []

  let content = formatter.formatContent(md)

  // 代码块安全检查
  const codeBlockCount = (content.match(/```/g) || []).length
  if (codeBlockCount % 2 !== 0) {
    warnings.push('代码块标记不匹配（``` 数量为奇数），可能存在渲染问题')
  }

  return { formatted: content, warnings, platform: formatter.name }
}

// =============================================================================
// 工具: blog_md_to_html — Markdown 转 HTML
// =============================================================================

export const blogMdToHtmlTool = buildTool({
  name: 'blog_md_to_html',
  description:
    '【BlogToolbox】将 Markdown 内容转换为 HTML。支持标题、粗斜体、代码块、表格、链接、图片、列表、引用等标准 Markdown 语法。可选择是否添加基础 CSS 样式和目录',
  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '要转换的 Markdown 原文',
      },
      addStyles: {
        type: 'boolean',
        description: '是否添加基础 CSS 样式（默认 false，纯 HTML 结构）',
      },
      addToc: {
        type: 'boolean',
        description: '是否在 HTML 开头生成目录（默认 false）',
      },
      title: {
        type: 'string',
        description: '可选，文档标题（会插入 <title> 和 H1 中）',
      },
    },
    required: ['markdown'],
  },
  handler: async (args: { markdown: string; addStyles?: boolean; addToc?: boolean; title?: string }) => {
    try {
      const md = String(args.markdown)
      if (!md.trim()) return formatToolError('Markdown 内容不能为空')

      let html = renderMarkdownToHtml(md)

      // 生成目录
      let tocHtml = ''
      if (args.addToc) {
        const headingPattern = /<h([1-6])>(.+?)<\/h\1>/g
        const headings: Array<{ level: number; text: string; id: string }> = []
        let match: RegExpExecArray | null
        while ((match = headingPattern.exec(html)) !== null) {
          const id = `heading-${headings.length + 1}`
          headings.push({ level: parseInt(match[1]), text: match[2], id })
        }
        // 给标题添加 id
        for (const h of headings) {
          html = html.replace(
            `<h${h.level}>${h.text}</h${h.level}>`,
            `<h${h.level} id="${h.id}">${h.text}</h${h.level}>`,
          )
        }
        if (headings.length > 0) {
          const tocLines = ['<nav class="blog-toc"><h3>目录</h3><ul>']
          for (const h of headings) {
            const indent = '&nbsp;&nbsp;'.repeat(h.level - 1)
            tocLines.push(`<li>${indent}<a href="#${h.id}">${h.text}</a></li>`)
          }
          tocLines.push('</ul></nav>')
          tocHtml = tocLines.join('\n')
        }
      }

      // 构建完整 HTML
      const titleStr = args.title ? escapeHtml(args.title) : 'Blog Post'
      const styleStr = args.addStyles
        ? `
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; line-height: 1.8; max-width: 800px; margin: 0 auto; padding: 20px; color: #333; }
  h1, h2, h3, h4 { margin-top: 24px; margin-bottom: 12px; font-weight: 600; }
  h1 { font-size: 24px; border-bottom: 2px solid #eee; padding-bottom: 8px; }
  h2 { font-size: 20px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
  h3 { font-size: 18px; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f8f8f8; padding: 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; margin: 10px 0; padding: 10px 15px; color: #666; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  img { max-width: 100%; border-radius: 4px; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .blog-toc { background: #f9f9f9; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
  .blog-toc ul { list-style: none; padding-left: 10px; }
  .blog-toc li { margin: 4px 0; }
</style>`
        : ''

      const fullHtml = [
        '<!DOCTYPE html>',
        `<html lang="zh-CN">`,
        `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${titleStr}</title>${styleStr}</head>`,
        '<body>',
        args.title ? `<h1>${escapeHtml(args.title)}</h1>` : '',
        tocHtml,
        html,
        '</body></html>',
      ].join('\n')

      return formatToolResult(fullHtml)
    } catch (err: any) {
      return formatToolError(`转换失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具: blog_seo_analyze — SEO 分析
// =============================================================================

export const blogSeoAnalyzeTool = buildTool({
  name: 'blog_seo_analyze',
  description:
    '【BlogToolbox】对博客内容执行 SEO 分析。包括关键词提取与词频统计、可读性评分、内链/外链分析、标题结构检查、字数统计与阅读时间估算。返回详细分析报告',
  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '博客正文（Markdown 格式）',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，目标关键词列表，用于检查关键词覆盖率',
      },
      topN: {
        type: 'number',
        description: '返回前 N 个高频词（默认 20）',
      },
    },
    required: ['markdown'],
  },
  handler: async (args: { markdown: string; keywords?: string[]; topN?: number }) => {
    try {
      const md = String(args.markdown)
      if (!md.trim()) return formatToolError('Markdown 内容不能为空')

      const topN = args.topN || 20
      const plainText = extractPlainText(md)

      // 基本统计
      const charCount = plainText.replace(/\s/g, '').length
      const wordCount = plainText.split(/[\s,，、。.？?！!；;：:]+/).filter(Boolean).length
      const sentenceCount = plainText.split(/[。！？\n!?\n]+/).filter(Boolean).length
      const readingTimeMin = Math.max(1, Math.round(charCount / 300)) // 中文阅读速度 ~300字/分钟
      const paragraphCount = md.split(/\n\n+/).filter(Boolean).length

      // 关键词提取
      const words = extractWords(plainText)
      const termFreq = computeTermFrequency(words).slice(0, topN)

      // 可读性
      const readability = estimateReadability(plainText)

      // 链接分析
      const linkAnalysis = analyzeInternalLinks(md)

      // 标题结构
      const headingAnalysis = analyzeHeadingStructure(md)

      // 关键词覆盖率（如果提供目标关键词）
      const keywordCoverage: Array<{ keyword: string; found: boolean; count: number }> = []
      if (args.keywords && args.keywords.length > 0) {
        for (const kw of args.keywords) {
          const regex = new RegExp(escapeRegex(kw), 'gi')
          const matches = plainText.match(regex)
          keywordCoverage.push({
            keyword: kw,
            found: !!matches,
            count: matches ? matches.length : 0,
          })
        }
      }

      // 构建报告
      const lines: string[] = [
        '📊 SEO 分析报告',
        '='.repeat(40),
        '',
        '📐 基本信息',
        `  字数: ${charCount} 字`,
        `  词数: ${wordCount} 词`,
        `  段落: ${paragraphCount} 段`,
        `  句子: ${sentenceCount} 句`,
        `  预计阅读时间: ${readingTimeMin} 分钟`,
        '',
        `🔤 可读性评分: ${readability.score}/100 (${readability.level})`,
        '',
      ]

      // 标题结构
      lines.push('📑 标题结构')
      if (headingAnalysis.valid) {
        lines.push('  ✅ 标题结构合理')
      }
      for (const issue of headingAnalysis.issues) {
        lines.push(`  ⚠️  ${issue}`)
      }
      if (headingAnalysis.headings.length > 0) {
        lines.push('  标题层级:')
        for (const h of headingAnalysis.headings) {
          lines.push(`    ${'  '.repeat(h.level - 1)}H${h.level}: ${h.text}`)
        }
      } else {
        lines.push('  ⚠️  未检测到标题（建议使用标题组织文章结构）')
      }
      lines.push('')

      // 高频词
      lines.push(`🔑 Top ${Math.min(topN, termFreq.length)} 高频词`)
      if (termFreq.length === 0) {
        lines.push('  (无法提取关键词，内容可能过短)')
      } else {
        lines.push('  | 排名 | 关键词 | 出现次数 | 密度 |')
        lines.push('  |------|--------|----------|------|')
        termFreq.slice(0, Math.min(topN, 30)).forEach((item, i) => {
          const densityPct = (item.density * 100).toFixed(2)
          lines.push(`  | ${String(i + 1).padStart(4)} | ${item.word.padEnd(8)} | ${String(item.count).padStart(6)} | ${densityPct}% |`)
        })
      }
      lines.push('')

      // 链接分析
      lines.push('🔗 链接分析')
      lines.push(`  总链接: ${linkAnalysis.totalLinks}`)
      lines.push(`  内部链接: ${linkAnalysis.internalLinks}`)
      lines.push(`  外部链接: ${linkAnalysis.externalLinks}`)
      if (linkAnalysis.brokenLinks.length > 0) {
        lines.push(`  ⚠️  可能断链: ${linkAnalysis.brokenLinks.slice(0, 5).join(', ')}`)
      }
      if (linkAnalysis.linkDetails.length > 0) {
        lines.push('  链接详情:')
        for (const l of linkAnalysis.linkDetails.slice(0, 10)) {
          const icon = l.type === 'internal' ? '🔗' : l.type === 'image' ? '🖼' : '🌐'
          lines.push(`    ${icon} [${l.text.slice(0, 30)}](${l.url.slice(0, 60)})`)
        }
        if (linkAnalysis.linkDetails.length > 10) {
          lines.push(`    ... 还有 ${linkAnalysis.linkDetails.length - 10} 个链接`)
        }
      }
      lines.push('')

      // 关键词覆盖率
      if (keywordCoverage.length > 0) {
        lines.push('🎯 目标关键词覆盖率')
        for (const kw of keywordCoverage) {
          const icon = kw.found && kw.count >= 3 ? '✅' : kw.found ? '⚠️' : '❌'
          lines.push(`  ${icon} "${kw.keyword}": ${kw.found ? `出现 ${kw.count} 次` : '未出现'}`)
          if (!kw.found) {
            lines.push(`    建议: 在文章中适当加入 "${kw.keyword}" 以优化 SEO`)
          } else if (kw.count < 3) {
            lines.push(`    建议: 适当增加 "${kw.keyword}" 的出现频率`)
          }
        }
        lines.push('')
      }

      // SEO 建议
      lines.push('💡 SEO 优化建议')
      const suggestions: string[] = []

      if (charCount < 500) {
        suggestions.push('文章字数不足 500 字，建议扩充内容以提升搜索引擎收录价值')
      }
      if (charCount > 10000) {
        suggestions.push('文章超过 10000 字，建议分篇发布以改善阅读体验')
      }
      if (headingAnalysis.headings.length < 2) {
        suggestions.push('缺少分段标题，建议使用 H2/H3 组织文章结构')
      }
      if (headingAnalysis.issues.some((i) => i.includes('跳跃'))) {
        suggestions.push('修复标题层级跳跃问题，保持层级连续')
      }
      if (headingAnalysis.issues.some((i) => i.includes('缺少 H1'))) {
        suggestions.push('添加 H1 主标题')
      }
      if (linkAnalysis.externalLinks === 0 && linkAnalysis.internalLinks === 0) {
        suggestions.push('文章未包含任何链接，适当添加内链和外链有助于 SEO')
      }
      if (linkAnalysis.brokenLinks.length > 0) {
        suggestions.push('修复断链以提升用户体验和 SEO 评分')
      }
      if (readability.score < 40) {
        suggestions.push('文章可读性偏低，建议使用更短的句子和更简单的词汇')
      }
      if (plainText.includes('点击这里') || plainText.includes('click here')) {
        suggestions.push('避免使用 "点击这里" 作为链接文本，应使用描述性锚文本')
      }

      if (suggestions.length === 0) {
        lines.push('  ✅ 各项指标良好，无需特别优化')
      } else {
        for (const s of suggestions) {
          lines.push(`  • ${s}`)
        }
      }

      lines.push('')
      lines.push(`报告生成时间: ${new Date().toLocaleString('zh-CN')}`)

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`SEO 分析失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具: blog_platform_format — 多平台格式化
// =============================================================================

export const blogPlatformFormatTool = buildTool({
  name: 'blog_platform_format',
  description:
    `【BlogToolbox】将博客内容格式化为目标平台的适配格式。支持平台: ${PLATFORM_KEYS.join('、')}。CSDN 自动添加 TOC 标记；微信公众号返回带样式的 HTML；博客园自动添加摘要分割线；知乎/掘金做代码块适配。可一次输出多个平台`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '博客正文（Markdown 格式）',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: `目标平台列表，可选值: ${PLATFORM_KEYS.join('、')}。留空则输出所有平台`,
      },
      title: {
        type: 'string',
        description: '可选，文章标题（部分平台需要）',
      },
    },
    required: ['markdown'],
  },
  handler: async (args: { markdown: string; platforms?: string[]; title?: string }) => {
    try {
      const md = String(args.markdown)
      if (!md.trim()) return formatToolError('Markdown 内容不能为空')

      const targets = args.platforms && args.platforms.length > 0
        ? args.platforms.map((p) => p.toLowerCase()).filter((p) => PLATFORM_FORMATTERS[p])
        : PLATFORM_KEYS

      if (targets.length === 0) {
        return formatToolError(`未找到有效的目标平台。可用平台: ${PLATFORM_KEYS.join('、')}`)
      }

      const results: string[] = []

      for (const platform of targets) {
        const { formatted, warnings, platform: platformName } = formatForPlatform(md, platform)

        const lines: string[] = [
          `---`,
          `🎯 ${platformName}`,
          `---`,
          '',
        ]

        // 标题
        if (args.title && PLATFORM_FORMATTERS[platform]) {
          lines.push(PLATFORM_FORMATTERS[platform].formatTitle(args.title))
          lines.push('')
        }

        lines.push(formatted)

        if (warnings.length > 0) {
          lines.push('', '⚠️ 警告:')
          for (const w of warnings) lines.push(`  • ${w}`)
        }

        results.push(lines.join('\n'))
      }

      const header = [
        '📝 多平台格式化结果',
        `源内容: ${md.length} 字符`,
        `目标平台: ${targets.length} 个`,
        '',
      ]

      return formatToolResult(header.join('\n') + results.join('\n\n'))
    } catch (err: any) {
      return formatToolError(`平台格式化失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具: blog_toolbox_pipeline — 流水线编排
// =============================================================================

/**
 * Blog Toolbox Pipeline — 工具流编排层
 *
 * 按推理链顺序调用多个 BlogToolbox 工具，前一工具的输出作为
 * 后一工具的输入（通过 reference 字段传递）。
 *
 * 支持阶段：
 * 1. seo_analyze — SEO 分析
 * 2. platform_format — 平台格式化
 * 3. convert_html — 转 HTML
 * 4. all — 全流程
 */
export const blogToolboxPipelineTool = buildTool({
  name: 'blog_toolbox_pipeline',
  description:
    '【BlogToolbox】博客工具箱流水线。按推理链顺序调用多个工具，前一工具的输出传递到下一工具。可用阶段: seo_analyze(SEO分析) → platform_format(平台格式化) → convert_html(转HTML)。使用 "all" 运行全流程，或指定 stages 数组自定义流程',
  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '博客正文（Markdown 格式）',
      },
      title: {
        type: 'string',
        description: '可选，文章标题',
      },
      stages: {
        type: 'array',
        items: { type: 'string' },
        description: '流水线阶段列表，顺序执行。可选值: seo_analyze, platform_format, convert_html。默认: ["seo_analyze", "platform_format", "convert_html"]',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: '平台格式化阶段的目标平台列表（仅 platform_format 阶段使用）',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '可选目标关键词（SEO 分析阶段使用）',
      },
    },
    required: ['markdown'],
  },
  handler: async (args: {
    markdown: string
    title?: string
    stages?: string[]
    platforms?: string[]
    keywords?: string[]
  }) => {
    try {
      const md = String(args.markdown)
      if (!md.trim()) return formatToolError('Markdown 内容不能为空')

      const stageOrder = args.stages || ['seo_analyze', 'platform_format', 'convert_html']
      const validStages = new Set(['seo_analyze', 'platform_format', 'convert_html'])
      for (const s of stageOrder) {
        if (!validStages.has(s)) {
          return formatToolError(`未知阶段 "${s}"。可用阶段: seo_analyze, platform_format, convert_html`)
        }
      }

      const pipelineId = `pipeline_${Date.now()}`
      const results: Array<{ stage: string; status: 'ok' | 'error'; output?: string; error?: string }> = []
      let currentMd = md

      for (const stage of stageOrder) {
        try {
          switch (stage) {
            case 'seo_analyze': {
              // 调用 SEO 分析逻辑
              const handler = blogSeoAnalyzeTool.handler
              const result = await handler({
                markdown: currentMd,
                keywords: args.keywords,
                topN: 20,
              })
              results.push({
                stage: 'seo_analyze',
                status: 'ok',
                output: result.content[0].text,
              })
              // SEO 分析不修改内容，传递原 MD
              break
            }

            case 'platform_format': {
              const handler = blogPlatformFormatTool.handler
              const result = await handler({
                markdown: currentMd,
                platforms: args.platforms,
                title: args.title,
              })
              results.push({
                stage: 'platform_format',
                status: 'ok',
                output: result.content[0].text,
              })
              // 使用最后一个平台的格式化结果作为后续输入
              const lastPlatform = (args.platforms && args.platforms.length > 0
                ? args.platforms[args.platforms.length - 1]
                : 'generic').toLowerCase()
              const formatted = formatForPlatform(currentMd, lastPlatform)
              currentMd = formatted.formatted
              break
            }

            case 'convert_html': {
              const handler = blogMdToHtmlTool.handler
              const result = await handler({
                markdown: currentMd,
                addStyles: true,
                addToc: true,
                title: args.title,
              })
              results.push({
                stage: 'convert_html',
                status: 'ok',
                output: result.content[0].text,
              })
              break
            }
          }
        } catch (err: any) {
          results.push({
            stage,
            status: 'error',
            error: err.message,
          })
        }
      }

      // 构建流水线报告
      const totalStages = stageOrder.length
      const succeeded = results.filter((r) => r.status === 'ok').length
      const failed = results.filter((r) => r.status === 'error').length

      const report: string[] = [
        '🏭 博客工具箱流水线',
        `流水线 ID: ${pipelineId}`,
        `阶段: ${stageOrder.join(' → ')}`,
        `结果: ${succeeded}/${totalStages} 成功${failed > 0 ? `, ${failed} 失败` : ''}`,
        '',
      ]

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const icon = r.status === 'ok' ? '✅' : '❌'
        report.push(`${icon} 阶段 ${i + 1}: ${r.stage}`)
        if (r.status === 'ok' && r.output) {
          // 截取输出摘要
          const summary = r.output.length > 500
            ? r.output.substring(0, 500) + `\n... (共 ${r.output.length} 字符)`
            : r.output
          report.push(summary)
        }
        if (r.status === 'error' && r.error) {
          report.push(`  错误: ${r.error}`)
        }
        report.push('')
      }

      report.push(`流水线完成时间: ${new Date().toLocaleString('zh-CN')}`)

      return formatToolResult(report.join('\n'))
    } catch (err: any) {
      return formatToolError(`流水线执行失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具: blog_toolbox_info — 工具箱自文档化界面
// =============================================================================

export const blogToolboxInfoTool = buildTool({
  name: 'blog_toolbox_info',
  description:
    '【BlogToolbox】显示博客工具箱的完整工具列表、使用说明和版本信息。提供自文档化界面，帮助用户了解每个工具的功能和用法',
  inputJSONSchema: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: '可选，查看特定工具的详细用法。如: blog_md_to_html, blog_seo_analyze, blog_platform_format, blog_toolbox_pipeline',
      },
    },
    required: [],
  },
  handler: async (args: { toolName?: string }) => {
    try {
      const TOOLS_INFO: Record<string, { description: string; usage: string; example: string }> = {
        blog_md_to_html: {
          description: '将 Markdown 内容转换为完整 HTML 文档',
          usage: 'blog_md_to_html(markdown, addStyles?, addToc?, title?)',
          example: 'blog_md_to_html({ markdown: "# Hello", addStyles: true, title: "My Post" })',
        },
        blog_seo_analyze: {
          description: '对博客内容执行全面的 SEO 分析',
          usage: 'blog_seo_analyze(markdown, keywords?, topN?)',
          example: 'blog_seo_analyze({ markdown: "...", keywords: ["TypeScript", "教程"], topN: 10 })',
        },
        blog_platform_format: {
          description: `将博客格式化为目标平台的适配格式。支持: ${PLATFORM_KEYS.join('、')}`,
          usage: 'blog_platform_format(markdown, platforms?, title?)',
          example: 'blog_platform_format({ markdown: "...", platforms: ["csdn", "zhihu"], title: "文章标题" })',
        },
        blog_toolbox_pipeline: {
          description: '按推理链顺序执行多个博客工具（流水线编排）',
          usage: 'blog_toolbox_pipeline(markdown, stages?, platforms?, keywords?, title?)',
          example: 'blog_toolbox_pipeline({ markdown: "...", stages: ["seo_analyze", "platform_format", "convert_html"] })',
        },
        blog_toolbox_info: {
          description: '博客工具箱自文档化界面',
          usage: 'blog_toolbox_info(toolName?)',
          example: 'blog_toolbox_info({ toolName: "blog_md_to_html" })',
        },
      }

      if (args.toolName) {
        const info = TOOLS_INFO[args.toolName]
        if (!info) {
          return formatToolError(
            `未知工具 "${args.toolName}"。可用工具: ${Object.keys(TOOLS_INFO).join('、')}`,
          )
        }
        return formatToolResult(
          [
            `📖 ${args.toolName}`,
            '',
            `描述: ${info.description}`,
            `用法: ${info.usage}`,
            `示例: ${info.example}`,
            '',
            '💡 提示: 所有 BlogToolbox 工具可通过 blog_toolbox_pipeline 串联使用',
          ].join('\n'),
        )
      }

      const lines: string[] = [
        '🧰 MCP 标准化博客工具箱 (BlogToolbox)',
        '='.repeat(45),
        '',
        '📋 可用工具:',
        '',
      ]

      for (const [name, info] of Object.entries(TOOLS_INFO)) {
        lines.push(`  🔧 ${name}`)
        lines.push(`     ${info.description}`)
        lines.push(`     用法: ${info.usage}`)
        lines.push('')
      }

      lines.push('🎯 快速开始:')
      lines.push('  1. SEO 分析:   blog_seo_analyze({ markdown: "文章内容" })')
      lines.push('  2. 平台格式化: blog_platform_format({ markdown: "...", platforms: ["csdn", "zhihu"] })')
      lines.push('  3. 转 HTML:    blog_md_to_html({ markdown: "...", addStyles: true })')
      lines.push('  4. 全流程:     blog_toolbox_pipeline({ markdown: "..." })')
      lines.push('')
      lines.push('💡 热插拔: 可通过 register_tool 动态添加新工具（如 AI 配音、图片生成）')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`获取工具箱信息失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具函数
// =============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
