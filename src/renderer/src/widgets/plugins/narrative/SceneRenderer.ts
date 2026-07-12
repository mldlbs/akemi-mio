/**
 * SceneRenderer — 语音叙事动态壁纸 Canvas 场景渲染引擎
 *
 * 使用 HTML5 Canvas 2D API 渲染场景背景、元素、粒子系统和过渡动画。
 * 每个场景由背景渐变、静态元素（树、城堡、山等）和粒子系统组成。
 *
 * 渲染循环：
 *   init() → 设置场景
 *   update(dt) → 更新粒子、过渡、效果
 *   render(ctx, w, h) → 绘制帧
 */

import type {
  SceneId,
  SceneVisualDefinition,
  SceneElement,
  ParticleSystemConfig,
  EffectType,
} from './types'

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
  life: number      // 剩余生命 (s)
  maxLife: number   // 总生命 (s)
  twinkle: boolean
  twinkleSpeed: number
  phase: number
  config: ParticleSystemConfig
}

// =============================================================================
// 过渡状态
// =============================================================================

interface TransitionState {
  active: boolean
  fromScene: SceneId | null
  toScene: SceneId
  progress: number       // 0 → 1, 1 = transition complete
  duration: number       // total transition duration (ms)
  elapsed: number        // elapsed time (ms)
}

// =============================================================================
// 效果实例（渲染管理器）
// =============================================================================

interface EffectInstance {
  type: EffectType
  particles: Particle[]
  config: ParticleSystemConfig
  elapsed: number
  duration: number | null   // null = unlimited (default effect)
  intensity: number
  active: boolean
}

// =============================================================================
// SceneRenderer
// =============================================================================

export class SceneRenderer {
  // 当前场景视觉定义
  private currentVisual: SceneVisualDefinition | null = null
  private previousVisual: SceneVisualDefinition | null = null

  // 粒子系统
  private particles: Particle[] = []
  private effects: EffectInstance[] = []

  // 过渡
  private transition: TransitionState = {
    active: false,
    fromScene: null,
    toScene: 'forest',
    progress: 1,
    duration: 800,
    elapsed: 0,
  }

  // 效果瞬态 ID 生成器
  private effectIdCounter = 0

  // 元素动画状态
  private elementAnimations: Map<string, number> = new Map()
  private time = 0

  // Canvas 尺寸
  private width = 0
  private height = 0

  // ===========================================================================
  // 初始化
  // ===========================================================================

  /**
   * 设置 Canvas 尺寸。
   */
  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  /**
   * 切换到新场景，开始过渡动画。
   */
  transitionTo(sceneVisual: SceneVisualDefinition, durationMs: number): void {
    this.previousVisual = this.currentVisual
    this.currentVisual = sceneVisual

    this.transition = {
      active: true,
      fromScene: this.previousVisual?.id ?? null,
      toScene: sceneVisual.id,
      progress: 0,
      duration: durationMs,
      elapsed: 0,
    }

    // 重置粒子系统
    this.particles = []

    // 设置默认效果
    this.setupDefaultEffects(sceneVisual)
  }

  /**
   * 触发瞬时动作效果。
   */
  triggerEffect(type: EffectType, intensity: number, durationMs: number): void {
    const config = this.getEffectConfig(type, intensity)
    if (!config) return

    this.effects.push({
      type,
      particles: [],
      config,
      elapsed: 0,
      duration: durationMs,
      intensity,
      active: true,
    })
  }

  /**
   * 停止所有瞬时动作效果（保留默认效果）。
   */
  clearActionEffects(): void {
    this.effects = this.effects.filter((e) => e.duration === null)
  }

  // ===========================================================================
  // 主循环
  // ===========================================================================

