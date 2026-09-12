/**
 * ContentVoiceMapper — 博客内容 → Piper 语音模型映射
 *
 * 根据段落内容类型、标题关键词、文档位置选择合适的 Piper TTS 模型。
 * 利用已有的 PiperOrchestrator 模型目录（3 个中文模型），
 * 实现"根据内容情感和章节匹配音色"的需求。
 *
 * 映射策略：
 * - 文章标题/开头 → 花颜·女声（huayan，通用清晰）
 * - 教程/技术内容 → 花颜·女声（huayan，清晰专业）
 * - 故事/叙事内容 → 玲玲·温柔女声（ling_ling，高表现力）
 * - 结论/总结 → 马提·沉稳男声（tx_mati，沉稳有力）
 * - 引用/提示 → 马提·沉稳男声（tx_mati，区分感）
 * - Intro 导读 → 花颜·女声（huayan，欢迎读者）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { PIPER_MODEL_CATALOG } from './PiperOrchestrator'
import type { TtsSegment, SegmentContentType } from './MarkdownSegmenter'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 语音模型选择结果 */
export interface VoiceAssignment {
  /** Piper 模型名 */
  model: string
  /** 语速因子 */
  speed: number
  /** 音调因子 */
  pitch: number
  /** 分配理由（日志用） */
  reason: string
  /** 是否需要在段落间插入停顿（毫秒） */
  pauseAfterMs: number
}

// ══════════════════════════════════════════
//  标题关键词 → 模型映射
// ══════════════════════════════════════════

interface KeywordRule {
  keywords: string[]
  model: string
  reason: string
}

/** 教程/技术类关键词 */
const TUTORIAL_KEYWORDS: KeywordRule[] = [
  {
    keywords: ['教程', '指南', '入门', '上手', '安装', '配置', '使用', '方法', '步骤', '如何'],
    model: 'zh_CN-huayan-medium',
    reason: '教程内容 - 花颜·女声',
  },
  {
    keywords: ['API', 'SDK', '接口', '函数', '方法', '参数', '返回值', '类型', '代码'],
    model: 'zh_CN-huayan-medium',
    reason: '技术内容 - 花颜·女声',
  },
  {
    keywords: ['实现', '架构', '设计', '模式', '原理', '机制', '流程', '算法'],
    model: 'zh_CN-huayan-medium',
    reason: '架构内容 - 花颜·女声',
  },
]

/** 故事/叙事类关键词 */
const STORY_KEYWORDS: KeywordRule[] = [
  { keywords: ['故事', '经历', '分享', '体验', '感受', '心路历程'], model: 'zh_CN-ling_ling-medium', reason: '故事内容 - 玲玲·温柔女声' },
  { keywords: ['回顾', '总结', '年度', '月度', '周报', '日志'], model: 'zh_CN-ling_ling-medium', reason: '回顾内容 - 玲玲·温柔女声' },
  { keywords: ['思考', '感悟', '启发', '反思', '心得', '体会'], model: 'zh_CN-ling_ling-medium', reason: '感悟内容 - 玲玲·温柔女声' },
]

/** 结论/通知类关键词 */
const CONCLUSION_KEYWORDS: KeywordRule[] = [
  { keywords: ['总结', '结论', '小结', '展望', '下一步'], model: 'zh_CN-tx_mati-medium', reason: '总结内容 - 马提·沉稳男声' },
  { keywords: ['注意', '警告', '提醒', '重要', '须知'], model: 'zh_CN-tx_mati-medium', reason: '重要提醒 - 马提·沉稳男声' },
  { keywords: ['公告', '通知', '更新', '发布', '版本', '变更'], model: 'zh_CN-tx_mati-medium', reason: '公告内容 - 马提·沉稳男声' },
]

/** 内容类型 → 模型回退映射 */
const CONTENT_TYPE_MODEL: Record<SegmentContentType, string> = {
  title: 'zh_CN-huayan-medium',
  heading: 'zh_CN-huayan-medium',
  paragraph: 'zh_CN-huayan-medium',
  list_item: 'zh_CN-huayan-medium',
  quote: 'zh_CN-tx_mati-medium',
  note: 'zh_CN-tx_mati-medium',
  code_skip: 'zh_CN-huayan-medium',
  table_skip: 'zh_CN-huayan-medium',
}

// ══════════════════════════════════════════
//  ContentVoiceMapper
// ══════════════════════════════════════════

