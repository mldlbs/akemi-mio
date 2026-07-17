/**
 * MergeAnalyzer — 代码分析模块
 *
 * 扫描 radar-bot 和 telegram-bot 代码，识别：
 * 1. 抓取、格式化、推送相关函数及其依赖
 * 2. 已集成部分 vs 缺失的合并缺口
 * 3. 类型对齐和依赖兼容性
 *
 * 输出 MergeScanResult，供 MergePlanGenerator 消费。
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { log } from '../../logger/Logger'
import { DEV_PROJECT_ROOT } from '../../config'
import type {
  ScannedFunction,
  MergeGap,
  MergeScanResult,
  SourceModule,
} from './types'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const PROJECT_ROOT = DEV_PROJECT_ROOT || process.cwd()

const SCAN_TARGETS: Array<{ module: SourceModule; dir: string; pattern: RegExp }> = [
  { module: 'startup-radar', dir: 'src/main/startup-radar', pattern: /\.ts$/ },
  { module: 'radar-tools', dir: 'src/main/tool/definitions', pattern: /Radar.*\.ts$/ },
  { module: 'radar-memory', dir: 'src/main/memory/sidecar', pattern: /Radar.*\.ts$/ },
  { module: 'telegram-service', dir: 'src/main/telegram', pattern: /\.ts$/ },
  { module: 'message-gateway', dir: 'src/main/telegram', pattern: /MessageGateway|DataSourceTool\.ts$/ },
]

// ═══════════════════════════════════════════
// 函数/能力点 扫描规则
// ═══════════════════════════════════════════

interface FunctionPattern {
  pattern: RegExp
  category: ScannedFunction['category']
  description: string
}

/** 各模块的函数扫描模式 */
const MODULE_FUNCTION_PATTERNS: Record<string, FunctionPattern[]> = {
  'startup-radar': [
    { pattern: /async\s+scan\s*\(/, category: 'fetch', description: '雷达扫描入口' },
    { pattern: /collectRawData/, category: 'fetch', description: '原始数据采集' },
    { pattern: /formatForTelegram/, category: 'format', description: '单条信号格式化为 Telegram' },
    { pattern: /formatBatchForTelegram/, category: 'format', description: '批量格式化为 Telegram' },
    { pattern: /onSignalsReady/, category: 'event', description: '信号就绪订阅' },
    { pattern: /notify\s*\(/, category: 'push', description: '通知订阅者' },
    { pattern: /evaluate(Relevance|Timeliness|Impact|Confidence|Actionability)/, category: 'analyze', description: '维度评分函数' },
    { pattern: /computeCompositeScore/, category: 'analyze', description: '复合评分计算' },
    { pattern: /classifyCategory/, category: 'analyze', description: '信号分类' },
    { pattern: /computeUrgency/, category: 'analyze', description: '紧急度评估' },
  ],
  'radar-tools': [
    { pattern: /radarScanTool/, category: 'fetch', description: 'radar_scan MCP 工具' },
    { pattern: /radarAnalyzeTool/, category: 'analyze', description: 'radar_analyze MCP 工具' },
  ],
  'telegram-service': [
    { pattern: /subscribePushEvents/, category: 'event', description: '推送事件订阅入口' },
    { pattern: /enqueueReply/, category: 'push', description: '回复消息入队' },
    { pattern: /enqueueEdit/, category: 'push', description: '编辑消息入队' },
    { pattern: /sendMessageSync/, category: 'push', description: '同步发送消息' },
    { pattern: /handlePushInput/, category: 'push', description: '推送输入处理' },
    { pattern: /handlePushResponse/, category: 'push', description: '推送响应处理' },
    { pattern: /handleToolPhoto/, category: 'push', description: '图片消息推送' },
    { pattern: /startPolling/, category: 'schedule', description: '轮询启动' },
    { pattern: /scheduleReconnect/, category: 'schedule', description: '重连调度' },
  ],
  'message-gateway': [
    { pattern: /executeTool/, category: 'fetch', description: '工具执行' },
    { pattern: /executeToolForTelegram/, category: 'push', description: '工具结果→ Telegram 格式' },
    { pattern: /register\s*\(/, category: 'route', description: '数据源工具注册' },
  ],
}

/** 检测已集成状态的模式 — 在 telegram 代码中查找对 radar 的引用 */
const INTEGRATION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /radar|startupRadar|startup.radar/i, description: 'radar 模块引用' },
  { pattern: /ROUTING.*radar|radar.*ROUTING/, description: 'radar 路由表入口' },
  { pattern: /'radar'/, description: 'radar 字符串引用' },
  { pattern: /radar_scan|radar_analyze/, description: 'radar MCP 工具调用' },
  { pattern: /startupRadarAdapter/, description: 'radar 适配器引用' },
]

// ═══════════════════════════════════════════
// MergeAnalyzer
// ═══════════════════════════════════════════

export class MergeAnalyzer {
  readonly name = 'merge-analyzer'

  private lastScanResult: MergeScanResult | null = null
  private cacheValid = false
  private cacheDurationMs = 30 * 60 * 1000 // 30 分钟缓存

  /** 获取上次扫描结果（带缓存） */
  getLastScanResult(): MergeScanResult | null {
    if (this.cacheValid && this.lastScanResult) {
      return this.lastScanResult
    }
    return null
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cacheValid = false
    this.lastScanResult = null
  }

  /**
   * 执行全量扫描：扫描所有目标模块，识别函数和合并缺口。
   */
  async scan(): Promise<MergeScanResult> {
    log('INFO', 'merge_scan_start', { targets: SCAN_TARGETS.length })

    const allFunctions: ScannedFunction[] = []
    const allGaps: MergeGap[] = []

    // 1. 逐模块扫描函数和能力点
    for (const target of SCAN_TARGETS) {
      const absDir = join(PROJECT_ROOT, target.dir)
      if (!existsSync(absDir)) {
        log('WARN', 'merge_scan_dir_missing', { dir: target.dir })
        continue
      }

      const files = this.findTargetFiles(absDir, target.pattern)
      for (const file of files) {
        const relPath = relative(PROJECT_ROOT, file)
        const content = readFileSync(file, 'utf-8')
        const lines = content.split('\n')

        const patterns = MODULE_FUNCTION_PATTERNS[target.module]
        if (!patterns) continue

        for (const fp of patterns) {
          const match = content.match(fp.pattern)
          if (match) {
            // 定位行号
            const prefix = content.slice(0, match.index!)
            const lineNum = prefix.split('\n').length

            // 判断是否已集成（在 telegram 代码中查找引用）
            const alreadyIntegrated = this.checkIntegration(
              fp.description,
              target.module,
            )

            allFunctions.push({
              name: fp.description,
              module: target.module,
              file: relPath,
              line: lineNum,
              description: fp.description,
              category: fp.category,
              dependencies: this.extractDependencies(lines, lineNum),
              alreadyIntegrated,
            })
          }
        }
      }
    }

    // 2. 分析合并缺口
    const gaps = this.analyzeGaps(allFunctions)
    allGaps.push(...gaps)

    // 3. 计算集成度评分
    const integrationScore = this.computeIntegrationScore(allFunctions)

    const result: MergeScanResult = {
      scannedFunctions: allFunctions,
      gaps: allGaps,
      scanTimestamp: Date.now(),
      sourceModules: ['startup-radar', 'radar-tools', 'telegram-service', 'message-gateway'],
      integrationScore,
    }

    this.lastScanResult = result
    this.cacheValid = true

    log('INFO', 'merge_scan_complete', {
      functions: allFunctions.length,
      gaps: allGaps.length,
      integrationScore,
      notIntegrated: allFunctions.filter(f => !f.alreadyIntegrated).length,
    })

    return result
  }

  // ═════════════════════════════════════════
  //  内部方法
  // ═════════════════════════════════════════

  /**
   * 查找匹配模式的目标文件。
   */
  private findTargetFiles(absDir: string, pattern: RegExp): string[] {
    const entries = readdirSync(absDir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) {
        files.push(join(absDir, entry.name))
      }
    }
    // 也检查 __tests__ 子目录
    const testDir = join(absDir, '__tests__')
    if (existsSync(testDir)) {
      for (const entry of readdirSync(testDir, { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name)) {
          files.push(join(testDir, entry.name))
        }
      }
    }
    return files.sort()
  }

  /**
   * 检查功能点是否已在 telegram 代码中集成引用。
   */
  private checkIntegration(functionDesc: string, sourceModule: SourceModule): boolean {
    // 如果函数本身就是 telegram 模块中的，标记为已集成
    if (sourceModule === 'telegram-service' || sourceModule === 'outbox-worker' || sourceModule === 'message-gateway') {
      return true
    }

    // 检查 telegram 代码是否引用了 radar
    try {
      const telegramDir = join(PROJECT_ROOT, 'src/main/telegram')
      if (!existsSync(telegramDir)) return false

      for (const file of readdirSync(telegramDir)) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue
        const content = readFileSync(join(telegramDir, file), 'utf-8')

        for (const ip of INTEGRATION_PATTERNS) {
          if (ip.pattern.test(content)) return true
        }
      }
    } catch {
      // 静默
    }

    return false
  }

  /**
   * 从文件内容中提取依赖（import 语句）。
   */
  private extractDependencies(lines: string[], functionLine: number): string[] {
    const deps: string[] = []
    const start = Math.max(0, functionLine - 20)
    const end = Math.min(lines.length, functionLine + 5)

    for (let i = start; i < end; i++) {
      const importMatch = lines[i].match(/import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/)
      if (importMatch) {
        deps.push(importMatch[1])
      }
    }
    return deps
  }

  /**
   * 分析合并缺口：对比 radar 功能和 telegram 集成状态。
   */
  private analyzeGaps(functions: ScannedFunction[]): MergeGap[] {
    const gaps: MergeGap[] = []
    let gapId = 0

    // 1. 检查 radar 模块的函数是否被 telegram 引用
    const radarFunctions = functions.filter(f =>
      f.module === 'startup-radar' || f.module === 'radar-tools' || f.module === 'radar-memory',
    )

    const notIntegrated = radarFunctions.filter(f => !f.alreadyIntegrated)
    for (const fn of notIntegrated) {
      // 确定缺口类型
      let gapType: MergeGap['type']
      switch (fn.category) {
        case 'fetch':
          gapType = 'function_integration'
          break
        case 'format':
          gapType = 'function_integration'
          break
        case 'push':
          gapType = 'event_handler_missing'
          break
        case 'event':
          gapType = 'event_handler_missing'
          break
        case 'analyze':
          gapType = 'function_integration'
          break
        case 'route':
          gapType = 'route_missing'
          break
        default:
          gapType = 'function_integration'
      }

      gaps.push({
        id: `mg_${++gapId}_${Date.now()}`,
        type: gapType,
        description: `集成 ${fn.module} 的 "${fn.description}" 到 telegram 推送系统`,
        sourceModule: fn.module,
        targetFile: 'src/main/telegram/TelegramService.ts',
        priority: fn.category === 'push' || fn.category === 'fetch' ? 4 : 3,
        estimatedChanges: [
          `在 TelegramService 中添加 ${fn.description} 的引用`,
          `在 ROUTING 表中添加 ${fn.module} 路由`,
        ],
        context: `${fn.file}:${fn.line} — ${fn.description} (${fn.module})`,
      })
    }

    // 2. 检查 routing 表是否有 radar 入口
    const hasRouteEntry = functions.some(f =>
      f.module === 'telegram-service' && f.description === '推送事件订阅入口',
    )
    if (!hasRouteEntry) {
      // 已经存在，不用添加
    }

    // 3. 检查是否有 radar 分类的定时推送任务
    const hasPeriodicScan = functions.some(f =>
      f.description === '雷达扫描入口' || f.description === '原始数据采集',
    )
    if (hasPeriodicScan) {
      // 检查 telegram 是否有定期调度
      const hasTelegramSchedule = functions.some(f =>
        f.module === 'telegram-service' && f.category === 'schedule',
      )
      if (hasTelegramSchedule) {
        gaps.push({
          id: `mg_${++gapId}_${Date.now()}`,
          type: 'periodic_task_missing',
          description: '添加定期雷达扫描→Telegram 推送任务',
          sourceModule: 'startup-radar',
          targetFile: 'src/main/telegram/TelegramService.ts',
          priority: 3,
          estimatedChanges: [
            '在 TelegramService 中添加雷达定时扫描逻辑',
            '扫描结果通过 formatBatchForTelegram 格式化后推送',
          ],
          context: 'startup-radar 已实现 scan() 和 formatBatchForTelegram()，但缺少定时触发机制',
        })
      }
    }

    // 4. 检查缺失的安全检查
    const telegramServiceFile = join(PROJECT_ROOT, 'src/main/telegram/TelegramService.ts')
    if (existsSync(telegramServiceFile)) {
      const content = readFileSync(telegramServiceFile, 'utf-8')
      if (!content.includes('radar_scan') && !content.includes('startupRadar')) {
        gaps.push({
          id: `mg_${++gapId}_${Date.now()}`,
          type: 'safety_check_missing',
          description: '为 radar 集成添加安全检查和错误处理',
          sourceModule: 'telegram-service',
          targetFile: 'src/main/telegram/TelegramService.ts',
          priority: 5,
          estimatedChanges: [
            '添加 radar 模块调用时的 try/catch 保护',
            '添加 fetch 超时控制',
            '添加降级策略（radar 不可用时静默跳过）',
          ],
          context: 'Microsoft 安全警示 #570: AI 生成的代码需注入安全检查',
        })
      }
    }

    return gaps
  }

  /**
   * 计算集成度评分 (0-100)。
   */
  private computeIntegrationScore(functions: ScannedFunction[]): number {
    const radarFuncs = functions.filter(f =>
      f.module === 'startup-radar' || f.module === 'radar-tools',
    )
    if (radarFuncs.length === 0) return 100

    const integrated = radarFuncs.filter(f => f.alreadyIntegrated).length
    return Math.round((integrated / radarFuncs.length) * 100)
  }
}