  /**
   * 更新所有动画状态。每帧调用一次。
   */
  update(dt: number): void {
    this.time += dt

    // ── 更新过渡 ──
    if (this.transition.active) {
      this.transition.elapsed += dt * 1000
      this.transition.progress = Math.min(1, this.transition.elapsed / this.transition.duration)
      if (this.transition.progress >= 1) {
        this.transition.active = false
        this.previousVisual = null
      }
    }

    // ── 更新粒子生成 ──
    this.updateParticles(dt)

    // ── 更新效果 ──
    this.updateEffects(dt)
  }

  /**
   * 渲染当前帧。
   */
  render(ctx: CanvasRenderingContext2D): void {
    if (!this.width || !this.height) return

    ctx.clearRect(0, 0, this.width, this.height)

    const t = this.transition

    if (t.active && this.previousVisual) {
      // ── 过渡中：渲染旧场景 + 新场景（叠化） ──
      ctx.save()
      ctx.globalAlpha = 1 - t.progress
      this.renderScene(ctx, this.previousVisual, 1)
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = t.progress
      this.renderScene(ctx, this.currentVisual!, t.progress)
      ctx.restore()
    } else if (this.currentVisual) {
      // ── 正常渲染 ──
      this.renderScene(ctx, this.currentVisual, 1)
    }

    // ── 渲染过渡中的效果叠加 ──
    this.renderEffects(ctx)
  }

  /**
   * 重置全部状态。
   */
  reset(): void {
    this.currentVisual = null
    this.previousVisual = null
    this.particles = []
    this.effects = []
    this.transition = {
      active: false,
      fromScene: null,
      toScene: 'forest',
      progress: 1,
      duration: 800,
      elapsed: 0,
    }
    this.elementAnimations.clear()
    this.time = 0
  }

  // ===========================================================================
  // 场景渲染
  // ===========================================================================

  private renderScene(ctx: CanvasRenderingContext2D, visual: SceneVisualDefinition, alpha: number): void {
    const w = this.width
    const h = this.height

    // 背景渐变
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, visual.backgroundTop)
    grad.addColorStop(1, visual.backgroundBottom)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    // 渲染元素
    for (const element of visual.elements) {
      this.renderElement(ctx, element, w, h, alpha, visual.id)
    }

