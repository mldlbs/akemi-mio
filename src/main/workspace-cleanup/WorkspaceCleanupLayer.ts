/**
 * WorkspaceCleanupLayer — Plan:清理工作区 - 整理文件目录 上层增强层
 *
 * 职责：
 * - 以装饰器模式包裹 AgentService，不侵入其核心逻辑
 * - 在 Agent 执行前后插入预处理/后处理钩子
 * - 通过 feature flag 控制各增强特性的启用/禁用
 * - 提供工作区文件整理与统计分析默认实现
 *
 * 架构模式：与 IndustrialOdeLayer / UserBehaviorLayer 一致
 *   WorkspaceCleanupLayer
 *     ├── wraps AgentService (decorator pattern)
 *     ├── preProcess()  — 调用前预处理（检测意图、注入工作区统计）
 *     ├── postProcess() — 调用后后处理（自动整理、附加报告）
 *     └── feature flags → 控制哪些钩子生效
 *
 * 【模式抽取】
 * 通用逻辑已抽取到 core/patterns：
 * - HookChain / MapHookChain → 钩子链执行器
 * - FeatureFlagSet → 特性开关管理
 * - applyDefaults → 配置默认值合并
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join, relative, dirname } from 'path'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import {
  HookChain,
  MapHookChain,
  FeatureFlagSet,
  applyDefaults,
} from '../core/patterns'
import type {
  WorkspaceCleanupFeature,
  WorkspaceStats,
  CleanupResult,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  WorkspaceCleanupLayerConfig,
} from './types'
import { parseFeaturesFromEnv } from './types'

const DEFAULT_CONFIG: Partial<WorkspaceCleanupLayerConfig> = {
  debug: false,
}

/** 扫描排除的目录 */
const EXCLUDED_SCAN_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.claude',
  'dist', 'build', '.next', '.nuxt', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', '.vscode', '.idea',
])

export class WorkspaceCleanupLayer {
  /** 启用的 feature 集合（使用通用 FeatureFlagSet） */
  private features: FeatureFlagSet<WorkspaceCleanupFeature>

  /** 配置 */
  private config: Required<Pick<WorkspaceCleanupLayerConfig, 'debug'>>

  /** 预处理钩子链（使用通用 HookChain） */
  private preChain: HookChain<PreProcessContext>

  /** 后处理钩子链（使用通用 MapHookChain） */
  private postChain: MapHookChain<PostProcessContext, PostProcessResult>

  /** 上一次后处理结果缓存 */
  private lastPostResult: PostProcessResult | null = null

  /** 工作区根目录 */
  private workspaceRoot: string

  /** LLM 服务引用 */
  private llmService: { chatJson(prompt: string, opts?: unknown): Promise<unknown> } | null = null

  constructor(config?: WorkspaceCleanupLayerConfig) {
    this.features = new FeatureFlagSet<WorkspaceCleanupFeature>(config?.features ?? parseFeaturesFromEnv())
    this.config = applyDefaults(
      { debug: config?.debug ?? false },
      DEFAULT_CONFIG,
    ) as Required<Pick<WorkspaceCleanupLayerConfig, 'debug'>>
    this.workspaceRoot = config?.workspaceRoot ?? WORKSPACE.projects

    if (config?.llmService) {
      this.llmService = config.llmService
    }

    // 初始化钩子链
    this.preChain = new HookChain<PreProcessContext>({
      loggerName: 'workspace_cleanup_pre',
      debug: this.config.debug,
    })
    this.postChain = new MapHookChain<PostProcessContext, PostProcessResult>(
      {
        merge: this.mergePostResults.bind(this),
      },
      {
        loggerName: 'workspace_cleanup_post',
        debug: this.config.debug,
      },
    )

    if (config?.preHooks) {
      for (const hook of config.preHooks) {
        this.preChain.add(hook)
      }
    }
    if (config?.postHooks) {
      for (const hook of config.postHooks) {
        this.postChain.add(hook)
      }
    }

    if (this.features.size > 0) {
      log('INFO', 'workspace_cleanup_active', {
        features: this.features.getActive(),
        preHooks: this.preChain.size,
        postHooks: this.postChain.size,
        workspaceRoot: this.workspaceRoot,
        llmAvailable: !!this.llmService,
      })
    }
  }

