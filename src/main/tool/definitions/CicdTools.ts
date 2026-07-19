/**
 * CI/CD MCP 工具定义
 *
 * 将 lint、typecheck、test、build、deploy 等 CI/CD 操作定义为 MCP 工具，
 * 使 Evolution 系统能够通过统一接口调用并获取结果。
 *
 * 生命周期：init() → 注册到 getAllTools() → Evolution 系统消费
 */

import { buildTool, formatToolResult } from '../types'
import { execAsync } from '../../utils/async'
import { log } from '../../logger/Logger'
import { existsSync, mkdirSync, readFileSync, cpSync, rmSync } from 'fs'
import { join } from 'path'

// ==============================================================================
// 常量配置
// ==============================================================================

const CONFIG = {
  PROJECT_ROOT: process.cwd(),
  /** TypeScript 编译检查超时 */
  TSC_TIMEOUT_MS: 120_000,
  /** ESLint 检查超时 */
  ESLINT_TIMEOUT_MS: 120_000,
  /** 测试运行超时 */
  TEST_TIMEOUT_MS: 180_000,
  /** 项目构建超时 */
  BUILD_TIMEOUT_MS: 300_000,
  /** 文档构建超时 */
  DOCS_TIMEOUT_MS: 120_000,
  /** 预览部署目录（相对 projectRoot） */
  PREVIEW_DIR: 'preview_dist',
}

// ==============================================================================
// 工具函数
// ==============================================================================

/** 裁剪过长的命令行输出 */
function truncateOutput(text: string, maxLen: number = 2000): string {
  if (!text) return '(无输出)'
  return text.length > maxLen ? text.slice(0, maxLen) + `\n…（已截断，共 ${text.length} 字符）` : text
}

// ==============================================================================
// cicd_typecheck — TypeScript 编译检查
// ==============================================================================

export const cicdTypecheckTool = buildTool({
  name: 'cicd_typecheck',
  description: '运行 TypeScript 编译检查 (tsc --noEmit)，返回错误列表和统计信息',
  inputJSONSchema: {
    type: 'object',
    properties: {
      tsconfig: {
        type: 'string',
        description: 'tsconfig 文件路径（相对项目根），默认 tsconfig.node.json',
      },
    },
    required: [],
  },
  handler: async (args: { tsconfig?: string }) => {
    try {
      const tsconfig = args.tsconfig || 'tsconfig.node.json'
      const tsconfigPath = join(CONFIG.PROJECT_ROOT, tsconfig)
      if (!existsSync(tsconfigPath)) {
        return formatToolResult(JSON.stringify({
          success: true,
          passed: true,
          summary: `tsconfig "${tsconfig}" 不存在，跳过检查`,
          errorCount: 0,
        }))
      }

      const stdout = await execAsync(`npx tsc --noEmit -p ${tsconfig} 2>&1`, {
        timeout: CONFIG.TSC_TIMEOUT_MS,
      })

      // tsc 成功时可能无输出或仅有信息性消息
      const errorLines = stdout.split('\n').filter((l: string) => l.includes('error TS'))
      const passed = errorLines.length === 0

      log('INFO', 'cicd_typecheck_result', { passed, errorCount: errorLines.length })

      return formatToolResult(JSON.stringify({
        success: true,
        passed,
        errorCount: errorLines.length,
        summary: passed
          ? 'TypeScript 编译检查通过，无类型错误'
          : `TypeScript 编译检查发现 ${errorLines.length} 个错误`,
        errors: errorLines.slice(0, 50),
        raw: truncateOutput(stdout, 3000),
      }))
    } catch (err: any) {
      const errorText = (err.stdout || err.stderr || err.message || String(err)).toString()
      const errorLines = errorText.split('\n').filter((l: string) => l.includes('error TS'))

      log('WARN', 'cicd_typecheck_error', { errorCount: errorLines.length })

      return formatToolResult(JSON.stringify({
        success: true,
        passed: false,
        errorCount: errorLines.length,
        summary: `TypeScript 编译检查失败：${errorLines.length} 个错误`,
        errors: errorLines.slice(0, 50),
        raw: truncateOutput(errorText, 3000),
      }))
    }
  },
  isReadOnly: true,
})

// ==============================================================================
// cicd_lint — ESLint 代码规范检查
// ==============================================================================

