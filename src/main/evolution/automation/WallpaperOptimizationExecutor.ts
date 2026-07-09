/**
 * WallpaperOptimizationExecutor — 壁纸 CSS 优化执行器
 *
 * 接收 WallpaperCollector 检测到的问题，生成 CSS 修改方案并应用。
 * 修改后推送新样式到渲染进程实现热加载。
 *
 * 供 PipelineOrchestrator 在自动化管道的执行阶段调用。
 */

import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult, ProblemSource } from './types'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'

export class WallpaperOptimizationExecutor implements FixExecutor {
  readonly name = 'wallpaper-optimization'
  readonly source = 'runtime' as ProblemSource
  readonly supportedSources = ['runtime' as ProblemSource]
  readonly timeoutMs = 10_000

  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const t0 = Date.now()

    try {
      switch (problem.id) {
        case 'wp_high_code_opacity':
          return this.fixCodeOpacity(problem)
        case 'wp_hardcoded_colors':
          return this.fixHardcodedColors(problem)
        case 'wp_css_missing':
          return this.fixMissingCss(problem)
        default:
          return {
            problemId: problem.id,
            success: true,
            summary: `未知壁纸问题类型: ${problem.id}，已跳过`,
            durationMs: Date.now() - t0,
          }
      }
    } catch (err: any) {
      log('ERROR', 'wallpaper_executor_failed', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `壁纸优化失败: ${err.message}`,
        durationMs: Date.now() - t0,
        error: err.message,
      }
    }
  }

  // ==================== 具体修复逻辑 ====================

  /**
   * 降低编码状态的透明度
   */
  private async fixCodeOpacity(problem: AssignedProblem): Promise<FixResult> {
    const t0 = Date.now()
    const targetOpacity = '0.2'

    // 通过凭据配置来调整透明度，不直接修改 CSS 文件
    const { credentialsManager } = await import('../../credentials/CredentialsManager')
    credentialsManager.set('wp_code_opacity', targetOpacity)

    // 推送刷新通知
    this.notifyConfigRefresh()

    return {
      problemId: problem.id,
      success: true,
      summary: `已将编码状态透明度凭据调整为 ${targetOpacity}，壁纸将在下次加载时生效`,
      durationMs: Date.now() - t0,
      output: 'updated credential wp_code_opacity',
    }
  }

  /**
   * 将硬编码颜色提取为 CSS 变量
   */
  private async fixHardcodedColors(problem: AssignedProblem): Promise<FixResult> {
    const t0 = Date.now()
    const wallpaperCssPath = join(this.projectRoot, 'src', 'renderer', 'src', 'styles', 'wallpaper.css')

    if (!existsSync(wallpaperCssPath)) {
      return {
        problemId: problem.id,
        success: false,
        summary: '壁纸 CSS 文件不存在',
        durationMs: Date.now() - t0,
        error: 'file_not_found',
      }
    }

    let css = readFileSync(wallpaperCssPath, 'utf-8')

    // 提取所有 oklch 颜色值并尝试替换为 CSS 变量
    const colorVarMap: Record<string, string> = {
      'oklch(0 0 0 / 0.25)': 'var(--wp-bg-glass)',
      'oklch(0 0 0 / 0.3)': 'var(--wp-bg-glass-strong)',
      'oklch(0 0 0 / 0.2)': 'var(--wp-bg-glass-mid)',
      'oklch(1 0 0 / 0.08)': 'var(--wp-border-glass)',
      'oklch(1 0 0 / 0.06)': 'var(--wp-border-glass-light)',
      'oklch(1 0 0 / 0.04)': 'var(--wp-bg-glass-light)',
    }

    let replacementCount = 0
    for (const [oldColor, newVar] of Object.entries(colorVarMap)) {
      const escaped = oldColor.replace(/[()]/g, '\\$&')
      const regex = new RegExp(escaped, 'g')
      if (regex.test(css)) {
        css = css.replace(regex, newVar)
        replacementCount++
      }
    }

    if (replacementCount > 0) {
      // 添加 CSS 变量定义
      const varBlock = `\n/* ─── 壁纸优化变量（由进化系统生成） ─── */\n:root {\n  --wp-bg-glass: oklch(0 0 0 / 0.25);\n  --wp-bg-glass-strong: oklch(0 0 0 / 0.3);\n  --wp-bg-glass-mid: oklch(0 0 0 / 0.2);\n  --wp-border-glass: oklch(1 0 0 / 0.08);\n  --wp-border-glass-light: oklch(1 0 0 / 0.06);\n  --wp-bg-glass-light: oklch(1 0 0 / 0.04);\n}\n`

      // 插入到文件头部（在已有 :root 之后）
      const rootEnd = css.indexOf('}') + 1
      css = css.slice(0, rootEnd) + varBlock + css.slice(rootEnd)

      writeFileSync(wallpaperCssPath, css, 'utf-8')

      // 推送热重载
      this.notifyCssReload(css)
    }

    return {
      problemId: problem.id,
      success: true,
      summary: `替换了 ${replacementCount} 个硬编码颜色值为 CSS 变量`,
      durationMs: Date.now() - t0,
      output: `replaced ${replacementCount} hardcoded colors`,
    }
  }

  /**
   * 修复缺失的壁纸 CSS — 创建默认样式
   */
  private async fixMissingCss(problem: AssignedProblem): Promise<FixResult> {
    const t0 = Date.now()
    const wallpaperCssPath = join(this.projectRoot, 'src', 'renderer', 'src', 'styles', 'wallpaper.css')

    const defaultCss = `/* ═══════════════════════════════════════
   Behavior-Aware Wallpaper Overlay (生成)
   ═══════════════════════════════════════ */

:root {
  --wallpaper-overlay-opacity: 0.95;
  --wallpaper-transition-duration: 0.6s;
  --wallpaper-idle-text: oklch(0.98 0.002 12);
}

.wallpaper-overlay {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  will-change: opacity;
}
`

    writeFileSync(wallpaperCssPath, defaultCss, 'utf-8')

    return {
      problemId: problem.id,
      success: true,
      summary: '已生成默认壁纸 CSS 文件',
      durationMs: Date.now() - t0,
      output: `created ${wallpaperCssPath}`,
    }
  }

  // ==================== 辅助方法 ====================

  /** 通知渲染进程刷新配置 */
  private notifyConfigRefresh(): void {
    try {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send('wallpaper:config-refresh')
        }
      }
    } catch {
      // 窗口不存在时静默失败
    }
  }

  /** 通知渲染进程热重载 CSS */
  private notifyCssReload(css: string): void {
    try {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send('wallpaper:styles-updated', css)
        }
      }
    } catch {
      // 窗口不存在时静默失败
    }
  }
}
