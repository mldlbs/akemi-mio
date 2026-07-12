/**
 * Voice Narrative Dynamic Wallpaper — 类型定义
 *
 * 定义语音叙事动态壁纸的场景、关键词映射、效果和状态类型。
 */

// =============================================================================
// 场景标识
// =============================================================================

/** 内置场景 ID */
export type SceneId =
  | 'forest'
  | 'castle'
  | 'beach'
  | 'stars'
  | 'cave'
  | 'lake'
  | 'rain'
  | 'snow'
  | 'sunset'
  | 'tavern'

// =============================================================================
// 效果标识
// =============================================================================

/** 叠加效果类型 */
export type EffectType =
  | 'rain'
  | 'snow'
  | 'fireflies'
  | 'torchlight'
  | 'sparkle'
  | 'stars_twinkle'
  | 'leaves_falling'
  | 'bubbles'

// =============================================================================
// 关键词 → 场景映射
// =============================================================================

/**
 * 场景映射条目。
 * 当 ASR 识别文本匹配 keywords 中的任意一个时触发场景切换。
 * compoundMatch 要求文本同时包含多个关键词。
 */
export interface SceneKeywordEntry {
  /** 目标场景 ID */
  sceneId: SceneId

  /** 触发关键词（任一匹配即触发） */
  keywords: string[]

  /**
   * 复合匹配：需要文本同时包含数组内所有关键词才触发。
   * 例如 ['森林', '下雨'] 要求文本同时包含"森林"和"下雨"。
   */
  compoundMatch?: string[][]

  /** 优先级（高值优先，冲突时高优先级获胜） */
  priority: number

  /** 叠加效果（场景切换后附加的效果） */
  effects?: EffectType[]

  /** 场景切换过渡持续时间（ms），默认 800 */
  transitionMs?: number
}

// =============================================================================
// 动作效果映射
// =============================================================================

/** 瞬时动作（非场景切换，触发特效） */
export interface ActionEffectEntry {
  /** 触发关键词 */
  keywords: string[]

  /** 触发的效果 */
  effects: EffectType[]

  /** 效果持续时长（ms） */
  durationMs: number

  /** 效果强度（0-1） */
  intensity: number
}

// =============================================================================
// 场景定义（渲染参数）
// =============================================================================

/**
 * 场景渲染参数。
 * 每个场景定义其 Canvas 渲染所需的颜色、粒子、形状参数。
 */
export interface SceneVisualDefinition {
  id: SceneId
  name: string

  // 背景
  backgroundTop: string    // CSS 颜色（渐变顶部）
  backgroundBottom: string // CSS 颜色（渐变底部）

  // 场景元素
  elements: SceneElement[]

  // 默认叠加效果
  defaultEffects?: EffectType[]

  // 粒子系统参数
  particles?: Partial<ParticleSystemConfig>
}

export interface SceneElement {
  type: 'mountain' | 'tree' | 'castle' | 'water' | 'cave_arch' | 'torch' | 'building' | 'rock' | 'window_glow'
  x: number     // 0-1 归一化 x 位置
  y: number     // 0-1 归一化 y 位置
  scale: number // 0.1-2 缩放
  color?: string
  variant?: number
}

export interface ParticleSystemConfig {
  /** 每秒生成粒子数 */
  rate: number
  /** 粒子最大数量 */
  maxCount: number
  /** 粒子速度 (px/s) */
  speed: number
  /** 粒子大小范围 [min, max] (px) */
  size: [number, number]
  /** 粒子颜色 */
  color: string
  /** 粒子生命周期 (s) */
  lifetime: number
  /** 粒子透明度范围 [min, max] */
  opacity: [number, number]
  /** 粒子运动方向角度 (弧度) */
  direction: number
  /** 粒子运动扩散角度 (弧度) */
  spread: number
  /** 是否受重力影响 */
  gravity: boolean
  /** 重力加速度 (px/s²) */
  gravityForce: number
  /** 粒子是否闪烁 */
  twinkle: boolean
}

// =============================================================================
// 场景运行时状态
// =============================================================================

export interface SceneRuntimeState {
  /** 当前场景 ID */
  currentScene: SceneId | null
  /** 上一个场景 ID */
  previousScene: SceneId | null
  /** 当前叠加效果列表 */
  activeEffects: EffectType[]
  /** 当前激活的瞬时动作效果 */
  activeActions: ActionEffectInstance[]
  /** 是否正在场景过渡中 */
  isTransitioning: boolean
  /** 过渡进度 (0-1) */
  transitionProgress: number
  /** 场景累积持续时长 (ms) */
  sceneDurationMs: number
  /** 场景匹配的原始文本 */
  matchedText: string | null
  /** 效果引擎活跃状态 */
  engineActive: boolean
}

