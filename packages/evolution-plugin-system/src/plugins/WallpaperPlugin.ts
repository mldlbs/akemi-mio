/**
 * WallpaperPlugin — 壁纸优化 Evolution 插件
 *
 * 实现 EvolutionPlugin 契约，将壁纸相关的检测和优化能力
 * 以插件形式接入 Evolution 系统。
 *
 * 内部委托给现有的 WallpaperCollector / WallpaperOptimizationExecutor，
 * 插件层只做适配，不重复实现领域逻辑。
 *
 * 注册方式：
 *   const loader = PluginServiceLoader.getInstance()
 *   loader.register(new WallpaperPlugin(projectRoot))
 *   await loader.loadAll()
 */

import type { EvolutionPlugin, EvolutionPluginManifest, PluginProblem, PluginFixResult } from '../types'
import { WallpaperCollector } from '@akemi-mio/evolution/automation/WallpaperCollector'
import { WallpaperOptimizationExecutor } from '@akemi-mio/evolution/automation/WallpaperOptimizationExecutor'
import type { AssignedProblem, ProblemSource } from '@akemi-mio/evolution/automation/types'
import { log } from '@akemi-mio/core/logger/Logger'

export class WallpaperPlugin implements EvolutionPlugin {
  readonly manifest: EvolutionPluginManifest = {
    name: 'wallpaper',
    version: '1.0.0',
    description: '壁纸优化插件 — 检测壁纸配置问题并自动优化 CSS',
    capabilities: ['collect', 'optimize'],
  }

  private collector: WallpaperCollector
  private executor: WallpaperOptimizationExecutor
  private _loaded = false

  constructor(projectRoot: string) {
    this.collector = new WallpaperCollector(projectRoot)
    this.executor = new WallpaperOptimizationExecutor(projectRoot)
  }

  isAvailable(): boolean {
    return this._loaded && this.executor.isAvailable()
  }

  async collect(): Promise<PluginProblem[]> {
    const problems = await this.collector.collect()
    return problems.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      severity: p.severity,
      file: p.file,
      line: p.line,
      estimatedCostChars: p.estimatedCostChars,
      context: {
        raw: p.context.raw,
        ...(p.context.snippet ? { snippet: p.context.snippet } : {}),
        ...(p.context.metadata ?? {}),
      },
    }))
  }

  async fix(problem: PluginProblem): Promise<PluginFixResult> {
    const t0 = Date.now()

    // 将 PluginProblem 适配为 AssignedProblem
    const assignedProblem: AssignedProblem = {
      id: problem.id,
      source: 'runtime' as ProblemSource,
      severity: problem.severity,
      title: problem.title,
      description: problem.description,
      file: problem.file,
      line: problem.line,
      estimatedCostChars: problem.estimatedCostChars,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      attempt: 1,
      assignedAt: Date.now(),
      context: {
        raw: problem.context.raw ?? '',
        snippet: problem.context.snippet,
        metadata: problem.context,
      },
    }

    const result = await this.executor.execute(assignedProblem)

    return {
      problemId: result.problemId,
      success: result.success,
      summary: result.summary,
      durationMs: result.durationMs,
      output: result.output,
      error: result.error,
    }
  }

  async onLoad(): Promise<void> {
    this._loaded = true
    log('INFO', 'wallpaper_plugin_loaded', { version: this.manifest.version })
  }

  async onUnload(): Promise<void> {
    this._loaded = false
    log('INFO', 'wallpaper_plugin_unloaded')
  }
}
