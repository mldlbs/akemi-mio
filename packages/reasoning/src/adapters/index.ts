/**
 * reasoning/adapters — ASR 算法复用到 Plan:推理链 适配器入口
 *
 * 导出所有 ASR→Reasoning 兼容适配组件。
 * 使用方式：
 * ```ts
 * import { asrReasoningAdapter } from './reasoning/adapters'
 *
 * // 博客写作推理链
 * const plan = await asrReasoningAdapter.planForBlog(ctx)
 *
 * // 内容质量评分
 * const assessment = asrReasoningAdapter.assessContent(input)
 * ```
 */

export { AsrReasoningAdapter, asrReasoningAdapter } from './AsrReasoningAdapter'
export { GenericFallbackChain, GenericContextBoost, GenericCompositeScoring, GenericCrossValidation } from './AsrReasoningAdapter'
export * from './types'