export interface ActionEffectInstance {
  id: string
  type: EffectType
  startTime: number
  durationMs: number
  intensity: number
}

// =============================================================================
// IPC 事件负载
// =============================================================================

export interface NarrativeAsrPayload {
  text: string
  requestId: string
  timestamp: number
}

// =============================================================================
// 默认场景视觉定义
// =============================================================================

export const DEFAULT_SCENE_VISUALS: Record<SceneId, SceneVisualDefinition> = {
  forest: {
    id: 'forest',
    name: '森林',
    backgroundTop: '#1a3a2a',
    backgroundBottom: '#0d1f15',
    elements: [
      { type: 'tree', x: 0.15, y: 0.55, scale: 1.2 },
      { type: 'tree', x: 0.35, y: 0.60, scale: 1.0 },
      { type: 'tree', x: 0.55, y: 0.50, scale: 1.4 },
      { type: 'tree', x: 0.75, y: 0.58, scale: 1.1 },
      { type: 'tree', x: 0.90, y: 0.52, scale: 1.3 },
      { type: 'mountain', x: 0.50, y: 0.70, scale: 0.6 },
      { type: 'water', x: 0.50, y: 0.90, scale: 1.0 },
    ],
    defaultEffects: ['fireflies'],
    particles: {
      rate: 3,
      maxCount: 30,
      size: [1.5, 4],
      color: '#c8e6a0',
      lifetime: 6,
      opacity: [0.2, 0.6],
      speed: 20,
      twinkle: true,
      gravity: false,
      gravityForce: 0,
      direction: -Math.PI / 2,
      spread: Math.PI / 4,
    },
  },

  castle: {
    id: 'castle',
    name: '城堡',
    backgroundTop: '#1a1a3a',
    backgroundBottom: '#0d0d1a',
    elements: [
      { type: 'castle', x: 0.50, y: 0.55, scale: 1.0 },
      { type: 'torch', x: 0.30, y: 0.55, scale: 0.6 },
      { type: 'torch', x: 0.70, y: 0.55, scale: 0.6 },
      { type: 'window_glow', x: 0.45, y: 0.42, scale: 0.4 },
      { type: 'window_glow', x: 0.55, y: 0.42, scale: 0.4 },
      { type: 'mountain', x: 0.20, y: 0.75, scale: 0.4 },
      { type: 'mountain', x: 0.80, y: 0.75, scale: 0.5 },
    ],
    defaultEffects: ['torchlight', 'stars_twinkle'],
    particles: { rate: 2, maxCount: 20, size: [1, 3], color: '#ffcc66', lifetime: 4, opacity: [0.3, 0.7], speed: 10, twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 6 },
  },

  beach: {
    id: 'beach',
    name: '海滩',
    backgroundTop: '#1a4a6a',
    backgroundBottom: '#2a5a3a',
    elements: [
      { type: 'water', x: 0.50, y: 0.70, scale: 1.5 },
      { type: 'tree', x: 0.15, y: 0.60, scale: 0.8 },
      { type: 'tree', x: 0.08, y: 0.65, scale: 0.6 },
      { type: 'mountain', x: 0.70, y: 0.65, scale: 0.7 },
      { type: 'mountain', x: 0.85, y: 0.70, scale: 0.5 },
    ],
    defaultEffects: ['bubbles'],
    particles: { rate: 4, maxCount: 25, size: [1, 4], color: '#ffffff', lifetime: 5, opacity: [0.1, 0.4], speed: 30, twinkle: false, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 8 },
  },

  stars: {
    id: 'stars',
    name: '星空',
    backgroundTop: '#0a0a1a',
    backgroundBottom: '#1a0a2a',
    elements: [
      { type: 'mountain', x: 0.30, y: 0.80, scale: 0.5 },
      { type: 'mountain', x: 0.70, y: 0.75, scale: 0.6 },
      { type: 'water', x: 0.50, y: 0.92, scale: 0.8 },
    ],
    defaultEffects: ['stars_twinkle'],
    particles: { rate: 5, maxCount: 80, size: [0.5, 2.5], color: '#ffffff', lifetime: 8, opacity: [0.3, 1.0], speed: 0, twinkle: true, gravity: false, gravityForce: 0, direction: 0, spread: Math.PI * 2 },
  },

  cave: {
    id: 'cave',
    name: '洞穴',
    backgroundTop: '#0d0d0d',
    backgroundBottom: '#1a1a0a',
    elements: [
      { type: 'cave_arch', x: 0.50, y: 0.40, scale: 1.2 },
      { type: 'torch', x: 0.25, y: 0.55, scale: 0.5 },
      { type: 'torch', x: 0.75, y: 0.55, scale: 0.5 },
      { type: 'rock', x: 0.30, y: 0.78, scale: 0.4 },
      { type: 'rock', x: 0.65, y: 0.80, scale: 0.5 },
      { type: 'water', x: 0.50, y: 0.92, scale: 0.6 },
    ],
    defaultEffects: ['torchlight'],
    particles: { rate: 1, maxCount: 10, size: [1, 2], color: '#ff8844', lifetime: 3, opacity: [0.2, 0.5], speed: 8, twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 4 },
  },

  lake: {
    id: 'lake',
    name: '湖畔',
    backgroundTop: '#1a2a4a',
    backgroundBottom: '#0d1a2a',
    elements: [
      { type: 'water', x: 0.50, y: 0.55, scale: 2.0 },
      { type: 'tree', x: 0.10, y: 0.60, scale: 0.9 },
      { type: 'tree', x: 0.90, y: 0.58, scale: 1.0 },
      { type: 'mountain', x: 0.50, y: 0.65, scale: 0.8 },
      { type: 'window_glow', x: 0.10, y: 0.52, scale: 0.2 },
    ],
    defaultEffects: ['fireflies'],
    particles: { rate: 3, maxCount: 25, size: [1.5, 3.5], color: '#aaddff', lifetime: 5, opacity: [0.2, 0.5], speed: 15, twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 4 },
  },

  rain: {
    id: 'rain',
    name: '雨景',
    backgroundTop: '#2a2a3a',
    backgroundBottom: '#1a1a2a',
    elements: [
      { type: 'water', x: 0.50, y: 0.95, scale: 0.5 },
      { type: 'tree', x: 0.20, y: 0.60, scale: 0.7 },
      { type: 'tree', x: 0.80, y: 0.55, scale: 0.8 },
      { type: 'building', x: 0.50, y: 0.65, scale: 0.5 },
    ],
    defaultEffects: ['rain'],
    particles: { rate: 80, maxCount: 300, size: [0.5, 2], color: '#8899bb', lifetime: 2, opacity: [0.2, 0.5], speed: 200, twinkle: false, gravity: true, gravityForce: 180, direction: Math.PI / 2, spread: 0.3 },
  },

  snow: {
    id: 'snow',
    name: '雪景',
    backgroundTop: '#3a3a4a',
    backgroundBottom: '#2a2a3a',
    elements: [
      { type: 'tree', x: 0.15, y: 0.58, scale: 0.8, variant: 1 },
      { type: 'tree', x: 0.40, y: 0.55, scale: 1.0, variant: 1 },
      { type: 'tree', x: 0.70, y: 0.60, scale: 0.7, variant: 1 },
      { type: 'tree', x: 0.88, y: 0.56, scale: 0.9, variant: 1 },
      { type: 'mountain', x: 0.50, y: 0.80, scale: 0.5 },
      { type: 'building', x: 0.50, y: 0.70, scale: 0.4 },
    ],
    defaultEffects: ['snow', 'leaves_falling'],
    particles: { rate: 30, maxCount: 150, size: [1, 4], color: '#ffffff', lifetime: 6, opacity: [0.4, 0.9], speed: 60, twinkle: false, gravity: true, gravityForce: 40, direction: Math.PI / 2 + 0.3, spread: 0.5 },
  },

  sunset: {
    id: 'sunset',
    name: '日落',
    backgroundTop: '#4a2a1a',
    backgroundBottom: '#1a0d0d',
    elements: [
      { type: 'mountain', x: 0.30, y: 0.70, scale: 0.7 },
      { type: 'mountain', x: 0.70, y: 0.65, scale: 0.8 },
      { type: 'water', x: 0.50, y: 0.85, scale: 1.2 },
      { type: 'tree', x: 0.10, y: 0.60, scale: 0.6 },
      { type: 'tree', x: 0.90, y: 0.58, scale: 0.7 },
    ],
    defaultEffects: ['fireflies'],
    particles: { rate: 2, maxCount: 15, size: [2, 5], color: '#ffaa44', lifetime: 4, opacity: [0.1, 0.3], speed: 10, twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 6 },
  },

  tavern: {
    id: 'tavern',
    name: '酒馆',
    backgroundTop: '#2a1a0a',
    backgroundBottom: '#1a0d00',
    elements: [
      { type: 'building', x: 0.50, y: 0.55, scale: 0.9 },
      { type: 'window_glow', x: 0.38, y: 0.42, scale: 0.3, color: '#ffaa44' },
      { type: 'window_glow', x: 0.62, y: 0.42, scale: 0.3, color: '#ffaa44' },
      { type: 'window_glow', x: 0.50, y: 0.48, scale: 0.35, color: '#ffcc66' },
      { type: 'torch', x: 0.20, y: 0.60, scale: 0.5 },
      { type: 'torch', x: 0.80, y: 0.60, scale: 0.5 },
      { type: 'tree', x: 0.08, y: 0.65, scale: 0.5 },
      { type: 'tree', x: 0.92, y: 0.63, scale: 0.6 },
    ],
    defaultEffects: ['torchlight', 'fireflies'],
    particles: { rate: 3, maxCount: 20, size: [1.5, 3], color: '#ffcc66', lifetime: 4, opacity: [0.3, 0.6], speed: 12, twinkle: true, gravity: false, gravityForce: 0, direction: -Math.PI / 2, spread: Math.PI / 4 },
  },
}

