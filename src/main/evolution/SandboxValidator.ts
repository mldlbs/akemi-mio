/**
 * SandboxValidator — 自主生成的 HTML/JS 产物质量验证器。
 *
 * 在 EvolutionReviewer 的 verify() 阶段被调用，对 sandbox 目录下的 HTML 产物
 * 做静态分析，检查常见渲染/逻辑问题，形成质量门禁。
 *
 * 检查项：
 * - HTML 结构完整性（DOCTYPE、body、script 闭合）
 * - 资源可达性（CDN 引用、本地文件依赖）
 * - p5.js 常见渲染错误（draw() 中 image() 覆盖粒子、setup 尺寸问题）
 * - 通用 JS 反模式（未定义变量、无错误边界、resize 未处理）
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../logger/Logger'

export interface SandboxValidationIssue {
  severity: 'error' | 'warning' | 'info'
  rule: string
  message: string
  line?: number
  fix?: string
}

export interface SandboxValidationResult {
  passed: boolean
  html: { valid: boolean; errors: string[] }
  resources: { external: string[]; missing: string[]; warnings: string[] }
  rendering: SandboxValidationIssue[]
  summary: string
}

/**
 * 已知的 sandbox HTML 产物问题模式 — 可根据经验持续扩充
 */
const PATTERNS: Array<{
  id: string
  severity: 'error' | 'warning' | 'info'
  test: (content: string) => { found: boolean; line?: number; fix?: string }
  message: string
}> = [
  // ── p5.js 渲染顺序错误：image() 在所有粒子/形状绘制之后 ──
  {
    id: 'p5-image-overlay',
    severity: 'error',
    message: 'draw() 中 image() 在粒子/形状绘制之后被调用，会覆盖掉之前绘制的内容',
    test: (content: string) => {
      const drawMatch = content.match(/function\s+draw\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)
      if (!drawMatch) return { found: false }
      const drawBody = drawMatch[1]
      const lines = drawBody.split('\n')

      // 找出 image() 和粒子绘制调用的行号
      let lastImageLine = -1,
        lastDrawLine = -1
      lines.forEach((line, i) => {
        const l = line.trim()
        if (l.startsWith('//') || l.startsWith('if') || l.startsWith('}') || l === '}' || l === '{' || l.endsWith('{')) return
        if (/\bimage\s*\(/.test(l)) lastImageLine = i
        if (/\.(update|show|display|draw|render)\s*\(/.test(l) || /\b(line|rect|ellipse|triangle|point)\s*\(/.test(l)) lastDrawLine = i
      })

      // Bug: image() 在粒子绘制之后执行 → 粒子被覆盖
      if (lastImageLine > lastDrawLine && lastDrawLine >= 0 && lastImageLine >= 0) {
        return { found: true, line: lastImageLine, fix: '将 image(bg, 0, 0) 移到粒子绘制之前，确保粒子叠在背景之上' }
      }
      return { found: false }
    },
  },

  // ── canvas 尺寸保护 ──
  {
    id: 'p5-zero-canvas',
    severity: 'warning',
    message: '创建 canvas 时容器尺寸可能为 0（容器尚未渲染或容器为空）',
    test: (content: string) => {
      if (!/createCanvas/.test(content)) return { found: false }
      if (/Math\.max/.test(content) || /Math\.min/.test(content)) return { found: false }
      if (/\b(innerWidth|innerHeight)\b/.test(content)) return { found: false }
      return { found: true, fix: '使用 Math.max(container.clientWidth, 1) 确保 canvas 尺寸非零' }
    },
  },

  // ── 无错误处理 ──
  {
    id: 'missing-error-boundary',
    severity: 'warning',
    message: '没有错误处理机制（window.onerror 或 try-catch）',
    test: (content: string) => {
      const hasHandler =
        /\bwindow\.onerror\b/.test(content) || /\baddEventListener\s*\(\s*['"]error['"]/.test(content) || /\btry\s*\{/.test(content)
      return { found: !hasHandler, fix: '添加 window.onerror 或在关键函数外包 try-catch' }
    },
  },

  // ── resize 未处理 ──
  {
    id: 'missing-resize-handler',
    severity: 'info',
    message: '缺失 windowResized 或 resize 事件处理，窗口尺寸变化后 canvas 可能错位',
    test: (content: string) => {
      if (!/createCanvas/.test(content)) return { found: false }
      const hasResize = /\bwindowResized\b/.test(content) || /\baddEventListener\s*\(\s*['"]resize['"]/.test(content)
      return { found: !hasResize, fix: '添加 function windowResized() { resizeCanvas(...); }' }
    },
  },

  // ── p5.js 脚本加载验证 ──
  {
    id: 'p5-script-check',
    severity: 'info',
    message: '使用 p5.js 全局模式但未检查库是否已加载',
    test: (content: string) => {
      if (!/cdnjs\.cloudflare\.com\/ajax\/libs\/p5\.js/.test(content)) return { found: false }
      const hasCheck = /typeof\s+(window\.)?p5\s*!==/.test(content) || /\bonload\b/.test(content)
      return { found: !hasCheck, fix: '在 script 标签上添加 onload 回调，或检查 window.p5 是否存在' }
    },
  },
]

function validateHtmlStructure(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!/<!DOCTYPE\s+html>/i.test(content)) errors.push('缺少 DOCTYPE 声明')
  if (!/<html/i.test(content)) errors.push('缺少 <html> 标签')
  if (!/<\/html>/i.test(content)) errors.push('缺少 </html> 闭合标签')
  if (!/<head>/i.test(content)) errors.push('缺少 <head> 标签')
  if (!/<\/head>/i.test(content)) errors.push('缺少 </head> 闭合标签')
  if (!/<body/i.test(content)) errors.push('缺少 <body> 标签')
  if (!/<\/body>/i.test(content)) errors.push('缺少 </body> 闭合标签')
  if (!/charset\s*=/i.test(content)) errors.push('未设置字符编码（charset）')
  return { valid: errors.length === 0, errors }
}

function analyzeResources(content: string, baseDir: string): SandboxValidationResult['resources'] {
  const external: string[] = []
  const missing: string[] = []
  const warnings: string[] = []

  const scriptSrcs = content.match(/<script[^>]*src=["']([^"']+)["']/g) || []
  for (const s of scriptSrcs) {
    const src = s.match(/src=["']([^"']+)["']/)?.[1]
    if (!src) continue
    if (src.startsWith('http://') || src.startsWith('https://')) {
      external.push(src)
      if (!/cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|cdnfonts)\.com/.test(src)) {
        warnings.push(`可能不可靠的外部资源：${src}`)
      }
    } else if (!src.startsWith('//')) {
      const localPath = join(baseDir, src)
      if (!existsSync(localPath)) missing.push(src)
    }
  }

  const linkHrefs = content.match(/<link[^>]*href=["']([^"']+)["']/g) || []
  for (const l of linkHrefs) {
    const href = l.match(/href=["']([^"']+)["']/)?.[1]
    if (!href) continue
    if (href.startsWith('http://') || href.startsWith('https://')) {
      external.push(href)
    } else {
      const localPath = join(baseDir, href)
      if (!existsSync(localPath)) missing.push(href)
    }
  }

  return { external, missing, warnings }
}

export function validateSandboxHtml(filePath: string): SandboxValidationResult {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (err) {
    return {
      passed: false,
      html: { valid: false, errors: [`无法读取文件: ${err}`] },
      resources: { external: [], missing: [], warnings: [] },
      rendering: [],
      summary: `FATAL: 无法读取文件 ${err}`,
    }
  }

  const html = validateHtmlStructure(content)
  const resources = analyzeResources(content, dirname(filePath))

  const renderingIssues: SandboxValidationIssue[] = []
  for (const pattern of PATTERNS) {
    const result = pattern.test(content)
    if (result.found) {
      renderingIssues.push({
        severity: pattern.severity,
        rule: pattern.id,
        message: pattern.message,
        line: result.line,
        fix: result.fix,
      })
    }
  }

  const errors = renderingIssues.filter((i) => i.severity === 'error')
  const passed = html.valid && errors.length === 0 && resources.missing.length === 0

  const parts: string[] = []
  if (html.errors.length) parts.push(`HTML 结构错误 ${html.errors.length} 项`)
  if (errors.length) parts.push(`渲染错误 ${errors.length} 项`)
  if (resources.missing.length) parts.push(`缺失本地资源 ${resources.missing.length} 项`)

  const summary = passed
    ? `✅ sandbox 验证通过（${renderingIssues.length} 项检查）`
    : `❌ sandbox 验证失败：${parts.join('；')}。详情：${renderingIssues.map((i) => `[${i.severity}] ${i.rule}: ${i.message}${i.fix ? ` → ${i.fix}` : ''}`).join(' | ')}`

  return { passed, html, resources, rendering: renderingIssues, summary }
}

/**
 * 扫描 sandbox 目录下所有 HTML 产物并验证
 */
export function validateAllSandboxes(sandboxRoot: string): {
  results: Record<string, SandboxValidationResult>
  total: number
  passed: number
  failed: number
} {
  const { readdirSync, statSync } = require('fs')
  const results: Record<string, SandboxValidationResult> = {}
  let passed = 0,
    failed = 0

  if (!existsSync(sandboxRoot)) return { results, total: 0, passed: 0, failed: 0 }

  for (const entry of readdirSync(sandboxRoot)) {
    const entryPath = join(sandboxRoot, entry)
    if (!statSync(entryPath).isDirectory()) continue
    const htmlFile = join(entryPath, `${entry}.html`)
    if (!existsSync(htmlFile)) continue

    const result = validateSandboxHtml(htmlFile)
    results[entry] = result
    if (result.passed) passed++
    else failed++

    log(result.passed ? 'INFO' : 'WARN', 'sandbox_validation', {
      name: entry,
      passed: result.passed,
      errors: result.rendering.filter((i) => i.severity === 'error').length,
      warnings: result.rendering.filter((i) => i.severity === 'warning').length,
    })
  }

  return { results, total: passed + failed, passed, failed }
}
