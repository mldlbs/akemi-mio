/**
 * FictionalMemoryGenerator — 虚构初始记忆生成器
 *
 * 在对话记忆为空（新用户/首次使用）时，使用随机种子从性格特征池中选取
 * 3-5 个特征组合成一段虚构记忆文本，注入对话上下文作为角色暖启动。
 *
 * 特性：
 * - 基于用户 ID（工作区路径 hash）计算固定种子，保证同一用户初始化一致
 * - 20 组性格特征场景描述池
 * - 模板化文本生成
 * - 权重衰减：随真实记忆增加按比例降低虚构记忆权重
 */

import { createHash } from 'crypto'
import { createSeededRandom, randomInt } from '@akemi-mio/core/utils/random'
import { WORKSPACE_ROOT } from '@akemi-mio/core/config'

// ─── 性格特征池（20 组） ───

const TRAIT_POOL: Array<{ trait: string; scene: string }> = [
  { trait: '容易紧张', scene: '在轻音部练习贝斯时紧张得手指发抖' },
  { trait: '温柔体贴', scene: '给熬夜的朋友泡了一杯热茶，安静地陪在旁边' },
  { trait: '认真执着', scene: '反复练习同一段旋律直到深夜，手指都酸了' },
  { trait: '害羞内向', scene: '在众人面前说话时声音越来越小，脸红到耳根' },
  { trait: '善解人意', scene: '察觉到朋友心情不好，默默递过去一颗糖' },
  { trait: '喜欢安静', scene: '独自在音乐室角落看乐谱，享受午后的宁静' },
  { trait: '有点笨拙', scene: '第一次尝试做便当时把厨房弄得一团糟' },
  { trait: '热爱音乐', scene: '听到喜欢的旋律会不自觉地轻轻哼唱出来' },
  { trait: '珍惜友情', scene: '和朋友一起在放学后的茶会上分享点心，聊到天黑' },
  { trait: '偶尔固执', scene: '坚持要用自己的方式调音，即使花了比预想更长的时间' },
  { trait: '心思细腻', scene: '注意到朋友换了新发型，真诚地称赞很好看' },
  { trait: '容易感动', scene: '听到一首感人的歌曲时悄悄抹了抹眼角' },
  { trait: '责任感强', scene: '承担了文化祭的准备工作，熬夜制作装饰直到天亮' },
  { trait: '有点迷糊', scene: '早上匆忙出门结果穿了两只不一样的袜子' },
  { trait: '喜欢学习', scene: '在图书馆找到一本有趣的书，不知不觉坐了一下午' },
  { trait: '关心他人', scene: '发现同学生病后，主动帮忙做好了当天的值日' },
  { trait: '偶尔自卑', scene: '在音乐比赛中看到其他选手的表演后有些沮丧，但很快振作' },
  { trait: '勇敢面对', scene: '鼓起勇气在学园祭的舞台上独奏了一曲，收获满堂掌声' },
  { trait: '有点天然呆', scene: '把盐当成糖放进了曲奇面团里，烤出来的味道一言难尽' },
  { trait: '珍惜日常', scene: '认真记录每一天的小确幸，日记本已经写满了大半' },
]

// ─── 记忆模板 ───

const MEMORY_TEMPLATES = ['记得{TRAITS}。', '想起自己{TRAITS}。', '印象中，{TRAITS}。', '以前{TRAITS}。']

// ─── 连接词 ───

const CONNECTORS = ['，也', '，还', '，又']

// ─── 类型 ───

export interface FictionalMemoryResult {
  /** 虚构记忆文本 */
  text: string
  /** 被选中的性格特征 */
  selectedTraits: string[]
  /** 当前权重 (0-1)，随真实记忆增长而衰减 */
  weight: number
  /** 标记为虚构 */
  isFictional: true
}

// ─── 生成器 ───

export class FictionalMemoryGenerator {
  private seed: number
  private rng: ReturnType<typeof createSeededRandom>

  constructor(userId?: string) {
    // 根据用户 ID 计算固定种子，保证同一环境下初始化一致
    this.seed = this.hashUserId(userId || WORKSPACE_ROOT || 'akemi-mio-default')
    this.rng = createSeededRandom(this.seed)
  }

  /** 将用户 ID 字符串 hash 为 32-bit 种子 */
  private hashUserId(userId: string): number {
    const hash = createHash('sha256').update(userId, 'utf-8').digest('hex')
    // 取前 8 位 hex 作为 32-bit 种子
    return parseInt(hash.slice(0, 8), 16)
  }

  /**
   * 生成虚构初始记忆
   * @param traitCount 选取的特征数量 (3-5)，不传则随机
   */
  generate(traitCount?: number): FictionalMemoryResult {
    const count = traitCount ?? randomInt(this.rng, 3, 5)

    // 从特征池中随机选取（使用 seeded RNG 保证同一用户每次生成一致）
    const pool = [...TRAIT_POOL]
    const selected: typeof TRAIT_POOL = []
    const used = new Set<number>()

    while (selected.length < count && used.size < pool.length) {
      const idx = Math.floor(this.rng() * pool.length)
      if (!used.has(idx)) {
        used.add(idx)
        selected.push(pool[idx])
      }
    }

    // 组合场景描述：使用不同的连接词
    const scenes = selected
      .map((s, i) => {
        if (i === 0) return s.scene
        const connector = CONNECTORS[Math.floor(this.rng() * CONNECTORS.length)]
        return `${connector}${s.scene}`
      })
      .join('')

    // 选择模板
    const templateIdx = Math.floor(this.rng() * MEMORY_TEMPLATES.length)
    const template = MEMORY_TEMPLATES[templateIdx]
    const text = template.replace('{TRAITS}', scenes)

    return {
      text,
      selectedTraits: selected.map((s) => s.trait),
      weight: 1.0,
      isFictional: true,
    }
  }

  /**
   * 计算虚构记忆的当前权重
   * 真实记忆条目越多，虚构记忆权重越低。
   *
   * @param realMemoryCount 真实记忆条目数（不含虚构类型）
   * @param threshold 阈值，超过此数量权重归零（默认 10）
   * @returns 0-1 的权重值
   */
  static computeWeight(realMemoryCount: number, threshold = 10): number {
    if (realMemoryCount >= threshold) return 0
    return Math.max(0, 1 - realMemoryCount / threshold)
  }

  /** 暴露种子供调试和日志 */
  getSeed(): number {
    return this.seed
  }
}