export const cicdLintTool = buildTool({
  name: 'cicd_lint',
  description: '运行 ESLint 代码规范检查，返回警告/错误列表',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '检查路径（相对 src/），默认 src/',
      },
      fix: {
        type: 'boolean',
        description: '是否自动修复可修复的问题',
      },
    },
    required: [],
  },
  handler: async (args: { path?: string; fix?: boolean }) => {
    try {
      const lintPath = args.path || 'src/'
      const fixFlag = args.fix ? '--fix' : ''
      const stdout = await execAsync(`npx eslint ${lintPath} --ext .ts,.tsx --format=compact ${fixFlag} 2>&1 || true`, {
        timeout: CONFIG.ESLINT_TIMEOUT_MS,
      })

      // 解析 compact 格式输出
      const lines = stdout.split('\n').filter(Boolean)
      const problemLines = lines.filter((l: string) => /:\d+:\d+:/i.test(l))
      const summaryLine = lines.find((l: string) => /✖|error|warning|problem/i.test(l))
      const errorCount = problemLines.length

      log('INFO', 'cicd_lint_result', { errorCount, fixed: !!args.fix })

      return formatToolResult(JSON.stringify({
        success: true,
        passed: errorCount === 0,
        errorCount,
        summary: errorCount === 0
          ? 'ESLint 检查通过，无代码规范问题'
          : `ESLint 检查发现 ${errorCount} 个问题`,
        problems: problemLines.slice(0, 100),
        summaryLine: summaryLine || '',
        raw: truncateOutput(stdout, 3000),
      }))
    } catch (err: any) {
      const errorText = (err.stdout || err.stderr || err.message || String(err)).toString()
      return formatToolResult(JSON.stringify({
        success: true,
        passed: false,
        errorCount: -1,
        summary: `ESLint 执行异常: ${err.message}`,
        raw: truncateOutput(errorText, 2000),
      }))
    }
  },
  isReadOnly: true,
})

// ==============================================================================
// cicd_test — 测试运行
// ==============================================================================

export const cicdTestTool = buildTool({
  name: 'cicd_test',
  description: '运行测试套件（vitest），返回通过/失败统计',
  inputJSONSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: '指定测试文件（可选），默认为全部测试',
      },
      watch: {
        type: 'boolean',
        description: '是否启用 watch 模式（默认 false）',
      },
      coverage: {
        type: 'boolean',
        description: '是否生成覆盖率报告（默认 false）',
      },
    },
    required: [],
  },
  handler: async (args: { file?: string; watch?: boolean; coverage?: boolean }) => {
    try {
      const fileArg = args.file || ''
      const watchFlag = args.watch ? '--watch' : 'run'
      const coverageFlag = args.coverage ? '--coverage' : ''
      const cmd = `npx vitest ${watchFlag} ${fileArg} ${coverageFlag} 2>&1`

      const stdout = await execAsync(cmd, {
        timeout: CONFIG.TEST_TIMEOUT_MS,
      })

      const passed = stdout.includes('PASS') || stdout.includes('Tests ') || (!stdout.includes('FAIL') && !stdout.includes('failed'))
      const failMatch = stdout.match(/(\d+)\s+fail(?:ed|ure)/i)
      const passMatch = stdout.match(/(\d+)\s+passed/i)
      const totalMatch = stdout.match(/Tests\s+(\d+)/i)

      const failedCount = failMatch ? parseInt(failMatch[1], 10) : 0
      const passedCount = passMatch ? parseInt(passMatch[1], 10) : 0
      const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : 0

      log('INFO', 'cicd_test_result', { passed, passedCount, failedCount, totalCount })

      return formatToolResult(JSON.stringify({
        success: true,
        passed,
        passedCount,
        failedCount,
        totalCount,
        summary: passed
          ? `测试通过: ${passedCount}/${totalCount} 通过`
          : `测试失败: ${failedCount} 个失败`,
        raw: truncateOutput(stdout, 3000),
      }))
    } catch (err: any) {
      const output = (err.stdout || err.stderr || err.message || String(err)).toString()

      // 尝试从错误输出中提取统计数据
      const failMatch = output.match(/(\d+)\s+fail(?:ed|ure)/i)
      const passMatch = output.match(/(\d+)\s+passed/i)
      const failedCount = failMatch ? parseInt(failMatch[1], 10) : -1
      const passedCount = passMatch ? parseInt(passMatch[1], 10) : 0

      log('WARN', 'cicd_test_error', { failedCount })

      return formatToolResult(JSON.stringify({
        success: true,
        passed: failedCount === 0,
        passedCount,
        failedCount,
        summary: failedCount > 0
          ? `测试失败: ${failedCount} 个失败`
          : `测试执行异常: ${err.message}`,
        raw: truncateOutput(output, 3000),
      }))
    }
  },
  isReadOnly: true,
})

// ==============================================================================
// cicd_build — 项目构建
// ==============================================================================

