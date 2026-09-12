/**
 * VoiceVisualizer — 语音动态壁纸 Canvas 渲染引擎
 *
 * 使用 HTML5 Canvas 2D API 在壁纸层绘制实时语音可视化和情感粒子效果。
 * 支持三种可视化风格：spectrum（频谱柱状图）、ripple（声波涟漪）、particle（粒子律动）。
 *
 * 渲染循环：
 *   update(config, state) → 每帧更新可视化参数
 *   render(ctx, w, h) → 绘制帧
 */

import type { VoiceVisualizationState, VoiceWallpaperConfig, VisualStyle } from './types'

// =============================================================================
// 粒子实例
// =============================================================================

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  color: string
  opacity: number
  life: number
  maxLife: number
  twinkle: boolean
  twinkleSpeed: number
  phase: number
  /** 粒子类型：背景 / 律动 / 情感 */
  kind: 'ambient' | 'beat' | 'emotion'
}

// =============================================================================
// VoiceVisualizer
// =============================================================================

export class VoiceVisualizer {
  // Canvas 尺寸
  private width = 0
  private height = 0

  // 粒子系统
  private particles: Particle[] = []

  // 波形历史（用于 ripple 效果）
  private rippleHistory: number[] = []
  private rippleIndex = 0

  // 频谱历史（用于 spectrum 平滑）
  private smoothedFreq: Float32Array = new Float32Array(0)

  // 动画时间
  private time = 0

  // 上次能量值（用于变化检测）
  private lastEnergy = 0
  private beatPhase = 0

  // 情感过渡
  private currentColors = { primary: '#1a2a4a', secondary: '#0d1a2a', accent: '#4a8aff', highlight: '#7ab8ff' }
  private targetColors = { primary: '#1a2a4a', secondary: '#0d1a2a', accent: '#4a8aff', highlight: '#7ab8ff' }
  private colorTransition = 1 // 1 = complete

  // ===========================================================================
  // 初始化
  // ===========================================================================

  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  reset(): void {
    this.particles = []
    this.rippleHistory = []
    this.smoothedFreq = new Float32Array(0)
    this.time = 0
    this.lastEnergy = 0
    this.beatPhase = 0
  }

  // ===========================================================================
  // 更新循环（每帧调用）
  // ===========================================================================

  update(config: VoiceWallpaperConfig, state: VoiceVisualizationState): void {
    const dt = 0.016 // ~60fps 固定步长
    this.time += dt
    const { energy, freqData, colorScheme } = state

    // ── 情感色彩平滑过渡 ──
    this.updateColors(colorScheme, dt)

    // ── 更新波形平滑 ──
    this.updateFreqSmoothing(freqData, dt)

    // ── 更新粒子系统 ──
    if (config.showParticles) {
      this.updateParticles(dt, config, state)
    }

    // ── 检测鼓点/重音（能量快速上升） ──
    const energyDelta = energy - this.lastEnergy
    if (energyDelta > 0.15 && config.showParticles) {
      this.spawnBeatParticles(config, state)
    }
    this.lastEnergy = energy

    // ── 更新波形历史（用于 ripple 风格） ──
    if (config.style === 'ripple') {
      this.rippleHistory[this.rippleIndex % 64] = energy
      this.rippleIndex++
    }

    // ── 节拍相位 ──
    this.beatPhase += dt * (1 + energy * 3)
  }

  // ===========================================================================
  // 渲染
  // ===========================================================================

  render(ctx: CanvasRenderingContext2D, config: VoiceWallpaperConfig, state: VoiceVisualizationState): void {
    if (!this.width || !this.height) return

    const { isPlaying } = state
    const visible = config.triggerMode === 'always' || isPlaying
    if (!visible) {
      ctx.clearRect(0, 0, this.width, this.height)
      return
    }

    ctx.clearRect(0, 0, this.width, this.height)
    ctx.globalAlpha = config.opacity

    // ── 背景渐变（带情感色调） ──
    if (config.showGlow) {
      this.renderBackground(ctx, state)
    }

    // ── 波形可视化 ──
    if (config.showWaveform && isPlaying) {
      switch (config.style) {
        case 'spectrum':
          this.renderSpectrum(ctx, state, config)
          break
        case 'ripple':
          this.renderRipple(ctx, state, config)
          break
        case 'particle':
          this.renderParticleWave(ctx, state, config)
          break
      }
    }

    // ── 粒子系统 ──
    if (config.showParticles) {
      this.renderParticles(ctx)
    }

    ctx.globalAlpha = 1
  }