// =============================================================================
// 默认关键词 → 场景映射表
// =============================================================================

export const DEFAULT_SCENE_KEYWORDS: SceneKeywordEntry[] = [
  // ── 森林场景（单关键词触发） ──
  { sceneId: 'forest', keywords: ['森林', '树林', '丛林', '林间', 'forest'], priority: 10 },
  // ── 森林 + 下雨复合触发 ──
  { sceneId: 'rain', keywords: ['下雨', '雨', 'rain'], compoundMatch: [['森林', '雨'], ['树林', '雨']], priority: 20, effects: ['rain'] },

  // ── 城堡场景 ──
  { sceneId: 'castle', keywords: ['城堡', '宫殿', '城', 'castle', '进入城堡'], priority: 10, effects: ['torchlight'] },
  // ── 城堡 + 下雨 → 雨城堡
  { sceneId: 'rain', keywords: [], compoundMatch: [['城堡', '雨'], ['城堡', '下雨']], priority: 25, effects: ['rain', 'torchlight'] },

  // ── 海滩/海洋场景 ──
  { sceneId: 'beach', keywords: ['海滩', '海边', '沙滩', '海洋', '大海', '海', 'sea', 'beach', 'ocean'], priority: 10 },

  // ── 星空场景 ──
  { sceneId: 'stars', keywords: ['星空', '星星', '星', 'star', '银河', '夜空'], priority: 10 },

  // ── 洞穴场景 ──
  { sceneId: 'cave', keywords: ['洞穴', '山洞', '洞窟', 'cave', '地下'], priority: 10 },

  // ── 湖畔场景 ──
  { sceneId: 'lake', keywords: ['湖', '湖畔', '湖边', 'lake', '池塘'], priority: 10 },

  // ── 雨景场景 ──
  { sceneId: 'rain', keywords: ['雨景', '雨天', '下雨', '雨水', 'rainy', '暴雨', '雷雨'], priority: 10, effects: ['rain'] },

  // ── 雪景场景 ──
  { sceneId: 'snow', keywords: ['雪', '雪景', '下雪', 'snow', '冬', '冰雪', '雪山'], priority: 10, effects: ['snow'] },

  // ── 日落场景 ──
  { sceneId: 'sunset', keywords: ['日落', '黄昏', '晚霞', '落日', 'sunset', 'dusk'], priority: 10 },

  // ── 酒馆场景 ──
  { sceneId: 'tavern', keywords: ['酒馆', '客栈', '酒吧', '旅店', 'tavern', 'inn'], priority: 10, effects: ['torchlight'] },
]

