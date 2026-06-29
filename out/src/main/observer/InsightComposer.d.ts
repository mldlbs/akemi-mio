import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { TopicCandidate, ResearchResult, BrainOutput, InsightOutput, WritingMode } from './types';
/**
 * InsightComposer — 五段式结构化输出
 *
 * 将研究结果 + 四脑输出转化为 5 段 markdown 文章。
 * 3 种写作模式 (neutral/analytical/creative) 控制语气。
 *
 * 写入格式 = YAML frontmatter + markdown（兼容 essays/published/）
 */
export declare class InsightComposer {
    private llm;
    private store;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    compose(topic: TopicCandidate, research: ResearchResult, brainOutputs: BrainOutput[], mode: WritingMode): Promise<InsightOutput>;
    private assembleSection1;
    private calcContributions;
    private formatInsightMarkdown;
}