    // 渲染粒子
    this.renderParticles(ctx, alpha)
  }

  // ===========================================================================
  // 元素渲染
  // ===========================================================================

  private renderElement(
    ctx: CanvasRenderingContext2D,
    element: SceneElement,
    w: number,
    h: number,
    alpha: number,
    sceneId: SceneId,
  ): void {
    const x = element.x * w
    const y = element.y * h
    const s = element.scale

    ctx.save()
    ctx.globalAlpha *= alpha

    switch (element.type) {
      case 'mountain':
        this.drawMountain(ctx, x, y, s, w)
        break
      case 'tree':
        this.drawTree(ctx, x, y, s, element.variant)
        break
      case 'castle':
        this.drawCastle(ctx, x, y, s)
        break
      case 'water':
        this.drawWater(ctx, x, y, s, w)
        break
      case 'cave_arch':
        this.drawCaveArch(ctx, x, y, s)
        break
      case 'torch':
        this.drawTorch(ctx, x, y, s)
        break
      case 'building':
        this.drawBuilding(ctx, x, y, s, element.color)
        break
      case 'rock':
        this.drawRock(ctx, x, y, s)
        break
      case 'window_glow':
        this.drawWindowGlow(ctx, x, y, s, element.color)
        break
    }

    ctx.restore()
  }

  // ── 绘制山脉 ──
  private drawMountain(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, w: number): void {
    ctx.beginPath()
    ctx.moveTo(0, y + 60 * scale)
    ctx.lineTo(x - 80 * scale, y + 60 * scale)
    ctx.lineTo(x, y - 40 * scale)
    ctx.lineTo(x + 80 * scale, y + 60 * scale)
    ctx.lineTo(w, y + 60 * scale)
    ctx.closePath()
    ctx.fillStyle = 'rgba(40, 50, 80, 0.5)'
    ctx.fill()
  }

  // ── 绘制树 ──
  private drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, variant?: number): void {
    const sway = Math.sin(this.time * 0.5 + x * 2) * 0.02

    // 树干
    ctx.fillStyle = variant === 1 ? '#3a2a1a' : '#2a1a0a'
    ctx.fillRect(x - 4 * scale, y - 20 * scale, 8 * scale, 40 * scale)

    // 树冠
    ctx.beginPath()
    ctx.ellipse(x + sway * 10, y - 30 * scale, 25 * scale, 20 * scale, 0, 0, Math.PI * 2)
    ctx.fillStyle = variant === 1 ? '#4a6a3a' : '#2a5a2a'
    ctx.fill()

    // 第二层树冠（更亮）
    ctx.beginPath()
    ctx.ellipse(x + sway * 8, y - 35 * scale, 18 * scale, 14 * scale, 0, 0, Math.PI * 2)
    ctx.fillStyle = variant === 1 ? '#5a7a4a' : '#3a6a3a'
    ctx.fill()
  }

  // ── 绘制城堡 ──
  private drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    const s = scale * 60
    ctx.fillStyle = '#3a3a4a'
    ctx.strokeStyle = '#4a4a5a'
    ctx.lineWidth = 2

    // 主楼
    ctx.fillRect(x - s * 0.4, y, s * 0.8, -s * 0.7)
    ctx.strokeRect(x - s * 0.4, y, s * 0.8, -s * 0.7)

    // 左塔
    ctx.fillRect(x - s * 0.55, y, s * 0.2, -s * 0.9)
    ctx.strokeRect(x - s * 0.55, y, s * 0.2, -s * 0.9)

    // 右塔
    ctx.fillRect(x + s * 0.35, y, s * 0.2, -s * 0.9)
    ctx.strokeRect(x + s * 0.35, y, s * 0.2, -s * 0.9)

    // 城垛
    for (let i = 0; i < 5; i++) {
      const cx = x - s * 0.35 + i * s * 0.18
      ctx.fillRect(cx, y - s * 0.7, s * 0.1, -s * 0.08)
    }

    // 塔顶尖
    ctx.beginPath()
    ctx.moveTo(x - s * 0.45, y - s * 0.9)
    ctx.lineTo(x - s * 0.35, y - s * 1.05)
    ctx.lineTo(x - s * 0.25, y - s * 0.9)
    ctx.fillStyle = '#5a3a2a'
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(x + s * 0.25, y - s * 0.9)
    ctx.lineTo(x + s * 0.35, y - s * 1.05)
    ctx.lineTo(x + s * 0.45, y - s * 0.9)
    ctx.fillStyle = '#5a3a2a'
    ctx.fill()

    // 大门
    ctx.fillStyle = '#1a1a2a'
    ctx.beginPath()
    ctx.ellipse(x, y - s * 0.1, s * 0.1, s * 0.18, 0, 0, Math.PI)
    ctx.fill()
  }

  // ── 绘制水面 ──
  private drawWater(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, w: number): void {
    const waveOffset = Math.sin(this.time * 0.8) * 2
    ctx.beginPath()
    ctx.moveTo(0, y)
    for (let i = 0; i <= w; i += 8) {
      const waveY = y + Math.sin(i * 0.03 + this.time * 1.5) * 3 * scale + waveOffset
      ctx.lineTo(i, waveY)
    }
    ctx.lineTo(w, y + 60 * scale)
    ctx.lineTo(0, y + 60 * scale)
    ctx.closePath()
    ctx.fillStyle = 'rgba(30, 60, 100, 0.4)'
    ctx.fill()
  }

  // ── 绘制洞穴拱门 ──
  private drawCaveArch(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    const s = scale * 60
    ctx.fillStyle = '#1a1a1a'

    // 拱形
    ctx.beginPath()
    ctx.ellipse(x, y, s * 0.8, s * 0.6, 0, 0, Math.PI)
    ctx.fill()

    // 洞穴内部（更暗）
    ctx.beginPath()
    ctx.ellipse(x, y + s * 0.05, s * 0.6, s * 0.45, 0, 0, Math.PI)
    ctx.fillStyle = '#0a0a0a'
    ctx.fill()

    // 岩壁纹理
    ctx.fillStyle = '#2a2a1a'
    ctx.beginPath()
    ctx.moveTo(x - s * 0.8, y + s * 0.1)
    ctx.lineTo(x - s * 0.7, y - s * 0.2)
    ctx.lineTo(x - s * 0.5, y + s * 0.1)
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(x + s * 0.5, y + s * 0.1)
    ctx.lineTo(x + s * 0.7, y - s * 0.2)
    ctx.lineTo(x + s * 0.8, y + s * 0.1)
    ctx.fill()
  }

  // ── 绘制火把 ──
  private drawTorch(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    const s = scale * 30
    const flicker = Math.sin(this.time * 8 + x * 10) * 0.3 + 0.7

    // 火把杆
    ctx.fillStyle = '#3a2a1a'
    ctx.fillRect(x - 2 * scale, y, 4 * scale, s * 1.2)

    // 火焰
    const flameHeight = s * 0.5 * flicker
    const flameWidth = s * 0.25 * (0.8 + Math.sin(this.time * 6 + x * 5) * 0.2)

    ctx.beginPath()
    ctx.ellipse(x, y - flameHeight * 0.5, flameWidth, flameHeight * 0.5, 0, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, ${150 + Math.sin(this.time * 10) * 50}, 50, ${0.6 * flicker})`
    ctx.fill()

    // 内焰
    ctx.beginPath()
    ctx.ellipse(x, y - flameHeight * 0.4, flameWidth * 0.5, flameHeight * 0.3, 0, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, ${150 + Math.sin(this.time * 12) * 50}, ${0.8 * flicker})`
    ctx.fill()

    // 发光
    const glow = ctx.createRadialGradient(x, y - s * 0.3, 0, x, y - s * 0.3, s * 0.8)
    glow.addColorStop(0, `rgba(255, 200, 100, ${0.15 * flicker})`)
    glow.addColorStop(1, 'rgba(255, 200, 100, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6)
  }

  // ── 绘制建筑 ──
  private drawBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, color?: string): void {
    const s = scale * 50
    ctx.fillStyle = color || '#3a3a2a'
    ctx.fillRect(x - s * 0.4, y - s * 0.6, s * 0.8, s * 0.6)

    // 屋顶
    ctx.beginPath()
    ctx.moveTo(x - s * 0.45, y - s * 0.6)
    ctx.lineTo(x, y - s * 0.85)
    ctx.lineTo(x + s * 0.45, y - s * 0.6)
    ctx.closePath()
    ctx.fillStyle = '#4a3a2a'
    ctx.fill()

    // 窗户
    ctx.fillStyle = '#2a2a3a'
    ctx.fillRect(x - s * 0.2, y - s * 0.5, s * 0.12, s * 0.15)
    ctx.fillRect(x + s * 0.08, y - s * 0.5, s * 0.12, s * 0.15)
  }

  // ── 绘制岩石 ──
  private drawRock(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    const s = scale * 25
    ctx.beginPath()
    ctx.ellipse(x, y, s, s * 0.7, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#3a3a3a'
    ctx.fill()

    // 高光
    ctx.beginPath()
    ctx.ellipse(x - s * 0.2, y - s * 0.2, s * 0.3, s * 0.2, -0.3, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(80, 80, 80, 0.3)'
    ctx.fill()
  }

  // ── 绘制发光窗户 ──
  private drawWindowGlow(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, color?: string): void {
    const s = scale * 15
    const pulse = Math.sin(this.time * 1.5 + x * 3) * 0.15 + 0.85
    const c = color || '#ffcc44'

    ctx.fillStyle = c
    ctx.globalAlpha *= 0.6 * pulse
    ctx.fillRect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6)

    // 发光
    ctx.globalAlpha = 1
    const glow = ctx.createRadialGradient(x, y, 0, x, y, s * 1.5)
    glow.addColorStop(0, `${c}${Math.round(40 * pulse).toString(16).padStart(2, '0')}`)
    glow.addColorStop(1, `${c}00`)
    ctx.fillStyle = glow
    ctx.fillRect(x - s * 2, y - s * 2, s * 4, s * 4)
  }

  // ===========================================================================
  // 粒子系统
  // ===========================================================================

  private updateParticles(dt: number): void {
    const config = this.currentVisual?.particles
    if (!config) return

    // 生成新粒子
    if (this.particles.length < config.maxCount) {
      const spawnCount = Math.min(
        Math.ceil(config.rate * dt),
        config.maxCount - this.particles.length,
      )
      for (let i = 0; i < spawnCount; i++) {
        this.particles.push(this.createParticle(config))
      }
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

      if (p.config.gravity) {
        p.vy += p.config.gravityForce * dt
      }

      // 生命周期透明度
      const lifeRatio = p.life / p.maxLife
      p.opacity = (p.config.opacity[0] + (p.config.opacity[1] - p.config.opacity[0]) * lifeRatio) *
        (p.twinkle ? (0.5 + 0.5 * Math.sin(this.time * p.twinkleSpeed + p.phase)) : 1)

      // 边界检查
      if (p.y > this.height + 10 || p.y < -10 || p.x > this.width + 10 || p.x < -10) {
        this.particles.splice(i, 1)
      }
    }
  }

  private createParticle(config: ParticleSystemConfig): Particle {
    const angle = config.direction + (Math.random() - 0.5) * config.spread
    const speed = config.speed * (0.5 + Math.random())

    return {
      x: Math.random() * this.width,
      y: config.gravity ? -5 : Math.random() * this.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: config.size[0] + Math.random() * (config.size[1] - config.size[0]),
      color: config.color,
      opacity: config.opacity[0],
      life: config.lifetime * (0.5 + Math.random()),
      maxLife: config.lifetime,
      twinkle: config.twinkle,
      twinkleSpeed: 2 + Math.random() * 4,
      phase: Math.random() * Math.PI * 2,
      config,
    }
  }

  private renderParticles(ctx: CanvasRenderingContext2D, alpha: number): void {
    for (const p of this.particles) {
      ctx.save()
      ctx.globalAlpha = p.opacity * alpha

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
      ctx.fillStyle = p.color
      ctx.fill()

      ctx.restore()
    }
  }

  // ===========================================================================
  // 效果系统
  // ===========================================================================

  private setupDefaultEffects(visual: SceneVisualDefinition): void {
    // 清除旧效果
    this.effects = []

    // 添加默认效果（无限期）
    for (const e of visual.defaultEffects ?? []) {
      const config = this.getEffectConfig(e, 1.0)
      if (config) {
        this.effects.push({
          type: e,
          particles: [],
          config,
          elapsed: 0,
          duration: null, // null = 无限期
          intensity: 1.0,
          active: true,
        })
      }
    }
  }

  private updateEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]
      effect.elapsed += dt * 1000

      // 检查有限期效果是否过期
      if (effect.duration !== null && effect.elapsed >= effect.duration) {
        this.effects.splice(i, 1)
        continue
      }

      // 生成效果粒子
      if (effect.particles.length < effect.config.maxCount) {
        const spawnCount = Math.min(
          Math.ceil(effect.config.rate * dt * effect.intensity),
          effect.config.maxCount - effect.particles.length,
        )
        for (let j = 0; j < spawnCount; j++) {
          effect.particles.push(this.createEffectParticle(effect))
        }
      }

      // 更新效果粒子
      for (let j = effect.particles.length - 1; j >= 0; j--) {
        const p = effect.particles[j]
        p.life -= dt
        if (p.life <= 0) {
          effect.particles.splice(j, 1)
          continue
        }

        p.x += p.vx * dt
        p.y += p.vy * dt

        if (p.config.gravity) {
          p.vy += p.config.gravityForce * dt
        }

        const lifeRatio = p.life / p.maxLife
        p.opacity = (p.config.opacity[0] + (p.config.opacity[1] - p.config.opacity[0]) * lifeRatio) *
          (p.twinkle ? (0.5 + 0.5 * Math.sin(this.time * p.twinkleSpeed + p.phase)) : 1) *
          effect.intensity

        if (p.y > this.height + 10 || p.y < -10 || p.x > this.width + 10 || p.x < -10) {
          effect.particles.splice(j, 1)
        }
      }
    }
  }

  private createEffectParticle(effect: EffectInstance): Particle {
    const config = effect.config
    const angle = config.direction + (Math.random() - 0.5) * config.spread
    const speed = config.speed * (0.5 + Math.random()) * effect.intensity

    const startX: number =
      effect.type === 'rain' || effect.type === 'snow' || effect.type === 'leaves_falling'
        ? Math.random() * this.width
        : effect.type === 'sparkle'
          ? this.width * (0.2 + Math.random() * 0.6)
          : Math.random() * this.width

    const startY: number =
      effect.type === 'rain' || effect.type === 'snow' || effect.type === 'leaves_falling'
        ? -5
        : effect.type === 'sparkle'
          ? this.height * (0.2 + Math.random() * 0.6)
          : Math.random() * this.height

    return {
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: config.size[0] + Math.random() * (config.size[1] - config.size[0]),
      color: this.getEffectColor(effect.type, effect.intensity),
      opacity: config.opacity[0],
      life: config.lifetime * (0.3 + Math.random() * 0.7),
      maxLife: config.lifetime,
      twinkle: config.twinkle,
      twinkleSpeed: 3 + Math.random() * 5,
      phase: Math.random() * Math.PI * 2,
      config,
    }
  }

  private getEffectColor(type: EffectType, intensity: number): string {
    switch (type) {
      case 'rain': return `rgba(136, 153, 187, ${0.3 + intensity * 0.4})`
      case 'snow': return `rgba(255, 255, 255, ${0.5 + intensity * 0.5})`
      case 'fireflies': return `rgba(200, 230, 160, ${0.3 + intensity * 0.5})`
      case 'torchlight': return `rgba(255, 200, 100, ${0.2 + intensity * 0.3})`
      case 'sparkle': return `rgba(255, 215, 0, ${0.5 + intensity * 0.5})`
      case 'stars_twinkle': return `rgba(255, 255, 255, ${0.5 + intensity * 0.5})`
      case 'leaves_falling': return `rgba(180, 130, 60, ${0.4 + intensity * 0.4})`
      case 'bubbles': return `rgba(200, 230, 255, ${0.2 + intensity * 0.3})`
    }
  }

  private renderEffects(ctx: CanvasRenderingContext2D, globalAlpha: number = 1): void {
    for (const effect of this.effects) {
      if (!effect.active) continue
      for (const p of effect.particles) {
        ctx.save()
        ctx.globalAlpha = p.opacity * globalAlpha

        switch (effect.type) {
          case 'rain':
            ctx.strokeStyle = p.color
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05)
            ctx.stroke()
            break

          case 'snow':
          case 'bubbles':
          case 'leaves_falling':
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
            ctx.fillStyle = p.color
            ctx.fill()
            break

          case 'sparkle': {
            // 星形闪烁
            const sparkSize = p.size * (0.5 + Math.sin(this.time * 3 + p.phase) * 0.5)
            ctx.beginPath()
            ctx.arc(p.x, p.y, sparkSize, 0, Math.PI * 2)
            ctx.fillStyle = p.color
            ctx.fill()
            // 十字光晕
            ctx.strokeStyle = p.color
            ctx.lineWidth = 0.5
            ctx.beginPath()
            ctx.moveTo(p.x - sparkSize * 2, p.y)
            ctx.lineTo(p.x + sparkSize * 2, p.y)
            ctx.moveTo(p.x, p.y - sparkSize * 2)
            ctx.lineTo(p.x, p.y + sparkSize * 2)
            ctx.stroke()
            break
          }

          case 'fireflies':
          case 'stars_twinkle':
          case 'torchlight':
          default:
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
            ctx.fillStyle = p.color
            ctx.fill()
            break
        }

        ctx.restore()
      }
    }
  }

  // ===========================================================================
  // 效果配置
  // ===========================================================================

  private getEffectConfig(type: EffectType, intensity: number): ParticleSystemConfig | null {
    switch (type) {
      case 'rain':
        return {
          rate: Math.round(80 * intensity), maxCount: Math.round(300 * intensity),
          size: [0.5, 2], color: '#8899bb', lifetime: 2, opacity: [0.2, 0.5], speed: 200 * intensity,
          twinkle: false, gravity: true, gravityForce: 180 * intensity, direction: Math.PI / 2, spread: 0.3,
        }
      case 'snow':
        return {
          rate: Math.round(30 * intensity), maxCount: Math.round(150 * intensity),
          size: [1, 4], color: '#ffffff', lifetime: 6, opacity: [0.4, 0.9], speed: 60,
          twinkle: false, gravity: true, gravityForce: 40, direction: Math.PI / 2 + 0.3, spread: 0.5,
        }
      case 'fireflies':
        return {
          rate: Math.round(3 * intensity), maxCount: Math.round(20 * intensity),
          size: [1.5, 3.5], color: '#c8e6a0', lifetime: 5, opacity: [0.2, 0.6], speed: 15,
          twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 4,
        }
      case 'torchlight':
        return {
          rate: Math.round(2 * intensity), maxCount: Math.round(15 * intensity),
          size: [1, 3], color: '#ffcc66', lifetime: 4, opacity: [0.3, 0.6], speed: 10,
          twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 6,
        }
      case 'sparkle':
        return {
          rate: Math.round(20 * intensity), maxCount: Math.round(60 * intensity),
          size: [1, 3], color: '#ffd700', lifetime: 2, opacity: [0.6, 1.0], speed: 30,
          twinkle: false, gravity: true, gravityForce: -20, direction: -Math.PI / 2, spread: Math.PI,
        }
      case 'stars_twinkle':
        return {
          rate: Math.round(3 * intensity), maxCount: Math.round(50 * intensity),
          size: [0.5, 2], color: '#ffffff', lifetime: 8, opacity: [0.4, 1.0], speed: 0,
          twinkle: true, gravity: false, gravityForce: 0, direction: 0, spread: Math.PI * 2,
        }
      case 'leaves_falling':
        return {
          rate: Math.round(5 * intensity), maxCount: Math.round(30 * intensity),
          size: [3, 6], color: '#b4823c', lifetime: 5, opacity: [0.5, 0.8], speed: 40,
          twinkle: false, gravity: true, gravityForce: 25, direction: Math.PI / 2 + 0.5, spread: 0.8,
        }
      case 'bubbles':
        return {
          rate: Math.round(4 * intensity), maxCount: Math.round(20 * intensity),
          size: [2, 5], color: '#c8e6ff', lifetime: 3, opacity: [0.1, 0.4], speed: 25,
          twinkle: false, gravity: true, gravityForce: -15, direction: -Math.PI / 2, spread: Math.PI / 4,
        }
    }
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  isTransitioning(): boolean {
    return this.transition.active
  }

  getTransitionProgress(): number {
    return this.transition.progress
  }

  getCurrentSceneId(): SceneId | null {
    return this.currentVisual?.id ?? null
  }
}
