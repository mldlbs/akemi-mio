/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner — 工具策略决策层。
 *
 * 职责：基于 Scene + 用户消息 + 上下文信号，输出结构化策略契约。
 *
 * 决策顺序（P4）：
 *   1. Signal Detection（强信号优先，独立于 Scene）
 *   2. Scene Default（弱信号兜底）
 *
 * I-1: 确定性 — 相同输入必然产生完全相同的 ToolDecision
 * I-2: 无副作用 — 不修改任何外部状态
 * I-3: 无 LLM 调用 — 纯本地同步逻辑
 * I-7: ToolDecision 不可变 — 输出后不可修改
 */

import type { SceneLabel } from '../UserBehaviorAnalyzer'
import { ToolDecision, ToolDecisionReason } from './types'
import type { ToolPreference } from './types'

// ── 信号检测配置 ──

/** 新鲜信息查询信号 — 用户需要实时/外部数据 */
const FRESH_INFO_PATTERNS: RegExp[] = [
  /天气|温度|湿度|空气质量|PM2[.]5|AQI|紫外线|降雨|台风|雪/,
  /新闻|头条|热搜|热点|今天.*发生|最新.*消息/,
  /搜索|搜.*一下|查.*一下|查查|查一查|百度|Google|搜索一下/,
  /几点了|现在.*时间|今天.*日期|今天是.*几|星期[几一二三四五六日天]/,
  /汇率|股价|股票|大盘|基金|行情|价格|房价|金价|油价/,
  /多少.*钱|多少钱|报价|价格.*多少/,
  /翻译|翻译成|用.*怎么说|英文怎么说|中文意思/,
  /地震|预警|警报|台风.*路径|天气.*预报/,
  /附近|周边|离.*最近|导航|路线|地图/,
  /[?？].*[?？]|什么.*情况|怎么回事|到底.*怎么/,
]

/** 执行型任务信号 — 用户要求执行操作/产出 */
const EXECUTION_PATTERNS: RegExp[] = [
  /实现|编写|创建|新建|生成|构建|搭建/,
  /部署|发布|上线|更新|升级|迁移/,
  /修复|修改|改进|优化|重构|重写/,
  /安装|配置|设置|搭建|初始化/,
  /写.*代码|写.*脚本|写.*函数|写.*程序|写.*应用/,
  /开发|编码|编程|敲.*代码|改.*代码/,
  /下载|上传|导入|导出|备份|恢复/,
  /编译|打包|构建|构建|build|compile|deploy/,
  /测试|单元测试|集成测试|运行.*测试|跑.*测试/,
  /帮我|请.*帮|能不能.*帮|可以.*帮/,
]

/** 用户明确要求使用工具的信号 */
const EXPLICIT_TOOL_PATTERNS: RegExp[] = [
  /用.*工具|使用.*工具|调用.*工具/,
  /读.*文件|读.*代码|查.*日志|看.*代码|查.*文件/,
  /执行|运行|run|execute|打开|启动/,
  /帮我.*查|帮我.*看|帮我.*找|帮我.*读/,
  /what.*tool|use.*tool|call.*tool/,
]

/** 文件/信息可用信号 — 用户提到了文件或新信息 */
const FILE_AVAILABLE_PATTERNS: RegExp[] = [
  /文件|文档|附件|截图|图片|照片/,
  /我刚.*发|刚才.*传|已.*发.*文件|看.*文件|检查.*文件/,
  /this file|that file|the.*file|my.*file/,
  /内容.*是|如下|以下.*内容|这段.*代码|这个.*函数/,
]

// ── 信号权重 ──

interface SignalDefinition {
  reason: ToolDecisionReason
  patterns: RegExp[]
  confidence: number
}

const SIGNALS: SignalDefinition[] = [
  { reason: ToolDecisionReason.USER_REQUEST, patterns: EXPLICIT_TOOL_PATTERNS, confidence: 0.85 },
  { reason: ToolDecisionReason.EXECUTION_TASK, patterns: EXECUTION_PATTERNS, confidence: 0.75 },
  { reason: ToolDecisionReason.FRESH_INFORMATION, patterns: FRESH_INFO_PATTERNS, confidence: 0.7 },
  { reason: ToolDecisionReason.FILE_AVAILABLE, patterns: FILE_AVAILABLE_PATTERNS, confidence: 0.65 },
]

/** Scene → ToolPreference 映射（默认兜底） */
const SCENE_DEFAULT: Record<SceneLabel, ToolPreference> = {
  code_debugging: 'proactive',
  system_evolution: 'proactive',
  task_execution: 'proactive',
  quick_qa: 'avoid',
  casual_chat: 'avoid',
  creative_writing: 'avoid',
  deep_discussion: 'auto',
  unknown: 'auto',
}

export class ToolPolicyPlanner {
  private getRecentToolCallCount: () => number

  constructor(getRecentToolCallCount?: () => number) {
    this.getRecentToolCallCount = getRecentToolCallCount ?? (() => 0)
  }

  /**
   * 基于 Scene + 用户消息 + 上下文信号，输出结构化策略契约。
   *
   * 决策顺序：
   *   1. 强信号检测（独立于 Scene）
   *   2. Scene 默认值（兜底）
   */
  decide(scene: SceneLabel, userText: string, context?: { hasRecentToolCalls?: boolean }): ToolDecision {
    // Step 1: 强信号检测
    const signal = this._detectSignals(userText, context)
    if (signal) {
      return signal
    }

    // Step 2: Scene 默认兜底
    const preference = SCENE_DEFAULT[scene] ?? 'auto'
    return {
      preference,
      confidence: 0.5,
      reason: ToolDecisionReason.DEFAULT,
    }
  }

  /**
   * 基于 ToolDecision 输出 Safety Filter（allowedToolNames）。
   *
   * ADR-008 明确声明：ToolFilter = Safety Enforcement ≠ Tool Planning
   *
   * 语义：
   *   forbidden → []     （安全禁止）
   *   avoid     → []     （执行 Avoid 策略）
   *   proactive → undefined（全部允许）
   *   auto      → undefined（全部允许）
   */
  toToolFilter(decision: ToolDecision): string[] | undefined {
    switch (decision.preference) {
      case 'forbidden':
        return []
      case 'avoid':
        return []
      case 'proactive':
        return undefined
      case 'auto':
        return undefined
      default:
        return undefined
    }
  }

  // ── 私有方法 ──

  /** 检测强信号。命中返回 ToolDecision，否则返回 null。 */
  private _detectSignals(userText: string, _context?: { hasRecentToolCalls?: boolean }): ToolDecision | null {
    if (!userText) return null

    const lower = userText.toLowerCase()

    for (const signal of SIGNALS) {
      for (const pattern of signal.patterns) {
        pattern.lastIndex = 0
        if (pattern.test(lower) || pattern.test(userText)) {
          return {
            preference: 'proactive',
            confidence: signal.confidence,
            reason: signal.reason,
          }
        }
      }
    }

    return null
  }
}
