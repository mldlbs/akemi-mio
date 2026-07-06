/**
 * SentimentAnalyzer — 轻量中文情感极性分析
 *
 * 基于规则（关键词匹配 + 否定词处理）实现，无需外部 ML 依赖。
 * 用于 MCP 工具返回结果后的自动情感检测，驱动 TTS 音色/语调自适应。
 */

import { log } from '../logger/Logger'
import type { SentimentResult, SentimentPolarity } from './types'

// ══════════════════════════════════════════
//  正面情感词库
// ══════════════════════════════════════════

const POSITIVE_WORDS = new Set([
  // 通用正面
  '好', '棒', '赞', '优秀', '出色', '完美', '精彩', '厉害', '了不起', '不错', '很好', '极好', '超好',
  '成功', '通过', '完成', '搞定', '解决', '修复', '顺利', '正常', '没问题', '无问题',
  '开心', '高兴', '愉快', '欢乐', '喜悦', '幸福', '满足', '欣慰', '舒适', '惬意',
  '喜欢', '热爱', '喜爱', '钟爱', '欣赏', '满意', '欣喜',
  '感谢', '感激', '感恩', '谢谢', '多谢',
  '漂亮', '美丽', '好看', '可爱', '帅气', '英俊',
  '温暖', '温馨', '暖心', '热情', '热烈',
  '强大', '牛逼', '高效', '快速', '便捷', '流畅', '好用',
  '进步', '提升', '增长', '突破', '创新', '领先',
  '第一名', '最佳', '最优', '顶级', '一流',
  // 天气相关正面
  '晴天', '晴朗', '阳光', '明媚', '暖和', '凉爽', '微风', '万里无云', '蓝天',
  '白云', '彩虹', '晴空', '灿烂',
  // 成功/完成类
  '✅', '已创建', '已保存', '已更新', '已删除', '已安装', '已部署', '已同步',
  '已通过', '已认证', '已授权', '已确认', '已验证',
  '创建成功', '保存成功', '更新成功', '删除成功', '部署成功',
  'ok', 'OK', 'Ok', 'success', 'SUCCESS',
])

// ══════════════════════════════════════════
//  负面情感词库
// ══════════════════════════════════════════

const NEGATIVE_WORDS = new Set([
  // 通用负面
  '差', '烂', '糟糕', '失败', '错误', '问题', 'bug', 'BUG', 'Bug',
  '坏', '恶', '劣', '低劣', '不合格',
  '伤心', '难过', '悲伤', '悲哀', '痛苦', '难受', '压抑', '郁闷', '沮丧', '失望',
  '生气', '愤怒', '恼火', '烦躁', '焦虑', '担心', '担忧', '不安', '紧张',
  '讨厌', '厌恶', '反感', '厌倦', '嫌弃',
  '害怕', '恐惧', '恐慌', '惊慌', '惊吓',
  '孤独', '寂寞', '无助', '绝望',
  '丑陋', '难看', '恶心', '厌恶',
  '冷漠', '冷淡', '残酷', '无情',
  '弱', '废物', '垃圾', '低效', '慢', '卡', '崩溃', '宕机',
  '退步', '下降', '衰退', '落后',
  '严重', '紧急', '危险', '致命', '崩溃',
  // 错误/失败类
  '❌', '失败', '出错', '报错', '异常', '中断', '终止', '拒绝', '禁止',
  '超时', '过期', '无效', '不可用', '无法', '不能', '不允许',
  'error', 'Error', 'ERROR', 'fail', 'FAIL', 'failed', 'FAILED',
  'timeout', 'TIMEOUT', 'denied', 'rejected',
  // 天气相关负面
  '暴雨', '暴风雨', '台风', '飓风', '洪水', '泥石流',
  '阴天', '阴沉', '多云', '昏暗', '雾霾', '沙尘', '雾', '霾',
  '寒冷', '酷寒', '严寒', '冰冷', '炎热', '酷热', '闷热', '潮湿',
  '雷暴', '闪电', '冰雹', '暴雪',
])