  // ==================== Feature 查询 ====================

  /** 检查指定特性是否启用 */
  hasFeature(feature: WorkspaceCleanupFeature): boolean {
    return this.features.has(feature)
  }

  /** 获取当前启用的特性列表 */
  getActiveFeatures(): WorkspaceCleanupFeature[] {
    return this.features.getActive()
  }

  /** 获取最后的后处理结果 */
  getLastPostProcessResult(): PostProcessResult | null {
    return this.lastPostResult
  }

  /** 设置 LLM 服务引用 */
  setLlmService(service: { chatJson(prompt: string, opts?: unknown): Promise<unknown> }): void {
    this.llmService = service
    log('INFO', 'workspace_cleanup_llm_service_set')
  }

  // ==================== 钩子注册 ====================

  /** 注册预处理钩子 */
  addPreHook(hook: PreProcessHook): void {
    this.preChain.add(hook)
    log('INFO', 'workspace_cleanup_pre_hook_added', { total: this.preChain.size })
  }

  /** 注册后处理钩子 */
  addPostHook(hook: PostProcessHook): void {
    this.postChain.add(hook)
    log('INFO', 'workspace_cleanup_post_hook_added', { total: this.postChain.size })
  }

  // ==================== 预处理 ====================

  /**
   * 在 Agent 执行前调用。
   * 返回增强后的上下文（可被后续 hook 消费）。
   */
  async preProcess(ctx: PreProcessContext): Promise<PreProcessContext> {
    if (this.features.size === 0) return ctx

    // 使用通用 HookChain 执行，自动处理错误隔离
    const current = await this.preChain.execute(ctx)

    if (this.config.debug) {
      log('DEBUG', 'workspace_cleanup_pre_process_done', {
        needsCleanup: current.needsCleanup,
        hasStats: !!current.workspaceStats,
        textChanged: current.rawText !== current.processedText,
      })
    }

    return current
  }

  // ==================== 后处理 ====================

  /**
   * 在 Agent 执行后调用。
   * 返回增强后的结果。
   */
  async postProcess(ctx: PostProcessContext): Promise<PostProcessResult> {
    if (this.features.size === 0) {
      const empty: PostProcessResult = { text: ctx.rawReply, enhanced: false }
      this.lastPostResult = empty
      return empty
    }

    // 使用通用 MapHookChain 执行，自动处理结果合并与错误隔离
    const result = await this.postChain.execute(ctx)

    this.lastPostResult = result

    if (this.config.debug) {
      log('DEBUG', 'workspace_cleanup_post_process_done', {
        enhanced: result.enhanced,
        length: result.text.length,
        description: result.description,
      })
    }

    return result
  }

  /**
   * 合并后处理结果（供 MapHookChain 使用的合并策略）
   * WorkspaceCleanup 特有：extraData 需要深度合并
   */
  private mergePostResults(base: PostProcessResult, incoming: Partial<PostProcessResult>): PostProcessResult {
    return {
      text: incoming.text ?? base.text ?? '',
      enhanced: incoming.enhanced ?? base.enhanced ?? false,
      description: incoming.description ?? base.description,
      extraData: { ...(base.extraData ?? {}), ...(incoming.extraData ?? {}) },
    }
  }

  // ==================== 扫描工具 ====================

