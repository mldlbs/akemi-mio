import type { ExecutionGoalMethodologyStat, ExecutionGoalStats } from './types'

/**
 * 将执行目标统计格式化为 Evolution 分析 Prompt 上下文（纯函数，不依赖 DB）。
 * 完成率分母 = completed + blocked + abandoned，因此上下文需同时呈现三者，
 * 让 Evolution 能分析“真实完成率”而非仅看 completed/total。
 */
export function formatExecutionGoalContext(stats: ExecutionGoalStats, byMethodology: ExecutionGoalMethodologyStat[]): string {
  if (stats.total === 0) return ''
  const lines = [
    '',
    '【执行目标闭环统计】',
    `总目标: ${stats.total}，完成: ${stats.completed}，阻塞: ${stats.blocked}，放弃: ${stats.abandoned}，完成率: ${(stats.completionRate * 100).toFixed(0)}%（completed/(completed+blocked+abandoned)）`,
  ]
  for (const item of byMethodology) {
    const label = item.methodology ?? '未绑定'
    lines.push(`- ${label}: ${item.completed}/${item.total} 完成，blocked=${item.blocked}，abandoned=${item.abandoned}`)
  }
  return lines.join('\n')
}