// ══════════════════════════════════════════
//  否定词（翻转极性）
// ══════════════════════════════════════════

const NEGATION_WORDS = new Set([
  '不', '没', '无', '非', '未', '别', '莫', '勿', '否', '没有', '并非', '绝不',
  '不是', '不会', '不能', '不好', '不行',
])

// ══════════════════════════════════════════
//  程度副词（增强信号）
// ══════════════════════════════════════════

const INTENSIFIERS = new Set([
  '非常', '十分', '极其', '特别', '格外', '尤其', '相当', '很', '太', '真',
  '最', '极', '超级', '无比', '极度', '绝对', '完全',
])

// ══════════════════════════════════════════
//  内容类型检测关键词
// ══════════════════════════════════════════

const CONTENT_TYPE_KEYWORDS: Array<{ type: string; words: string[] }> = [
  {
    type: 'weather',
    words: ['天气', '气温', '温度', '降雨', '降雪', '风速', '湿度', '晴天', '阴天', '多云', '暴雨', '台风', '雾霾', '空气质量', '紫外线'],
  },
  {
    type: 'error',
    words: ['错误', '失败', '异常', '崩溃', '超时', '拒绝', '禁止', '无效', '无法连接', '中断', 'bug', 'error', 'timeout', '500', '404', '403', '401'],
  },
  {
    type: 'success',
    words: ['成功', '完成', '通过', '已创建', '已保存', '已部署', '已更新', '已删除', '✅', 'done', 'success', 'ok'],
  },
  {
    type: 'news',
    words: ['新闻', '报道', '消息', '资讯', '头条', '快讯', '发布', '公告', '声明'],
  },
  {
    type: 'code',
    words: ['代码', '文件', '函数', '类', '接口', '模块', 'import', 'export', 'function', 'class', 'const', 'type', 'interface', 'git', 'commit', 'push', 'pull', 'merge', '分支', '仓库'],
  },
  {
    type: 'data',
    words: ['数据', '统计', '分析', '查询', '结果', '总数', '平均', '最大', '最小', '比例', '图表', '报告', '趋势'],
  },
]

// ══════════════════════════════════════════
//  分析器
// ══════════════════════════════════════════

export class SentimentAnalyzer {
  /** 上次分析结果缓存（用于 debounce / 避免相同文本重复分析） */
  private lastResult: SentimentResult | null = null
  private lastText = ''

