/**
 * BlogSecurityReviewer — 博客内容安全审查模块
 *
 * 职责：
 * 1. 检测博客内容中的安全风险（XSS、注入、敏感信息泄露等）
 * 2. 提供基于内容模式的自动检测，不依赖外部 API
 * 3. 生成结构化安全审查报告，支持工作流门控决策
 *
 * 检测维度：
 * - XSS 脚本注入（<script>、on* 事件处理器、javascript: URL）
 * - 敏感信息泄露（API Key、Token、密码、内网 IP、文件路径）
 * - 外部链接风险评估（可疑域名、恶意链接模式）
 * - 钓鱼内容检测
 * - 恶意代码/脚本检测
 * - 版权问题提示
 * - 模板注入、SQL 注入、命令注入
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SecurityFinding, SecurityReviewReport, SecurityRiskLevel } from './types'

// =============================================================================
// 常量
// =============================================================================

/** 检测模式定义 */
interface DetectionPattern {
  category: SecurityFinding['category']
  riskLevel: SecurityRiskLevel
  patterns: RegExp[]
  description: string
  suggestion: string
  autoFixable: boolean
  /** 匹配上下文长度（字符数） */
  contextChars: number
}

/** 敏感信息正则 */
const SENSITIVE_PATTERNS: DetectionPattern[] = [
  {
    category: 'sensitive_data',
    riskLevel: 'critical',
    patterns: [
      // API Keys
      /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|api[-_]?key[-_]?['"]?\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"])/gi,
      // AWS Access Key
      /\b(AKIA[0-9A-Z]{16})\b/,
      // GitHub Token
      /\b(ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{80,})\b/,
      // JWT Token
      /\b(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/,
      // Base64 encoded credentials (high entropy)
      /\b([A-Za-z0-9+/]{40,}={0,2})\b/g,
    ],
    description: '检测到疑似 API 密钥/令牌/凭证泄露',
    suggestion: '移除硬编码的密钥和令牌，使用环境变量或密钥管理服务代替。如为示例凭证，添加明确标注"此为示例，请勿用于生产环境"',
    autoFixable: false,
    contextChars: 60,
  },
  {
    category: 'sensitive_data',
    riskLevel: 'high',
    patterns: [
      // Password patterns
      /\b(password|pwd|passwd|secret)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
      // Connection strings
      /(mongodb|postgresql|mysql|redis):\/\/[a-zA-Z0-9]+:[^@]+@/gi,
      // Private keys
      /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    ],
    description: '检测到密码或连接字符串',
    suggestion: '移除明文密码和连接字符串中的凭证信息。使用配置文件或环境变量注入',
    autoFixable: false,
    contextChars: 80,
  },
  {
    category: 'sensitive_data',
    riskLevel: 'medium',
    patterns: [
      // Internal IP addresses
      /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/,
      // Internal URLs
      /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?[/\s)]/i,
      // File paths (Windows)
      /[A-Z]:\\(?:Users|home|tmp|temp|var|etc|opt|app)[^"'\s)]*/gi,
      // File paths (Unix)
      /\/(?:home|tmp|var|etc|opt|app|root|usr)\/[^\s"')\]]{10,}/gi,
    ],
    description: '检测到内部网络地址或文件路径',
    suggestion: '将内部地址替换为占位符（如 `your-server-ip`），文件路径使用相对路径或环境变量',
    autoFixable: true,
    contextChars: 60,
  },
]

/** XSS 相关检测 */
const XSS_PATTERNS: DetectionPattern[] = [
  {
    category: 'xss',
    riskLevel: 'critical',
    patterns: [
      /<script[\s>][\s\S]*?<\/script>/gi,
      /javascript\s*:\s*(?:alert|prompt|confirm|eval|document|location|window)\s*\(/gi,
      /on(?:load|error|click|mouseover|submit|focus|blur|change|keydown|keyup|input)\s*=\s*['"][^"']*['"]/gi,
      /document\.(?:write|cookie|domain|location)\s*=/gi,
      /eval\s*\(/gi,
    ],
    description: '检测到 XSS 攻击向量',
    suggestion: '移除内联 JavaScript 代码。如需要交互功能，使用安全的前端框架方法',
    autoFixable: false,
    contextChars: 100,
  },
  {
    category: 'xss',
    riskLevel: 'high',
    patterns: [
      /<iframe[\s>][\s\S]*?<\/iframe>/gi,
      /<embed[\s>][\s\S]*?<\/embed>/gi,
      /<object[\s>][\s\S]*?<\/object>/gi,
      /data\s*:\s*text\/html\s*;/gi,
      /src\s*=\s*['"]\s*(?:javascript|data)\s*:/gi,
    ],
    description: '检测到潜在 XSS 风险（iframe/embed/object）',
    suggestion: '除非必要，移除 iframe/embed/object 标签。如需要嵌入，确保使用 sandbox 属性和 https 来源',
    autoFixable: false,
    contextChars: 80,
  },
]

/** 外部链接风险检测 */
const LINK_PATTERNS: DetectionPattern[] = [
  {
    category: 'external_link',
    riskLevel: 'medium',
    patterns: [
      /https?:\/\/(?:bit\.ly|tinyurl|shorturl|short\.link|rb\.gy|shortener)[^\s"')\]]+/gi,
      /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?[^\s"')\]]*/gi,
    ],
    description: '检测到短链接或 IP 直连链接',
    suggestion: '尽量使用完整域名链接替代短链接，避免 IP 直连。确保链接指向可信域名',
    autoFixable: false,
    contextChars: 80,
  },
  {
    category: 'phishing',
    riskLevel: 'high',
    patterns: [
      /https?:\/\/(?:[a-zA-Z0-9-]+\.)+(?:xyz|top|club|work|click|download|review|live|online|site|website)\/[^\s"')\]]+/gi,
      // Homograph attack patterns (mixed scripts)
      /https?:\/\/[^\s]*[а-яА-Я][^\s]*/gi,
      /https?:\/\/[^\s]*(?:secure|login|verify|account|bank|update|confirm)[^\s]*\.(?:com|net|org)[^\s]*/gi,
    ],
    description: '检测到可能包含钓鱼风险的链接',
    suggestion: '验证链接目标域名的合法性。避免链接到不熟悉的顶级域名',
    autoFixable: false,
    contextChars: 100,
  },
]

/** 注入攻击检测 */
const INJECTION_PATTERNS: DetectionPattern[] = [
  {
    category: 'injection',
    riskLevel: 'critical',
    patterns: [
      // SQL injection in code examples
      /(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\s+.+?(?:'|\$|#|--)/gi,
      // Template injection
      /\{\{[\s]*[a-zA-Z_][\w.()[\]]*[\s]*\}\}/g,
      /\{%[\s\S]*?%\}/g,
      // Command injection
      /(?:system|exec|shell_exec|popen|proc_open|passthru)\s*\(/gi,
      /\$\(.+?\)/g,
      /`[^`]*`/g,
    ],
    description: '检测到可能的注入攻击模式',
    suggestion: '使用参数化查询替代字符串拼接，使用安全的模板引擎，避免直接执行用户输入',
    autoFixable: false,
    contextChars: 120,
  },
  {
    category: 'injection',
    riskLevel: 'high',
    patterns: [
      /eval\s*\(\s*(?:request|input|\$_GET|\$_POST|\$_REQUEST|req\.|ctx\.)/gi,
      /\.innerHTML\s*=/gi,
      /dangerouslySetInnerHTML/i,
      /v-html\s*=/gi,
    ],
    description: '检测到不安全的内容渲染模式',
    suggestion: '使用 textContent/.innerText 替代 innerHTML，避免使用 dangerouslySetInnerHTML/v-html',
    autoFixable: true,
    contextChars: 60,
  },
]

/** 版权相关问题 */
const COPYRIGHT_PATTERNS: DetectionPattern[] = [
  {
    category: 'copyright',
    riskLevel: 'low',
    patterns: [
      // Large copied blocks (detect via repetition, not regex alone)
    ],
    description: '可能涉及版权内容',
    suggestion: '确保引用他人内容时标注来源和授权方式',
    autoFixable: false,
    contextChars: 0,
  },
]

/** 所有检测模式 */
const ALL_PATTERNS: DetectionPattern[] = [
  ...SENSITIVE_PATTERNS,
  ...XSS_PATTERNS,
  ...LINK_PATTERNS,
  ...INJECTION_PATTERNS,
  ...COPYRIGHT_PATTERNS,
]

// =============================================================================
// BlogSecurityReviewer
// =============================================================================

export class BlogSecurityReviewer {
  private findingCounter = 0

  /**
   * 对博客内容执行安全审查
   *
   * @param content 博客正文（Markdown 格式）
   * @param options 审查选项
   * @returns 安全审查报告
   */
  review(
    content: string,
    options?: {
      /** 是否跳过代码块中的检测（默认 true，代码块中可能包含合法代码） */
      skipCodeBlocks?: boolean
      /** 是否仅检查关键风险（默认 false，检查全部） */
      criticalOnly?: boolean
    },
  ): SecurityReviewReport {
    const skipCodeBlocks = options?.skipCodeBlocks ?? true
    const criticalOnly = options?.criticalOnly ?? false

    this.findingCounter = 0

    const findings: SecurityFinding[] = []

    // 分离代码块和正文
    const { textContent } = this.separateCodeBlocks(content)

    // 对每个检测模式执行匹配
    const patternsToRun = criticalOnly ? ALL_PATTERNS.filter((p) => p.riskLevel === 'critical' || p.riskLevel === 'high') : ALL_PATTERNS

    for (const pattern of patternsToRun) {
      const targetContent = skipCodeBlocks ? textContent : content
      const matches = this.matchPattern(targetContent, pattern)
      findings.push(...matches)
    }

    // 额外检测：大段重复文本（疑似抄袭）
    const duplicateCheck = this.checkDuplicateContent(textContent)
    if (duplicateCheck) {
      findings.push(duplicateCheck)
    }

    // 计算风险等级
    const criticalHighCount = findings.filter((f) => f.riskLevel === 'critical' || f.riskLevel === 'high').length
    const totalFindings = findings.length
    const overallRiskLevel = this.computeOverallRisk(findings)
    const passed = this.isPassed(overallRiskLevel)
    const recommendedAction = this.getRecommendedAction(overallRiskLevel)

    const report: SecurityReviewReport = {
      timestamp: Date.now(),
      contentPreview: content.slice(0, 200),
      overallRiskLevel,
      findings,
      criticalHighCount,
      totalFindings,
      passed,
      recommendedAction,
    }

    log('INFO', 'blog_security_review_completed', {
      overallRiskLevel,
      totalFindings,
      criticalHighCount,
      passed,
    })

    return report
  }

  /**
   * 快速安全审查 — 仅检查关键/高风险问题
   */
  quickReview(content: string): { passed: boolean; riskLevel: SecurityRiskLevel; findingCount: number } {
    const report = this.review(content, { criticalOnly: true })
    return {
      passed: report.passed,
      riskLevel: report.overallRiskLevel,
      findingCount: report.totalFindings,
    }
  }

  /**
   * 自动修复可自动修复的安全问题
   * 目前支持：内网IP替换、文件路径模糊化、不安全渲染标记移除
   */
  autoFix(content: string): { fixed: string; changes: number } {
    let result = content
    let changes = 0

    // 替换内网 IP
    result = result.replace(
      /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
      () => {
        changes++
        return '<internal-ip>'
      },
    )

    // 替换 localhost 引用
    result = result.replace(/https?:\/\/localhost(:\d+)?/gi, () => {
      changes++
      return 'http://localhost<port>'
    })

    // 替换文件路径
    result = result.replace(/[A-Z]:\\(?:Users|home|tmp|temp|var|etc|opt|app)[^"'\s)]*/gi, (match) => {
      changes++
      return match.replace(/[^\\]+$/, '<user-path>')
    })

    return { fixed: result, changes }
  }

  // ===========================================================================
  // 私有方法
  // ===========================================================================

  /**
   * 分离代码块和正文，避免在代码块中误报
   */
  private separateCodeBlocks(content: string): {
    textContent: string
    codeBlocks: string[]
  } {
    const codeBlocks: string[] = []
    const textContent = content.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match)
      return '' // 移除代码块，剩余部分进行安全审查
    })
    return { textContent, codeBlocks }
  }

  /**
   * 对单个检测模式执行匹配
   */
  private matchPattern(content: string, pattern: DetectionPattern): SecurityFinding[] {
    const findings: SecurityFinding[] = []

    for (const regex of pattern.patterns) {
      let match: RegExpExecArray | null
      const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')

      while ((match = globalRegex.exec(content)) !== null) {
        const matchedText = match[0]
        if (matchedText.length < 4) continue // 忽略过短的匹配

        // 获取匹配上下文
        const start = Math.max(0, match.index - pattern.contextChars / 2)
        const end = Math.min(content.length, match.index + matchedText.length + pattern.contextChars / 2)
        const snippet = content.slice(start, end).replace(/\n/g, '↵').slice(0, 150)

        this.findingCounter++

        findings.push({
          id: `sec_${Date.now()}_${this.findingCounter}`,
          riskLevel: pattern.riskLevel,
          category: pattern.category,
          description: `${pattern.description}: ${matchedText.slice(0, 80)}`,
          location: {
            snippet: `...${snippet}...`,
          },
          suggestion: pattern.suggestion,
          autoFixable: pattern.autoFixable,
          confidence: pattern.riskLevel === 'critical' ? 0.9 : pattern.riskLevel === 'high' ? 0.75 : 0.6,
        })

        // 防止正则死循环（零长度匹配）
        if (match.index === globalRegex.lastIndex) {
          globalRegex.lastIndex++
        }
      }
    }

    return findings
  }

  /**
   * 检测大段重复文本（抄袭/转载可能性）
   */
  private checkDuplicateContent(content: string): SecurityFinding | null {
    // 检查是否有超过 3 个连续的、长度超过 80 字符的重复段落
    const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

    for (let i = 0; i < paragraphs.length - 1; i++) {
      for (let j = i + 1; j < paragraphs.length; j++) {
        const pi = paragraphs[i].trim()
        const pj = paragraphs[j].trim()
        // 计算最长公共子串比例
        if (pi.length > 80 && pj.length > 80) {
          const common = this.longestCommonSubstring(pi, pj)
          if (common.length > Math.min(pi.length, pj.length) * 0.7) {
            this.findingCounter++
            return {
              id: `sec_${Date.now()}_dup_${this.findingCounter}`,
              riskLevel: 'medium',
              category: 'copyright',
              description: `检测到大段重复内容（相似度 > 70%），可能是未标注来源的转载`,
              location: {
                snippet: common.slice(0, 100),
              },
              suggestion: '如为引用他人内容，请标注来源和授权方式。如为原创内容，确保没有粘贴重复',
              autoFixable: false,
              confidence: 0.6,
            }
          }
        }
      }
    }

    return null
  }

  /**
   * 最长公共子串（用于重复检测）
   */
  private longestCommonSubstring(a: string, b: string): string {
    const m = a.length
    const n = b.length
    let maxLen = 0
    let endIndex = 0

    // 使用滚动数组优化空间
    const dp: number[][] = [[], []]
    for (let i = 0; i < m; i++) {
      const cur = i % 2
      const prev = (i + 1) % 2
      dp[cur] = new Array(n).fill(0)
      for (let j = 0; j < n; j++) {
        if (a[i] === b[j]) {
          dp[cur][j] = (i > 0 && j > 0 ? dp[prev][j - 1] : 0) + 1
          if (dp[cur][j] > maxLen) {
            maxLen = dp[cur][j]
            endIndex = i
          }
        }
      }
    }

    return a.slice(endIndex - maxLen + 1, endIndex + 1)
  }

  /**
   * 综合计算风险等级
   */
  private computeOverallRisk(findings: SecurityFinding[]): SecurityRiskLevel {
    if (findings.some((f) => f.riskLevel === 'critical')) return 'critical'
    if (findings.some((f) => f.riskLevel === 'high')) return 'high'
    if (findings.some((f) => f.riskLevel === 'medium')) return 'medium'
    if (findings.length > 0) return 'low'
    return 'info'
  }

  /**
   * 判断是否通过安全审查
   */
  private isPassed(riskLevel: SecurityRiskLevel): boolean {
    return riskLevel === 'info' || riskLevel === 'low'
  }

  /**
   * 获取推荐动作
   */
  private getRecommendedAction(riskLevel: SecurityRiskLevel): 'proceed' | 'fix_before_publish' | 'block' {
    switch (riskLevel) {
      case 'info':
      case 'low':
        return 'proceed'
      case 'medium':
      case 'high':
        return 'fix_before_publish'
      case 'critical':
        return 'block'
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const blogSecurityReviewer = new BlogSecurityReviewer()
