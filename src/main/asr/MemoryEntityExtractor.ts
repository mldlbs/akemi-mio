/**
 * MemoryEntityExtractor — 从 Memory 中提取命名实体的规则引擎
 *
 * 职责：
 * 从 MemoryService 存储的用户记忆条目和交互记录中，提取三类高频实体：
 * - 人名（persons）：用户提到的人，包括亲属称谓
 * - 项目名（projects）：用户提到的项目、系统、平台名称
 * - 地名（locations）：用户提到的地点
 *
 * 这些实体被注入 ASR 热词系统，提升语音识别对这些专有名词的准确率，
 * 实现"记忆唤醒语音热词"功能。
 *
 * 设计原则：
 * - 纯规则驱动：不依赖 LLM，在热路径上保持低延迟
 * - 增量学习：随着记忆积累自动发现新实体
 * - 频率加权：高频率实体会获得更高的热词优先级
 * - 可降级：无 Memory 或数据不足时返回空列表
 */

import type { MemoryEntry, InteractionRecord } from '../memory/types'
import { log } from '../logger/Logger'

// ══════════════════════════════════════════
//  命名实体类型
// ══════════════════════════════════════════

export type EntityCategory = 'person' | 'project' | 'location'

export interface ExtractedEntity {
  /** 实体名称 */
  name: string
  /** 实体分类 */
  category: EntityCategory
  /** 在记忆中出现次数 */
  frequency: number
  /** 最后出现时间戳 */
  lastSeenAt: number
}

// ══════════════════════════════════════════
//  中文姓氏表（常见百家姓）
// ══════════════════════════════════════════

const CHINESE_SURNAMES = new Set([
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗',
  '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧',
  '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕',
  '苏', '卢', '蒋', '蔡', '贾', '丁', '魏', '薛', '叶', '阎',
  '余', '潘', '杜', '戴', '夏', '钟', '汪', '田', '任', '姜',
  '范', '方', '石', '姚', '谭', '廖', '邹', '熊', '金', '陆',
  '郝', '孔', '白', '崔', '康', '毛', '邱', '秦', '江', '史',
  '顾', '侯', '邵', '孟', '龙', '万', '段', '漕', '钱', '汤',
  '尹', '黎', '易', '常', '武', '乔', '贺', '赖', '龚', '文',
])

/** 常见亲属/称谓/角色词 */
const KINSHIP_TERMS = new Set([
  '妈妈', '爸爸', '爷爷', '奶奶', '外公', '外婆', '姥爷', '姥姥',
  '哥哥', '姐姐', '弟弟', '妹妹', '大哥', '大姐', '老弟', '小妹',
  '老公', '老婆', '丈夫', '妻子', '媳妇', '女婿', '儿媳',
  '儿子', '女儿', '孩子', '小孩', '宝宝', '宝贝',
  '叔叔', '阿姨', '伯伯', '伯母', '舅舅', '舅妈', '姑姑', '姑父',
  '老师', '同学', '同事', '朋友', '老板', '领导', '经理',
  '客户', '顾客', '用户', '房东', '邻居',
  '医生', '护士', '律师', '司机',
])

/** 已知中文地名 */
const KNOWN_LOCATIONS = new Set([
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京',
  '重庆', '天津', '苏州', '西安', '长沙', '郑州', '东莞', '青岛',
  '沈阳', '宁波', '昆明', '大连', '厦门', '合肥', '佛山', '福州',
  '哈尔滨', '济南', '温州', '长春', '石家庄', '常州', '泉州',
  '南宁', '贵阳', '南昌', '太原', '烟台', '嘉兴', '南通', '金华',
  '珠海', '惠州', '徐州', '海口', '乌鲁木齐', '绍兴', '中山',
  '美国', '中国', '日本', '韩国', '英国', '法国', '德国', '意大利',
  '加拿大', '澳大利亚', '印度', '新加坡', '马来西亚', '泰国',
  '香港', '澳门', '台湾',
  '纽约', '伦敦', '东京', '巴黎', '柏林', '悉尼',
  '硅谷', '中关村', '陆家嘴', '西二旗',
])

