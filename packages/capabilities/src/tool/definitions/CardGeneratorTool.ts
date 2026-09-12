import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { WORKSPACE } from '@akemi-mio/core/config'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/** 候选字体路径（按优先级：小体积优先） */
const FONT_PATHS = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/NotoSansSC-VF.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simsun.ttc',
]

interface CardStyle {
  bgColor: string
  titleColor: string
  textColor: string
  accentColor: string
  badgeBg: string
  badgeText: string
}

const STYLES: Record<string, CardStyle> = {
  error: {
    bgColor: '#1a0a0a',
    titleColor: '#ff6b6b',
    textColor: '#e8d0d0',
    accentColor: '#c0392b',
    badgeBg: '#c0392b',
    badgeText: '#ffffff',
  },
  warn: {
    bgColor: '#1a1410',
    titleColor: '#f0a030',
    textColor: '#d8d0c8',
    accentColor: '#b8860b',
    badgeBg: '#b8860b',
    badgeText: '#ffffff',
  },
  info: {
    bgColor: '#0d1117',
    titleColor: '#58a6ff',
    textColor: '#c9d1d9',
    accentColor: '#30363d',
    badgeBg: '#21262d',
    badgeText: '#8b949e',
  },
}

let _fontBase64: string | null = null
let _fontName: string | null = null

function loadFont(): { base64: string; name: string } {
  if (_fontBase64 && _fontName) return { base64: _fontBase64, name: _fontName }

  for (const fp of FONT_PATHS) {
    if (existsSync(fp)) {
      const buf = readFileSync(fp)
      _fontBase64 = buf.toString('base64')
      const basename = fp.replace(/.*[/\\]/, '').replace(/\.(ttf|ttc|otf)$/i, '')
      _fontName = basename
      return { base64: _fontBase64, name: _fontName }
    }
  }

  throw new Error('未找到中文字体文件。请安装 Noto Sans SC / 微软雅黑 / 黑体之一。')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48)
}

function buildCardSVG(params: {
  title: string
  description: string
  severity: string
  category: string
  tags: string[]
  fontBase64: string
  fontName: string
}): string {
  const { title, description, severity, category, tags, fontBase64, fontName } = params
  const style = STYLES[severity] || STYLES.info
  const cardW = 600
  const cardH = 420
  const pad = 32
  const titleY = 96
  const descY = 148
  const lineH = 24
  const maxDescLines = 7

  const descLines: string[] = []
  const words = description.split('\n')
  for (const w of words) {
    if (descLines.length >= maxDescLines) {
      descLines[descLines.length - 1] += '…'
      break
    }
    const maxChars = 42
    let remaining = w
    while (remaining.length > 0 && descLines.length < maxDescLines) {
      const line = remaining.slice(0, maxChars)
      descLines.push(line)
      remaining = remaining.slice(maxChars)
    }
    if (remaining.length > 0 && descLines.length >= maxDescLines) {
      descLines[descLines.length - 1] += '…'
    }
  }

  const tagBadges = tags
    .slice(0, 4)
    .map((t, i) => {
      const x = pad + i * 90
      return `<rect x="${x}" y="350" width="80" height="22" rx="4" fill="${style.badgeBg}" opacity="0.6"/>
<text x="${x + 40}" y="365" fill="${style.badgeText}" font-size="11" font-family="${fontName}" text-anchor="middle" dominant-baseline="middle">${escapeXml(t)}</text>`
    })
    .join('\n')

  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}">
  <defs>
    <style>
      @font-face {
        font-family: '${fontName}';
        src: url(data:font/truetype;base64,${fontBase64}) format('truetype');
        font-weight: normal;
        font-style: normal;
      }
      @font-face {
        font-family: '${fontName}';
        src: url(data:font/truetype;base64,${fontBase64}) format('truetype');
        font-weight: bold;
        font-style: normal;
      }
    </style>
  </defs>

  <rect width="${cardW}" height="${cardH}" rx="16" fill="${style.bgColor}" />
  <rect x="0" y="0" width="${cardW}" height="4" fill="${style.accentColor}" />

  <rect x="${pad}" y="40" width="${Math.max(60, category.length * 14 + 24)}" height="26" rx="6" fill="${style.accentColor}" opacity="0.25"/>
  <text x="${pad + 12}" y="56" fill="${style.accentColor}" font-size="13" font-family="${fontName}" font-weight="bold" dominant-baseline="middle">${escapeXml(category)}</text>

  <circle cx="${cardW - pad - 16}" cy="53" r="6" fill="${style.accentColor}" opacity="0.6"/>
  <text x="${cardW - pad - 8}" y="56" fill="${style.textColor}" font-size="12" font-family="${fontName}" dominant-baseline="middle" opacity="0.7">${severity.toUpperCase()}</text>

  <line x1="${pad}" y1="76" x2="${cardW - pad}" y2="76" stroke="${style.accentColor}" stroke-width="0.5" opacity="0.3"/>

  <text x="${pad}" y="${titleY}" fill="${style.titleColor}" font-size="22" font-family="${fontName}" font-weight="bold">${escapeXml(title)}</text>

  ${descLines
    .map(
      (line, i) =>
        `<text x="${pad}" y="${descY + i * lineH}" fill="${style.textColor}" font-size="15" font-family="${fontName}" opacity="0.9">${escapeXml(line)}</text>`,
    )
    .join('\n')}

  <line x1="${pad}" y1="334" x2="${cardW - pad}" y2="334" stroke="${style.accentColor}" stroke-width="0.5" opacity="0.15"/>

  ${tagBadges}

  <text x="${pad}" y="${cardH - 16}" fill="${style.textColor}" font-size="11" font-family="${fontName}" opacity="0.4">秋山澪 · ${dateStr}</text>
  <circle cx="${cardW - pad - 6}" cy="${cardH - 20}" r="3" fill="${style.accentColor}" opacity="0.3"/>
