/**
 * WritingDecisionMemory — 写作决策记忆回溯与一致性检查
 *
 * 职责：
 * 1. 定义结构化记忆格式：决策类型、实体（角色/地点/时间）、原设定、修改后设定、上下文摘要
 * 2. 在每次场景保存时自动 diff 旧/新内容，生成决策记录写入 Memory
 * 3. 提供实体查询，供 Agent 在新章节写作前回溯已变更项
 * 4. 草稿完成后运行一致性校验，检测与 Memory 记录的冲突点
 *
 * 数据模型：
 * - 每条决策记录以 MemoryEntry type='writing_decision' 存储
 * - structuredData 包含完整的决策元数据（JSON）
 * - content 为可读摘要，支持文本检索
 *
 * 与 WritingMemoryContinuation 的区别：
 * - WritingMemoryContinuation 管理「读者反馈」记忆（writing_feedback type）
 * - WritingDecisionMemory 管理「写作决策」记忆（writing_decision type）
 *   记录的是作者/Agent 对角色、设定、情节的修改决策，用于跨章节一致性维护
 */
import { log } from '../logger/Logger'
import { getMemoryService } from '../tool/deps'
import type { MemoryEntry } from '../memory/types'

// ===== 导出类型 =====

/** 写作决策类型 */
export type WritingDecisionType =
  | 'character_change'      // 角色变更（性格、外貌、背景等）
  | 'setting_change'        // 场景/设定变更（地点、时代、气候等）
  | 'plot_change'           // 情节变更（事件走向、悬念设置等）
  | 'style_change'          // 文风变更（叙事视角、语言风格等）
  | 'timeline_change'       // 时间线变更（顺序、间隔、时间点等）
  | 'relationship_change'   // 关系变更（角色间互动关系等）
  | 'dialogue_change'       // 对话变更（台词、对话风格等）
  | 'worldbuilding_change'  // 世界观变更（规则、体系、力量设定等）
  | 'other'                 // 其他

/** 写作决策条目（结构化存储格式） */
export interface WritingDecisionEntry {
  id: string
  storyName: string
  sceneId?: string
  sceneTitle?: string
  chapterNumber?: number
  /** 决策类型 */
  decisionType: WritingDecisionType
  /** 涉及的实体列表（角色名/地名/物名等） */
  entities: string[]
  /** 原设定摘录 */
  originalContent: string
  /** 修改后设定摘录 */
  modifiedContent: string
  /** 上下文摘要（100 字以内） */
  contextSummary: string
  /** 时间戳 */
  timestamp: number
}

/** 一致性检查结果 */
export interface ConsistencyIssue {
  /** 冲突涉及的实体 */
  entity: string
  /** 关联的决策记录 */
  decision: WritingDecisionEntry
  /** 新文本中冲突的行摘录 */
  conflictingLine: string
  /** 冲突严重程度 */
  severity: 'conflict' | 'warning'
  /** 冲突描述 */
  description: string
}

/** Diff 段 */
interface DiffSegment {
  type: 'equal' | 'add' | 'delete' | 'modify'
  text: string
  oldText?: string
}

// ===== 常用中文实体模式 =====
// 用于从文本中提取潜在的人名、地名、时间词
const ENTITY_PATTERNS = [
  // 角色名：引号内的2-4字名称 「林默」「陈峰」「老王」
  /[「「『『]([^」」』』]{1,6})[」」』』]/g,
  // 可能的角色名：大写+小写组合（全名）
  /([一-鿿]{2,4}(?:先生|小姐|女士|老师|同学|医生|局长|经理|教授|博士|将军|上尉|队长|兄|姐|妹|弟))/g,
  // 地名：带方位/地名词尾的
  /([一-鿿]{2,6}(?:市|县|镇|村|省|国|河|江|湖|海|山|峰|谷|原|区|街|路|道|城|堡|塔|殿|宫|府|园|场))/g,
  // 时间：朝代/年份/季节/时间点
  /((?:民国|公元|纪元|时代|世纪|年代|年份|纪元前|公元|春季|夏季|秋季|冬季|清晨|黄昏|午夜|黎明))/g,
]

// ===== 服务 =====

export class WritingDecisionService {
  // ================================================================
  //  决策记录
  // ================================================================

