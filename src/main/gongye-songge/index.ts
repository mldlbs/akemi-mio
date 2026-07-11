/**
 * Plan:工业颂歌 公众号排版处理 — 模块入口
 *
 * 作为 Agent 的上层增强层，拦截其输入输出进行预处理/后处理增强。
 * 通过环境变量 GONGYE_SONGE_FEATURES 控制特性。
 */

export { IndustrialOdeLayer } from './IndustrialOdeLayer'

export {
  parseFeaturesFromEnv,
} from './types'

export type {
  GongyeSonggeFeature,
  GongyeSonggeFeatureMap,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  IndustrialOdeLayerConfig,
} from './types'

export {
  formatBasic,
  formatWithLlm,
  detectFormatNeed,
} from './formatters'

export type {
  WechatFormatOptions,
  FormatResult,
} from './formatters'
