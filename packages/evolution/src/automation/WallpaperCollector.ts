/**
 * WallpaperCollector — 壁纸使用数据采集器
 *
 * 读取壁纸配置和使用数据，分析可优化项，
 * 生成墙纸优化建议（透明度偏好、颜色偏好、布局问题）。
 *
 * 供 PipelineOrchestrator 在自动化管道的采集阶段调用。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem, ProblemSource } from './types'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

export class WallpaperCollector implements SignalCollector {
  readonly name = 'wallpaper-collector'
  readonly source = 'runtime' as ProblemSource

  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  shouldRun(): boolean {
    return true
  }

  async collect(): Promise<Problem[]> {
    const problems: Problem[] = []
    const wallpaperCssPath = join(this.projectRoot, 'src', 'renderer', 'src', 'styles', 'wallpaper.css')

    // 1. 检查壁纸 CSS 是否存在
    if (!existsSync(wallpaperCssPath)) {
      problems.push({
        id: 'wp_css_missing',
        source: 'runtime',
        severity: 'warning',
        title: '壁纸 CSS 文件丢失',
        description: `壁纸样式文件不存在: ${wallpaperCssPath}`,
        file: wallpaperCssPath,
        estimatedCostChars: 100,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: { raw: 'wallpaper.css not found' },
      })
      return problems
    }

    // 2. 读取当前壁纸配置
    const cfg = this.readWallpaperConfig()

    // 3. 检测可优化的透明度配置
    if (cfg.codeOpacity !== undefined && cfg.codeOpacity > 0.4) {
      problems.push({
        id: 'wp_high_code_opacity',
        source: 'runtime',
        severity: 'info',
        title: '编码状态透明度偏高',
        description: `当前编码透明度 ${cfg.codeOpacity}，建议降低到 0.15~0.25 以减少编码时的视觉干扰`,
        file: wallpaperCssPath,
        estimatedCostChars: 200,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: `codeOpacity=${cfg.codeOpacity}`,
          snippet: '编码状态透明度可通过 wallpaper.css 或凭据 wp_code_opacity 调节',
          metadata: { currentValue: String(cfg.codeOpacity), suggestedRange: '0.15-0.25' },
        },
      })
    }

    // 4. 检测 CSS 文件中的硬编码颜色值（可优化为主题变量）
    try {
      const css = readFileSync(wallpaperCssPath, 'utf-8')
      const hardcodedColors = this.findHardcodedColors(css)
      if (hardcodedColors.length > 3) {
        problems.push({
          id: 'wp_hardcoded_colors',
          source: 'runtime',
          severity: 'info',
          title: '壁纸存在硬编码颜色值',
          description: `发现 ${hardcodedColors.length} 处硬编码颜色值，建议提取为 CSS 变量以便进化系统优化主题`,
          file: wallpaperCssPath,
          estimatedCostChars: hardcodedColors.length * 50,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: hardcodedColors.slice(0, 10).join('\n'),
            snippet: '硬编码颜色示例: ' + hardcodedColors.slice(0, 5).join(', '),
            metadata: { count: String(hardcodedColors.length) },
          },
        })
      }
    } catch {
      // 读取失败时跳过
    }

    // 5. 检查锁定状态 — 如果锁定则不生成优化建议
    const evoLocked = credentialsManager.get('wp_evo_locked') === 'true'
    if (evoLocked) {
      log('DEBUG', 'wallpaper_collector_skipped_locked', { reason: 'evolution locked' })
      return [] // 锁定状态不下发优化建议
    }

    return problems
  }

  // ==================== 辅助方法 ====================

  private readWallpaperConfig(): Record<string, any> {
    const get = (key: string, fallback?: number): number | undefined => {
      const v = credentialsManager.get(key)
      if (v === null || v === undefined) return fallback
      const n = parseFloat(v)
      return isNaN(n) ? fallback : n
    }

    return {
      enabled: credentialsManager.get('wp_enabled') !== 'false',
      idleOverlay: credentialsManager.get('wp_idle_overlay') !== 'false',
      adaptiveOpacity: credentialsManager.get('wp_adaptive_opacity') !== 'false',
      codeOpacity: get('wp_code_opacity'),
      fullscreenOpacity: get('wp_fullscreen_opacity'),
      idleOpacity: get('wp_idle_opacity'),
      normalOpacity: get('wp_normal_opacity'),
      evoLocked: credentialsManager.get('wp_evo_locked') === 'true',
    }
  }

  private findHardcodedColors(css: string): string[] {
    const colorPattern =
      /(color|background|border-color|background-color|border)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\s*\([^)]+\)|oklch\s*\([^)]+\))/g
    const matches = css.match(colorPattern)
    if (!matches) return []

    // 过滤掉已经是 CSS 变量的引用
    return matches.filter((m) => !m.includes('var('))
  }
}