/** 项目名常见后缀/前缀 */
const PROJECT_SUFFIXES = ['项目', '系统', '平台', '服务', '工具', '软件', '应用', '程序',
  '框架', '引擎', '模型', '协议', '接口', '版本', '组件', '模块', '网络',
  '项目组', '团队', '小组',
  'AI', 'OS', 'SDK', 'API', 'UI', 'UX',
]

const PROJECT_PREFIXES = ['新', '老', '旧', '大', '小', '微', '智能']

// ══════════════════════════════════════════
//  正则模式
// ══════════════════════════════════════════

/** 英文/数字项目名模式：大驼峰或全大写缩写 */
const PROJECT_EN_PATTERN = /[A-Z][a-z]+(?:[A-Z][a-z]+)+(?:\s+\d+(?:\.\d+)?)?/g
/** 引号包裹的项目名 */
const QUOTED_PROJECT_PATTERN = /[""「」『』【】]\s*([^"」』】]{2,30}?)\s*[""「」『』【】]/g
/** 项目名跟随动词/介词 */
const PROJECT_CONTEXT_PATTERN = /(?:在做|开发|维护|负责|参与|启动|叫|名为|叫做|称作|取名|代号)\s*(.{2,20})/g
/** 英文人名模式 */
const EN_NAME_PATTERN = /[A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*/g
/** 中文人名候选：姓氏+1-2字 */
const CN_NAME_PATTERN = /([王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段漕钱汤尹黎易常武乔贺赖龚文])([一-鿿]{1,2}(?:生|总|工|哥|姐|叔|姨|先生|女士|小姐)?)/g

// ══════════════════════════════════════════
//  上下文停用词
// ══════════════════════════════════════════

const CONTEXT_STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '这样', '那样', '这些', '那些',
  '这里', '那里', '他们', '她们', '它们', '因为', '所以', '但是',
  '然后', '而且', '或者', '如果', '虽然', '可以', '可能', '应该',
  '已经', '没有', '不是', '就是', '还是', '只是', '但是',
])

// ══════════════════════════════════════════
//  MemoryEntityExtractor
// ══════════════════════════════════════════

export class MemoryEntityExtractor {
  /** 内部实体频率表（内存态，不持久化） */
  private entityMap = new Map<string, ExtractedEntity>()

  /** 配置 */
  private minFrequency = 2 // 最少出现次数才视为有效实体
  private maxEntities = 50 // 最多跟踪的实体数

  constructor(minFrequency?: number, maxEntities?: number) {
    if (minFrequency !== undefined) this.minFrequency = minFrequency
    if (maxEntities !== undefined) this.maxEntities = maxEntities
  }

  // ══════════════════════════════════════════
  //  核心提取方法
  // ══════════════════════════════════════════

  /**
   * 从单条记忆条目中提取实体。
   * 返回提取到的实体列表（不去重，用于频率统计）。
   */
  extractFromEntry(entry: MemoryEntry): ExtractedEntity[] {
    const found: ExtractedEntity[] = []
    const now = Date.now()

    // 从 content 中提取实体
    const textEntities = this.extractFromText(entry.content, now)
    found.push(...textEntities)

    // 从 topics 中提取可能的项目名
    if (entry.topics) {
      for (const topic of entry.topics) {
        if (topic.length >= 3 && !CONTEXT_STOPWORDS.has(topic)) {
          // 话题标签可能是项目名缩写，给予低置信度标记
          // 不重复写入，后续在频率统计阶段处理
        }
      }
    }

    return found
  }

  /**
   * 从交互记录中提取实体。
   */
  extractFromInteraction(record: InteractionRecord): ExtractedEntity[] {
    return this.extractFromText(record.userText, record.timestamp)
  }

  /**
   * 从纯文本中提取实体。
   */
  extractFromText(text: string, timestamp: number = Date.now()): ExtractedEntity[] {
    if (!text || text.trim().length === 0) return []

    const found: ExtractedEntity[] = []
    const trimmed = text.trim()

    // 1. 提取亲属称谓
    for (const term of KINSHIP_TERMS) {
      if (trimmed.includes(term)) {
        found.push({ name: term, category: 'person', frequency: 1, lastSeenAt: timestamp })
      }
    }

    // 2. 提取中文人名（姓氏+名字）
    const cnNameMatches = trimmed.matchAll(CN_NAME_PATTERN)
    for (const match of cnNameMatches) {
      const fullName = match[0]
      const surname = match[1]
      if (CHINESE_SURNAMES.has(surname) && fullName.length >= 2 && fullName.length <= 4) {
        found.push({ name: fullName, category: 'person', frequency: 1, lastSeenAt: timestamp })
      }
    }

    // 3. 提取英文人名（两个以上大写开头的单词）
    const enNameMatches = trimmed.matchAll(EN_NAME_PATTERN)
    for (const match of enNameMatches) {
      const name = match[0]
      // 过滤掉句子开头的单词（误判）
      if (name.split(/\s+/).length >= 2 && name.length <= 30) {
        // 检查是否真的是人名（排除项目名等常见误判）
        if (!name.includes('.') && !name.includes('/') && !name.includes('_')) {
          found.push({ name, category: 'person', frequency: 1, lastSeenAt: timestamp })
        }
      }
    }

    // 4. 提取已知地名
    for (const loc of KNOWN_LOCATIONS) {
      if (trimmed.includes(loc)) {
        found.push({ name: loc, category: 'location', frequency: 1, lastSeenAt: timestamp })
      }
    }

    // 5. 提取引号包裹的项目名
    const quotedMatches = trimmed.matchAll(QUOTED_PROJECT_PATTERN)
    for (const match of quotedMatches) {
      const name = match[1].trim()
      if (name.length >= 2 && !CONTEXT_STOPWORDS.has(name)) {
        found.push({ name, category: 'project', frequency: 1, lastSeenAt: timestamp })
      }
    }

    // 6. 提取上下文暗示的项目名（在做xxx、开发xxx等）
    const contextMatches = trimmed.matchAll(PROJECT_CONTEXT_PATTERN)
    for (const match of contextMatches) {
      const name = match[1].trim()
      if (name.length >= 2 && name.length <= 20 && !CONTEXT_STOPWORDS.has(name)) {
        // 排除常见非项目词汇
        if (!this.isCommonWord(name)) {
          found.push({ name, category: 'project', frequency: 1, lastSeenAt: timestamp })
        }
      }
    }

    // 7. 提取英文驼峰项目名
    const enProjectMatches = trimmed.matchAll(PROJECT_EN_PATTERN)
    for (const match of enProjectMatches) {
      const name = match[0]
      if (name.length >= 3 && name.length <= 40) {
        found.push({ name, category: 'project', frequency: 1, lastSeenAt: timestamp })
      }
    }

    return found
  }

  // ══════════════════════════════════════════
  //  批量处理
  // ══════════════════════════════════════════

  /**
   * 从一组记忆条目中批量提取实体并更新频率统计。
   * 在 MemoryService 初始化或定期刷新时调用。
   *
   * @param entries 记忆条目列表
   * @param interactions 交互记录列表（可选）
   */
  feedEntries(
    entries: MemoryEntry[],
    interactions?: InteractionRecord[],
  ): void {
    const now = Date.now()

    // 1. 处理记忆条目
    for (const entry of entries) {
      const entities = this.extractFromEntry(entry)
      for (const e of entities) {
        this.incrementEntity(e.name, e.category, e.lastSeenAt || now)
      }
    }

    // 2. 处理交互记录
    if (interactions) {
      for (const record of interactions) {
        const entities = this.extractFromInteraction(record)
        for (const e of entities) {
          this.incrementEntity(e.name, e.category, record.timestamp || now)
        }
      }
    }

    // 3. 裁剪到上限
    this.pruneExcess()

    log('INFO', 'entity_extractor_fed', {
      entries: entries.length,
      interactions: interactions?.length ?? 0,
      totalEntities: this.entityMap.size,
      topPersons: this.getTopByCategory('person', 3).map(e => e.name),
      topProjects: this.getTopByCategory('project', 3).map(e => e.name),
      topLocations: this.getTopByCategory('location', 3).map(e => e.name),
    })
  }

  /**
   * 清除所有已提取实体（用于重置）。
   */
  clear(): void {
    this.entityMap.clear()
  }

  // ══════════════════════════════════════════
  //  查询接口
  // ══════════════════════════════════════════

  /**
   * 获取所有达到频率阈值的实体（供 ASR 热词注入）。
   *
   * @param minFreq 最低频率（覆盖默认值）
   * @returns 实体名称列表
   */
  getEntities(minFreq?: number): ExtractedEntity[] {
    const threshold = minFreq ?? this.minFrequency
    return Array.from(this.entityMap.values())
      .filter((e) => e.frequency >= threshold)
      .sort((a, b) => b.frequency - a.frequency)
  }

  /**
   * 获取所有达到频率阈值的实体名称列表（供 ASR 热词注入）。
   */
  getEntityNames(minFreq?: number): string[] {
    return this.getEntities(minFreq).map((e) => e.name)
  }

  /**
   * 获取指定分类的实体列表（按频率降序）。
   */
  getByCategory(category: EntityCategory, minFreq?: number): ExtractedEntity[] {
    return this.getEntities(minFreq).filter((e) => e.category === category)
  }

  /**
   * 获取指定分类的前 N 个实体名称。
   */
  getTopByCategory(category: EntityCategory, n: number): ExtractedEntity[] {
    return this.getByCategory(category)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, n)
  }

  /**
   * 获取所有实体的统计信息。
   */
  getStats(): {
    total: number
    persons: number
    projects: number
    locations: number
    topNames: string[]
  } {
    const all = Array.from(this.entityMap.values())
    return {
      total: all.length,
      persons: all.filter((e) => e.category === 'person').length,
      projects: all.filter((e) => e.category === 'project').length,
      locations: all.filter((e) => e.category === 'location').length,
      topNames: this.getEntityNames(1).slice(0, 10),
    }
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 增加一个实体的频率计数。
   */
  private incrementEntity(name: string, category: EntityCategory, timestamp: number): void {
    const key = `${category}:${name.toLowerCase()}`
    const existing = this.entityMap.get(key)

    if (existing) {
      existing.frequency++
      existing.lastSeenAt = Math.max(existing.lastSeenAt, timestamp)
    } else {
      this.entityMap.set(key, {
        name,
        category,
        frequency: 1,
        lastSeenAt: timestamp,
      })
    }
  }

  /**
   * 当实体数量超过上限时，移除频率最低的实体。
   */
  private pruneExcess(): void {
    if (this.entityMap.size <= this.maxEntities) return

    const sorted = Array.from(this.entityMap.entries())
      .sort((a, b) => a[1].frequency - b[1].frequency)

    const toRemove = sorted.slice(0, sorted.length - this.maxEntities)
    for (const [key] of toRemove) {
      this.entityMap.delete(key)
    }
  }

  /**
   * 判断词语是否为常见非项目名词（用于过滤上下文提取的误判）。
   */
  private isCommonWord(word: string): boolean {
    const common = new Set([
      '东西', '事情', '任务', '工作', '业务', '方案', '计划',
      '产品', '功能', '需求', '项目', '系统', '平台',
      '自己', '别人', '时候', '地方', '问题', '方法',
    ])
    return common.has(word)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 AsrService 和 IPC handler 共享 */
export const memoryEntityExtractor = new MemoryEntityExtractor()