</svg>`
}

export const cardGeneratorTool = buildTool({
  name: 'generate_card',
  description: '使用 sharp 渲染秋山澪对话问题卡片（文字转图片）。支持中文标题/描述，按 severity 分色。返回图片的本地文件路径',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '卡片标题（简短有力，如"失忆了"、"工具超时"）',
      },
      description: {
        type: 'string',
        description: '卡片描述文字（支持多行，自动换行）',
      },
      severity: {
        type: 'string',
        description: '严重程度：error（深红，适用于失忆/失败/超时）、warn（琥珀，预算/上下文问题）、info（默认，玻璃蓝）',
      },
      category: {
        type: 'string',
        description: '问题类别，如"记忆"、"工具"、"LLM"、"预算"',
      },
      tags: {
        type: 'string',
        description: '标签列表，用逗号分隔，如"失忆,memory_fail,常见"',
      },
    },
    required: ['title', 'description'],
  },
  handler: async (args: { title: string; description: string; severity?: string; category?: string; tags?: string }) => {
    try {
      const title = String(args.title).trim()
      if (!title) return formatToolError('title 不能为空')
      const description = String(args.description).trim()
      if (!description) return formatToolError('description 不能为空')
      const severity = args.severity || 'info'
      if (!STYLES[severity]) return formatToolError(`不支持的 severity: ${severity}，可选: ${Object.keys(STYLES).join(', ')}`)
      const category = args.category || '未分类'
      const tags = args.tags
        ? args.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : []

      const { base64: fontBase64, name: fontName } = loadFont()
      const svg = buildCardSVG({ title, description, severity, category, tags, fontBase64, fontName })

      const sharp = (await import('sharp')).default
      const buf = await sharp(Buffer.from(svg)).png().toBuffer()

      const cardsDir = join(WORKSPACE.cache, 'cards')
      if (!existsSync(cardsDir)) {
        mkdirSync(cardsDir, { recursive: true })
      }
      const ts = Date.now()
      const slug = toSlug(title)
      const filePath = join(cardsDir, `card_${ts}_${slug}.png`)
      const { writeFileSync } = await import('fs')
      writeFileSync(filePath, buf)

      return formatToolResult(
        [
          `卡片生成成功！`,
          `文件: ${filePath}`,
          `标题: ${title}`,
          `类别: ${category}`,
          `严重程度: ${severity}`,
          `标签: ${tags.join(', ') || '(无)'}`,
          `尺寸: 600×420 PNG`,
        ].join('\n'),
      )
    } catch (err: any) {
      return formatToolError(`卡片生成失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