export const cicdBuildTool = buildTool({
  name: 'cicd_build',
  description: '运行项目构建（npm run build），返回构建日志',
  inputJSONSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: '构建脚本名（package.json scripts），默认 "build"',
      },
    },
    required: [],
  },
  handler: async (args: { script?: string }) => {
    try {
      const script = args.script || 'build'
      const stdout = await execAsync(`npm run ${script} 2>&1`, {
        timeout: CONFIG.BUILD_TIMEOUT_MS,
      })

      const passed = !stdout.includes('ERROR') && !stdout.includes('error')
      const errorCount = (stdout.match(/error/gi) || []).length

      log('INFO', 'cicd_build_result', { script, passed })

      return formatToolResult(JSON.stringify({
        success: true,
        passed,
        script,
        errorCount,
        summary: passed
          ? `构建成功 (npm run ${script})`
          : `构建失败: ${errorCount} 个错误`,
        raw: truncateOutput(stdout, 3000),
      }))
    } catch (err: any) {
      const output = (err.stdout || err.stderr || err.message || String(err)).toString()
      return formatToolResult(JSON.stringify({
        success: true,
        passed: false,
        script: args.script || 'build',
        summary: `构建失败: ${err.message}`,
        raw: truncateOutput(output, 3000),
      }))
    }
  },
  isReadOnly: true,
})

// ==============================================================================
// cicd_build_docs — 文档构建
// ==============================================================================

export const cicdBuildDocsTool = buildTool({
  name: 'cicd_build_docs',
  description: '构建项目文档（如 typedoc、docs 目录），返回构建日志',
  inputJSONSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: '文档构建脚本名，默认 "docs:build"',
      },
      outputDir: {
        type: 'string',
        description: '文档输出目录（用于后续预览），默认 "docs_dist"',
      },
    },
    required: [],
  },
  handler: async (args: { script?: string; outputDir?: string }) => {
    try {
      const script = args.script || 'docs:build'
      const outputDir = args.outputDir || 'docs_dist'

      // 先检查脚本是否存在
      const pkgPath = join(CONFIG.PROJECT_ROOT, 'package.json')
      let scriptExists = false
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        scriptExists = !!(pkg.scripts && pkg.scripts[script])
      } catch {
        // 无法读取 package.json
      }

      if (!scriptExists) {
        return formatToolResult(JSON.stringify({
          success: true,
          passed: true,
          summary: `文档构建脚本 "${script}" 不存在，跳过`,
          outputDir,
        }))
      }

      const stdout = await execAsync(`npm run ${script} 2>&1`, {
        timeout: CONFIG.DOCS_TIMEOUT_MS,
      })

      const passed = !stdout.includes('ERROR') && !stdout.includes('error')
      const outputPath = join(CONFIG.PROJECT_ROOT, outputDir)
      const hasOutput = existsSync(outputPath)

      log('INFO', 'cicd_build_docs_result', { script, passed, hasOutput })

      return formatToolResult(JSON.stringify({
        success: true,
        passed,
        script,
        outputDir,
        hasOutput,
        summary: passed
          ? `文档构建成功 (npm run ${script})`
          : `文档构建失败`,
        raw: truncateOutput(stdout, 3000),
      }))
    } catch (err: any) {
      const output = (err.stdout || err.stderr || err.message || String(err)).toString()
      return formatToolResult(JSON.stringify({
        success: true,
        passed: false,
        script: args.script || 'docs:build',
        summary: `文档构建失败: ${err.message}`,
        raw: truncateOutput(output, 2000),
      }))
    }
  },
  isReadOnly: true,
})

// ==============================================================================
// cicd_deploy_preview — 预览部署（自动发布）
// ==============================================================================

