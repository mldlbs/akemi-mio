import type { ObserverLlmService } from './ObserverLlmService';
import type { ResearchResult, BrainOutput, WritingMode } from './types';
/**
 * MultiBrainModel — 四脑认知模型（并行版）
 *
 * 升级点：
 * - perception / curiosity / analyst 独立并行执行，不依赖前序输出
 * - writer 在所有前序完成后运行，接收完整上下文
 * - 任一脑失败不影响其他脑
 */
export declare class MultiBrainModel {
    private llm;
    constructor(llm: ObserverLlmService);
    process(result: ResearchResult, mode: WritingMode): Promise<BrainOutput[]>;
    private buildResearchSummary;
    private runBrain;
}
