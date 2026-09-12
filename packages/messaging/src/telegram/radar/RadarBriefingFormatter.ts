/**
 * 商业信号雷达 —— 简报格式化器
 *
 * 将 /radar/pipeline 的完整原始数据格式化为 Telegram 推送简报。
 * 与远程 /api/briefing 不同，这里对每条信号展示完整字段
 * （问题 / 目标用户 / 市场差距 / 定价 / MVP 建议），避免上游简报截断信号内容。
 */

import type { RadarPushRule } from '@akemi-mio/messaging/telegram/radar/types'

/** 今日解读：完整展示的信号条数上限 */
const MAX_DETAILED_SIGNALS = 5
/** 持续追踪：机会条数上限 */
const MAX_TRACKED_OPPS = 5
/** 主题覆盖：主题条数上限 */
const MAX_THEMES = 5
/** Telegram 单条消息安全长度（上限 4096，预留余量） */
const TELEGRAM_SAFE_LIMIT = 4000

/**
 * 将 /radar/pipeline 返回的完整数据格式化为简报。
 * 若消息过长，自动减少"今日解读"的详细信号条数，保证不触发 Telegram 截断。
 */
export function formatPipelineBriefing(body: any, rule: Pick<RadarPushRule, 'keywords'>): string {
  const keywords = rule.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean)
  let detailedCount = MAX_DETAILED_SIGNALS

  let lines = buildBriefingLines(body, keywords, detailedCount)
  while (lines.join('\n').length > TELEGRAM_SAFE_LIMIT && detailedCount > 2) {
    detailedCount -= 1
    lines = buildBriefingLines(body, keywords, detailedCount)
  }
  return lines.join('\n')
}

function buildBriefingLines(body: any, keywords: string[], detailedCount: number): string[] {
  const signals: any[] = Array.isArray(body.signals) ? body.signals : []
  const opportunities: any[] = Array.isArray(body.opportunities) ? body.opportunities : []
  const themes: any[] = Array.isArray(body.themes) ? body.themes : []
  const report = Array.isArray(body.reports) && body.reports.length > 0 ? body.reports[0] : undefined

  // 按评分排序；配置了关键词时先按关键词过滤，没有命中则回退到全量 Top，保证推送不落空
  let topSignals = [...signals].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  let topOpps = [...opportunities].sort((a, b) => (b.avg_score ?? 0) - (a.avg_score ?? 0))
  if (keywords.length > 0) {
    const matchedSignals = topSignals.filter((s) => keywords.some((k) => signalSearchText(s).toLowerCase().includes(k)))
    const matchedOpps = topOpps.filter((o) =>
      keywords.some((k) =>
        String(o.title || '')
          .toLowerCase()
          .includes(k),
      ),
    )
    if (matchedSignals.length > 0 || matchedOpps.length > 0) {
      topSignals = matchedSignals
      topOpps = matchedOpps
    }
  }

  const lines: string[] = [`📡 商业信号雷达 · ${new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`]

  if (report) {
    const summary: string[] = []
    if (report.total_signals != null) summary.push(`今日 ${report.total_signals} 信号`)
    if (report.high_value != null) summary.push(`高价值 ${report.high_value}`)
    summary.push(`追踪 ${opportunities.length} 个机会`)
    lines.push(`📊 ${summary.join(' | ')}`)
  }

  // ── 今日解读：完整信号内容 ──
  const detailed = topSignals.slice(0, detailedCount)
  if (detailed.length > 0) {
    lines.push('', '━━━ 今日解读 ━━━')
    detailed.forEach((s, i) => {
      lines.push('')
      lines.push(`  ${i + 1}. ${String(s.problem || s.title || '未命名信号').trim()}`)
      lines.push(`     📌 ${classTags(s)}`)
      lines.push(`     ${metricLine(s)}`)
      if (s.icp || s.persona) lines.push(`     💡 目标用户: ${String(s.icp || s.persona).trim()}`)
      if (s.gap) lines.push(`     🔍 市场差距: ${String(s.gap).trim()}`)
      if (s.pricing || s.estimated_acv) lines.push(`     💰 定价: ${String(s.pricing || s.estimated_acv).trim()}`)
      if (s.mvp_suggestion) lines.push(`     🛠️ MVP建议: ${String(s.mvp_suggestion).trim()}`)
    })
  }

  // ── 持续追踪：完整机会标题 ──
  const tracked = topOpps.slice(0, MAX_TRACKED_OPPS)
  if (tracked.length > 0) {
    lines.push('', '━━━ 持续追踪 ━━━')
    tracked.forEach((o, i) => {
      const meta = [
        `类型 ${o.type || '?'}`,
        `出现 ${o.appearances ?? '?'} 次`,
        o.consecutive_days ? `连续 ${o.consecutive_days} 天` : '',
        `均分 ${o.avg_score ?? '?'}`,
      ]
        .filter(Boolean)
        .join(' · ')
      lines.push(`  ${i + 1}. ${String(o.title || '未命名机会').trim()}`)
      lines.push(`     ${meta}`)
    })
  }

  // ── 主题覆盖 ──
  if (themes.length > 0) {
    lines.push('', '━━━ 主题覆盖 ━━━')
    for (const t of themes.slice(0, MAX_THEMES)) {
      const parts = [`${t.theme || t.name || '?'}: ${t.count ?? '?'} 条信号`]
      if (t.trend_score != null) parts.push(`趋势 ${t.trend_score}`)
      lines.push(`  • ${parts.join(' | ')}`)
    }
  }

  if (detailed.length === 0 && tracked.length === 0) {
    lines.push('', '📭 今日暂无信号数据。')
  }

  return lines
}

/** 信号全文检索文本（关键词过滤用） */
function signalSearchText(s: any): string {
  return [s.problem, s.title, s.business_value, s.gap, s.icp, s.pricing, s.persona].filter((v) => v != null).join(' ')
}

/** 信号分类标签 */
function classTags(s: any): string {
  return [s.classification, s.theme, s.opportunity_class].filter(Boolean).join(' · ') || '未分类'
}

/** 信号维度评分行 */
function metricLine(s: any): string {
  const metrics: string[] = []
  const add = (icon: string, abbr: string, label: string, value: any) => {
    if (value != null) metrics.push(`${icon} ${label}(${abbr}=${value})`)
  }
  add('🔴', 'MP', '强需求', s.market_pull)
  add('⏰', 'U', '紧迫', s.urgency)
  add('👤', 'BC', '买家清晰', s.buyer_clarity)
  add('🔄', 'RV', '高频', s.recurring_value)
  add('🛠️', 'EE', '易构建', s.execution_ease)
  add('🔄', 'RI', '替代窗口', s.replacement_intent)
  if (metrics.length === 0 && s.score != null) metrics.push(`🔍 综合评分 ${s.score}`)
  return metrics.join(' | ') || '暂无评分'
}