// =============================================================================
// 默认动作效果映射
// =============================================================================

export const DEFAULT_ACTION_EFFECTS: ActionEffectEntry[] = [
  { keywords: ['宝箱', '宝藏', '宝物', '打开宝箱'], effects: ['sparkle'], durationMs: 3000, intensity: 0.9 },
  { keywords: ['魔法', '法术', '施法', '释放'], effects: ['sparkle'], durationMs: 2000, intensity: 0.7 },
  { keywords: ['火把', '照明', '点亮', '蜡烛'], effects: ['torchlight'], durationMs: 4000, intensity: 0.8 },
  { keywords: ['落叶', '秋叶', '树叶'], effects: ['leaves_falling'], durationMs: 5000, intensity: 0.6 },
  { keywords: ['开门', '进门', '打开门', '推门'], effects: ['sparkle'], durationMs: 1500, intensity: 0.5 },
]

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 根据场景 ID 获取默认视觉定义。
 */
export function getSceneVisual(sceneId: SceneId): SceneVisualDefinition {
  return DEFAULT_SCENE_VISUALS[sceneId]
}

/**
 * 检查是否所有场景视觉定义都已配置。
 */
export function validateSceneVisuals(): SceneId[] {
  const missing: SceneId[] = []
  for (const id of Object.keys(DEFAULT_SCENE_VISUALS) as SceneId[]) {
    if (!DEFAULT_SCENE_VISUALS[id]) missing.push(id)
  }
  return missing
}