export class ContentVoiceMapper {
  /**
   * 为段落分配 Piper 语音模型。
   *
   * 优先级：
   * 1. 标题关键词匹配（按关键词规则匹配 headingText）
   * 2. 内容类型映射（按 contentType 回退）
   * 3. 默认模型（zh_CN-huayan-medium）
   */
  assignVoice(segment: TtsSegment, segmentIndex: number, totalSegments: number): VoiceAssignment {
    // ── 特定段落映射 ──

    // 文章标题 → 花颜·女声（快速清晰）
    if (segment.contentType === 'title') {
      return {
        model: 'zh_CN-huayan-medium',
        speed: 0.95,
        pitch: 1.0,
        reason: '文章标题 - 花颜·女声',
        pauseAfterMs: 800,
      }
    }

    // Intro 段落 → 花颜·女声（欢迎读者）
    if (segment.isIntro) {
      return {
        model: 'zh_CN-huayan-medium',
        speed: 0.95,
        pitch: 1.0,
        reason: '导读段落 - 花颜·女声',
        pauseAfterMs: 500,
      }
    }

    // ── 根据标题关键词匹配 ──
    const headingText = segment.headingText || ''

    for (const rule of TUTORIAL_KEYWORDS) {
      if (rule.keywords.some((kw) => headingText.includes(kw))) {
        return {
          model: rule.model,
          speed: PIPER_MODEL_CATALOG[rule.model]?.speed ?? 1.0,
          pitch: PIPER_MODEL_CATALOG[rule.model]?.pitch ?? 1.0,
          reason: rule.reason,
          pauseAfterMs: 400,
        }
      }
    }

    for (const rule of STORY_KEYWORDS) {
      if (rule.keywords.some((kw) => headingText.includes(kw))) {
        return {
          model: rule.model,
          speed: PIPER_MODEL_CATALOG[rule.model]?.speed ?? 0.9,
          pitch: PIPER_MODEL_CATALOG[rule.model]?.pitch ?? 1.0,
          reason: rule.reason,
          pauseAfterMs: 500,
        }
      }
    }

    for (const rule of CONCLUSION_KEYWORDS) {
      if (rule.keywords.some((kw) => headingText.includes(kw))) {
        return {
          model: rule.model,
          speed: PIPER_MODEL_CATALOG[rule.model]?.speed ?? 1.1,
          pitch: PIPER_MODEL_CATALOG[rule.model]?.pitch ?? 0.95,
          reason: rule.reason,
          pauseAfterMs: 600,
        }
      }
    }

    // ── 根据内容类型回退 ──
    const modelByType = CONTENT_TYPE_MODEL[segment.contentType] || 'zh_CN-huayan-medium'
    const config = PIPER_MODEL_CATALOG[modelByType]

    // 引用/提示段落使用沉稳男声
    if (segment.contentType === 'quote' || segment.contentType === 'note') {
      return {
        model: 'zh_CN-tx_mati-medium',
        speed: config?.speed ?? 1.0,
        pitch: config?.pitch ?? 0.95,
        reason: '引用/提示 - 马提·沉稳男声',
        pauseAfterMs: 400,
      }
    }

    // ── 文档末段落（最后 2 段）→ 沉稳男声，作为结尾 ──
    if (segmentIndex >= totalSegments - 2 && totalSegments > 3) {
      return {
        model: 'zh_CN-tx_mati-medium',
        speed: 0.95,
        pitch: 0.9,
        reason: '结尾段落 - 马提·沉稳男声',
        pauseAfterMs: 0,
      }
    }

    // ── 默认：花颜·女声 ──
    return {
      model: 'zh_CN-huayan-medium',
      speed: config?.speed ?? 1.0,
      pitch: config?.pitch ?? 1.0,
      reason: '默认 - 花颜·女声',
      pauseAfterMs: 300,
    }
  }

  /**
   * 为整篇文档生成完整的语音分配方案。
   * 连续相同的模型会合并 pause（避免段落间不必要停顿）。
   */
  assignAll(segments: TtsSegment[]): VoiceAssignment[] {
    const t0 = Date.now()
    const total = segments.length

    const assignments: VoiceAssignment[] = segments.map((seg, i) => {
      return this.assignVoice(seg, i, total)
    })

    // 合并 pause：如果当前段和上一段使用相同模型，减少停顿
    for (let i = 1; i < assignments.length; i++) {
      if (assignments[i].model === assignments[i - 1].model) {
        // 同模型段落间只保留较短的停顿
        assignments[i].pauseAfterMs = Math.min(assignments[i].pauseAfterMs, 200)
      }
    }

    log('INFO', 'content_voice_mapper_done', {
      total_segments: total,
      model_counts: this.countModels(assignments),
      duration_ms: Date.now() - t0,
    })

    return assignments
  }

  /** 统计各模型分配的段落数 */
  private countModels(assignments: VoiceAssignment[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const a of assignments) {
      const name = PIPER_MODEL_CATALOG[a.model]?.displayName || a.model
      counts[name] = (counts[name] || 0) + 1
    }
    return counts
  }
}

/** 全局单例 */
export const contentVoiceMapper = new ContentVoiceMapper()