  /**
   * 扫描工作区并返回统计信息。
   * 递归遍历 projects 目录，收集文件分布统计。
   */
  private scanWorkspace(): WorkspaceStats {
    const startTime = Date.now()
    const totalFiles: string[] = []
    const byExtension: Record<string, number> = {}
    const byTopDir: Record<string, number> = {}
    const rootLevelFiles: string[] = []
    const largeFiles: { name: string; sizeKB: number }[] = []
    const allDirs = new Set<string>()

    const scanDir = (dirPath: string, depth: number): void => {
      let entries: string[]
      try {
        entries = readdirSync(dirPath)
      } catch {
        return
      }

      const dirName = dirPath.split(/[/\\]/).pop() || ''
      if (depth > 0 && EXCLUDED_SCAN_DIRS.has(dirName)) return

      let hasFiles = false
      for (const entry of entries) {
        const fullPath = join(dirPath, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            allDirs.add(fullPath)
            scanDir(fullPath, depth + 1)
          } else if (stat.isFile()) {
            hasFiles = true
            totalFiles.push(fullPath)

            const ext = (entry.includes('.') ? entry.split('.').pop()?.toLowerCase() : '') || '(no ext)'
            byExtension[ext] = (byExtension[ext] || 0) + 1

            const relPath = relative(this.workspaceRoot, fullPath)
            const topDir = relPath.split(/[/\\]/)[0] || '(root)'
            byTopDir[topDir] = (byTopDir[topDir] || 0) + 1

            if (depth === 1) {
              rootLevelFiles.push(entry)
            }

            const sizeKB = Math.round(stat.size / 1024)
            if (sizeKB > 100) {
              largeFiles.push({ name: relPath, sizeKB })
            }
          }
        } catch {
          // skip inaccessible entries
        }
      }

      // 记录目录（如果目录为空，hasFiles 为 false）
      if (!hasFiles && depth > 0) {
        // empty dir — will be detected via set diff
      }
    }

    if (existsSync(this.workspaceRoot)) {
      scanDir(this.workspaceRoot, 0)
    }

    // 找出空目录：所有已记录的目录中，其路径不在任何文件路径前缀中的
    const fileDirs = new Set(totalFiles.map((f) => {
      const d = dirname(relative(this.workspaceRoot, f))
      return d !== '.' ? d : ''
    }))
    const emptyDirs: string[] = []
    for (const dirPath of allDirs) {
      const relDir = relative(this.workspaceRoot, dirPath)
      if (relDir && !fileDirs.has(relDir)) {
        emptyDirs.push(relDir)
      }
    }

    // 排序大文件（按大小降序）
    largeFiles.sort((a, b) => b.sizeKB - a.sizeKB)

    log('INFO', 'workspace_cleanup_scan_done', {
      totalFiles: totalFiles.length,
      totalDirs: allDirs.size,
      emptyDirs: emptyDirs.length,
      largeFiles: largeFiles.length,
      durationMs: Date.now() - startTime,
    })

