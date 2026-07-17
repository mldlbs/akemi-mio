/**
 * MergeSecurityScanner — 安全扫描器
 *
 * 参考 Microsoft 安全漏洞 #570（AI 生成代码的注入风险），
 * 对生成的合并补丁进行安全扫描。
 *
 * 扫描规则：
 * 1. 命令注入检测（exec, execSync, eval, new Function）
 * 2. 路径遍历检测（未消毒的用户输入拼接到路径）
 * 3. 敏感信息泄露（硬编码密钥、Token）
 * 4. 不安全的 fetch 调用（缺少超时、缺少状态检查）
 * 5. 原型污染（__proto__、constructor.prototype）
 * 6. SQL 注入（未参数化的查询拼接）
 * 7. SSRF 风险（用户控制的 URL 传递给 fetch）
 */

import { log } from '../../logger/Logger'
import type { SecurityFinding, SecuritySeverity, SecurityScanResult } from './types'

// ═══════════════════════════════════════════
// 安全扫描规则定义
// ═══════════════════════════════════════════

interface SecurityRule {
  name: string
  severity: SecuritySeverity
  pattern: RegExp
  description: string
  recommendation: string
}

const SECURITY_RULES: SecurityRule[] = [
  // 命令注入
  {
    name: 'command-injection-exec',
    severity: 'critical',
    pattern: /(exec|execSync|spawn|spawnSync|fork)\s*\([^)]*\+/,
    description: '检测到字符串拼接的命令执行调用，可能存在命令注入风险',
    recommendation: '使用参数化 API（如 execFile）替代字符串拼接，或严格消毒用户输入',
  },
  {
    name: 'command-injection-eval',
    severity: 'critical',
    pattern: /(eval|new\s+Function|setTimeout|setInterval)\s*\(\s*(['"`]|.*\+)/,
    description: '检测到动态代码执行，可能导致任意代码执行',
    recommendation: '避免使用 eval / new Function，使用安全的替代方案',
  },
  // 路径遍历
  {
    name: 'path-traversal',
    severity: 'high',
    pattern: /(readFileSync|writeFileSync|readFile|writeFile|join|resolve)\s*\([^)]*\+(?:userInput|req\.param|body\.|query\.|params\.)/,
    description: '检测到用户输入拼接到文件路径操作中，可能存在路径遍历风险',
    recommendation: '使用 path.resolve 并验证路径在预期目录内，或使用白名单验证输入',
  },
  // 敏感信息泄露
  {
    name: 'hardcoded-secret',
    severity: 'high',
    pattern: /(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*['"][A-Za-z0-9_\-+/]{16,}['"]/i,
    description: '检测到可能的硬编码密钥或 Token',
    recommendation: '将敏感信息移到环境变量或 credentialManager 中',
  },
  // 不安全的 fetch
  {
    name: 'unsafe-fetch-no-timeout',
    severity: 'medium',
    pattern: /fetch\s*\([^)]*\)(?![\s\S]{0,100}AbortSignal)/,
    description: 'fetch() 调用缺少 AbortSignal.timeout 超时控制',
    recommendation: '添加 signal: AbortSignal.timeout(15000) 防止请求挂起',
  },
  {
    name: 'unsafe-fetch-no-ok-check',
    severity: 'medium',
    pattern: /const\s+\w+\s*=\s*await\s+fetch\s*\([^)]*\)\s*(?![\s\S]{0,10}\.(?:ok|status))/,
    description: 'fetch() 响应缺少 !res.ok 状态检查',
    recommendation: '添加 if (!res.ok) throw new Error(...) 响应状态检查',
  },
  // 原型污染
  {
    name: 'prototype-pollution',
    severity: 'high',
    pattern: /(?:__proto__|constructor\.prototype|prototype\.\w+\s*=)/,
    description: '检测到可能的原型污染操作',
    recommendation: '使用 Object.create(null) 或 Map 替代普通对象作为字典',
  },
  // SQL 注入（如果代码中有 SQL）
  {
    name: 'sql-injection',
    severity: 'critical',
    pattern: /(?:query|execute|run)\s*\([^)]*['"`]\s*\+/,
    description: '检测到字符串拼接的 SQL 查询，可能存在 SQL 注入风险',
    recommendation: '使用参数化查询或 prepared statements',
  },
  // SSRF 风险
  {
    name: 'ssrf-risk',
    severity: 'medium',
    pattern: /(?:req\.|body\.|query\.|params\.)(?:url|link|href|uri|path|target)\s*.*fetch\s*\(/i,
    description: '检测到用户控制的 URL 传递给 fetch，可能存在 SSRF 风险',
    recommendation: '验证 URL 的 host 在白名单内，或限制协议为 https',
  },
  // 不安全的 JSON 解析
  {
    name: 'unsafe-json-parse',
    severity: 'low',
    pattern: /JSON\.parse\s*\([^)]*\)(?![\s\S]{0,50}catch)/,
    description: 'JSON.parse() 调用缺少 try/catch 保护',
    recommendation: '使用 try/catch 包装 JSON.parse 调用',
  },
  // 打印敏感信息到日志
  {
    name: 'log-sensitive-data',
    severity: 'medium',
    pattern: /log\(.*(?:token|secret|password|key|credential|auth).*\)/i,
    description: '可能将敏感信息记录到日志中',
    recommendation: '在日志中脱敏处理或移除敏感信息记录',
  },
]

// ═══════════════════════════════════════════
// MergeSecurityScanner
// ═══════════════════════════════════════════

export class MergeSecurityScanner {
  readonly name = 'merge-security-scanner'

  /**
   * 扫描补丁代码的安全问题。
   *
   * @param filePath 文件路径（用于报告）
   * @param content 要扫描的代码内容
   * @returns 安全扫描结果
   */
  scanPatch(filePath: string, content: string): SecurityScanResult {
    const findings: SecurityFinding[] = []

    for (const rule of SECURITY_RULES) {
      let match: RegExpExecArray | null
      const regex = new RegExp(rule.pattern.source, 'gm')
      while ((match = regex.exec(content)) !== null) {
        // 计算行号
        const prefix = content.slice(0, match.index)
        const lineNum = prefix.split('\n').length

        findings.push({
          type: rule.name,
          severity: rule.severity,
          description: rule.description,
          file: filePath,
          line: lineNum,
          recommendation: rule.recommendation,
        })
      }
    }

    // 去重（同行同类型只保留一个）
    const seen = new Set<string>()
    const uniqueFindings = findings.filter(f => {
      const key = `${f.file}:${f.line}:${f.type}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const criticalCount = uniqueFindings.filter(f => f.severity === 'critical').length
    const highCount = uniqueFindings.filter(f => f.severity === 'high').length

    const passed = criticalCount === 0 && highCount === 0

    if (uniqueFindings.length > 0) {
      log('INFO', 'merge_security_scan', {
        passed,
        total: uniqueFindings.length,
        critical: criticalCount,
        high: highCount,
        file: filePath,
      })
    }

    return {
      passed,
      findings: uniqueFindings,
      criticalCount,
      highCount,
    }
  }

  /**
   * 批量扫描多个文件的补丁。
   */
  scanPatches(patches: Array<{ file: string; content: string }>): SecurityScanResult {
    const allFindings: SecurityFinding[] = []
    let totalCritical = 0
    let totalHigh = 0

    for (const patch of patches) {
      const result = this.scanPatch(patch.file, patch.content)
      allFindings.push(...result.findings)
      totalCritical += result.criticalCount
      totalHigh += result.highCount
    }

    return {
      passed: totalCritical === 0 && totalHigh === 0,
      findings: allFindings,
      criticalCount: totalCritical,
      highCount: totalHigh,
    }
  }
}