  /**
   * 分析文本的情感极性和内容类型
   *
   * @param text 待分析文本
   * @returns SentimentResult
   */
  analyze(text: string): SentimentResult {
    if (!text || text.trim().length === 0) {
      return { polarity: 'neutral', score: 0, contentType: 'unknown', matchedWords: [] }
    }

    // 相同文本返回缓存结果
    if (text === this.lastText && this.lastResult) {
      return this.lastResult
    }
    this.lastText = text

    // 归一化：全角→半角，统一大小写
    const normalized = text.toLowerCase()

    // 1. 扫描情感词
    let posScore = 0
    let negScore = 0
    const matchedWords: string[] = []

    // 按句子分割以处理否定词上下文
    const sentences = normalized.split(/[。！？\n.!?]+/)

    for (const sentence of sentences) {
      const words = this._segmentWords(sentence)
      let sentenceHasNegation = false

      for (let i = 0; i < words.length; i++) {
        const word = words[i]

        // 检测否定词（影响后方 2–3 个词的极性）
        if (NEGATION_WORDS.has(word)) {
          sentenceHasNegation = true
          continue
        }

        // 检测程度副词
        const hasIntensifier = i > 0 && INTENSIFIERS.has(words[i - 1])

        if (POSITIVE_WORDS.has(word)) {
          matchedWords.push(word)
          if (sentenceHasNegation) {
            negScore += hasIntensifier ? 2 : 1
          } else {
            posScore += hasIntensifier ? 2 : 1
          }
          sentenceHasNegation = false
        } else if (NEGATIVE_WORDS.has(word)) {
          matchedWords.push(word)
          if (sentenceHasNegation) {
            // 否定 + 负面 = 中性偏正（如 "不错"）
            posScore += 0.5
          } else {
            negScore += hasIntensifier ? 2 : 1
          }
          sentenceHasNegation = false
        }
      }
    }

    // 2. 判定极性和置信度
    const totalScore = posScore + negScore
    let polarity: SentimentPolarity
    let score: number

    if (totalScore === 0) {
      polarity = 'neutral'
      score = 0
    } else if (posScore > negScore * 1.5) {
      polarity = 'positive'
      score = Math.min(1, posScore / totalScore)
    } else if (negScore > posScore * 1.5) {
      polarity = 'negative'
      score = Math.min(1, negScore / totalScore)
    } else if (posScore > 0 && negScore > 0) {
      // 正负得分接近 → 中性偏弱
      polarity = posScore > negScore ? 'positive' : 'negative'
      score = Math.abs(posScore - negScore) / totalScore
    } else if (posScore > 0) {
      polarity = 'positive'
      score = Math.min(1, posScore / (posScore + 1))
    } else {
      polarity = 'negative'
      score = Math.min(1, negScore / (negScore + 1))
    }

    // 3. 内容类型检测
    const contentType = this._detectContentType(normalized, polarity)

    const result: SentimentResult = { polarity, score, contentType, matchedWords }
    this.lastResult = result

    log('INFO', 'sentiment_analysis', {
      polarity,
      score: score.toFixed(2),
      content_type: contentType,
      matched_words: matchedWords.slice(0, 10).join(','),
      text_snippet: text.slice(0, 80),
    })

    return result
  }

  /**
   * 简单分词：按标点和空白切分
   */
  private _segmentWords(sentence: string): string[] {
    // 中文按字符切分但保留常见双字/三字词的基本形式
    // 简化版：单字+双字滑动窗口
    const chars = sentence.replace(/\s+/g, '').split('')
    const words: string[] = []

    for (let i = 0; i < chars.length; i++) {
      // 单字
      words.push(chars[i])
      // 双字
      if (i + 1 < chars.length) {
        words.push(chars[i] + chars[i + 1])
      }
      // 三字
      if (i + 2 < chars.length) {
        words.push(chars[i] + chars[i + 1] + chars[i + 2])
      }
    }

    return words
  }

  /**
   * 检测内容类型
   */
  private _detectContentType(text: string, polarity: SentimentPolarity): string {
    const typeScores: Record<string, number> = {}

    for (const { type, words: keywords } of CONTENT_TYPE_KEYWORDS) {
      let score = 0
      for (const kw of keywords) {
        if (text.includes(kw)) {
          score += 1
          // 精确匹配加分
          if (new RegExp(`\\b${kw}\\b`, 'i').test(text)) {
            score += 0.5
          }
        }
      }
      if (score > 0) typeScores[type] = score
    }

    // 错误类内容自带负面极性提示
    if (typeScores['error'] && typeScores['error'] >= 2) return 'error'
    if (typeScores['success'] && typeScores['success'] >= 2) return 'success'
    if (typeScores['weather'] && typeScores['weather'] >= 2) return 'weather'
    if (typeScores['news'] && typeScores['news'] >= 2) return 'news'
    if (typeScores['code'] && typeScores['code'] >= 2) return 'code'
    if (typeScores['data'] && typeScores['data'] >= 2) return 'data'

    // 回退
    return polarity === 'positive' ? 'chat' : polarity === 'negative' ? 'error' : 'info'
  }
}

/** 全局单例 */
export const sentimentAnalyzer = new SentimentAnalyzer()