    return {
      totalFiles: totalFiles.length,
      totalDirs: allDirs.size,
      byExtension,
      byTopDir,
      rootLevelFiles,
      largeFiles: largeFiles.slice(0, 20), // 最多返回 20 个大文件
      emptyDirs,
      scannedAt: Date.now(),
    }
  }

  // ==================== 默认钩子实现 ====================

  /**
   * 默认预处理钩子：意图检测。
   * 检测用户输入是否涉及工作区整理、文件组织、目录清理相关需求。
   */
  static createIntentDetectPreHook(): PreProcessHook {
    return async (ctx) => {
      const text = ctx.rawText.toLowerCase()

      // 中文关键词：工作区清理、文件整理、目录组织
      const cleanupKeywords = [
        '整理文件', '清理工作区', '组织目录', '文件归类',
        '整理目录', '工作区清理', '文件整理', '目录整理',
        '文件组织', '整理项目', '清理项目', '清理文件',
        '归类', '重新组织', '目录结构', '文件分布',
        'workspace clean', 'organize file', 'cleanup',
        'file organization', 'organize directory',
      ]

      const matched = cleanupKeywords.some((kw) => text.includes(kw))

      return {
        ...ctx,
        needsCleanup: matched,
      }
    }
  }

  /**
   * 默认预处理钩子：工作区统计注入。
   * 当检测到清理需求或 inject_stats 开启时，
   * 注入工作区文件统计数据到上下文中。
   */
  createInjectStatsPreHook(): PreProcessHook {
    // 使用箭头函数保留 this 引用
    return async (ctx) => {
      if (!ctx.needsCleanup && !this.features.has('inject_stats' as WorkspaceCleanupFeature)) {
        return ctx
      }

      const stats = this.scanWorkspace()

      // 生成统计摘要文本
      const statsSummary = this.formatStatsSummary(stats)

      return {
        ...ctx,
        workspaceStats: stats,
        processedText: `${ctx.rawText}\n\n【工作区状态】\n${statsSummary}`,
      }
    }
  }

  /**
   * 格式化统计信息为可读文本。
   */
  private formatStatsSummary(stats: WorkspaceStats): string {
    const lines: string[] = [
      `📁 工作区概览：${stats.totalFiles} 个文件，${stats.totalDirs} 个目录`,
    ]

    // 顶级目录分布
    if (Object.keys(stats.byTopDir).length > 0) {
      const topDirEntries = Object.entries(stats.byTopDir)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([dir, count]) => `  · ${dir === '(root)' ? '根目录' : dir}：${count} 个文件`)
      lines.push('')
      lines.push('按目录分布：')
      lines.push(...topDirEntries)
    }

    // 文件类型分布
    if (Object.keys(stats.byExtension).length > 0) {
      const extEntries = Object.entries(stats.byExtension)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([ext, count]) => `  · .${ext}：${count} 个文件`)
      lines.push('')
      lines.push('按文件类型：')
      lines.push(...extEntries)
    }

    // 根目录松散文件
    if (stats.rootLevelFiles.length > 0) {
      lines.push('')
      lines.push(`根目录松散文件（${stats.rootLevelFiles.length} 个）：`)
      lines.push(`  ${stats.rootLevelFiles.slice(0, 10).join(', ')}${stats.rootLevelFiles.length > 10 ? '...' : ''}`)
    }

    // 大文件
    if (stats.largeFiles.length > 0) {
      lines.push('')
      lines.push(`大文件（>100KB，${stats.largeFiles.length} 个）：`)
      for (const f of stats.largeFiles.slice(0, 5)) {
        lines.push(`  · ${f.name}（${f.sizeKB}KB）`)
      }
    }

    // 空目录
    if (stats.emptyDirs.length > 0) {
      lines.push('')
      lines.push(`空目录（${stats.emptyDirs.length} 个）`)
    }

    return lines.join('\n')
  }

  /**
   * 默认后处理钩子：扫描并报告。
   * 在 Agent 回复后立即扫描工作区并附加统计报告。
   */
  createScanAndReportPostHook(): PostProcessHook {
    return async (ctx) => {
      const stats = this.scanWorkspace()
      const summary = this.formatStatsSummary(stats)

      const report = `\n\n---\n📋 **工作区扫描报告**\n\n${summary}`

      return {
        text: ctx.rawReply + report,
        enhanced: true,
        description: '工作区扫描报告',
        extraData: { workspaceStats: stats },
      }
    }
  }

  /**
   * 默认后处理钩子：整理报告。
   * 当 auto_organize 开启且发生了清理操作时，附加整理报告。
   */
  static createCleanupReportPostHook(): PostProcessHook {
    return async (ctx) => {
      const cleanup = ctx.cleanupResult
      if (!cleanup || !cleanup.performed) {
        return { text: ctx.rawReply, enhanced: false }
      }

      const reportLines: string[] = [
        '',
        '---',
        `📦 **文件整理完成**`,
        '',
        `移动了 ${cleanup.movedCount} 个文件`,
        `耗时：${cleanup.durationMs}ms`,
      ]

      if (cleanup.changes.length > 0) {
        reportLines.push('')
        reportLines.push('变更详情：')
        for (const change of cleanup.changes.slice(0, 10)) {
          reportLines.push(`  · ${change.from} → ${change.to}`)
        }
        if (cleanup.changes.length > 10) {
          reportLines.push(`  ... 还有 ${cleanup.changes.length - 10} 项变更`)
        }
      }

      return {
        text: ctx.rawReply + reportLines.join('\n'),
        enhanced: true,
        description: `整理了 ${cleanup.movedCount} 个文件`,
        extraData: { cleanupResult: cleanup },
      }
    }
  }
}
