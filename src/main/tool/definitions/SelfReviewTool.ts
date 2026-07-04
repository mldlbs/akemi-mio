import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCognitiveService } from '../deps'

export const runSelfReviewTool = buildTool({
  name: 'run_self_review',
  description: '触发元认知自评循环，生成关于当前状态、模式、改进建议的自我审查报告',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      if (!cs.metaCycle) return formatToolError('元认知循环未初始化')

      const snapshot = cs.metaCycle.collectSnapshot()
      const review = await cs.metaCycle.generateReview(snapshot)
      if (!review) return formatToolError('自评生成失败')

      cs.metaCycle.applyReview(review)

      const lines = [
        '【自评摘要】',
        review.summary,
        '',
        '【观察到的模式】',
        ...(review.patterns?.length ? review.patterns.map((p: string) => `  - ${p}`) : ['  (无)']),
        '',
        '【改进建议】',
        ...(review.improvements?.length ? review.improvements.map((i: string) => `  - ${i}`) : ['  (无)']),
        '',
        `置信度: ${(review.confidence * 100).toFixed(0)}%`,
      ]
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