  /**
   * 手动记录一条写作决策。
   * 存储为 writing_decision 类型的 MemoryEntry，tier=semi。
   *
   * @returns 生成的 entry ID，或 null 如果 MemoryService 不可用
   */
  recordDecision(input: {
    storyName: string
    sceneId?: string
    sceneTitle?: string
    chapterNumber?: number
    decisionType: WritingDecisionType
    entities: string[]
    originalContent: string
    modifiedContent: string
    contextSummary: string
  }): string | null {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'writing_decision_no_service', { storyName: input.storyName })
      return null
    }

    // 构建可读内容摘要，支持文本检索
    const entityTag = input.entities.length > 0 ? `[${input.entities.join(',')}]` : '[]'
    const content = `【${input.storyName}决策】${entityTag} ${input.decisionType}: ${input.contextSummary.slice(0, 120)}`

    // structuredData 包含完整元数据
    const structuredData = JSON.stringify({
      storyName: input.storyName,
      sceneId: input.sceneId || null,
      sceneTitle: input.sceneTitle || null,
      chapterNumber: input.chapterNumber || null,
      decisionType: input.decisionType,
      entities: input.entities,
      originalContent: input.originalContent.slice(0, 500),
      modifiedContent: input.modifiedContent.slice(0, 500),
      contextSummary: input.contextSummary.slice(0, 300),
      timestamp: Date.now(),
    } satisfies Omit<WritingDecisionEntry, 'id'>)

    ms.addEntry('writing_decision', content, 0.85, {
      tier: 'semi',
      structuredData,
    })

    log('INFO', 'writing_decision_recorded', {
      storyName: input.storyName,
      decisionType: input.decisionType,
      entities: input.entities,
      contextSummary: input.contextSummary.slice(0, 60),
    })

    // 返回一个占位 ID（实际 ID 由 MemoryService 内部生成，此处简化）
    return `writing_dec_${Date.now()}`
  }

  /**
   * 通过 diff 检测场景内容变更，自动生成决策记录。
   * 比较 oldContent 和 newContent，提取变更段落和实体，推断决策类型。
   *
   * @returns 生成的决策记录列表（可能有多条）
   */
  recordDecisionFromDiff(input: {
    storyName: string
    sceneId?: string
    sceneTitle?: string
    chapterNumber?: number
    oldContent: string
    newContent: string
  }): WritingDecisionEntry[] {
    if (input.oldContent === input.newContent) {
      log('INFO', 'writing_decision_no_diff', { sceneId: input.sceneId })
      return []
    }

    const segments = this.computeDiff(input.oldContent, input.newContent)
    const changeBlocks = segments.filter((s) => s.type !== 'equal')

    if (changeBlocks.length === 0) return []

    // 从变更段落中提取所有实体
    const allChangedText = changeBlocks.map((s) => s.text).join('\n')
    const oldChangedText = changeBlocks
      .filter((s) => s.type === 'delete' || s.type === 'modify')
      .map((s) => s.oldText || s.text)
      .join('\n')

    const entities = this.extractEntities(allChangedText)
    if (entities.length === 0) {
      // 无实体则用段落摘要
      const summary = this.summarizeText(allChangedText, 80)
      const entry: WritingDecisionEntry = {
        id: `writing_dec_${Date.now()}_0`,
        storyName: input.storyName,
        sceneId: input.sceneId,
        sceneTitle: input.sceneTitle,
        chapterNumber: input.chapterNumber,
        decisionType: 'other',
        entities: [],
        originalContent: oldChangedText.slice(0, 500) || '（原内容）',
        modifiedContent: allChangedText.slice(0, 500),
        contextSummary: summary,
        timestamp: Date.now(),
      }
      this.recordDecision(entry)
      return [entry]
    }

    // 按实体分组生成决策记录
    const records: WritingDecisionEntry[] = []
    const seenEntities = new Set<string>()

    for (const entity of entities) {
      if (seenEntities.has(entity)) continue
      seenEntities.add(entity)

      // 找与该实体相关的变更行
      const entityLines = changeBlocks.filter((s) => s.text.includes(entity))
      if (entityLines.length === 0) continue

      const entityText = entityLines.map((s) => s.text).join('\n').slice(0, 500)
      const oldEntityText = changeBlocks
        .filter((s) => (s.type === 'delete' || s.type === 'modify') && (s.text.includes(entity) || (s.oldText && s.oldText.includes(entity))))
        .map((s) => (s.oldText || s.text))
        .join('\n')
        .slice(0, 500)

      const summary = this.summarizeText(entityText, 80)
      const decisionType = this.inferDecisionType(entity, allChangedText)

      const entry: WritingDecisionEntry = {
        id: `writing_dec_${Date.now()}_${records.length}`,
        storyName: input.storyName,
        sceneId: input.sceneId,
        sceneTitle: input.sceneTitle,
        chapterNumber: input.chapterNumber,
        decisionType,
        entities: [entity],
        originalContent: oldEntityText || '（原内容修改）',
        modifiedContent: entityText,
        contextSummary: summary,
        timestamp: Date.now(),
      }

      // 存储到 Memory
      this.recordDecision(entry)
      records.push(entry)
    }

    // 如果提取的实体少于 3 个且总变更较大，额外生成一条上下文摘要
    if (records.length < 3 && changeBlocks.length > 3) {
      const fullSummary = this.summarizeText(allChangedText, 100)
      // 去重：不要与已有摘要重复
      if (!records.some((r) => r.contextSummary === fullSummary)) {
        const entry: WritingDecisionEntry = {
          id: `writing_dec_${Date.now()}_ctx`,
          storyName: input.storyName,
          sceneId: input.sceneId,
          sceneTitle: input.sceneTitle,
          chapterNumber: input.chapterNumber,
          decisionType: 'other',
          entities: [...seenEntities],
          originalContent: oldChangedText.slice(0, 500),
          modifiedContent: allChangedText.slice(0, 500),
          contextSummary: fullSummary,
          timestamp: Date.now(),
        }
        this.recordDecision(entry)
        records.push(entry)
      }
    }

    log('INFO', 'writing_decision_diff_recorded', {
      storyName: input.storyName,
      changeBlocks: changeBlocks.length,
      records: records.length,
      entities: [...seenEntities],
    })

    return records
  }

  // ================================================================
  //  查询
  // ================================================================

  /**
   * 按实体名查询决策记录。
   * 返回与指定实体相关的所有写作决策。
   */
  queryByEntities(storyName: string, entities: string[]): WritingDecisionEntry[] {
    const all = this._parseAllDecisions(storyName)
    if (entities.length === 0) return all

    const lowerEntities = entities.map((e) => e.toLowerCase())
    return all.filter((d) =>
      d.entities.some((e) => lowerEntities.some((le) => e.toLowerCase().includes(le) || le.includes(e.toLowerCase()))),
    )
  }

  /**
   * 查询某故事的所有决策记录。
   */
  queryByStory(storyName: string): WritingDecisionEntry[] {
    return this._parseAllDecisions(storyName)
  }

  /**
   * 查询所有故事的决策记录。
   */
  queryAll(): WritingDecisionEntry[] {
    return this._parseAllDecisions()
  }

  /**
   * 获取格式化上下文（用于 Agent 写作前注入 prompt）。
   * 按决策类型分组，每条摘要 80 字以内。
   *
   * @param storyName 故事名
   * @param entityFilter 可选实体过滤，只返回涉及指定实体的决策
   */
  getFormattedContext(storyName: string, entityFilter?: string[]): string {
    const decisions = entityFilter
      ? this.queryByEntities(storyName, entityFilter)
      : this.queryByStory(storyName)

    if (decisions.length === 0) return ''

    // 按决策类型分组
    const byType = new Map<WritingDecisionType, WritingDecisionEntry[]>()
    for (const d of decisions) {
      const list = byType.get(d.decisionType) || []
      list.push(d)
      byType.set(d.decisionType, list)
    }

    const typeLabels: Record<WritingDecisionType, string> = {
      character_change: '角色变更',
      setting_change: '设定变更',
      plot_change: '情节变更',
      style_change: '文风变更',
      timeline_change: '时间线变更',
      relationship_change: '关系变更',
      dialogue_change: '对话变更',
      worldbuilding_change: '世界观变更',
      other: '其他变更',
    }

    const parts: string[] = ['---', '【写作决策回溯】以下是对各章节修改的历史决策记录，续写时请注意保持一致：']

    for (const [type, entries] of byType) {
      const label = typeLabels[type] || type
      parts.push(`\n【${label}】`)
      // 按时间倒序，最多展示 5 条
      const sorted = entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5)
      for (const e of sorted) {
        const entitiesStr = e.entities.length > 0 ? `[${e.entities.join(', ')}]` : ''
        const sceneStr = e.sceneTitle ? `（${e.sceneTitle}）` : ''
        parts.push(`- ${entitiesStr} ${e.contextSummary} ${sceneStr}`)
      }
    }

    // 汇总涉及的实体
    const allEntities = [...new Set(decisions.flatMap((d) => d.entities))].sort()
    if (allEntities.length > 0) {
      parts.push(`\n涉及实体：${allEntities.join('、')}`)
    }

    parts.push('---')
    return parts.join('\n')
  }

  // ================================================================
  //  一致性检查
  // ================================================================

  /**
   * 对新内容运行一致性校验。
   * 遍历决策记录，检测新文本中与已记录决策矛盾的内容。
   *
   * 检查策略：
   * 1. 对每条决策，取其涉及的实体列表
   * 2. 在新文本中查找这些实体的出现位置
   * 3. 检查决策的 modifiedContent 中的关键信息是否在新文本中被违背
   *    （例如：决策记录"林默性格改为开朗"，新文本却说"林默沉默寡言"）
   *
   * @param storyName 故事名
   * @param newContent 待检查的新章节内容
   */
  checkConsistency(storyName: string, newContent: string): ConsistencyIssue[] {
    const decisions = this.queryByStory(storyName)
    if (decisions.length === 0) return []

    const issues: ConsistencyIssue[] = []

    for (const decision of decisions) {
      if (decision.entities.length === 0) continue

      // 对每条决策的每个实体，检查新文本中的上下文
      for (const entity of decision.entities) {
        // 如果新文本根本不涉及此实体，跳过
        if (!newContent.includes(entity)) continue

        // 提取实体附近的行（前后各 1 行）
        const lines = newContent.split('\n')
        const relevantLines = lines.filter((line) => line.includes(entity))

        for (const line of relevantLines) {
          // 对比 decision 的 modifiedContent 中的关键描述词
          // 从 modifiedContent 中提取关键描述词（形容词、动词等）
          const keyTerms = this.extractKeyTerms(decision.modifiedContent)

          // 检查当前行是否与决策矛盾
          const contradiction = this.detectContradiction(line, decision.modifiedContent, keyTerms)
          if (contradiction) {
            issues.push({
              entity,
              decision,
              conflictingLine: line.trim().slice(0, 100),
              severity: 'conflict',
              description: contradiction,
            })
          } else {
            // 如果没检测到明显矛盾，但确实提到了该实体，给一个弱提示
            // 避免过多干扰
            const lineLower = line.toLowerCase()
            const modifiedLower = decision.modifiedContent.toLowerCase()
            // 检查是否有否定词（不/没/未）出现在实体附近
            const negationPattern = new RegExp(`.{0,10}(?:不|没|未|不要|没有|不是|不再是|不再).{0,10}${entity}.{0,20}`)
            if (negationPattern.test(lineLower) && !modifiedLower.includes('不再')) {
              issues.push({
                entity,
                decision,
                conflictingLine: line.trim().slice(0, 100),
                severity: 'warning',
                description: `检测到「${entity}」附近有否定表述，可能与之前决策的设定冲突`,
              })
            }
          }
        }
      }
    }

    log('INFO', 'writing_decision_consistency_check', {
      storyName,
      decisionsChecked: decisions.length,
      issuesFound: issues.length,
    })

    return issues
  }

  // ================================================================
  //  内部方法
  // ================================================================

  /**
   * 从 Memory 中解析所有 writing_decision 类型的结构化条目。
   */
  private _parseAllDecisions(storyName?: string): WritingDecisionEntry[] {
    const ms = getMemoryService()
    if (!ms) return []

    const allEntries = ms.getEntries()
    const results: WritingDecisionEntry[] = []

    for (const entry of allEntries) {
      if (entry.type !== 'writing_decision') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as Omit<WritingDecisionEntry, 'id'>
        if (storyName && data.storyName !== storyName) continue
        results.push({
          id: entry.id,
          ...data,
        })
      } catch {
        // 解析失败则跳过
        continue
      }
    }

    // 按时间倒序排列
    results.sort((a, b) => b.timestamp - a.timestamp)
    return results
  }

  /**
   * 简单的文本 diff 实现。
   * 按行比较，标记 equal / add / delete / modify。
   */
  private computeDiff(oldContent: string, newContent: string): DiffSegment[] {
    const oldLines = oldContent.split('\n')
    const newLines = newContent.split('\n')
    const segments: DiffSegment[] = []

    // 简单的逐行 LCS 风格比较
    // 使用行级精确匹配
    const oldSet = new Map<string, number[]>()
    for (let i = 0; i < oldLines.length; i++) {
      const line = oldLines[i].trim()
      if (!oldSet.has(line)) oldSet.set(line, [])
      oldSet.get(line)!.push(i)
    }

    let oi = 0
    let ni = 0

    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length && oldLines[oi].trim() === newLines[ni].trim()) {
        segments.push({ type: 'equal', text: oldLines[oi] })
        oi++
        ni++
      } else if (ni < newLines.length && (oi >= oldLines.length || !oldSet.has(newLines[ni].trim()) || oldSet.get(newLines[ni].trim())!.every((idx) => idx < oi))) {
        segments.push({ type: 'add', text: newLines[ni] })
        ni++
      } else if (oi < oldLines.length) {
        // 检查是否 modify（旧行被修改为新行）
        if (ni < newLines.length && oldLines[oi].trim() !== newLines[ni].trim()) {
          segments.push({ type: 'modify', text: newLines[ni], oldText: oldLines[oi] })
          oi++
          ni++
        } else {
          segments.push({ type: 'delete', text: oldLines[oi] })
          oi++
        }
      } else {
        segments.push({ type: 'add', text: newLines[ni] })
        ni++
      }
    }

    return segments
  }

  /**
   * 从文本中提取实体（角色名、地名、时间词）。
   */
  private extractEntities(text: string): string[] {
    const found = new Set<string>()

    for (const pattern of ENTITY_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const entity = match[1]?.trim()
        if (entity && entity.length >= 2 && entity.length <= 10) {
          found.add(entity)
        }
      }
    }

    // 额外：提取连续出现的 2-4 字中文词（可能的人名）
    // 仅在没有引号包裹时作为后备
    const namePattern = /([一-鿿]{2,4})(?=说|道|想|问|答|笑|哭|喊|叫|走|来|去|看|望|指|拍|拉|推|站|坐|躺)/g
    let match: RegExpExecArray | null
    while ((match = namePattern.exec(text)) !== null) {
      const name = match[1].trim()
      if (name.length >= 2) {
        found.add(name)
      }
    }

    return [...found].slice(0, 20) // 最多 20 个实体
  }

  /**
   * 从文本中提取关键描述词（形容词、动词等），用于矛盾检测。
   */
  private extractKeyTerms(text: string): string[] {
    const terms: string[] = []
    // 提取中文双音节及以上词汇
    const wordPattern = /[一-鿿]{2,6}/g
    let match: RegExpExecArray | null
    while ((match = wordPattern.exec(text)) !== null) {
      const word = match[0]
      // 排除常见的非描述性词汇
      const stopWords = new Set([
        '一个', '没有', '什么', '可以', '这个', '那个', '他们', '它们',
        '我们', '你们', '自己', '时候', '知道', '就是', '但是', '如果',
        '因为', '所以', '虽然', '而且', '或者', '然后', '最后', '开始',
        '已经', '这么', '那么', '怎么', '如何', '关于', '对于', '还是',
        '不是', '就是', '只是', '可是', '而是', '却是', '却是', '也是',
      ])
      if (!stopWords.has(word) && word.length >= 2) {
        terms.push(word)
      }
    }
    return [...new Set(terms)]
  }

  /**
   * 检测单行文本与决策设定是否矛盾。
   * 基于关键词的否定匹配。
   */
  private detectContradiction(line: string, modifiedContent: string, keyTerms: string[]): string | null {
    const lineLower = line.toLowerCase()
    const modifiedLower = modifiedContent.toLowerCase()

    // 策略：检查 modifiedContent 中的关键正面描述是否在行中被否定
    // 例如：modified 说"开朗"，line 说"不再开朗" / "沉默寡言"

    for (const term of keyTerms) {
      if (term.length < 2) continue
      // 如果 term 在 modifiedContent 中出现（正面描述）
      if (modifiedLower.includes(term)) {
        // 检查 line 中该 term 附近是否有否定词
        const termIndex = lineLower.indexOf(term)
        if (termIndex >= 0) {
          const before = lineLower.slice(Math.max(0, termIndex - 15), termIndex)
          const after = lineLower.slice(termIndex + term.length, termIndex + term.length + 10)
          const context = before + after

          const negations = ['不', '没', '未', '不再', '不是', '没有', '反对', '否认', '拒绝', '违背']
          const hasNegation = negations.some((n) => context.includes(n))

          if (hasNegation) {
            return `与之前决策矛盾：已设定「${term}」，但新文本中使用否定表述「${context.slice(0, 20)}…」`
          }
        }
      }
    }

    // 检查是否有明确的时间线矛盾
    const timePattern = /(\d+)年[前后]|(\d+)小时[前后]|第二天|次日|隔天|三天[前后]|一周[前后]/g
    let match: RegExpExecArray | null
    while ((match = timePattern.exec(line)) !== null) {
      // 如果 modifiedContent 也包含时间表述，对比是否一致
      const timeKeywords = ['时间', '年', '月', '日', '天', '小时', '分钟', '星期', '周', '季节']
      if (timeKeywords.some((kw) => modifiedLower.includes(kw))) {
        // 简化的时间线冲突检测
        // 实际场景需要更复杂的解析
        return `检测到时间表述「${match[0]}」，请核对是否与之前设定的时间线一致`
      }
    }

    return null
  }

  /**
   * 推断变更的决策类型。
   */
  private inferDecisionType(entity: string, changedText: string): WritingDecisionType {
    const typeKeywords: Array<[WritingDecisionType, string[]]> = [
      ['character_change', ['性格', '外貌', '年龄', '身份', '职业', '能力', '技能', '背景', '经历']],
      ['setting_change', ['地点', '场景', '环境', '时代', '季节', '天气', '建筑', '装饰', '背景设定']],
      ['plot_change', ['情节', '剧情', '事件', '转折', '悬念', '发展', '结局', '冲突']],
      ['style_change', ['风格', '视角', '叙述', '描写', '语气', '节奏', '文笔']],
      ['timeline_change', ['时间', '顺序', '间隔', '同时', '之后', '之前', '倒叙', '插叙']],
      ['relationship_change', ['关系', '感情', '互动', '对立', '合作', '信任', '矛盾']],
      ['dialogue_change', ['对话', '台词', '对白', '说', '道', '语言', '口吻']],
      ['worldbuilding_change', ['规则', '体系', '力量', '魔法', '科技', '社会', '文化', '历史']],
    ]

    const lowerText = changedText.toLowerCase()
    for (const [type, keywords] of typeKeywords) {
      if (keywords.some((kw) => lowerText.includes(kw))) {
        return type
      }
    }

    return 'other'
  }

  /**
   * 文本摘要工具：截取前 N 字并确保句末完整。
   */
  private summarizeText(text: string, maxLength: number): string {
    const cleaned = text.replace(/\s+/g, '').trim()
    if (cleaned.length <= maxLength) return cleaned

    // 在 maxLength 附近寻找句号、逗号作为断句点
    const cut = cleaned.slice(0, maxLength)
    const lastPeriod = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'))
    if (lastPeriod > maxLength * 0.5) {
      return cut.slice(0, lastPeriod + 1)
    }

    return cut + '…'
  }

  /**
   * 获取一致性检查结果的格式化文本（用于 Agent 反馈）。
   */
  formatIssues(issues: ConsistencyIssue[]): string {
    if (issues.length === 0) return ''

    const parts: string[] = ['---', '【一致性检查结果】发现以下潜在冲突：']

    for (const issue of issues) {
      const severityLabel = issue.severity === 'conflict' ? '⚠️ 冲突' : '⚡ 提示'
      parts.push(
        `\n${severityLabel} [${issue.entity}]`,
        `  决策记录：${issue.decision.contextSummary.slice(0, 80)}`,
        `  冲突内容：「${issue.conflictingLine}」`,
        `  说明：${issue.description}`,
      )
    }

    parts.push('\n---')
    return parts.join('\n')
  }
}
