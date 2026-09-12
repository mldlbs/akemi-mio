/**
 * WritingRewriteTools — MCP 辅助章节重写工具集
 *
 * 提供三个工具，用于在重写执行阶段辅助写作：
 *
 * 1. writing_rewrite_search      — 搜索背景资料与相关章节参考
 * 2. writing_rewrite_structure   — 分析章节逻辑结构与节奏
 * 3. writing_rewrite_replace     — 批量替换旧命名/术语（预览 + 执行）
 *
 * 配合 WritingPlanTools（计划阶段）使用：
 *   WritingPlanTools → 分析设计 + 对比 + 分解任务（计划阶段）
 *   WritingRewriteTools → 执行重写时的辅助工具（执行阶段）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { resolve, join, basename, relative } from 'path'
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { WritingDecisionService } from '@akemi-mio/creativity/WritingDecisionMemory'

// ===== 常量 =====

const PROJECT_ROOT = resolve(process.cwd())
const DOCS_DIR = resolve(PROJECT_ROOT, 'docs')
const CHAPTER_DIR = resolve(PROJECT_ROOT, 'docs/chapters')
const SNAPSHOT_DIR = resolve(PROJECT_ROOT, '.writing-snapshots')

const MAX_PREVIEW_LINES = 40
const MAX_SEARCH_RESULTS = 15

// ===== 辅助类型 =====

interface ReplacementPair {
  old: string
  new: string
  description?: string
}

interface PreviewChange {
  file: string
  replaceCount: number
  lines: Array<{ lineNumber: number; oldText: string; newText: string }>
}

// ===== 辅助函数 =====

/** 收集文档目录下的 .md 文件（docs/ + docs/chapters/） */
function collectDocFiles(): string[] {
  const files: string[] = []
  const dirs = [DOCS_DIR, CHAPTER_DIR]

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir)
      for (const e of entries) {
        if (!e.endsWith('.md')) continue
        const p = join(dir, e)
        if (statSync(p).isFile()) {
          files.push(p)
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return files.sort()
}

/** 搜索文档内容，返回匹配片段 */
function searchDocs(query: string, maxResults: number = MAX_SEARCH_RESULTS): string {
  const files = collectDocFiles()
  const results: string[] = []
  const lowerQuery = query.toLowerCase()

  for (const filePath of files) {
    if (results.length >= maxResults) break
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      const relPath = relative(PROJECT_ROOT, filePath)
      let matchCount = 0

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          const lineNum = i + 1
          const text = lines[i].trim().slice(0, 200)
          // 上下文：前后各取 1 行
          const prevLine = i > 0 ? lines[i - 1].trim().slice(0, 100) : ''
          const nextLine = i + 1 < lines.length ? lines[i + 1].trim().slice(0, 100) : ''
          const ctx = prevLine ? `  ┌ ${prevLine}\n` : ''
          const nctx = nextLine ? `  └ ${nextLine}` : ''
          results.push(`📄 ${relPath}:${lineNum}\n${ctx}  → ${text}\n${nctx}`)
          matchCount++
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  if (results.length === 0) {
    return `未在 docs/ 中找到包含 "${query}" 的相关文档。`
  }

  return `🔍 搜索 "${query}" 共找到 ${results.length} 处匹配：\n\n${results.join('\n\n')}`
}

/** 收集指定范围内的章节文件路径 */
function collectChapterFiles(start: number, end: number): string[] {
  if (!existsSync(CHAPTER_DIR)) return []
  const files: string[] = []
  try {
    const entries = readdirSync(CHAPTER_DIR)
    for (const e of entries) {
      if (!e.endsWith('.md')) continue
      const match = e.match(/(\d+)/)
      if (!match) continue
      const num = parseInt(match[1], 10)
      if (num >= start && num <= end) {
        files.push(join(CHAPTER_DIR, e))
      }
    }
  } catch {
    return []
  }
  return files.sort((a, b) => {
    const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10)
    const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10)
    return na - nb
  })
}

