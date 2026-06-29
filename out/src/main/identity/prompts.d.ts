import type { CoreIdentity, EvolvedTrait, GrowthMetrics } from './IdentitySchema';
/**
 * 构建可注入 system prompt 的自我认知段落。
 * 格式与原先 PROMPT_IDENTITY 兼容，但增加了动态 trait 和 metrics 信息。
 */
export declare function buildIdentityPrompt(core: CoreIdentity, metrics: GrowthMetrics, traits?: EvolvedTrait[]): string;