  // ===========================================================================
  // 背景渲染
  // ===========================================================================

  private renderBackground(ctx: CanvasRenderingContext2D, state: VoiceVisualizationState): void {
    const { primary, secondary } = this.currentColors
    const { energy } = state

    // 能量驱动背景光晕强度
    const glowIntensity = 0.3 + energy * 0.4

    const grad = ctx.createRadialGradient(this.width / 2, this.height / 2, 0, this.width / 2, this.height / 2, this.width * 0.7)
    grad.addColorStop(0, this.blendColor(primary, secondary, 0.3 + energy * 0.3))
    grad.addColorStop(0.5, secondary)
    grad.addColorStop(1, '#000000')

    ctx.fillStyle = grad
    ctx.globalAlpha = glowIntensity
    ctx.fillRect(0, 0, this.width, this.height)

    // 情感色调呼吸光晕
    const breathPulse = Math.sin(this.time * 0.5) * 0.1 + 0.9
    const emotionGlow = ctx.createRadialGradient(
      this.width * 0.3,
      this.height * 0.4,
      0,
      this.width * 0.3,
      this.height * 0.4,
      this.width * 0.5,
    )
    emotionGlow.addColorStop(0, `rgba(${this.hexToRgb(primary)}, ${0.05 * breathPulse * (0.5 + energy)})`)
    emotionGlow.addColorStop(1, 'rgba(0,0,0,0)')

    ctx.fillStyle = emotionGlow
    ctx.globalAlpha = 0.5
    ctx.fillRect(0, 0, this.width, this.height)
  }

  // ===========================================================================
  // 频谱柱状图
  // ===========================================================================

  private renderSpectrum(ctx: CanvasRenderingContext2D, state: VoiceVisualizationState, config: VoiceWallpaperConfig): void {
    const { accent, highlight } = this.currentColors
    const { energy } = state
    const sensitivity = config.sensitivity

    const freq = this.smoothedFreq
    if (freq.length === 0) return

    const barCount = Math.min(freq.length, 64)
    const barWidth = (this.width / barCount) * 0.8
    const barGap = (this.width / barCount) * 0.2
    const centerY = this.height * 0.6

    for (let i = 0; i < barCount; i++) {
      // 取对数映射让低频更明显
      const idx = Math.floor((i / barCount) * freq.length)
      let value = freq[idx] / 255
      value = Math.pow(value, 0.6) * sensitivity // gamma 映射
      value = Math.min(value, 1)

      const barHeight = value * this.height * 0.4
      const x = i * (barWidth + barGap) + barGap / 2

      // 从底部向上画
      const gradient = ctx.createLinearGradient(x, centerY, x, centerY - barHeight)
      gradient.addColorStop(0, accent)
      gradient.addColorStop(1, highlight)

      // 圆角矩形
      ctx.fillStyle = gradient
      ctx.globalAlpha = config.opacity * (0.5 + value * 0.5)

      this.roundRect(ctx, x, centerY - barHeight, barWidth, barHeight, 2)
      ctx.fill()
    }
  }

  // ===========================================================================
  // 声波涟漪
  // ===========================================================================