export const cicdDeployPreviewTool = buildTool({
  name: 'cicd_deploy_preview',
  description: '部署预览版本（复制构建产物到预览目录），支持自动发布流程',
  inputJSONSchema: {
    type: 'object',
    properties: {
      sourceDir: {
        type: 'string',
        description: '构建产物源目录（相对 projectRoot），默认 "dist"',
      },
      targetDir: {
        type: 'string',
        description: '预览部署目标目录（相对 projectRoot），默认 "preview_dist"',
      },
      clean: {
        type: 'boolean',
        description: '是否先清理目标目录再部署',
      },
      tag: {
        type: 'string',
        description: '部署标签（如 "nightly"、"v1.0.0-preview"），用于标识',
      },
    },
    required: [],
  },
  handler: async (args: { sourceDir?: string; targetDir?: string; clean?: boolean; tag?: string }) => {
    const sourceDir = args.sourceDir || 'dist'
    const targetDir = args.targetDir || CONFIG.PREVIEW_DIR
    const tag = args.tag || `preview_${Date.now()}`

    const sourcePath = join(CONFIG.PROJECT_ROOT, sourceDir)
    const targetPath = join(CONFIG.PROJECT_ROOT, targetDir)

    // 检查源目录是否存在
    if (!existsSync(sourcePath)) {
      return formatToolResult(JSON.stringify({
        success: false,
        passed: false,
        summary: `构建产物目录 "${sourceDir}" 不存在，请先运行构建`,
        deployed: false,
        tag,
        targetDir,
      }))
    }

    try {
      // 清理目标目录
      if (args.clean && existsSync(targetPath)) {
        rmSync(targetPath, { recursive: true, force: true })
      }

      // 创建目标目录
      if (!existsSync(targetPath)) {
        mkdirSync(targetPath, { recursive: true })
      }

      // 复制构建产物到预览目录 using native fs.cp (Node 16.7+)
      try {
        cpSync(sourcePath, targetPath, { recursive: true, force: true })
      } catch {
        // 回退：使用 xcopy (Windows) 或 cp -r (Unix/Mac)
        const isWin = process.platform === 'win32'
        if (isWin) {
          await execAsync(`xcopy /E /I /Y "${sourcePath}" "${targetPath}"`, { timeout: 30_000 })
        } else {
          await execAsync(`cp -rf "${sourcePath}/" "${targetPath}/"`, { timeout: 30_000 })
        }
      }

      log('INFO', 'cicd_deploy_preview_result', {
        tag,
        source: sourceDir,
        target: targetDir,
      })

      return formatToolResult(JSON.stringify({
        success: true,
        passed: true,
        summary: `预览已部署: ${sourceDir} → ${targetDir}${tag ? ` (标签: ${tag})` : ''}`,
        deployed: true,
        tag,
        sourceDir,
        targetDir,
        timestamp: Date.now(),
      }))
    } catch (err: any) {
      return formatToolResult(JSON.stringify({
        success: false,
        passed: false,
        summary: `预览部署失败: ${err.message}`,
        deployed: false,
        tag,
        sourceDir,
        targetDir,
      }))
    }
  },
  isReadOnly: false,
})

// ==============================================================================
// cicd_quality_gate — 综合质量门禁
// ==============================================================================

/**
 * 综合质量门禁：一次性执行 typecheck + lint + test + build，
 * 返回合并的门禁结果。Evolution 系统可直接用此工具做前置验证。
 */
export const cicdQualityGateTool = buildTool({
  name: 'cicd_quality_gate',
  description: '综合质量门禁：同时执行 typecheck、lint、test、build 并返回合并结果',
  inputJSONSchema: {
    type: 'object',
    properties: {
      skipLint: {
        type: 'boolean',
        description: '跳过 ESLint 检查',
      },
      skipTest: {
        type: 'boolean',
        description: '跳过测试',
      },
      skipBuild: {
        type: 'boolean',
        description: '跳过构建',
      },
      skipDocs: {
        type: 'boolean',
        description: '跳过文档构建',
      },
      tsconfig: {
        type: 'string',
        description: 'tsconfig 文件路径',
      },
    },
    required: [],
  },
  handler: async (args: {
    skipLint?: boolean
    skipTest?: boolean
    skipBuild?: boolean
    skipDocs?: boolean
    tsconfig?: string
  }) => {
    const startedAt = Date.now()
    const results: Record<string, any> = {}
    let allPassed = true
    const failures: string[] = []

    // 并行执行所有检查
    const checks: Array<{ name: string; fn: () => Promise<any> }> = [
      { name: 'typecheck', fn: () => cicdTypecheckTool.handler({ tsconfig: args.tsconfig }) },
    ]

    if (!args.skipLint) {
      checks.push({ name: 'lint', fn: () => cicdLintTool.handler({ path: 'src/' }) })
    }
    if (!args.skipTest) {
      checks.push({ name: 'test', fn: () => cicdTestTool.handler({}) })
    }
    if (!args.skipBuild) {
      checks.push({ name: 'build', fn: () => cicdBuildTool.handler({}) })
    }
    if (!args.skipDocs) {
      checks.push({ name: 'docs', fn: () => cicdBuildDocsTool.handler({}) })
    }

    await Promise.all(
      checks.map(async (check) => {
        try {
          const result = await check.fn()
          const rawText = result.content?.[0]?.text || '{}'
          const parsed = JSON.parse(rawText)
          results[check.name] = parsed
          if (!parsed.passed) {
            allPassed = false
            failures.push(`${check.name}: ${parsed.summary}`)
          }
        } catch (err: any) {
          results[check.name] = { passed: false, summary: err.message }
          allPassed = false
          failures.push(`${check.name}: ${err.message}`)
        }
      }),
    )

    const durationMs = Date.now() - startedAt

    log('INFO', 'cicd_quality_gate_result', {
      allPassed,
      failures: failures.length,
      durationMs,
    })

    return formatToolResult(JSON.stringify({
      success: true,
      passed: allPassed,
      summary: allPassed
        ? `✅ 质量门禁通过（${durationMs}ms）`
        : `❌ 质量门禁未通过 (${durationMs}ms):\n${failures.join('\n')}`,
      checks: results,
      failures,
      durationMs,
      timestamp: Date.now(),
    }))
  },
  isReadOnly: true,
})