/** 读取 .md 文件内容，去掉 frontmatter */
function readChapterContent(filePath: string): { content: string; title: string } | null {
  try {
    if (!existsSync(filePath)) return null
    let content = readFileSync(filePath, 'utf-8')
    let title = basename(filePath, '.md')

    // 尝试提取 frontmatter title
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3)
      if (endIdx > 0) {
        const frontmatter = content.slice(3, endIdx).trim()
        const titleMatch = frontmatter.match(/^title:\s*(.+)$/m)
        if (titleMatch) title = titleMatch[1].trim()
        content = content.slice(endIdx + 3).trim()
      }
    }

    return { content, title }
  } catch {
    return null
  }
}

/** 创建快照目录并备份文件 */
function createSnapshotForFiles(filePaths: string[]): string | null {
  try {
    if (!existsSync(SNAPSHOT_DIR)) {
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
    }

    const snapId = `replace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const snapDir = join(SNAPSHOT_DIR, snapId)
    mkdirSync(snapDir, { recursive: true })

    for (const fp of filePaths) {
      if (existsSync(fp)) {
        const name = basename(fp)
        copyFileSync(fp, join(snapDir, name))
      }
    }

    // 写入元数据
    writeFileSync(
      join(snapDir, '.meta.json'),
      JSON.stringify(
        {
          id: snapId,
          label: `批量替换快照 ${new Date().toLocaleString('zh-CN')}`,
          createdAt: Date.now(),
          files: filePaths.map((p) => ({
            path: p,
            originalName: basename(p),
            size: existsSync(p) ? statSync(p).size : 0,
          })),
        },
        null,
        2,
      ),
      'utf-8',
    )

    return snapId
  } catch {
    return null
  }
}

/** 记录操作到 Memory */
function recordToMemory(type: string, content: string): void {
  try {
    const ms = getMemoryService()
    if (!ms) return
    ms.addEntry('writing_feedback', `rewrite_tool:${type}: ${content}`, 0.6, { tier: 'semi' })
  } catch {
    // non-critical, silent
  }
}

// =================================================================
//  Tool 1: writing_rewrite_search — 背景资料搜索
// =================================================================

export const writingRewriteSearchTool = buildTool({
  name: 'writing_rewrite_search',
  description:
    '搜索背景资料与相关章节参考 — 在重写章节时快速查找设计文档、角色设定、' +
    '工业美学要素等相关内容。支持全文搜索 docs/ 目录下的所有 .md 文件。\n\n' +
    '参数:\n' +
    '- query: 搜索关键词（如 "齿轮三角"、"工业美学"、"林默"）\n' +
    '- maxResults: 最大结果数（默认 10）\n\n' +
    '工作流建议：\n' +
    '  1. 重写前搜索章节涉及的关键要素和设定\n' +
    '  2. 搜索需要替换的旧命名在全文中出现的位置\n' +
    '  3. 搜索设计文档中关于某角色的详细设定',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，如 "齿轮三角"、"工业美学"、"林默"、"蒸汽机械"',
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数（1-50，默认 10）',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  handler: async (args: { query: string; maxResults?: number }) => {
    try {
      if (!args.query || args.query.trim().length === 0) {
        return formatToolError('请提供搜索关键词')
      }

      const maxResults = Math.max(1, Math.min(50, args.maxResults ?? 10))
      const result = searchDocs(args.query.trim(), maxResults)

      recordToMemory('search', `query="${args.query}" found ${result.split('共找到 ').length > 1 ? 'matches' : 'no matches'}`)
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(`搜索失败: ${err.message}`)
    }
  },
})

// =================================================================
//  Tool 2: writing_rewrite_structure — 章节结构分析
// =================================================================

export const writingRewriteStructureTool = buildTool({
  name: 'writing_rewrite_structure',
  description:
    '分析章节逻辑结构与叙事节奏 — 读取章节 .md 文件，从段落分布、' +
    '对话/叙事比例、场景转换、句子复杂度等维度进行分析，' +
    '给出结构改进建议。\n\n' +
    '参数:\n' +
    '- chapterPath: 章节文件路径（相对项目根目录，如 "docs/chapters/19.md"）\n' +
    '- detailLevel: 分析详细程度 basic | normal | detailed（默认 normal）\n\n' +
    '分析维度：\n' +
    '  • 段落统计：段落数、平均段落长度、过长/过短段落\n' +
    '  • 对话分析：对话行占比、对话密集区域\n' +
    '  • 场景结构：场景分隔符、章节分区\n' +
    '  • 句子分析：句子长度分布、可读性\n' +
    '  • 节奏评估：段落/对话/叙事的交替模式',
  inputJSONSchema: {
    type: 'object',
    properties: {
      chapterPath: {
        type: 'string',
        description: '章节文件路径（相对项目根目录），如 "docs/chapters/19.md"',
      },
      detailLevel: {
        type: 'string',
        enum: ['basic', 'normal', 'detailed'] as any,
        description: '分析详细程度：basic（基础统计）、normal（标准分析，默认）、detailed（详细分析含逐段建议）',
      },
    },
    required: ['chapterPath'],
  },
  isReadOnly: true,
  handler: async (args: { chapterPath: string; detailLevel?: string }) => {
    try {
      if (!args.chapterPath) {
        return formatToolError('请提供 chapterPath')
      }

      const filePath = resolve(PROJECT_ROOT, args.chapterPath)
      if (!existsSync(filePath)) {
        return formatToolError(`文件不存在: ${args.chapterPath}`)
      }

      const chapter = readChapterContent(filePath)
      if (!chapter) {
        return formatToolError(`无法读取文件: ${args.chapterPath}`)
      }

      const { content, title } = chapter
      const detail = args.detailLevel || 'normal'
      const lines = content.split('\n')
      const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

      // ── 基础统计 ──
      const totalChars = content.length
      const totalLines = lines.length
      const totalParagraphs = paragraphs.length
      const nonEmptyLines = lines.filter((l) => l.trim().length > 0)

      // 段落长度分析
      const paraLengths = paragraphs.map((p) => p.length)
      const avgParaLen = Math.round(paraLengths.reduce((a, b) => a + b, 0) / Math.max(1, paraLengths.length))
      const maxParaLen = Math.max(...paraLengths)
      const minParaLen = Math.min(...paraLengths)
      const longParas = paragraphs.filter((p) => p.length > 500).length
      const shortParas = paragraphs.filter((p) => p.length < 50).length

      // 对话分析
      const dialogueMarkers = nonEmptyLines.filter((l) => l.includes('「') || l.includes('『') || l.includes('"') || l.includes('"'))
      const dialogueRatio = nonEmptyLines.length > 0 ? Math.round((dialogueMarkers.length / nonEmptyLines.length) * 100) : 0

      // 场景分隔符
      const sceneBreaks = lines.filter((l) => /^---\s*$|^\*\*\*\s*$|^#\s{1,6}/.test(l.trim())).length
      const headings = lines.filter((l) => /^#{1,6}\s/.test(l.trim()))

      // 句子分析（按句号、问号、感叹号、省略号分割）
      const sentences = content.split(/[。！？．…]+/).filter((s) => s.trim().length > 0)
      const avgSentenceLen =
        sentences.length > 0 ? Math.round(sentences.reduce((a, s) => a + s.replace(/\s/g, '').length, 0) / sentences.length) : 0
      const longSentences = sentences.filter((s) => s.replace(/\s/g, '').length > 80).length

      // ── 构建报告 ──

      const lines_output: string[] = []

      // 标题
      lines_output.push(`📊 章节结构分析报告`)
      lines_output.push(`━━━━━━━━━━━━━━━━━━━━━━`)
      lines_output.push(`📄 ${basename(filePath)} — ${title}`)
      lines_output.push(`📏 详细程度: ${detail === 'basic' ? '基础' : detail === 'normal' ? '标准' : '详细'}`)
      lines_output.push('')

      // ── 基础统计 ──
      lines_output.push(`📐 【基础统计】`)
      lines_output.push(`  总字数: ${totalChars}`)
      lines_output.push(`  总行数: ${totalLines}`)
      lines_output.push(`  段落数: ${totalParagraphs}`)
      lines_output.push(`  句子数: ${sentences.length}`)
      lines_output.push(`  场景片段: ~${sceneBreaks} 个`)
      lines_output.push('')

      // ── 段落分析 ──
      lines_output.push(`📋 【段落分析】`)
      lines_output.push(`  平均段落长度: ${avgParaLen} 字`)
      lines_output.push(`  最长段落: ${maxParaLen} 字`)
      lines_output.push(`  最短段落: ${minParaLen} 字`)
      lines_output.push(`  过长段落(>500字): ${longParas} 段`)
      lines_output.push(`  过短段落(<50字): ${shortParas} 段`)
      lines_output.push('')

      // ── 对话分析 ──
      lines_output.push(`💬 【对话分析】`)
      lines_output.push(`  对话标记行: ${dialogueMarkers.length}/${nonEmptyLines.length} (${dialogueRatio}%)`)
      if (dialogueRatio < 10) {
        lines_output.push(`  ⚠️ 对话比例偏低，考虑增加对话以丰富节奏`)
      } else if (dialogueRatio > 60) {
        lines_output.push(`  ⚠️ 对话比例偏高，注意叙事描写的平衡`)
      } else {
        lines_output.push(`  ✓ 对话比例适中`)
      }
      lines_output.push('')

      // ── 句子分析 ──
      lines_output.push(`✍️ 【句子分析】`)
      lines_output.push(`  平均句子长度: ${avgSentenceLen} 字`)
      lines_output.push(
        `  长句子(>80字): ${longSentences} 句 (${sentences.length > 0 ? Math.round((longSentences / sentences.length) * 100) : 0}%)`,
      )
      if (longSentences > sentences.length * 0.3) {
        lines_output.push(`  ⚠️ 长句比例偏高，建议适当拆分以提升可读性`)
      }
      lines_output.push('')

      // ── 节奏评估 ──
      const rhythmScore = calculateRhythmScore(paragraphs, dialogueMarkers.length, nonEmptyLines.length)
      lines_output.push(`🎵 【节奏评估】`)
      lines_output.push(`  综合节奏评分: ${rhythmScore}/100`)
      if (rhythmScore >= 70) {
        lines_output.push(`  ✓ 节奏良好，段落长短搭配合理`)
      } else if (rhythmScore >= 40) {
        lines_output.push(`  ⚠️ 节奏一般，建议调整段落长短搭配以增强阅读节奏感`)
      } else {
        lines_output.push(`  🔴 节奏需要改善，段落分布过于均匀或失衡`)
      }
      lines_output.push('')

      // ── 章节标题结构 ──
      if (headings.length > 0) {
        lines_output.push(`🏷️ 【章节标题结构】`)
        for (const h of headings) {
          const level = h.match(/^#+/)?.[0]?.length || 1
          const indent = '  '.repeat(level - 1)
          lines_output.push(`  ${indent}${h.trim()}`)
        }
        lines_output.push('')
      }

      // ── 详细分析（detailLevel 为 normal 或 detailed 时） ──
      if (detail !== 'basic') {
        // 段落长度分段统计
        const lenGroups = { '<50': 0, '50-200': 0, '200-500': 0, '>500': 0 }
        for (const pl of paraLengths) {
          if (pl < 50) lenGroups['<50']++
          else if (pl < 200) lenGroups['50-200']++
          else if (pl < 500) lenGroups['200-500']++
          else lenGroups['>500']++
        }

        lines_output.push(`📊 【段落长度分布】`)
        lines_output.push(`  短段落(<50字): ${'█'.repeat(lenGroups['<50'])} ${lenGroups['<50']}段`)
        lines_output.push(`  中段落(50-200字): ${'█'.repeat(Math.min(lenGroups['50-200'], 30))} ${lenGroups['50-200']}段`)
        lines_output.push(`  长段落(200-500字): ${'█'.repeat(Math.min(lenGroups['200-500'], 30))} ${lenGroups['200-500']}段`)
        lines_output.push(`  超长段落(>500字): ${'█'.repeat(Math.min(lenGroups['>500'], 30))} ${lenGroups['>500']}段`)
        lines_output.push('')

        // 结构改进建议
        const suggestions: string[] = []

        if (longParas > totalParagraphs * 0.2) {
          suggestions.push('🔸 考虑将过长段落拆分为 2-3 个小段落，提升阅读节奏')
        }
        if (shortParas > totalParagraphs * 0.3) {
          suggestions.push('🔸 过多短段落可能造成碎片化，考虑合并部分相邻短段')
        }
        if (dialogueRatio < 15 && totalParagraphs > 5) {
          suggestions.push('🔸 增加对话场景可以丰富节奏和角色塑造')
        }
        if (longSentences > sentences.length * 0.25) {
          suggestions.push('🔸 拆分长句为短句组合，增强节奏感和清晰度')
        }
        if (sceneBreaks < 2 && totalParagraphs > 10) {
          suggestions.push('🔸 考虑增加场景分隔（--- 或 ***）以明确章节内部结构')
        }
        if (avgSentenceLen > 50) {
          suggestions.push('🔸 平均句长偏大，可适当增加短句以提升节奏变化')
        }

        if (suggestions.length > 0) {
          lines_output.push(`💡 【改进建议】`)
          for (const s of suggestions) {
            lines_output.push(`  ${s}`)
          }
        }

        // 详细模式：逐段落分析
        if (detail === 'detailed') {
          lines_output.push('')
          lines_output.push(`🔎 【逐段落分析】`)
          for (let i = 0; i < Math.min(paragraphs.length, 30); i++) {
            const p = paragraphs[i]
            const plen = p.length
            const pLines = p.split('\n').length
            const hasDialogue = /["""「『]/.test(p)
            const label = plen > 500 ? '⚠️长' : plen < 50 ? '短' : '  '
            const dia = hasDialogue ? '💬' : '  '
            const preview = p.replace(/\n/g, ' ').trim().slice(0, 60)
            lines_output.push(`  ${dia}[${label}] 段${i + 1}(${plen}字/${pLines}行): ${preview}${preview.length >= 60 ? '…' : ''}`)
          }
          if (paragraphs.length > 30) {
            lines_output.push(`  …及另外 ${paragraphs.length - 30} 段`)
          }
        }
      }

      // ── 尾部提示 ──
      lines_output.push('')
      lines_output.push(`💡 使用 writing_rewrite_search 搜索章节所需背景资料`)
      lines_output.push(`💡 使用 writing_rewrite_replace 批量替换旧术语`)

      recordToMemory(
        'structure_check',
        `file="${args.chapterPath}" paragraphs=${totalParagraphs} dialogue=${dialogueRatio}% score=${rhythmScore}`,
      )
      return formatToolResult(lines_output.join('\n'))
    } catch (err: any) {
      return formatToolError(`结构分析失败: ${err.message}`)
    }
  },
})

/**
 * 计算段落节奏评分 (0-100)
 * 基于段落长度多样性、对话与叙事交替、场景密度
 */
function calculateRhythmScore(paragraphs: string[], dialogueLineCount: number, totalLines: number): number {
  if (paragraphs.length < 3) return 50

  let score = 50

  // 段落长度多样性（标准差越小越均匀，但过于均匀节奏感差）
  const lengths = paragraphs.map((p) => p.length)
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const variance = lengths.reduce((sum, l) => sum + Math.pow(l - avg, 2), 0) / lengths.length
  const stdDev = Math.sqrt(variance)
  const cv = avg > 0 ? stdDev / avg : 0 // 变异系数

  // 中等变异系数（0.5-1.2）表示段落长度变化适中，节奏好
  if (cv >= 0.5 && cv <= 1.2) score += 20
  else if (cv > 1.2)
    score += 10 // 变化大但可能过激
  else score -= 10 // 过于均匀

  // 对话比例加分
  if (dialogueLineCount > 0 && totalLines > 0) {
    const ratio = dialogueLineCount / totalLines
    if (ratio >= 0.15 && ratio <= 0.5) score += 15
    else if (ratio > 0.05 && ratio < 0.15) score += 5
    else score -= 5
  }

  // 场景分段加分
  if (paragraphs.length > 10) {
    // 检查是否有明显的场景分段（段落长度变化点）
    let transitions = 0
    for (let i = 1; i < lengths.length; i++) {
      if (Math.abs(lengths[i] - lengths[i - 1]) > avg * 0.5) transitions++
    }
    const transitionRatio = transitions / (lengths.length - 1)
    if (transitionRatio >= 0.2 && transitionRatio <= 0.6) score += 15
    else if (transitionRatio > 0.6) score += 5
  }

  return Math.max(0, Math.min(100, score))
}

// =================================================================
//  Tool 3: writing_rewrite_replace — 批量替换
// =================================================================

export const writingRewriteReplaceTool = buildTool({
  name: 'writing_rewrite_replace',
  description:
    '批量替换章节中的旧命名/术语 — 在重写章节时快速替换角色名、地名、' +
    '术语等。支持预览模式（不实际修改）和执行模式（自动备份后修改）。\n\n' +
    '参数:\n' +
    '- replacements: 替换规则列表（JSON 字符串数组）\n' +
    '  格式：[{"old": "旧文本", "new": "新文本", "description": "说明（可选）"}]\n' +
    '- chapterDir: 章节目录（相对路径，如 "docs/chapters"），不提供则搜索全部 docs/\n' +
    '- chapterStart: 起始章节号（可选）\n' +
    '- chapterEnd: 结束章节号（可选）\n' +
    '- mode: "preview"（预览，默认）| "apply"（执行替换）\n' +
    '- storyName: 故事名称（apply 模式可选，用于记录写作决策）\n\n' +
    '安全机制：\n' +
    '  • preview 模式不修改任何文件\n' +
    '  • apply 模式自动创建快照备份（.writing-snapshots/ 目录下）\n' +
    '  • 替换操作会记录到 Memory，可追溯\n\n' +
    '工作流建议：\n' +
    '  1. 先用 preview 模式查看替换范围\n' +
    '  2. 确认无误后使用 apply 模式执行\n' +
    '  3. 替换后可调用 writing_rewrite_search 验证替换结果',
  inputJSONSchema: {
    type: 'object',
    properties: {
      replacements: {
        type: 'string',
        description:
          '替换规则列表（JSON 字符串）。\n' +
          '格式：[{"old": "旧文本", "new": "新文本", "description": "说明（可选）"}]\n' +
          '示例：[{"old":"齿轮","new":"星轮","description":"统一术语"}, {"old":"老林","new":"林默"}]',
      },
      chapterDir: {
        type: 'string',
        description: '章节目录（相对路径，如 "docs/chapters"），不提供则搜索全部 docs/',
      },
      chapterStart: {
        type: 'number',
        description: '起始章节号（可选，限制替换范围）',
      },
      chapterEnd: {
        type: 'number',
        description: '结束章节号（可选，限制替换范围）',
      },
      mode: {
        type: 'string',
        enum: ['preview', 'apply'] as any,
        description: '模式：preview（仅预览，默认）| apply（执行替换并自动备份）',
      },
      storyName: {
        type: 'string',
        description: '故事名称（apply 模式可选，用于记录写作决策到 WritingDecisionMemory）',
      },
    },
    required: ['replacements'],
  },
  isReadOnly: false,
  handler: async (args: {
    replacements: string
    chapterDir?: string
    chapterStart?: number
    chapterEnd?: number
    mode?: string
    storyName?: string
  }) => {
    try {
      // ── 解析替换规则 ──
      let pairs: ReplacementPair[]
      try {
        pairs = JSON.parse(args.replacements)
        if (!Array.isArray(pairs) || pairs.length === 0) {
          return formatToolError('replacements 应为非空 JSON 数组')
        }
        // 验证每条记录
        for (let i = 0; i < pairs.length; i++) {
          if (!pairs[i].old || typeof pairs[i].old !== 'string') {
            return formatToolError(`第 ${i + 1} 条替换规则缺少有效的 "old" 字段`)
          }
          if (pairs[i].new === undefined || pairs[i].new === null) {
            return formatToolError(`第 ${i + 1} 条替换规则缺少 "new" 字段`)
          }
        }
      } catch {
        return formatToolError('replacements 格式错误，应为有效的 JSON 数组字符串')
      }

      const mode = args.mode || 'preview'
      const isApply = mode === 'apply'

      // ── 收集目标文件 ──
      let targetFiles: string[] = []

      if (args.chapterDir) {
        const dirPath = resolve(PROJECT_ROOT, args.chapterDir)
        if (!existsSync(dirPath)) {
          return formatToolError(`章节目录不存在: ${args.chapterDir}`)
        }
        const start = args.chapterStart ?? 1
        const end = args.chapterEnd ?? 99
        // 扫描指定目录，按章节范围过滤
        try {
          const entries = readdirSync(dirPath)
          for (const e of entries) {
            if (!e.endsWith('.md')) continue
            const p = join(dirPath, e)
            if (!statSync(p).isFile()) continue
            if (args.chapterStart || args.chapterEnd) {
              const match = e.match(/(\d+)/)
              if (match) {
                const num = parseInt(match[1], 10)
                if (num < start || num > end) continue
              }
            }
            targetFiles.push(p)
          }
        } catch {
          return formatToolError(`无法读取目录: ${args.chapterDir}`)
        }
      } else {
        // 默认：docs/ 下所有 .md 文件
        targetFiles = collectDocFiles()
      }

      if (targetFiles.length === 0) {
        return formatToolError('未找到匹配的章节文件')
      }

      // ── 执行替换分析 ──
      const allChanges: PreviewChange[] = []
      let totalReplaceCount = 0

      for (const filePath of targetFiles) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          const lines = content.split('\n')
          const fileChanges: PreviewChange['lines'] = []

          for (let i = 0; i < lines.length; i++) {
            let modified = lines[i]
            let lineChanged = false

            for (const pair of pairs) {
              if (modified.includes(pair.old)) {
                const newLine = modified.split(pair.old).join(pair.new)
                if (newLine !== modified) {
                  if (!lineChanged) {
                    fileChanges.push({ lineNumber: i + 1, oldText: lines[i], newText: newLine })
                    lineChanged = true
                  } else {
                    // Update last entry's newText to include all replacements
                    const lastEntry = fileChanges[fileChanges.length - 1]
                    lastEntry.newText = newLine
                  }
                  modified = newLine
                }
              }
            }
          }

          if (fileChanges.length > 0) {
            const replaceCount = fileChanges.reduce((count, change) => {
              let c = 0
              for (const pair of pairs) {
                const occurrences = change.oldText.split(pair.old).length - 1
                c += occurrences
              }
              return count + c
            }, 0)

            allChanges.push({
              file: relative(PROJECT_ROOT, filePath),
              replaceCount,
              lines: fileChanges.slice(0, MAX_PREVIEW_LINES),
            })
            totalReplaceCount += replaceCount
          }
        } catch {
          // skip unreadable files
        }
      }

      if (allChanges.length === 0) {
        return formatToolResult(
          `✅ 未找到任何匹配的替换内容。\n\n` +
            `检查以下替换规则是否存在于目标文件中：\n${pairs
              .map((p, i) => `  ${i + 1}. "${p.old}" → "${p.new}"${p.description ? ` (${p.description})` : ''}`)
              .join('\n')}`,
        )
      }

      // ── Preview 模式输出 ──
      if (!isApply) {
        const summaryLines: string[] = [`🔍 【替换预览】`, `━━━━━━━━━━━━━━━━━━━━━━`, `📋 共 ${pairs.length} 条替换规则：`]

        for (let i = 0; i < pairs.length; i++) {
          summaryLines.push(`  ${i + 1}. "${pairs[i].old}" → "${pairs[i].new}"${pairs[i].description ? ` (${pairs[i].description})` : ''}`)
        }

        summaryLines.push('')
        summaryLines.push(`📄 涉及 ${allChanges.length} 个文件，共 ${totalReplaceCount} 处替换:`)

        for (const change of allChanges) {
          summaryLines.push('')
          summaryLines.push(`  📄 ${change.file} (${change.replaceCount} 处)`)

          for (const line of change.lines.slice(0, 10)) {
            const oldPreview = line.oldText.trim().slice(0, 80)
            const newPreview = line.newText.trim().slice(0, 80)
            summaryLines.push(`    L${line.lineNumber}:`)
            summaryLines.push(`      - ${oldPreview}${oldPreview.length >= 80 ? '…' : ''}`)
            summaryLines.push(`      + ${newPreview}${newPreview.length >= 80 ? '…' : ''}`)
          }

          if (change.lines.length > 10) {
            summaryLines.push(`    …及另外 ${change.lines.length - 10} 行`)
          }
        }

        summaryLines.push('')
        summaryLines.push(`💡 使用 mode="apply" 执行替换（自动创建快照备份）`)

        return formatToolResult(summaryLines.join('\n'))
      }

      // ── Apply 模式 ──
      // 备份文件
      const snapId = createSnapshotForFiles(allChanges.map((c) => resolve(PROJECT_ROOT, c.file)))
      if (!snapId) {
        return formatToolError('无法创建快照备份，替换已取消。请检查文件系统权限。')
      }

      // 执行替换
      let appliedCount = 0
      const errors: string[] = []

      for (const change of allChanges) {
        try {
          const fullPath = resolve(PROJECT_ROOT, change.file)
          if (!existsSync(fullPath)) {
            errors.push(`文件不存在: ${change.file}`)
            continue
          }

          const content = readFileSync(fullPath, 'utf-8')
          let modified = content

          for (const pair of pairs) {
            modified = modified.split(pair.old).join(pair.new)
          }

          if (modified !== content) {
            writeFileSync(fullPath, modified, 'utf-8')
            appliedCount++
          }
        } catch (err: any) {
          errors.push(`${change.file}: ${err.message}`)
        }
      }

      // 记录到 Memory
      const summary = `${pairs.length} 条规则，涉及 ${appliedCount} 个文件，共 ${totalReplaceCount} 处替换`
      recordToMemory('replace', summary)

      // 可选：记录到 WritingDecisionMemory
      if (args.storyName) {
        try {
          const decisionService = new WritingDecisionService()
          for (const pair of pairs) {
            decisionService.recordDecision({
              storyName: args.storyName,
              decisionType: 'style_change',
              entities: [],
              originalContent: `旧术语: ${pair.old}`,
              modifiedContent: `新术语: ${pair.new}`,
              contextSummary: `批量替换: ${pair.description || `${pair.old} → ${pair.new}`}`,
            })
          }
        } catch {
          // WritingDecisionMemory 不可用时静默跳过
        }
      }

      const resultLines: string[] = [
        `✅ 批量替换完成！`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `📋 替换规则：`,
        ...pairs.map((p, i) => `  ${i + 1}. "${p.old}" → "${p.new}"${p.description ? ` (${p.description})` : ''}`),
        '',
        `📄 已修改 ${appliedCount} 个文件`,
        `🔢 共执行 ${totalReplaceCount} 处替换`,
        `💾 快照 ID: ${snapId}`,
      ]

      if (errors.length > 0) {
        resultLines.push('', '⚠️ 以下文件替换失败：')
        for (const err of errors) {
          resultLines.push(`  - ${err}`)
        }
      }

      resultLines.push('')
      resultLines.push(`💡 如需恢复，可执行：`)
      resultLines.push(`  1. writing_snapshot action=list 查找快照`)
      resultLines.push(`  2. writing_snapshot action=restore snapshotId=${snapId}`)
      resultLines.push(`💡 使用 writing_rewrite_search 验证替换结果`)

      return formatToolResult(resultLines.join('\n'))
    } catch (err: any) {
      return formatToolError(`批量替换失败: ${err.message}`)
    }
  },
})