  private renderRipple(ctx: CanvasRenderingContext2D, state: VoiceVisualizationState, config: VoiceWallpaperConfig): void {
    const { accent, highlight } = this.currentColors
    const { energy } = state
    const cx = this.width / 2
    const cy = this.height * 0.55

    // 从中心扩散的波纹
    const rippleCount = 3
    for (let r = 0; r < rippleCount; r++) {
      const phase = (this.time * 2 + r * ((Math.PI * 2) / rippleCount)) % (Math.PI * 2)
      const radius = 30 + phase * ((this.width * 0.3) / (Math.PI * 2)) * (0.5 + energy * 0.5)
      const alpha = Math.max(0, 0.6 - phase / (Math.PI * 2)) * (0.3 + energy * 0.7)

      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.strokeStyle = highlight
      ctx.lineWidth = 1.5 + energy * 3
      ctx.globalAlpha = alpha * config.opacity
      ctx.stroke()
    }

    // 能量驱动的脉冲光晕
    const pulseRadius = 20 + energy * 60 * (0.8 + Math.sin(this.beatPhase) * 0.2)
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulseRadius)
    glow.addColorStop(
      0,
      `${accent}${Math.round(60 * energy)
        .toString(16)
        .padStart(2, '0')}`,
    )
    glow.addColorStop(
      0.5,
      `${accent}${Math.round(20 * energy)
        .toString(16)
        .padStart(2, '0')}`,
    )
    glow.addColorStop(1, `${accent}00`)
    ctx.fillStyle = glow
    ctx.globalAlpha = config.opacity * 0.6
    ctx.beginPath()
    ctx.arc(cx, cy, pulseRadius, 0, Math.PI * 2)
    ctx.fill()
  }

  // ===========================================================================
  // 粒子波动（particle 风格）
  // ===========================================================================

  private renderParticleWave(ctx: CanvasRenderingContext2D, state: VoiceVisualizationState, config: VoiceWallpaperConfig): void {
    const { accent, highlight } = this.currentColors
    const { energy } = state

    // 在屏幕底部绘制一条随语音波动的粒子线
    const pointCount = 40
    const spacing = this.width / pointCount
    const baseY = this.height * 0.7

    ctx.beginPath()
    ctx.moveTo(0, baseY)

    for (let i = 0; i <= pointCount; i++) {
      const x = i * spacing
      const freqIdx = Math.floor((i / pointCount) * this.smoothedFreq.length)
      const freqVal = this.smoothedFreq[freqIdx] ?? 0
      const wave = Math.sin(this.time * 3 + i * 0.3) * 5 * energy + (freqVal / 255) * 60 * energy * config.sensitivity
      const y = baseY - wave

      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    ctx.lineTo(this.width, this.height)
    ctx.lineTo(0, this.height)
    ctx.closePath()

    const grad = ctx.createLinearGradient(0, baseY - 40, 0, this.height)
    grad.addColorStop(
      0,
      `${accent}${Math.round(40 * energy)
        .toString(16)
        .padStart(2, '0')}`,
    )
    grad.addColorStop(
      0.5,
      `${accent}${Math.round(15 * energy)
        .toString(16)
        .padStart(2, '0')}`,
    )
    grad.addColorStop(1, `${accent}00`)
    ctx.fillStyle = grad
    ctx.globalAlpha = config.opacity * 0.5
    ctx.fill()
  }

  // ===========================================================================
  // 粒子系统
  // ===========================================================================

  private updateParticles(dt: number, config: VoiceWallpaperConfig, state: VoiceVisualizationState): void {
    const { energy } = state
    const maxParticles = Math.round(40 + energy * 60)

    // 生成环境粒子
    if (this.particles.length < maxParticles && Math.random() < 0.3) {
      this.particles.push(this.createAmbientParticle(config, state))
    }

    // 更新现有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life -= dt
      if (p.life <= 0) {
        this.particles.splice(i, 1)
        continue
      }

      p.x += p.vx * dt
      p.y += p.vy * dt

      // 生命周期透明度
      const lifeRatio = p.life / p.maxLife
      p.opacity = lifeRatio * (p.twinkle ? 0.5 + 0.5 * Math.sin(this.time * p.twinkleSpeed + p.phase) : 1)

      // 边界移除
      if (p.y > this.height + 10 || p.y < -10 || p.x > this.width + 10 || p.x < -10) {
        this.particles.splice(i, 1)
      }
    }
  }

  private createAmbientParticle(config: VoiceWallpaperConfig, state: VoiceVisualizationState): Particle {
    const { accent } = this.currentColors
    const { energy } = state

    return {
      x: Math.random() * this.width,
      y: this.height + 5,
      vx: (Math.random() - 0.5) * 20,
      vy: -(20 + Math.random() * 30 + energy * 40),
      size: 1 + Math.random() * 3,
      color: accent,
      opacity: 0.1,
      life: 3 + Math.random() * 4,
      maxLife: 7,
      twinkle: Math.random() > 0.5,
      twinkleSpeed: 1 + Math.random() * 3,
      phase: Math.random() * Math.PI * 2,
      kind: 'ambient',
    }
  }

  private spawnBeatParticles(config: VoiceWallpaperConfig, state: VoiceVisualizationState): void {
    const { highlight } = this.currentColors
    const { energy } = state
    const count = Math.round(3 + energy * 8)

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 80 + energy * 60
      this.particles.push({
        x: this.width / 2 + (Math.random() - 0.5) * 60,
        y: this.height * 0.6 + (Math.random() - 0.5) * 40,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 1.5 + Math.random() * 3,
        color: highlight,
        opacity: 0.7,
        life: 0.5 + Math.random() * 1.0,
        maxLife: 1.5,
        twinkle: true,
        twinkleSpeed: 5 + Math.random() * 5,
        phase: Math.random() * Math.PI * 2,
        kind: 'beat',
      })
    }
  }

  private renderParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      ctx.save()
      ctx.globalAlpha = p.opacity

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
      ctx.fillStyle = p.color
      ctx.fill()

      ctx.restore()
    }
  }

  // ===========================================================================
  // 工具方法
  // ===========================================================================

  private updateColors(
    colorScheme: {
      primaryColor: string
      secondaryColor: string
      accentColor: string
      highlightColor: string
    },
    dt: number,
  ): void {
    const { primaryColor, secondaryColor, accentColor, highlightColor } = colorScheme

    // 平滑过渡到目标颜色
    const lerpFactor = 1 - Math.exp(-dt * 2) // ~2s 过渡

    this.currentColors.primary = this.lerpColor(this.currentColors.primary, primaryColor, lerpFactor)
    this.currentColors.secondary = this.lerpColor(this.currentColors.secondary, secondaryColor, lerpFactor)
    this.currentColors.accent = this.lerpColor(this.currentColors.accent, accentColor, lerpFactor)
    this.currentColors.highlight = this.lerpColor(this.currentColors.highlight, highlightColor, lerpFactor)
  }

  private updateFreqSmoothing(freqData: Uint8Array, dt: number): void {
    if (freqData.length === 0) return

    if (this.smoothedFreq.length !== freqData.length) {
      this.smoothedFreq = new Float32Array(freqData.length)
      for (let i = 0; i < freqData.length; i++) {
        this.smoothedFreq[i] = freqData[i]
      }
      return
    }

    const smoothFactor = 1 - Math.exp(-dt * 8) // ~125ms smoothing
    for (let i = 0; i < freqData.length; i++) {
      this.smoothedFreq[i] += (freqData[i] - this.smoothedFreq[i]) * smoothFactor
    }
  }

  private lerpColor(a: string, b: string, t: number): string {
    const [ar, ag, ab] = this.hexToRgbArray(a)
    const [br, bg, bb] = this.hexToRgbArray(b)
    const r = Math.round(ar + (br - ar) * t)
    const g = Math.round(ag + (bg - ag) * t)
    const bl = Math.round(ab + (bb - ab) * t)
    return `rgb(${r}, ${g}, ${bl})`
  }

  private hexToRgbArray(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    if (!result) return [26, 42, 74] // fallback to default blue
    return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
  }

  private hexToRgb(hex: string): string {
    const [r, g, b] = this.hexToRgbArray(hex)
    return `${r}, ${g}, ${b}`
  }

  private blendColor(a: string, b: string, t: number): string {
    return this.lerpColor(a, b, t)
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }
}
